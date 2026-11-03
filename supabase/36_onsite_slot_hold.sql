-- =====================================================================
-- 36_onsite_slot_hold.sql  (safe to re-run)
-- Slot hold for the staff "Onsite booking" form ("Held by Staff").
--
-- While staff fill in the Onsite booking form, the chosen hours are held for 2 minutes
-- (the form renews the hold every minute and releases it after 2 minutes of inactivity,
-- when staff leave the tab, or after the booking is recorded).
--   * customers see those hours as "Held by Staff" and cannot book them
--   * the booking is recorded with the same token, so the staff member's own hold never blocks it
--
-- Run once in the Supabase SQL Editor (after 16_extension_slot_hold.sql and 24_onsite_gcash_optional.sql).
-- =====================================================================

-- 1. Hold the hours for this staff member. Returns false when the time is not free.
create or replace function public.staff_hold_onsite(p_studio_id bigint, p_start_at timestamptz, p_end_at timestamptz, p_token text)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  if p_token is null or length(p_token) < 8 or length(p_token) > 80 then
    raise exception 'Missing hold token.' using errcode = 'P0001';
  end if;
  perform public.validate_slot(p_start_at, p_end_at, true);
  perform pg_advisory_xact_lock(hashtextextended('studio:' || p_studio_id, 0));

  delete from public.slot_hold where expires_at < now() or token = p_token;

  if exists (select 1 from public.studio where studio_id = p_studio_id and status <> 'Available') then
    return false;
  end if;
  if exists (
    select 1 from public.booking b
    where b.studio_id = p_studio_id and b.status in ('Pending', 'Approved', 'In Progress')
      and tstzrange(b.start_at, b.end_at, '[)') && tstzrange(p_start_at, p_end_at, '[)')
  ) then
    return false;
  end if;
  if public.slot_held_by_other(p_studio_id, p_start_at, p_end_at, p_token) then
    return false;
  end if;

  insert into public.slot_hold (studio_id, start_at, end_at, token, expires_at, held_by_staff)
  values (p_studio_id, p_start_at, p_end_at, p_token, now() + interval '2 minutes', true);
  return true;
end $$;

grant execute on function public.staff_hold_onsite(bigint, timestamptz, timestamptz, text) to authenticated;

-- 2. Onsite booking now accepts the hold token (so its own hold never blocks it, and the hold is removed afterwards).
drop function if exists public.staff_create_onsite_booking(bigint, timestamptz, timestamptz, text, text, text, text, text);

create or replace function public.staff_create_onsite_booking(
  p_studio_id bigint, p_start_at timestamptz, p_end_at timestamptz,
  p_first_name text, p_last_name text, p_number text,
  p_payment_method text, p_gcash_reference text default null,
  p_token text default null
) returns table (booking_id bigint, booking_ref text, total_amount numeric)
language plpgsql security definer set search_path = public as $$
declare b public.booking; cid bigint;
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  perform public.validate_slot(p_start_at, p_end_at, true);
  if p_payment_method not in ('GCash', 'Cash') then
    raise exception 'Choose GCash or Cash.' using errcode = 'P0001';
  end if;
  -- the GCash reference is optional; if one is typed it must look real
  if p_payment_method = 'GCash' and nullif(trim(coalesce(p_gcash_reference, '')), '') is not null
     and length(trim(p_gcash_reference)) < 6 then
    raise exception 'The GCash reference must be at least 6 characters, or leave it blank.' using errcode = 'P0001';
  end if;

  cid := public.resolve_customer(p_first_name, p_last_name, p_number, true);
  b := public.insert_booking_with_payment(cid, p_studio_id, p_start_at, p_end_at,
         p_payment_method, p_gcash_reference, 'Onsite', public.current_app_user_id(), p_token);
  return query select b.booking_id, b.booking_ref::text, public.booking_total(b.booking_id);
end $$;

grant execute on function public.staff_create_onsite_booking(bigint, timestamptz, timestamptz, text, text, text, text, text, text) to authenticated;
