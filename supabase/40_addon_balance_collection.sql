-- =====================================================================
-- 40_addon_balance_collection.sql  (safe to re-run)
-- Add-on equipment added LATER and paid with a 50% down payment:
--   * its payment stays a DOWN PAYMENT (not fully paid) until staff collect the rest at the studio
--   * the add-on is NOT issued (In Use) until that balance is collected, also when the session is already running
--   * staff collect it with "Collect balance & issue" (Rentals tab); the payment then becomes fully paid
--   * starting the studio session collects it too, in one step with the booking balance (each payment is marked fully paid)
-- Run this once in the Supabase SQL Editor (after 39_addon_auto_issue_return.sql).
-- =====================================================================

-- 1. What was paid for the later add-ons: the online payment PLUS the balance staff collected ---------------
create or replace function public.booking_addon_paid(p_booking_id bigint) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(p.amount + p.balance_paid_amount), 0)::numeric(10,2)
    from public.rental_order o
    join public.payment p on p.rental_order_id = o.rental_order_id and p.status <> 'Rejected'
   where o.booking_id = p_booking_id and o.rental_type = 'Add-on' and o.status not in ('Rejected', 'Cancelled');
$$;
revoke all on function public.booking_addon_paid(bigint) from public, anon, authenticated;
grant execute on function public.booking_addon_paid(bigint) to authenticated;

-- 2. The balance of ONE order: outside rentals, and add-ons that have their own down payment ---------------------
--    (add-ons ordered together with the booking are paid with the booking, so their balance is the booking's)
create or replace function public.rental_balance_due(p_rental_order_id bigint) returns numeric
language sql stable security definer set search_path = public as $$
  select case
    when coalesce(o.down_payment, 0) <= 0 then 0::numeric
    else greatest(0, public.rental_order_total(o.rental_order_id) - o.down_payment
                     - coalesce((select p.balance_paid_amount from public.payment p
                                  where p.rental_order_id = o.rental_order_id and p.status <> 'Rejected'
                                  order by p.payment_id desc limit 1), 0))::numeric(10,2)
  end
  from public.rental_order o where o.rental_order_id = p_rental_order_id;
$$;
revoke all on function public.rental_balance_due(bigint) from public, anon;
grant execute on function public.rental_balance_due(bigint) to authenticated;

-- 3. Collect the balance (booking: studio + add-on rests, each recorded on its own payment; rental / add-on: its own) --
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

    -- the add-on orders the customer paid 50% for later: their rest is recorded on THEIR payment (it becomes fully paid)
    for ap in
      select p2.payment_id, greatest(0, public.rental_order_total(o2.rental_order_id) - coalesce(o2.down_payment, 0) - p2.balance_paid_amount) as rest
        from public.rental_order o2
        join public.payment p2 on p2.rental_order_id = o2.rental_order_id and p2.status <> 'Rejected'
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
    if bal - addon_part > 0.005 then
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

-- 4. Guard: an add-on with a balance cannot be issued without collecting it (like outside rentals) ----------------
create or replace function public.guard_rental_balance() returns trigger
language plpgsql security definer set search_path = public as $$
declare bal numeric;
begin
  if new.status = 'Active' and old.status is distinct from 'Active' and coalesce(new.down_payment, 0) > 0 then
    bal := public.rental_balance_due(new.rental_order_id);
    if bal > 0.005 then
      raise exception 'The remaining balance of PHP % has not been collected yet. Use Collect balance & issue on the admin page and confirm the payment first.',
        to_char(bal, 'FM999,999,990.00') using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_rental_balance_guard on public.rental_order;
create trigger trg_rental_balance_guard before update of status on public.rental_order
  for each row execute function public.guard_rental_balance();

-- 5. An add-on approved while the session is running is issued by itself ONLY when nothing is left to collect ------
create or replace function public.rental_addon_inprogress() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'Approved' and old.status is distinct from 'Approved' and new.rental_type = 'Add-on' and new.booking_id is not null
     and exists (select 1 from public.booking b where b.booking_id = new.booking_id and b.status = 'In Progress')
     and public.rental_balance_due(new.rental_order_id) <= 0.005 then
    new.status := 'Active';
  end if;
  return new;
end $$;
drop trigger if exists aa_rental_addon_inprogress on public.rental_order;
create trigger aa_rental_addon_inprogress before update of status on public.rental_order
  for each row execute function public.rental_addon_inprogress();

-- 6. sync_addon_orders (from 39): issue only add-ons without a balance left -----------------------------------------
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

  -- b. the session is running: approved add-ons with nothing left to collect are issued (In Use)
  for o in
    select ro.rental_order_id from public.rental_order ro
      join public.booking b on b.booking_id = ro.booking_id
     where ro.rental_type = 'Add-on' and ro.status = 'Approved' and b.status = 'In Progress'
       and (p_booking_id is null or ro.booking_id = p_booking_id)
       and public.rental_balance_due(ro.rental_order_id) <= 0.005
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

-- 7. Catch-up --------------------------------------------------------------------------------------------------------
select public.sync_addon_orders(null);
