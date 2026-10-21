-- =====================================================================
-- 13_overdue_hours_addon_return.sql  (safe to re-run)
--  1. v_rental_lines gets a new LAST column, hours_overdue. The admin Rentals page uses it to show
--     "Overdue" instead of "In Use" and to write "3 hours overdue". (A started hour counts as a
--     full hour, the same rule the late fee uses. days_overdue is still there, unchanged.)
--  2. When a studio booking becomes Completed, every add-on rental linked to it that is still
--     Approved or In Use is set to Returned automatically (the existing trigger
--     trg_rental_returned then stamps returned_at on each item, so stock comes back).
--  3. One-time clean-up: add-ons of bookings that are ALREADY Completed are set to Returned too.
-- Run this once in the Supabase SQL Editor (after 12_rental_base_hours_autostatus.sql).
-- =====================================================================

-- 1. hours_overdue ---------------------------------------------------------------------------------
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
  end as hours_overdue
from public.rental_order o
join public.rental_detail d on d.rental_order_id = o.rental_order_id
join public.equipment e on e.equipment_id = d.equipment_id
join public.customer c on c.customer_id = o.customer_id
left join public.booking bk on bk.booking_id = o.booking_id;

-- 2. completing a booking returns its add-on equipment -----------------------------------------------
create or replace function public.booking_completed_addons() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'Completed' and old.status is distinct from 'Completed' then
    update public.rental_order
       set status = 'Returned'
     where booking_id = new.booking_id
       and rental_type = 'Add-on'
       and status in ('Approved', 'Active');
  end if;
  return null;
end $$;

drop trigger if exists trg_booking_completed_addons on public.booking;
create trigger trg_booking_completed_addons after update of status on public.booking
  for each row execute function public.booking_completed_addons();

-- 3. clean-up of add-ons that belong to bookings completed before this script ran ------------------------
update public.rental_order o
   set status = 'Returned'
  from public.booking b
 where o.booking_id = b.booking_id
   and b.status = 'Completed'
   and o.rental_type = 'Add-on'
   and o.status in ('Approved', 'Active');
