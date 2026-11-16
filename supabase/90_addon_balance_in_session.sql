-- =====================================================================
-- 90_addon_balance_in_session.sql  (safe to re-run)
-- Equipment added to a session that is ALREADY RUNNING can be paid AFTER the session, exactly like the extra hours of an
-- extension.
--   Before (file 50): equipment added while the session was running had to be paid in full with GCash first.
--   Now:      * the customer (online) or staff (onsite) can add equipment to an In Progress session with NOTHING paid now
--             * the equipment is handed out / marked In Use right away (nothing to verify: no payment was sent)
--             * its price becomes a BALANCE of the booking: the Payment column shows "Balance P...", the customer sees it
--               on the booking, and staff collect it with "Collect balance & complete" (file 85) when the session ends,
--               Cash (amount tendered, change) or GCash (13-digit reference). The balance is then recorded as fully paid.
--             * like an extension balance, a session that owes it is never completed by itself (file 86)
--             * paying in full online is still possible (file 50 / 89 are unchanged)
--   How it is stored: rental_order.balance_deferred = true (down_payment stays 0) and one payment row of PHP 0.00
--   (Verified, Cash). That row is where the balance staff collect is recorded, the same place file 40 uses for the
--   balance of a 50% add-on.
-- Run this once in the Supabase SQL Editor (after 89_equipment_checkout_hold.sql). No Edge Function change.
-- =====================================================================

-- 1. The flag --------------------------------------------------------------------------------------------------------
alter table public.rental_order add column if not exists balance_deferred boolean not null default false;

-- 2. Balance of ONE order: also an add-on whose whole price is left for the end of the session ------------------------
create or replace function public.rental_balance_due(p_rental_order_id bigint) returns numeric
language sql stable security definer set search_path = public as $$
  select case
    when coalesce(o.down_payment, 0) <= 0 and not o.balance_deferred then 0::numeric
    else greatest(0, public.rental_order_total(o.rental_order_id) - coalesce(o.down_payment, 0)
                     - coalesce((select p.balance_paid_amount from public.payment p
                                  where p.rental_order_id = o.rental_order_id and p.status <> 'Rejected'
                                  order by p.payment_id desc limit 1), 0))::numeric(10,2)
  end
  from public.rental_order o where o.rental_order_id = p_rental_order_id;
$$;
revoke all on function public.rental_balance_due(bigint) from public, anon;
grant execute on function public.rental_balance_due(bigint) to authenticated;

-- 3. Balance of a booking (file 45) + deferred add-ons on a booking that was paid in full ----------------------------
--    (a booking with a down payment already counts every add-on price that was not paid: nothing to change there)
create or replace function public.booking_balance_due(p_booking_id bigint) returns numeric
language sql stable security definer set search_path = public as $$
  select case
    when coalesce(b.down_payment, 0) <= 0 then
      coalesce((select sum(public.rental_balance_due(o.rental_order_id))
                  from public.rental_order o
                 where o.booking_id = b.booking_id and o.rental_type = 'Add-on'
                   and o.status not in ('Rejected', 'Cancelled')
                   and (coalesce(o.down_payment, 0) > 0 or o.balance_deferred)
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

-- 4. Collecting the balance (file 85) also settles the deferred add-ons --------------------------------------------
create or replace function public.staff_collect_balance(
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
    if b.status <> 'Approved' and not (b.status = 'In Progress' and not coalesce(p_start, true)) then
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

    -- add-on orders with their own balance (50% paid, or NEW (90): added during the session and paid at the end):
    -- the rest is recorded on THEIR payment (it becomes fully paid)
    for ap in
      select p2.payment_id, greatest(0, public.rental_order_total(o2.rental_order_id) - coalesce(o2.down_payment, 0) - p2.balance_paid_amount) as rest
        from public.rental_order o2
        join public.payment p2 on p2.rental_order_id = o2.rental_order_id and p2.status = 'Verified'
       where o2.booking_id = b.booking_id and o2.rental_type = 'Add-on' and o2.status not in ('Rejected', 'Cancelled')
         and (coalesce(o2.down_payment, 0) > 0 or o2.balance_deferred)
    loop
      if ap.rest > 0.005 then
        update public.payment
           set balance_paid_amount = balance_paid_amount + ap.rest,
               balance_paid_at     = now(),
               balance_paid_by     = public.current_app_user_id(),
               balance_paid_method = m,
               payment_option      = 'full',
               balance_email_sent_at = null
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
             payment_option      = 'full',
             balance_email_sent_at = null
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
             payment_option      = 'full',
             balance_email_sent_at = null
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

-- 5. A deferred add-on of a running session is issued at once (no balance to wait for) ------------------------------
create or replace function public.rental_addon_inprogress() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'Approved' and old.status is distinct from 'Approved' and new.rental_type = 'Add-on' and new.booking_id is not null
     and exists (select 1 from public.booking b where b.booking_id = new.booking_id and b.status = 'In Progress')
     and (new.balance_deferred or public.rental_balance_due(new.rental_order_id) <= 0.005) then
    new.status := 'Active';
  end if;
  return new;
end $$;
drop trigger if exists aa_rental_addon_inprogress on public.rental_order;
create trigger aa_rental_addon_inprogress before update of status on public.rental_order
  for each row execute function public.rental_addon_inprogress();

-- 6. sync_addon_orders (file 40): approved deferred add-ons of a running session are issued too ----------------------
create or replace function public.sync_addon_orders(p_booking_id bigint default null) returns integer
language plpgsql security definer set search_path = public as $$
declare o record; n integer := 0;
begin
  -- a. a Pending add-on whose own payment was verified is approved (booking must still be Confirmed or Active)
  for o in
    select ro.rental_order_id from public.rental_order ro
      join public.booking b on b.booking_id = ro.booking_id
     where ro.rental_type = 'Add-on' and ro.status = 'Pending'
       and b.status in ('Approved', 'In Progress')
       and (p_booking_id is null or ro.booking_id = p_booking_id)
       and exists (select 1 from public.payment p where p.rental_order_id = ro.rental_order_id and p.status = 'Verified')
  loop
    begin
      update public.rental_order set status = 'Approved' where rental_order_id = o.rental_order_id;
      n := n + 1;
    exception when others then null;
    end;
  end loop;

  -- b. the session is running: approved add-ons with nothing left to collect (or paid at the end of the session) are issued
  for o in
    select ro.rental_order_id from public.rental_order ro
      join public.booking b on b.booking_id = ro.booking_id
     where ro.rental_type = 'Add-on' and ro.status = 'Approved' and b.status = 'In Progress'
       and (p_booking_id is null or ro.booking_id = p_booking_id)
       and (ro.balance_deferred or public.rental_balance_due(ro.rental_order_id) <= 0.005)
  loop
    begin
      update public.rental_order set status = 'Active' where rental_order_id = o.rental_order_id;
      n := n + 1;
    exception when others then null;
    end;
  end loop;

  -- c. the session is completed: add-ons that were issued (or approved) are returned
  update public.rental_order ro set status = 'Returned'
    from public.booking b
   where b.booking_id = ro.booking_id and b.status = 'Completed'
     and ro.rental_type = 'Add-on' and ro.status in ('Approved', 'Active')
     and (p_booking_id is null or ro.booking_id = p_booking_id);

  -- d. an add-on that was never verified, on a booking that is over, is closed
  update public.rental_order ro set status = 'Cancelled'
    from public.booking b
   where b.booking_id = ro.booking_id and b.status in ('Completed', 'Cancelled', 'Rejected')
     and ro.rental_type = 'Add-on' and ro.status = 'Pending'
     and (p_booking_id is null or ro.booking_id = p_booking_id);

  return n;
end $$;
revoke all on function public.sync_addon_orders(bigint) from public, anon;
grant execute on function public.sync_addon_orders(bigint) to authenticated;

-- 7. Customer: add equipment to a RUNNING session and pay for it after the session ------------------------------------
create or replace function public.request_addon_rental_later(
  p_booking_ref text, p_items jsonb, p_hold_token text default null
) returns table (rental_ref text, total_amount numeric, down_payment numeric, pay_option text)
language plpgsql security definer set search_path = public as $$
declare
  r record; mail text; bk public.booking; ro public.rental_order;
begin
  select * into bk from public.booking
   where booking_ref = upper(regexp_replace(coalesce(p_booking_ref, ''), '\s', '', 'g')) for update;
  if not found then raise exception 'Booking reference not found.' using errcode = 'P0001'; end if;
  if bk.status <> 'In Progress' then
    raise exception 'Paying after the session is only for a session that is running now. Pay with GCash instead.' using errcode = 'P0001';
  end if;

  perform set_config('app.eq_hold_token', coalesce(p_hold_token, ''), true);
  select o.rental_order_id, o.rental_ref, o.total_amount into r
    from public.request_rental('Add-on', p_items, p_booking_ref) o;     -- checks ownership, stock for the session's hours
  perform set_config('app.eq_hold_token', '', true);

  select coalesce(public.current_account_email(), b.receipt_email) into mail
    from public.booking b where b.booking_id = bk.booking_id;

  update public.rental_order set balance_deferred = true, down_payment = 0, receipt_email = mail
   where rental_order_id = r.rental_order_id;
  -- nothing is paid now: PHP 0.00 payment row (the balance staff collect later is recorded on it)
  insert into public.payment (rental_order_id, method, gcash_reference, amount, status, payment_option)
  values (r.rental_order_id, 'Cash', null, 0, 'Verified', 'down');

  -- nothing to verify: approve it, the trigger issues it (In Use) because the session is running
  update public.rental_order set status = 'Approved' where rental_order_id = r.rental_order_id;

  return query select r.rental_ref::text, r.total_amount, 0::numeric, 'later'::text;
end $$;
revoke all on function public.request_addon_rental_later(text, jsonb, text) from public, anon, authenticated;
grant execute on function public.request_addon_rental_later(text, jsonb, text) to anon, authenticated;

-- 8. Staff: record equipment for a RUNNING session with the payment left for the end of the session -------------------
drop function if exists public.staff_create_onsite_rental(text, jsonb, text, text, text, text, timestamptz, text, boolean, text, text, timestamptz, text);

create or replace function public.staff_create_onsite_rental(
  p_type text, p_items jsonb,
  p_booking_ref text default null,
  p_first_name text default null, p_last_name text default null, p_number text default null,
  p_return_date timestamptz default null, p_id_type text default null, p_id_checked boolean default false,
  p_payment_method text default 'Cash', p_gcash_reference text default null,
  p_pickup_date timestamptz default null,
  p_pay_option text default 'full',
  p_pay_later boolean default false          -- NEW (90): add-on for a running session, paid with the balance at the end
) returns table (rental_order_id bigint, rental_ref text, total_amount numeric)
language plpgsql security definer set search_path = public as $$
declare
  o public.rental_order; bk public.booking; cid bigint; staff_id bigint := public.current_app_user_id();
  it jsonb; eq public.equipment; qty int; rate numeric; hrs numeric; pick timestamptz := coalesce(p_pickup_date, now());
  total numeric; st text := 'Approved'; dp numeric := 0; paid numeric;
  later boolean := coalesce(p_pay_later, false);
  pm text := p_payment_method; gref text := p_gcash_reference;
begin
  if staff_id is null then raise exception 'Staff only.' using errcode = '42501'; end if;
  if p_type not in ('Add-on', 'Outside') then raise exception 'Choose Add-on or Outside.' using errcode = 'P0001'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one item.' using errcode = 'P0001';
  end if;
  if later and p_type <> 'Add-on' then
    raise exception 'Paying after the session is only for add-on equipment of a running session.' using errcode = 'P0001';
  end if;
  if later then
    pm := 'Cash'; gref := null;               -- nothing is received now
  end if;
  if pm not in ('GCash', 'Cash') then raise exception 'Choose GCash or Cash.' using errcode = 'P0001'; end if;
  if p_pay_option not in ('full', 'down') then raise exception 'Choose full payment or 50%% down payment.' using errcode = 'P0001'; end if;
  -- a 50% down payment is only for an OUTSIDE rental that is picked up on a later day (the rest is collected at pick-up)
  if p_pay_option = 'down' then
    if p_type <> 'Outside' then raise exception 'A down payment is only for outside rentals.' using errcode = 'P0001'; end if;
    if (pick at time zone 'Asia/Manila')::date <= (now() at time zone 'Asia/Manila')::date then
      raise exception 'A 50%% down payment is only for a pick-up on a later day. Today''s rentals are paid in full.' using errcode = 'P0001';
    end if;
  end if;
  -- the GCash reference is REQUIRED when the payment is GCash: exactly 13 digits (same rule as online payments)
  if pm = 'GCash' and regexp_replace(coalesce(gref, ''), '\s', '', 'g') !~ '^[0-9]{13}$' then
    raise exception 'Enter the 13-digit GCash reference number.' using errcode = 'P0001';
  end if;

  if p_type = 'Add-on' then
    select * into bk from public.booking where booking_ref = upper(regexp_replace(coalesce(p_booking_ref, ''), '\s', '', 'g'));
    if not found then raise exception 'Choose a confirmed booking.' using errcode = 'P0001'; end if;
    if bk.status not in ('Approved', 'In Progress') then
      raise exception 'Add-ons need a confirmed or active booking. This one is %.', bk.status using errcode = 'P0001';
    end if;
    if later and bk.status <> 'In Progress' then
      raise exception 'Paying at the end of the session is only for a session that is running now (Active).' using errcode = 'P0001';
    end if;
    cid := bk.customer_id;
    if bk.status = 'In Progress' then st := 'Active'; end if;      -- the session is already running
  else
    if p_return_date is null or p_return_date <= pick then raise exception 'The return time must be after the start time.' using errcode = 'P0001'; end if;
    if nullif(trim(coalesce(p_id_type, '')), '') is null then raise exception 'Choose the ID type.' using errcode = 'P0001'; end if;
    if not coalesce(p_id_checked, false) then raise exception 'Confirm that you checked a valid ID in person.' using errcode = 'P0001'; end if;
    cid := public.resolve_customer(p_first_name, p_last_name, p_number, true);
  end if;

  insert into public.rental_order (rental_ref, customer_id, rental_type, booking_id, status, source,
                                   approved_by, created_by, pickup_date, return_date, contact_number, id_type, balance_deferred)
  values ('', cid, p_type, bk.booking_id, st, 'Onsite', staff_id, staff_id,
          case when p_type = 'Outside' then pick end, p_return_date, nullif(trim(p_number), ''), nullif(trim(p_id_type), ''), later)
  returning * into o;

  for it in select * from jsonb_array_elements(p_items) loop
    qty := (it ->> 'quantity')::int;
    select * into eq from public.equipment where equipment_id = (it ->> 'equipment_id')::bigint;
    if not found then raise exception 'Equipment not found.' using errcode = 'P0001'; end if;
    if qty is null or qty < 1 then raise exception 'Quantity must be at least 1.' using errcode = 'P0001'; end if;

    if p_type = 'Add-on' then
      if not eq.allow_addon then raise exception '% cannot be rented as an add-on.', eq.name using errcode = 'P0001'; end if;
      rate := eq.add_on_rate; hrs := null;
    else
      if not eq.allow_outside then raise exception '% cannot be rented outside the studio.', eq.name using errcode = 'P0001'; end if;
      rate := eq.outside_rate; hrs := round(extract(epoch from (p_return_date - pick)) / 3600.0, 2);
    end if;

    -- the stock trigger runs here and rejects the row if there isn't enough
    insert into public.rental_detail (rental_order_id, equipment_id, quantity, unit_price_at_request, rental_hours)
    values (o.rental_order_id, eq.equipment_id, qty, rate, hrs);
  end loop;

  total := public.rental_order_total(o.rental_order_id);
  paid := total;
  if later then
    paid := 0;                                                   -- the whole price is the booking's balance
  elsif p_pay_option = 'down' then
    dp := public.pay_option_amount(total, 'down');
    paid := dp;
    update public.rental_order ro set down_payment = dp where ro.rental_order_id = o.rental_order_id;   -- the balance is collected at pick-up
  end if;
  insert into public.payment (rental_order_id, method, gcash_reference, amount, status, verified_by, verified_at, payment_option)
  values (o.rental_order_id, pm, nullif(trim(gref), ''), paid, 'Verified', staff_id, now(),
          case when later then 'down' else p_pay_option end);

  return query select o.rental_order_id, o.rental_ref::text, total;
exception when unique_violation then
  raise exception 'Each item can only be listed once, or that GCash reference was already used.' using errcode = 'P0001';
end $$;
revoke all on function public.staff_create_onsite_rental(text, jsonb, text, text, text, text, timestamptz, text, boolean, text, text, timestamptz, text, boolean) from public, anon;
grant execute on function public.staff_create_onsite_rental(text, jsonb, text, text, text, text, timestamptz, text, boolean, text, text, timestamptz, text, boolean) to authenticated;

-- 9. Catch-up ---------------------------------------------------------------------------------------------------------
select public.sync_addon_orders(null);

-- end of 90_addon_balance_in_session.sql
