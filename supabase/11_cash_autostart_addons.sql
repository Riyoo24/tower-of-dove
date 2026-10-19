-- =====================================================================
-- 11_cash_autostart_addons.sql  (safe to re-run)
--  1. Online bookings cannot be paid in cash (only staff can record cash for walk-ins).
--  2. Confirmed bookings start by themselves when their scheduled time begins.
--  3. Add-on equipment added to a booking (also later, from the Rent equipment page):
--       - a guest cannot attach equipment to a booking that belongs to a registered account
--       - the booking's payment amount follows the add-ons while the payment is still Pending
-- Run this once in the Supabase SQL Editor.
-- =====================================================================

-- 1. No cash for online bookings --------------------------------------------------------------
create or replace function public.payment_no_online_cash() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.booking_id is not null and new.method = 'Cash' and not public.is_staff() then
    raise exception 'Online bookings are paid with GCash. Cash is only accepted at the studio for walk-in bookings recorded by staff.' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists trg_payment_no_online_cash on public.payment;
create trigger trg_payment_no_online_cash before insert on public.payment
  for each row execute function public.payment_no_online_cash();

-- 2. Start sessions automatically -------------------------------------------------------------
create or replace function public.start_due_sessions() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update public.booking set status = 'In Progress'
   where status = 'Approved' and start_at <= now() and end_at > now();
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.start_due_sessions() from public, anon;
grant execute on function public.start_due_sessions() to authenticated;

-- Optional: if the pg_cron extension is enabled (Database > Extensions), also start sessions every minute
-- even when nobody has the dashboard open.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('tod-start-sessions', '* * * * *', 'select public.start_due_sessions()');
  end if;
exception when others then
  null;   -- scheduling is optional; the dashboard also starts due sessions every 30 seconds
end $$;

-- 3a. Add-ons can only be attached to your own booking (guest bookings are open to guests) ----
create or replace function public.rental_addon_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare owner uuid;
begin
  if new.rental_type = 'Add-on' and new.booking_id is not null then
    select c.auth_user_id into owner
      from public.booking b join public.customer c on c.customer_id = b.customer_id
     where b.booking_id = new.booking_id;
    if owner is not null and owner is distinct from auth.uid() and not public.is_staff() then
      raise exception 'Booking not found.' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_rental_addon_guard on public.rental_order;
create trigger trg_rental_addon_guard before insert on public.rental_order
  for each row execute function public.rental_addon_guard();

-- 3b. A Pending booking payment follows the add-ons: studio price + active add-on equipment ----
create or replace function public.sync_booking_payment(p_booking_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.payment p
     set amount = public.booking_total(p_booking_id) + coalesce((
           select sum(d.unit_price_at_request * d.quantity)
             from public.rental_order o
             join public.rental_detail d on d.rental_order_id = o.rental_order_id
            where o.booking_id = p_booking_id and o.rental_type = 'Add-on'
              and o.status not in ('Rejected', 'Cancelled')), 0)
   where p.booking_id = p_booking_id and p.status = 'Pending';
end $$;

create or replace function public.sync_payment_from_detail() returns trigger
language plpgsql security definer set search_path = public as $$
declare bid bigint;
begin
  select o.booking_id into bid from public.rental_order o where o.rental_order_id = new.rental_order_id;
  if bid is not null then perform public.sync_booking_payment(bid); end if;
  return null;
end $$;
drop trigger if exists trg_sync_payment_detail on public.rental_detail;
create trigger trg_sync_payment_detail after insert on public.rental_detail
  for each row execute function public.sync_payment_from_detail();

create or replace function public.sync_payment_from_order() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.booking_id is not null then perform public.sync_booking_payment(new.booking_id); end if;
  return null;
end $$;
drop trigger if exists trg_sync_payment_order on public.rental_order;
create trigger trg_sync_payment_order after update of status on public.rental_order
  for each row execute function public.sync_payment_from_order();
