-- =====================================================================
-- 96_outside_rental_max_48h.sql  (safe to re-run)
-- Outside (take-home) rentals booked online can be kept for 2 days at most:
-- the return time may not be more than 48 hours after the pick-up time
-- (pick-up 11/18 at 10 AM -> the latest return is 11/20 at 10 AM).
--
-- The website (js/customer/rent.js) already stops the customer from choosing a
-- later return. This migration makes the DATABASE refuse it too, so the limit
-- cannot be skipped by calling the API directly.
--
-- It extends the existing rental-window trigger from file 94 (the 4-week limit
-- stays as it was). Staff-made rentals (on-site / back-office) are not limited.
-- Run once in the Supabase SQL Editor. No other setup is needed.
-- =====================================================================

create or replace function public.guard_rental_window() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.rental_type = 'Outside' and new.source = 'Online' and not public.is_staff() then
    -- the 4-week booking window (unchanged from file 94)
    if (new.pickup_date at time zone 'Asia/Manila')::date
         > (now() at time zone 'Asia/Manila')::date + public.booking_window_days()
       or (new.return_date at time zone 'Asia/Manila')::date
         > (now() at time zone 'Asia/Manila')::date + public.booking_window_days() then
      raise exception 'Equipment can only be rented up to % days ahead. Please choose an earlier date.',
        public.booking_window_days() using errcode = 'P0001';
    end if;

    -- NEW: the 2-day (48-hour) maximum rental length
    if new.pickup_date is not null and new.return_date is not null
       and new.return_date > new.pickup_date + interval '48 hours' then
      raise exception 'Outside rentals can be kept for 2 days (48 hours) at most. Please choose a return time within 48 hours of the pick-up.'
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;

-- the trigger itself already exists (file 94); this re-creates it identically so the file also works on its own
drop trigger if exists trg_rental_window on public.rental_order;
create trigger trg_rental_window before insert or update of pickup_date, return_date on public.rental_order
  for each row execute function public.guard_rental_window();

-- ---------------------------------------------------------------------
-- Self-check (optional): both lines should show the new function body
-- ---------------------------------------------------------------------
-- select pg_get_functiondef('public.guard_rental_window'::regproc) like '%48 hours%' as has_48h_limit;
-- select tgname from pg_trigger where tgrelid = 'public.rental_order'::regclass and tgname = 'trg_rental_window';

-- end of 96_outside_rental_max_48h.sql