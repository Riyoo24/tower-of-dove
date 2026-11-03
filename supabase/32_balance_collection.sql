-- =====================================================================
-- 32_balance_collection.sql  (safe to re-run)
-- Staff must collect the remaining balance before a session starts or equipment is issued.
--
--   * payment gets 4 columns that record the balance collected at the studio / pick-up
--   * booking_balance_due(), rental_balance_due(): the exact amount still to collect (one source of truth)
--   * staff_collect_balance(): ONE database transaction that
--         1) checks the amount the staff member saw is still the amount due,
--         2) records the balance and changes the payment from 'down' (50%) to 'full' (100%),
--         3) moves the booking to In Progress (shown as Active) / the rental to Active (shown as In Use).
--     If any step fails (for example no stock) nothing is saved.
--   * a guard trigger on booking and rental_order: a booking or outside rental with a balance cannot be
--     started / issued until it was collected (also blocks any shortcut that skips the admin page)
--   * start_due_sessions(): no longer starts a session or rental by itself while a balance is still due
--   * views get extra columns at the END (balance_due, balance_paid_amount, balance_paid_at, ...)
--   * lookup_booking(): the customer sees the balance as paid once staff collected it
-- Revenue report: unchanged. payment.amount still holds the online payment, so nothing is counted twice;
-- the balance keeps being counted on the day the session starts / the equipment is issued.
-- Run once in the Supabase SQL Editor (after 31_payment_options.sql).
-- =====================================================================

-- 1. Where the collected balance is recorded --------------------------------------------------------
alter table public.payment add column if not exists balance_paid_amount numeric(10,2) not null default 0;
alter table public.payment add column if not exists balance_paid_at     timestamptz;
alter table public.payment add column if not exists balance_paid_by     bigint references public.app_user (user_id) on delete set null;
alter table public.payment add column if not exists balance_paid_method varchar(10);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payment_balance_paid_chk') then
    alter table public.payment add constraint payment_balance_paid_chk
      check (balance_paid_amount >= 0 and (balance_paid_method is null or balance_paid_method in ('Cash', 'GCash')));
  end if;
end $$;

-- 2. The exact balance still to collect --------------------------------------------------------------
-- Booking: studio + add-on equipment (+ verified extensions, which are inside the booking total)
--          - the online payment(s) - what staff already collected. 0 when nothing was paid as a down payment.
create or replace function public.booking_balance_due(p_booking_id bigint) returns numeric
language sql stable security definer set search_path = public as $$
  select case
    when coalesce(b.down_payment, 0) <= 0 then 0::numeric
    else greatest(0, public.booking_total(b.booking_id) + public.booking_addons_total(b.booking_id)
                     - b.down_payment - public.booking_addon_paid(b.booking_id)
                     - coalesce((select p.balance_paid_amount from public.payment p
                                  where p.booking_id = b.booking_id and p.status <> 'Rejected'
                                  order by p.payment_id desc limit 1), 0))::numeric(10,2)
  end
  from public.booking b where b.booking_id = p_booking_id;
$$;
revoke all on function public.booking_balance_due(bigint) from public, anon;
grant execute on function public.booking_balance_due(bigint) to authenticated;

-- Outside rental: rental total - down payment - what staff already collected (add-on orders follow their booking)
create or replace function public.rental_balance_due(p_rental_order_id bigint) returns numeric
language sql stable security definer set search_path = public as $$
  select case
    when o.rental_type <> 'Outside' or coalesce(o.down_payment, 0) <= 0 then 0::numeric
    else greatest(0, public.rental_order_total(o.rental_order_id) - o.down_payment
                     - coalesce((select p.balance_paid_amount from public.payment p
                                  where p.rental_order_id = o.rental_order_id and p.status <> 'Rejected'
                                  order by p.payment_id desc limit 1), 0))::numeric(10,2)
  end
  from public.rental_order o where o.rental_order_id = p_rental_order_id;
$$;
revoke all on function public.rental_balance_due(bigint) from public, anon;
grant execute on function public.rental_balance_due(bigint) to authenticated;

-- 3. Collect the balance and start / issue, all or nothing --------------------------------------------
--    p_kind 'booking' : p_ref = booking reference. p_start true  -> also moves the booking to In Progress (Active).
--                                                 p_start false -> only records the balance (used before issuing an add-on).
--    p_kind 'rental'  : p_ref = rental reference (outside rental). Also moves it to Active (In Use).
--    p_expected       : the amount shown to the staff member. If the real balance changed meanwhile, nothing is saved.
drop function if exists public.staff_collect_balance(text, text, text, numeric, boolean);
create function public.staff_collect_balance(
  p_kind text, p_ref text, p_method text default 'Cash', p_expected numeric default null, p_start boolean default true
) returns table (kind text, ref text, collected numeric, new_status text)
language plpgsql security definer set search_path = public as $$
declare
  k   text := lower(coalesce(trim(p_kind), ''));
  m   text := case lower(coalesce(trim(p_method), 'cash')) when 'gcash' then 'GCash' when 'cash' then 'Cash' else null end;
  b   public.booking;
  o   public.rental_order;
  pay public.payment;
  bal numeric := 0;
  r   text := upper(regexp_replace(coalesce(p_ref, ''), '\s', '', 'g'));
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  if m is null then raise exception 'Choose how the balance was paid: Cash or GCash.' using errcode = 'P0001'; end if;

  if k = 'booking' then
    select * into b from public.booking where booking_ref = r for update;
    if not found then raise exception 'Booking % was not found.', r using errcode = 'P0001'; end if;
    if b.status <> 'Approved' then
      raise exception 'Booking % is % now. Only a Confirmed booking can be started.', r, b.status using errcode = 'P0001';
    end if;
    select * into pay from public.payment where booking_id = b.booking_id and status <> 'Rejected' order by payment_id desc limit 1 for update;
    if coalesce(b.down_payment, 0) > 0 and (not found or pay.status <> 'Verified') then
      raise exception 'Verify the customer''s down payment first.' using errcode = 'P0001';
    end if;

    bal := public.booking_balance_due(b.booking_id);
    if p_expected is not null and abs(bal - p_expected) > 0.005 then
      raise exception 'The balance changed to PHP %. Close this window and open it again.', to_char(bal, 'FM999,999,990.00') using errcode = 'P0001';
    end if;

    if bal > 0.005 then
      update public.payment
         set balance_paid_amount = balance_paid_amount + bal,
             balance_paid_at     = now(),
             balance_paid_by     = public.current_app_user_id(),
             balance_paid_method = m,
             payment_option      = 'full'
       where payment_id = pay.payment_id;
    end if;

    if p_start then
      update public.booking set status = 'In Progress' where booking_id = b.booking_id;   -- stamps actual_start_at, starts the add-ons
    end if;
    return query select 'booking'::text, b.booking_ref::text, bal, case when p_start then 'In Progress' else b.status end::text;

  elsif k = 'rental' then
    select * into o from public.rental_order where rental_ref = r for update;
    if not found then raise exception 'Rental % was not found.', r using errcode = 'P0001'; end if;
    if o.status <> 'Approved' then
      raise exception 'Rental % is % now. Only a verified rental can be issued.', r, o.status using errcode = 'P0001';
    end if;
    select * into pay from public.payment where rental_order_id = o.rental_order_id and status <> 'Rejected' order by payment_id desc limit 1 for update;
    if coalesce(o.down_payment, 0) > 0 and (not found or pay.status <> 'Verified') then
      raise exception 'Verify the customer''s down payment first.' using errcode = 'P0001';
    end if;

    bal := public.rental_balance_due(o.rental_order_id);
    if p_expected is not null and abs(bal - p_expected) > 0.005 then
      raise exception 'The balance changed to PHP %. Close this window and open it again.', to_char(bal, 'FM999,999,990.00') using errcode = 'P0001';
    end if;

    if bal > 0.005 then
      update public.payment
         set balance_paid_amount = balance_paid_amount + bal,
             balance_paid_at     = now(),
             balance_paid_by     = public.current_app_user_id(),
             balance_paid_method = m,
             payment_option      = 'full'
       where payment_id = pay.payment_id;
    end if;

    update public.rental_order set status = 'Active' where rental_order_id = o.rental_order_id;   -- stock is checked here; stamps issued_at
    return query select 'rental'::text, o.rental_ref::text, bal, 'Active'::text;

  else
    raise exception 'Unknown kind. Use booking or rental.' using errcode = 'P0001';
  end if;
end $$;
revoke all on function public.staff_collect_balance(text, text, text, numeric, boolean) from public, anon;
grant execute on function public.staff_collect_balance(text, text, text, numeric, boolean) to authenticated;

-- 4. Guards: a balance cannot be skipped ---------------------------------------------------------------
create or replace function public.guard_booking_balance() returns trigger
language plpgsql security definer set search_path = public as $$
declare bal numeric;
begin
  if new.status = 'In Progress' and old.status is distinct from 'In Progress' and coalesce(new.down_payment, 0) > 0 then
    bal := public.booking_balance_due(new.booking_id);
    if bal > 0.005 then
      raise exception 'The remaining balance of PHP % has not been collected yet. Use Start session on the admin page and confirm the payment first.',
        to_char(bal, 'FM999,999,990.00') using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_booking_balance_guard on public.booking;
create trigger trg_booking_balance_guard before update of status on public.booking
  for each row execute function public.guard_booking_balance();

create or replace function public.guard_rental_balance() returns trigger
language plpgsql security definer set search_path = public as $$
declare bal numeric;
begin
  if new.status = 'Active' and old.status is distinct from 'Active' and new.rental_type = 'Outside' and coalesce(new.down_payment, 0) > 0 then
    bal := public.rental_balance_due(new.rental_order_id);
    if bal > 0.005 then
      raise exception 'The remaining balance of PHP % has not been collected yet. Use Issue on the admin page and confirm the payment first.',
        to_char(bal, 'FM999,999,990.00') using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_rental_balance_guard on public.rental_order;
create trigger trg_rental_balance_guard before update of status on public.rental_order
  for each row execute function public.guard_rental_balance();

-- 5. Nothing starts by itself while a balance is still due (staff start it from the admin page) ---------
create or replace function public.start_due_sessions() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer := 0; k integer; o record;
begin
  -- confirmed studio sessions whose time has begun and that have no balance left to collect
  update public.booking set status = 'In Progress'
   where status = 'Approved' and start_at <= now() and end_at > now()
     and public.booking_balance_due(booking_id) <= 0.005;
  get diagnostics k = row_count; n := n + k;

  -- outside rentals: In Use as soon as the pick-up time arrives, unless a balance is still due
  for o in select rental_order_id from public.rental_order
            where rental_type = 'Outside' and status = 'Approved' and pickup_date <= now()
              and public.rental_balance_due(rental_order_id) <= 0.005 loop
    begin
      update public.rental_order set status = 'Active' where rental_order_id = o.rental_order_id;
      n := n + 1;
    exception when others then null;   -- for example the stock check failed: leave it for staff
    end;
  end loop;
  return n;
end $$;
revoke all on function public.start_due_sessions() from public, anon;
grant execute on function public.start_due_sessions() to authenticated;

-- 6. Views: new columns are added at the END -------------------------------------------------------------
create or replace view public.v_booking_summary with (security_invoker = true) as
select
  b.booking_id, b.booking_ref, b.status, b.source,
  b.studio_id, s.name as studio_name,
  b.customer_id, trim(c.first_name || ' ' || c.last_name) as customer_name, c.number as customer_number,
  (c.auth_user_id is null) as is_guest,
  b.start_at, b.end_at,
  extract(epoch from (b.end_at - b.start_at)) / 3600.0 as hours,
  b.actual_start_at, b.actual_end_at,
  b.hourly_rate_at_booking,
  round(b.hourly_rate_at_booking * extract(epoch from (b.end_at - b.start_at)) / 3600.0, 2) as total_amount,
  p.payment_id, p.method as payment_method, p.gcash_reference, p.status as payment_status,
  b.approved_by, b.created_at,
  b.rejected_reason,
  b.down_payment,
  p.payment_option,
  p.balance_paid_amount, p.balance_paid_at, p.balance_paid_method,
  public.booking_balance_due(b.booking_id) as balance_due
from public.booking b
join public.studio s   on s.studio_id = b.studio_id
join public.customer c on c.customer_id = b.customer_id
left join lateral (
  select * from public.payment p where p.booking_id = b.booking_id order by p.payment_id desc limit 1
) p on true;
grant select on public.v_booking_summary to authenticated;

create or replace view public.v_payment_queue with (security_invoker = true) as
select
  p.payment_id, p.status, p.method, p.gcash_reference, p.amount, p.created_at, p.verified_at,
  coalesce(b.booking_ref, o.rental_ref, xb.booking_ref) as reference,
  case when p.booking_id is not null then 'Booking'
       when p.extension_id is not null then 'Extension'
       else 'Rental' end as kind,
  trim(c.first_name || ' ' || c.last_name) as customer_name,
  p.extension_id,
  p.payment_option,
  p.balance_paid_amount, p.balance_paid_at, p.balance_paid_method
from public.payment p
left join public.booking b on b.booking_id = p.booking_id
left join public.rental_order o on o.rental_order_id = p.rental_order_id
left join public.booking_extension x on x.extension_id = p.extension_id
left join public.booking xb on xb.booking_id = x.booking_id
join public.customer c on c.customer_id = coalesce(b.customer_id, o.customer_id, xb.customer_id);
grant select on public.v_payment_queue to authenticated;

create or replace view public.v_rental_lines with (security_invoker = true) as
select
  o.rental_order_id, o.rental_ref, o.rental_type, o.status, o.source,
  o.customer_id, trim(c.first_name || ' ' || c.last_name) as customer_name, c.number as customer_number,
  bk.booking_ref,
  d.rental_detail_id, d.equipment_id, e.name as equipment_name, d.quantity,
  d.unit_price_at_request, d.rental_hours, d.returned_at as line_returned_at,
  o.pickup_date, o.return_date,
  -- overdue only after the full 8-hour window, whatever return time was scheduled
  case when o.rental_type = 'Outside' then public.rental_due_at(o.pickup_date, o.return_date) else bk.end_at end as due_at,
  case
    when o.status = 'Active' and d.returned_at is null
         and now() > case when o.rental_type = 'Outside' then public.rental_due_at(o.pickup_date, o.return_date) else bk.end_at end
    then greatest(1,
      (now() at time zone 'Asia/Manila')::date
      - ((case when o.rental_type = 'Outside' then public.rental_due_at(o.pickup_date, o.return_date) else bk.end_at end) at time zone 'Asia/Manila')::date)
    else 0
  end as days_overdue,
  o.rejected_reason, o.issued_at, o.returned_at, o.created_at,
  d.late_fee, o.down_payment,
  -- NEW (must stay the last column): whole hours past the due time, 0 when not overdue
  case
    when o.status = 'Active' and d.returned_at is null
         and now() > case when o.rental_type = 'Outside' then public.rental_due_at(o.pickup_date, o.return_date) else bk.end_at end
    then greatest(1, ceil(extract(epoch from (now() - (case when o.rental_type = 'Outside' then public.rental_due_at(o.pickup_date, o.return_date) else bk.end_at end))) / 3600.0))::int
    else 0
  end as hours_overdue,
  -- NEW (must stay last): what staff collected at pick-up and what is still to collect
  pb.balance_paid_amount, pb.balance_paid_at,
  public.rental_balance_due(o.rental_order_id) as balance_due
from public.rental_order o
join public.rental_detail d on d.rental_order_id = o.rental_order_id
join public.equipment e on e.equipment_id = d.equipment_id
join public.customer c on c.customer_id = o.customer_id
left join public.booking bk on bk.booking_id = o.booking_id
left join lateral (
  select p.balance_paid_amount, p.balance_paid_at from public.payment p
   where p.rental_order_id = o.rental_order_id and p.status <> 'Rejected' order by p.payment_id desc limit 1
) pb on true;
grant select on public.v_rental_lines to authenticated;

-- 7. Booking lookup: the balance counts as paid once staff collected it ---------------------------------
create or replace function public.lookup_booking(p_ref text, p_phone text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r record; ad jsonb; ad_total numeric;
begin
  select b.booking_id, b.booking_ref, b.status, b.start_at, b.end_at, s.name as studio_name, s.description as studio_desc,
         public.booking_total(b.booking_id) as total,
         (select p.status from public.payment p where p.booking_id = b.booking_id order by p.payment_id desc limit 1) as payment_status,
         c.number, c.auth_user_id, b.rejected_reason, b.down_payment,
         (select p.balance_paid_amount from public.payment p where p.booking_id = b.booking_id and p.status <> 'Rejected' order by p.payment_id desc limit 1) as balance_paid,
         (select p.payment_option from public.payment p where p.booking_id = b.booking_id order by p.payment_id desc limit 1) as payment_option
    into r
  from public.booking b
  join public.studio s on s.studio_id = b.studio_id
  join public.customer c on c.customer_id = b.customer_id
  where b.booking_ref = upper(regexp_replace(coalesce(p_ref, ''), '\s', '', 'g'));

  if not found then return null; end if;

  -- registered customers' bookings are private: only the owner of the account or staff may read them
  if r.auth_user_id is not null and r.auth_user_id is distinct from auth.uid() and not public.is_staff() then
    return null;
  end if;
  if p_phone is not null and public.digits(p_phone) <> public.digits(r.number) then return null; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'equipment', e.name, 'quantity', d.quantity,
           'price', d.unit_price_at_request * d.quantity, 'status', o.status) order by e.name), '[]'::jsonb),
         coalesce(sum(d.unit_price_at_request * d.quantity), 0)
    into ad, ad_total
  from public.rental_order o
  join public.rental_detail d on d.rental_order_id = o.rental_order_id
  join public.equipment e on e.equipment_id = d.equipment_id
  where o.booking_id = r.booking_id and o.rental_type = 'Add-on' and o.status not in ('Rejected', 'Cancelled');

  return jsonb_build_object(
    'booking_ref', r.booking_ref, 'status', r.status, 'start_at', r.start_at, 'end_at', r.end_at,
    'studio', r.studio_name, 'studio_description', r.studio_desc,
    'total', r.total,
    'studio_total', r.total, 'addons', ad, 'addons_total', ad_total, 'grand_total', r.total + ad_total,
    'payment_status', r.payment_status, 'rejected_reason', r.rejected_reason,
    'down_payment', r.down_payment,
    -- once staff collected the balance the payment record says 'full'; the customer still sees the original online payment + the balance paid at the studio
    'payment_option', case when coalesce(r.balance_paid, 0) > 0 then 'down' else coalesce(r.payment_option, 'down') end,
    'balance_paid', coalesce(r.balance_paid, 0),
    'addons_paid', public.booking_addon_paid(r.booking_id),
    'balance_due', greatest(0, r.total + ad_total - r.down_payment - public.booking_addon_paid(r.booking_id) - coalesce(r.balance_paid, 0)));
end $$;


-- end of 32_balance_collection.sql
