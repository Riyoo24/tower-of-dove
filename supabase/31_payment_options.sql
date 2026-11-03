-- =====================================================================
-- 31_payment_options.sql  (safe to re-run)
-- Customers choose how much to pay online with GCash:
--     'down' = 50% DOWN PAYMENT (the balance is paid at the studio / at pick-up)   <- the old behaviour, still the default
--     'full' = FULL PAYMENT (100%), nothing left to pay on arrival
-- It applies to: studio bookings (with their add-ons), outside rentals, add-on rentals added later from the
-- Rent equipment page, and session extensions. The server calculates the amount from the option, so the browser
-- cannot change it, and the choice is stored on every payment (payment.payment_option).
-- Staff walk-in (onsite) records are unchanged: paid in full by staff.
-- Run once in the Supabase SQL Editor (after 30_claim_guest_bookings.sql).
-- =====================================================================

-- 1. Store the option on each payment -------------------------------------------------------------
alter table public.payment add column if not exists payment_option varchar(10) not null default 'down';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payment_option_chk') then
    alter table public.payment add constraint payment_option_chk check (payment_option in ('down', 'full'));
  end if;
end $$;

-- older records: bookings / rentals that were paid in full before this file have no down payment
update public.payment p set payment_option = 'full'
  from public.booking b
 where p.booking_id = b.booking_id and b.down_payment = 0 and p.payment_option = 'down';
update public.payment p set payment_option = 'full'
  from public.rental_order o
 where p.rental_order_id = o.rental_order_id and o.down_payment = 0 and p.payment_option = 'down';

-- 2. Helper: amount due now for a total and an option ---------------------------------------------
create or replace function public.pay_option_amount(p_total numeric, p_option text) returns numeric
language plpgsql immutable as $$
begin
  if p_option = 'full' then return round(p_total, 2); end if;
  if p_option = 'down' then return round(p_total * 0.5, 2); end if;
  raise exception 'Choose 50%% down payment or full payment.' using errcode = 'P0001';
end $$;
grant execute on function public.pay_option_amount(numeric, text) to anon, authenticated;

-- 3. Book a studio plus add-on equipment: 50% or 100% of studio + add-ons -------------------------
drop function if exists public.create_booking_with_addons(bigint, timestamptz, timestamptz, text, text, text, text, text, text, jsonb);
drop function if exists public.create_booking_with_addons(bigint, timestamptz, timestamptz, text, text, text, text, text, text, jsonb, text);
create function public.create_booking_with_addons(
  p_studio_id bigint, p_start_at timestamptz, p_end_at timestamptz,
  p_first_name text, p_last_name text, p_number text,
  p_payment_method text, p_gcash_reference text default null, p_hold_token text default null,
  p_items jsonb default '[]'::jsonb,
  p_pay_option text default 'down'
) returns table (
  booking_ref text, status text, studio_total numeric, addons_total numeric, total_amount numeric, rental_ref text,
  down_payment numeric, balance_due numeric, pay_option text
)
language plpgsql security definer set search_path = public as $$
declare
  bk record;
  studio numeric := 0;
  addons numeric := 0;
  rref   text;
  dp     numeric;
  opt    text := lower(coalesce(nullif(trim(p_pay_option), ''), 'down'));
begin
  if opt not in ('down', 'full') then
    raise exception 'Choose 50%% down payment or full payment.' using errcode = 'P0001';
  end if;

  select * into bk from public.create_booking(
    p_studio_id, p_start_at, p_end_at, p_first_name, p_last_name, p_number,
    p_payment_method, p_gcash_reference, p_hold_token);
  studio := bk.total_amount;

  if p_items is not null and jsonb_typeof(p_items) = 'array' and jsonb_array_length(p_items) > 0 then
    select o.rental_ref, o.total_amount into rref, addons
      from public.request_rental('Add-on', p_items, bk.booking_ref) o;
  end if;

  -- 50% or 100% of everything booked now; the rest (if any) is the balance paid at the studio
  dp := public.pay_option_amount(studio + coalesce(addons, 0), opt);
  update public.booking set down_payment = dp where booking_id = bk.booking_id;
  update public.payment pay set amount = dp, payment_option = opt
   where pay.booking_id = bk.booking_id and pay.status <> 'Rejected';

  return query select bk.booking_ref::text, bk.status::text, studio, coalesce(addons, 0),
                      studio + coalesce(addons, 0), rref, dp, (studio + coalesce(addons, 0)) - dp, opt;
end $$;
revoke all on function public.create_booking_with_addons(bigint, timestamptz, timestamptz, text, text, text, text, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.create_booking_with_addons(bigint, timestamptz, timestamptz, text, text, text, text, text, text, jsonb, text) to anon, authenticated;

-- 4. Outside rental: 50% or 100% -------------------------------------------------------------------
drop function if exists public.request_outside_rental(jsonb, text, text, text, timestamptz, timestamptz, text, text, text, text, text);
drop function if exists public.request_outside_rental(jsonb, text, text, text, timestamptz, timestamptz, text, text, text, text, text, text);
create function public.request_outside_rental(
  p_items jsonb, p_first_name text, p_last_name text, p_number text,
  p_pickup_date timestamptz, p_return_date timestamptz,
  p_contact_number text, p_backup_contact text, p_id_type text, p_id_image_path text,
  p_gcash_reference text,
  p_pay_option text default 'down'
) returns table (rental_ref text, total_amount numeric, down_payment numeric, pay_option text)
language plpgsql security definer set search_path = public as $$
declare
  r record; total numeric; dp numeric;
  gref text := regexp_replace(coalesce(p_gcash_reference, ''), '\s', '', 'g');
  opt  text := lower(coalesce(nullif(trim(p_pay_option), ''), 'down'));
begin
  if public.current_customer_id() is null then
    raise exception 'Please log in or register to rent equipment outside the studio.' using errcode = 'P0001';
  end if;
  if opt not in ('down', 'full') then
    raise exception 'Choose 50%% down payment or full payment.' using errcode = 'P0001';
  end if;
  if gref !~ '^[0-9]{13}$' then
    raise exception 'Enter the 13-digit GCash reference number of your payment.' using errcode = 'P0001';
  end if;

  perform set_config('app.outside_ok', '1', true);
  select o.rental_order_id, o.rental_ref, o.total_amount into r
    from public.request_rental('Outside', p_items, null, p_first_name, p_last_name, p_number,
                               p_pickup_date, p_return_date, p_contact_number, p_backup_contact,
                               p_id_type, p_id_image_path) o;
  perform set_config('app.outside_ok', '', true);

  total := r.total_amount;
  dp := public.pay_option_amount(total, opt);
  update public.rental_order set down_payment = dp where rental_order_id = r.rental_order_id;
  insert into public.payment (rental_order_id, method, gcash_reference, amount, status, payment_option)
  values (r.rental_order_id, 'GCash', gref, dp, 'Pending', opt);

  return query select r.rental_ref::text, total, dp, opt;
exception when unique_violation then
  raise exception 'That GCash reference number was already used.' using errcode = 'P0001';
end $$;
revoke all on function public.request_outside_rental(jsonb, text, text, text, timestamptz, timestamptz, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.request_outside_rental(jsonb, text, text, text, timestamptz, timestamptz, text, text, text, text, text, text) to authenticated;

-- 5. Add-on rental added to an existing booking later (Rent equipment page): pay 50% or 100% now ---
--    The payment belongs to the add-on order. The booking's balance and the revenue report take it into account.
create or replace function public.request_addon_rental(
  p_booking_ref text, p_items jsonb, p_pay_option text default 'down', p_gcash_reference text default null
) returns table (rental_ref text, total_amount numeric, down_payment numeric, pay_option text)
language plpgsql security definer set search_path = public as $$
declare
  r record; total numeric; dp numeric;
  gref text := regexp_replace(coalesce(p_gcash_reference, ''), '\s', '', 'g');
  opt  text := lower(coalesce(nullif(trim(p_pay_option), ''), 'down'));
begin
  if opt not in ('down', 'full') then
    raise exception 'Choose 50%% down payment or full payment.' using errcode = 'P0001';
  end if;
  if gref !~ '^[0-9]{13}$' then
    raise exception 'Enter the 13-digit GCash reference number of your payment.' using errcode = 'P0001';
  end if;

  select o.rental_order_id, o.rental_ref, o.total_amount into r
    from public.request_rental('Add-on', p_items, p_booking_ref) o;

  total := r.total_amount;
  dp := public.pay_option_amount(total, opt);
  update public.rental_order set down_payment = dp where rental_order_id = r.rental_order_id;
  insert into public.payment (rental_order_id, method, gcash_reference, amount, status, payment_option)
  values (r.rental_order_id, 'GCash', gref, dp, 'Pending', opt);

  return query select r.rental_ref::text, total, dp, opt;
exception when unique_violation then
  raise exception 'That GCash reference number was already used.' using errcode = 'P0001';
end $$;
revoke all on function public.request_addon_rental(text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.request_addon_rental(text, jsonb, text, text) to anon, authenticated;

-- 6. An add-on that has its own payment is not added to the booking payment again -------------------
create or replace function public.sync_booking_payment(p_booking_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.payment p
     set amount = public.booking_total(p_booking_id) + coalesce((
           select sum(d.unit_price_at_request * d.quantity)
             from public.rental_order o
             join public.rental_detail d on d.rental_order_id = o.rental_order_id
            where o.booking_id = p_booking_id and o.rental_type = 'Add-on'
              and o.status not in ('Rejected', 'Cancelled')
              and not exists (select 1 from public.payment q where q.rental_order_id = o.rental_order_id and q.status <> 'Rejected')), 0)
   where p.booking_id = p_booking_id and p.status = 'Pending'
     and not exists (select 1 from public.booking b where b.booking_id = p_booking_id and b.down_payment > 0);
end $$;

-- 7. What the customer already paid for add-on orders of a booking ----------------------------------
create or replace function public.booking_addon_paid(p_booking_id bigint) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(p.amount), 0)::numeric(10,2)
    from public.rental_order o
    join public.payment p on p.rental_order_id = o.rental_order_id and p.status <> 'Rejected'
   where o.booking_id = p_booking_id and o.rental_type = 'Add-on' and o.status not in ('Rejected', 'Cancelled');
$$;
revoke all on function public.booking_addon_paid(bigint) from public, anon, authenticated;
grant execute on function public.booking_addon_paid(bigint) to authenticated;

-- 8. Booking lookup: also returns the payment option and what was paid for later add-ons -------------
create or replace function public.lookup_booking(p_ref text, p_phone text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r record; ad jsonb; ad_total numeric;
begin
  select b.booking_id, b.booking_ref, b.status, b.start_at, b.end_at, s.name as studio_name, s.description as studio_desc,
         public.booking_total(b.booking_id) as total,
         (select p.status from public.payment p where p.booking_id = b.booking_id order by p.payment_id desc limit 1) as payment_status,
         c.number, c.auth_user_id, b.rejected_reason, b.down_payment,
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
    'down_payment', r.down_payment, 'payment_option', coalesce(r.payment_option, 'down'),
    'addons_paid', public.booking_addon_paid(r.booking_id),
    'balance_due', greatest(0, r.total + ad_total - r.down_payment - public.booking_addon_paid(r.booking_id)));
end $$;

-- 9. My bookings / dashboard view: one extra column at the end (payment_option) -------------------------
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
  p.payment_option
from public.booking b
join public.studio s   on s.studio_id = b.studio_id
join public.customer c on c.customer_id = b.customer_id
left join lateral (
  select * from public.payment p where p.booking_id = b.booking_id order by p.payment_id desc limit 1
) p on true;
grant select on public.v_booking_summary to authenticated;

-- 10. Extension view: one extra column at the end -----------------------------------------------------
create or replace view public.v_booking_extension with (security_invoker = true) as
select
  x.extension_id, x.booking_id, b.booking_ref, x.customer_id,
  x.extra_hours, x.hourly_rate, x.extra_cost, x.down_payment, (x.extra_cost - x.down_payment) as balance_due,
  x.old_end_at, x.new_end_at, x.status, x.rejected_reason, x.created_at, x.updated_at,
  p.payment_id, p.status as payment_status, p.method as payment_method, p.gcash_reference,
  p.payment_option
from public.booking_extension x
join public.booking b on b.booking_id = x.booking_id
left join lateral (
  select * from public.payment p where p.extension_id = x.extension_id order by p.payment_id desc limit 1
) p on true;
grant select on public.v_booking_extension to authenticated;

-- 11. Payments tab: shows whether a payment is a 50% down payment or a full payment --------------------
create or replace view public.v_payment_queue with (security_invoker = true) as
select
  p.payment_id, p.status, p.method, p.gcash_reference, p.amount, p.created_at, p.verified_at,
  coalesce(b.booking_ref, o.rental_ref, xb.booking_ref) as reference,
  case when p.booking_id is not null then 'Booking'
       when p.extension_id is not null then 'Extension'
       else 'Rental' end as kind,
  trim(c.first_name || ' ' || c.last_name) as customer_name,
  p.extension_id,
  p.payment_option
from public.payment p
left join public.booking b on b.booking_id = p.booking_id
left join public.rental_order o on o.rental_order_id = p.rental_order_id
left join public.booking_extension x on x.extension_id = p.extension_id
left join public.booking xb on xb.booking_id = x.booking_id
join public.customer c on c.customer_id = coalesce(b.customer_id, o.customer_id, xb.customer_id);
grant select on public.v_payment_queue to authenticated;

-- 12. Extend a session: 50% or 100% of the extra cost ---------------------------------------------------
drop function if exists public.customer_request_extension(text, integer, text, text);
drop function if exists public.customer_request_extension(text, integer, text, text, text);
create function public.customer_request_extension(
  p_booking_ref text, p_extra_hours integer, p_token text, p_gcash_reference text,
  p_pay_option text default 'down'
) returns table (extension_id bigint, booking_ref text, new_end_at timestamptz, extra_cost numeric, down_payment numeric, balance_due numeric, pay_option text)
language plpgsql security definer set search_path = public as $$
declare
  cid bigint := public.current_customer_id();
  b public.booking; info record; x public.booking_extension;
  cost numeric; dp numeric; tok text;
  gref text := regexp_replace(coalesce(p_gcash_reference, ''), '\s', '', 'g');
  opt text := lower(coalesce(nullif(trim(p_pay_option), ''), 'down'));
begin
  if opt not in ('down', 'full') then
    raise exception 'Choose 50%% down payment or full payment.' using errcode = 'P0001';
  end if;
  if cid is null then raise exception 'Please log in to extend your booking.' using errcode = 'P0001'; end if;
  if p_extra_hours is null or p_extra_hours < 1 or p_extra_hours > 4 then
    raise exception 'Choose 1 to 4 extra hours.' using errcode = 'P0001';
  end if;
  if gref !~ '^[0-9]{13}$' then
    raise exception 'Enter the 13-digit GCash reference number of your payment.' using errcode = 'P0001';
  end if;

  select * into b from public.booking bk where bk.booking_ref = upper(trim(p_booking_ref)) for update;
  if not found or b.customer_id is distinct from cid then
    raise exception 'That is not your booking.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('studio:' || b.studio_id, 0));

  if exists (select 1 from public.booking_extension e where e.booking_id = b.booking_id and e.status = 'Pending') then
    raise exception 'You already have an extension request waiting for staff to verify its payment.' using errcode = 'P0001';
  end if;

  -- the customer's own open Extend window (p_token) does not block the hours
  select * into info from public.staff_extension_info(b.booking_ref, p_token);
  if info.max_hours < info.min_hours then raise exception '%', info.message using errcode = 'P0001'; end if;
  if p_extra_hours > info.max_hours then
    raise exception '%', coalesce(info.message, 'Cannot extend: that time is not free.') using errcode = 'P0001';
  end if;
  if p_extra_hours < info.min_hours then
    raise exception 'The session is already past its end time. Extend by at least % hour(s).', info.min_hours using errcode = 'P0001';
  end if;

  cost := round(b.hourly_rate_at_booking * p_extra_hours, 2);
  dp   := public.pay_option_amount(cost, opt);
  tok  := 'e' || replace(gen_random_uuid()::text, '-', '');

  insert into public.booking_extension (booking_id, customer_id, extra_hours, hourly_rate, extra_cost, down_payment,
                                        old_end_at, new_end_at, hold_token)
  values (b.booking_id, cid, p_extra_hours, b.hourly_rate_at_booking, cost, dp,
          b.end_at, b.end_at + make_interval(hours => p_extra_hours), tok)
  returning * into x;

  insert into public.payment (extension_id, method, gcash_reference, amount, status, payment_option)
  values (x.extension_id, 'GCash', gref, dp, 'Pending', opt);

  -- reserve the extra hours until staff decide (an ordinary hold: nobody else can book or extend them)
  delete from public.slot_hold where expires_at < now() or token = p_token;
  insert into public.slot_hold (studio_id, start_at, end_at, token, expires_at, held_by_staff)
  values (b.studio_id, x.old_end_at, x.new_end_at, tok, x.new_end_at, false);

  return query select x.extension_id, b.booking_ref::text, x.new_end_at, cost, dp, cost - dp, opt;
exception when unique_violation then
  raise exception 'That GCash reference number was already used.' using errcode = 'P0001';
end $$;
revoke all on function public.customer_request_extension(text, integer, text, text, text) from public, anon, authenticated;
grant execute on function public.customer_request_extension(text, integer, text, text, text) to authenticated;

-- 13. Revenue report: a full payment leaves no balance to count later; add-on payments are not counted twice --
drop view if exists public.v_revenue_daily;
create view public.v_revenue_daily with (security_invoker = true) as
select day, kind, studio_name, sum(amount) as amount, count(*) as payments
from (
  -- studio part of a booking payment (the down payment, or the full payment of older/walk-in bookings)
  select (coalesce(p.verified_at, p.created_at) at time zone 'Asia/Manila')::date as day,
         'Studio'::text as kind, s.name::varchar(100) as studio_name,
         least(p.amount, public.booking_total(b.booking_id)) as amount
    from public.payment p
    join public.booking b on b.booking_id = p.booking_id
    join public.studio  s on s.studio_id  = b.studio_id
   where p.status = 'Verified'
  union all
  -- add-on equipment paid together with the booking
  select (coalesce(p.verified_at, p.created_at) at time zone 'Asia/Manila')::date,
         'Equipment'::text, null::varchar(100),
         p.amount - public.booking_total(b.booking_id)
    from public.payment p
    join public.booking b on b.booking_id = p.booking_id
   where p.status = 'Verified' and p.amount > public.booking_total(b.booking_id)
  union all
  -- the studio balance of a booking with a down payment, collected when the session starts
  select (b.actual_start_at at time zone 'Asia/Manila')::date,
         'Studio'::text, s.name::varchar(100),
         public.booking_total(b.booking_id) - least(b.down_payment, public.booking_total(b.booking_id))
    from public.booking b
    join public.studio s on s.studio_id = b.studio_id
   where b.down_payment > 0 and b.status in ('In Progress', 'Completed') and b.actual_start_at is not null
     and exists (select 1 from public.payment p where p.booking_id = b.booking_id and p.status = 'Verified')
     and public.booking_total(b.booking_id) - least(b.down_payment, public.booking_total(b.booking_id)) > 0
  union all
  -- the add-on equipment balance of a booking with a down payment, collected when the session starts
  select (b.actual_start_at at time zone 'Asia/Manila')::date,
         'Equipment'::text, null::varchar(100),
         public.booking_addons_total(b.booking_id) - greatest(b.down_payment - public.booking_total(b.booking_id), 0)
           - public.booking_addon_paid(b.booking_id)
    from public.booking b
   where b.down_payment > 0 and b.status in ('In Progress', 'Completed') and b.actual_start_at is not null
     and exists (select 1 from public.payment p where p.booking_id = b.booking_id and p.status = 'Verified')
     and public.booking_addons_total(b.booking_id) - greatest(b.down_payment - public.booking_total(b.booking_id), 0)
         - public.booking_addon_paid(b.booking_id) > 0
  union all
  -- NEW: down payments of verified session extensions (the extra cost itself is in the booking total)
  select (coalesce(p.verified_at, p.created_at) at time zone 'Asia/Manila')::date,
         'Studio'::text, s.name::varchar(100), p.amount
    from public.payment p
    join public.booking_extension x on x.extension_id = p.extension_id
    join public.booking b on b.booking_id = x.booking_id
    join public.studio  s on s.studio_id  = b.studio_id
   where p.status = 'Verified'
  union all
  -- rental payments (outside rental down payments, onsite rentals)
  select (coalesce(p.verified_at, p.created_at) at time zone 'Asia/Manila')::date,
         'Equipment'::text, null::varchar(100), p.amount
    from public.payment p
   where p.status = 'Verified' and p.rental_order_id is not null
  union all
  -- the balance of an online outside rental (nothing when it was paid in full), collected when the equipment is issued
  select (o.issued_at at time zone 'Asia/Manila')::date,
         'Equipment'::text, null::varchar(100),
         public.rental_order_total(o.rental_order_id) - o.down_payment
    from public.rental_order o
   where o.rental_type = 'Outside' and o.down_payment > 0 and o.status in ('Active', 'Returned') and o.issued_at is not null
     and public.rental_order_total(o.rental_order_id) - o.down_payment > 0
  union all
  -- late fees collected when the equipment is returned
  select (d.returned_at at time zone 'Asia/Manila')::date,
         'Equipment'::text, null::varchar(100), d.late_fee
    from public.rental_detail d
   where d.late_fee > 0
) x
group by day, kind, studio_name;

grant select on public.v_revenue_daily to authenticated;
