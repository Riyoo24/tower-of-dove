-- =====================================================================
-- 33_booking_window.sql  (safe to re-run)
-- Customers can only book a studio, or rent equipment for pick-up, up to 4 weeks (28 days) ahead.
-- The website already limits the date pickers; this makes the database refuse it too, so a
-- changed page or a direct API call cannot book further ahead. Staff walk-ins (onsite) and
-- staff accounts are not limited. Existing bookings are not touched.
-- Run once in the Supabase SQL Editor.
-- =====================================================================

create or replace function public.guard_booking_window() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.source = 'Online' and not public.is_staff()
     and (new.start_at at time zone 'Asia/Manila')::date > (now() at time zone 'Asia/Manila')::date + 28 then
    raise exception 'Bookings can only be made up to 4 weeks ahead. Please choose an earlier date.' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists trg_booking_window on public.booking;
create trigger trg_booking_window before insert or update of start_at on public.booking
  for each row execute function public.guard_booking_window();

create or replace function public.guard_rental_window() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.rental_type = 'Outside' and new.source = 'Online' and not public.is_staff()
     and ((new.pickup_date at time zone 'Asia/Manila')::date > (now() at time zone 'Asia/Manila')::date + 28
          or (new.return_date at time zone 'Asia/Manila')::date > (now() at time zone 'Asia/Manila')::date + 28) then
    raise exception 'Equipment can only be rented up to 4 weeks ahead. Please choose an earlier date.' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists trg_rental_window on public.rental_order;
create trigger trg_rental_window before insert or update of pickup_date, return_date on public.rental_order
  for each row execute function public.guard_rental_window();

-- end of 33_booking_window.sql
