-- =====================================================================
-- 45_addon_balance_on_booking.sql  (safe to re-run)
-- A booking must show the balance of its add-on equipment.
--   Problem: a booking paid IN FULL at the studio (down_payment = 0) kept showing "Fully Paid" even after the
--            customer added equipment later with a 50% payment (guest or account) and staff verified it.
--   Now:     * booking_balance_due() also counts the balance of add-on orders that have their own down payment,
--              so v_booking_summary.balance_due, the Bookings tab ("Balance PHP x") and Studio sessions agree
--              with the Rentals tab
--            * starting the session ("Collect balance & start") collects it, together with any booking balance
--            * staff_collect_balance(): only add-ons whose payment staff VERIFIED are collected
--            * the "balance not collected" guard on starting a session now also covers this balance
--            * lookup_booking() also returns 'addon_balance', so the customer (guest lookup / receipt) sees what is left to pay
-- Run this once in the Supabase SQL Editor (after 44_onsite_booking_down_payment.sql).
-- =====================================================================

-- 1. The balance of a booking: its own balance + the balance of add-ons that have their own down payment ----------
create or replace function public.booking_balance_due(p_booking_id bigint) returns numeric
language sql stable security definer set search_path = public as $$
  select case
    when coalesce(b.down_payment, 0) <= 0 then
      -- booking paid in full: only add-ons added later with their own (verified) down payment can leave a balance
      coalesce((select sum(public.rental_balance_due(o.rental_order_id))
                  from public.rental_order o
                 where o.booking_id = b.booking_id and o.rental_type = 'Add-on'
                   and o.status not in ('Rejected', 'Cancelled') and coalesce(o.down_payment, 0) > 0
                   and exists (select 1 from public.payment q
                                where q.rental_order_id = o.rental_order_id and q.status = 'Verified')), 0)::numeric(10,2)
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

-- 2. Collect the balance (same as 40, but a booking collects only VERIFIED add-on payments) -----------------------
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
  addon_part numeric := 0;
  ap  record;
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

    -- add-on orders the customer paid 50% for later: their rest is recorded on THEIR payment (it becomes fully paid)
    for ap in
      select p2.payment_id, greatest(0, public.rental_order_total(o2.rental_order_id) - coalesce(o2.down_payment, 0) - p2.balance_paid_amount) as rest
        from public.rental_order o2
        join public.payment p2 on p2.rental_order_id = o2.rental_order_id and p2.status = 'Verified'
       where o2.booking_id = b.booking_id and o2.rental_type = 'Add-on' and o2.status not in ('Rejected', 'Cancelled')
         and coalesce(o2.down_payment, 0) > 0
    loop
      if ap.rest > 0.005 then
        update public.payment
           set balance_paid_amount = balance_paid_amount + ap.rest,
               balance_paid_at     = now(),
               balance_paid_by     = public.current_app_user_id(),
               balance_paid_method = m,
               payment_option      = 'full'
         where payment_id = ap.payment_id;
        addon_part := addon_part + ap.rest;
      end if;
    end loop;

    -- what is left is the studio session (and add-ons ordered with the booking): recorded on the booking's payment
    if bal - addon_part > 0.005 and pay.payment_id is not null then
      update public.payment
         set balance_paid_amount = balance_paid_amount + (bal - addon_part),
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

-- 3. Guard: a session cannot start while ANY balance of the booking (also a later add-on's) is uncollected ----------
create or replace function public.guard_booking_balance() returns trigger
language plpgsql security definer set search_path = public as $$
declare bal numeric;
begin
  if new.status = 'In Progress' and old.status is distinct from 'In Progress' then
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

-- 4. Booking lookup (guests and My Bookings): also returns the balance of add-ons added later ------------------------
-- (same as 32, plus the key 'addon_balance'; it is 0 unless the booking was paid in full and an add-on still has a balance)
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
    'balance_due', greatest(0, r.total + ad_total - r.down_payment - public.booking_addon_paid(r.booking_id) - coalesce(r.balance_paid, 0)),
    -- NEW (45): booking paid in full, but equipment added later still has a balance to pay at the studio
    'addon_balance', case when coalesce(r.down_payment, 0) <= 0 then public.booking_balance_due(r.booking_id) else 0 end);
end $$;

-- 5. Catch-up ---------------------------------------------------------------------------------------------------------
select public.sync_addon_orders(null);

-- end of 45_addon_balance_on_booking.sql
