-- =====================================================================
-- 07_auto_approve_addons.sql  (safe to re-run)
-- When staff VERIFY a booking payment, the add-on equipment requested with that
-- booking is approved automatically (no second trip to the Rentals tab).
-- If the payment is REJECTED, the pending add-on request is rejected too.
-- If an item is out of stock, that add-on stays Pending for staff to review.
-- Run this once in the Supabase SQL Editor.
-- =====================================================================
create or replace function public.payment_effects() returns trigger
language plpgsql security definer set search_path = public as $$
declare o record;
begin
  if new.status is distinct from old.status and new.booking_id is not null then
    if new.status = 'Verified' then
      update public.booking set status = 'Approved'
       where booking_id = new.booking_id and status = 'Pending';

      for o in select ro.rental_order_id from public.rental_order ro
                where ro.booking_id = new.booking_id and ro.rental_type = 'Add-on' and ro.status = 'Pending' loop
        begin
          update public.rental_order set status = 'Approved' where rental_order_id = o.rental_order_id;
        exception when others then
          null;   -- for example not enough stock right now: leave it Pending
        end;
      end loop;

    elsif new.status = 'Rejected' then
      update public.booking set status = 'Rejected', rejected_reason = coalesce(rejected_reason, 'Payment rejected')
       where booking_id = new.booking_id and status = 'Pending';

      for o in select ro.rental_order_id from public.rental_order ro
                where ro.booking_id = new.booking_id and ro.rental_type = 'Add-on' and ro.status = 'Pending' loop
        begin
          update public.rental_order set status = 'Rejected', rejected_reason = 'Booking payment was rejected'
           where rental_order_id = o.rental_order_id;
        exception when others then
          null;
        end;
      end loop;
    end if;
  end if;
  return null;
end $$;

-- One-time catch-up: add-ons on bookings that were already verified but are still Pending
do $$
declare o record;
begin
  for o in
    select ro.rental_order_id
      from public.rental_order ro
      join public.booking b on b.booking_id = ro.booking_id
     where ro.rental_type = 'Add-on' and ro.status = 'Pending'
       and b.status in ('Approved', 'In Progress')
       and exists (select 1 from public.payment p where p.booking_id = b.booking_id and p.status = 'Verified')
  loop
    begin
      update public.rental_order set status = 'Approved' where rental_order_id = o.rental_order_id;
    exception when others then
      null;
    end;
  end loop;
end $$;
