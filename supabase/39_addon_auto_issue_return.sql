-- =====================================================================
-- 39_addon_auto_issue_return.sql  (safe to re-run)
-- Add-on equipment follows its studio session, even when it was added LATER (Rent equipment page):
--   * session starts (Start session)  -> add-on is issued by itself (Approved -> In Use)
--   * session completed               -> add-on is returned by itself (In Use -> Returned)
-- Why this file: the old triggers only handled add-ons that were already Approved, and they ignored
-- any error without trying again. Now one function (sync_addon_orders) does the work, it runs
--   - right when the booking changes to In Progress / Completed,
--   - and again every time the dashboard checks for due sessions (every 30 seconds),
-- so an add-on that was missed (for example it was verified a moment after the session started) is caught up.
-- Also:
--   * an add-on whose own payment is already Verified but is still Pending is approved
--   * a still-Pending add-on (its payment was never verified) of a booking that ended is Cancelled,
--     so it does not stay in the Rentals list forever
-- Run this once in the Supabase SQL Editor (after 38_gcash_screenshots.sql).
-- =====================================================================

-- 1. The one function that keeps add-ons in step with their booking -----------------------------------
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
    exception when others then null;   -- for example not enough stock: it is tried again on the next check
    end;
  end loop;

  -- b. the session is running: approved add-ons are issued (In Use)
  for o in
    select ro.rental_order_id from public.rental_order ro
      join public.booking b on b.booking_id = ro.booking_id
     where ro.rental_type = 'Add-on' and ro.status = 'Approved' and b.status = 'In Progress'
       and (p_booking_id is null or ro.booking_id = p_booking_id)
  loop
    begin
      update public.rental_order set status = 'Active' where rental_order_id = o.rental_order_id;
      n := n + 1;
    exception when others then null;
    end;
  end loop;

  -- c. the session is completed: add-ons that were issued (or approved) are returned; every item comes back to stock
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

-- 2. The booking triggers use it -----------------------------------------------------------------------
create or replace function public.booking_started_addons() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'In Progress' and old.status is distinct from 'In Progress' then
    perform public.sync_addon_orders(new.booking_id);
  end if;
  return null;
end $$;
drop trigger if exists trg_booking_started_addons on public.booking;
create trigger trg_booking_started_addons after update of status on public.booking
  for each row execute function public.booking_started_addons();

create or replace function public.booking_completed_addons() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'Completed' and old.status is distinct from 'Completed' then
    perform public.sync_addon_orders(new.booking_id);
  end if;
  return null;
end $$;
drop trigger if exists trg_booking_completed_addons on public.booking;
create trigger trg_booking_completed_addons after update of status on public.booking
  for each row execute function public.booking_completed_addons();

-- 3. The dashboard check (every 30 seconds) also catches up add-ons ---------------------------------------
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

  -- NEW: add-ons follow their session (issued while it runs, returned when it is completed)
  perform public.sync_addon_orders(null);
  return n;
end $$;
revoke all on function public.start_due_sessions() from public, anon;
grant execute on function public.start_due_sessions() to authenticated;

-- 4. One-time catch-up for what is already in the database ----------------------------------------------------
select public.sync_addon_orders(null);
