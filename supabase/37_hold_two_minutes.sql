-- =====================================================================
-- 37_hold_two_minutes.sql  (safe to re-run)
-- Makes the Extend slot hold last 2 minutes, like every other slot hold
-- (customer booking, reschedule, and the Onsite booking form in file 36).
-- The Extend windows still renew the hold every minute while they are open.
-- Run once in the Supabase SQL Editor (after 36_onsite_slot_hold.sql).
-- =====================================================================

create or replace function public.staff_hold_extension(p_booking_ref text, p_extra_hours integer, p_token text)
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare b public.booking; info record; till timestamptz := now() + interval '2 minutes';
begin
  if p_token is null or length(p_token) < 8 or length(p_token) > 80 then
    raise exception 'Missing hold token.' using errcode = 'P0001';
  end if;
  if p_extra_hours is null or p_extra_hours < 1 or p_extra_hours > 4 then
    raise exception 'Choose 1 to 4 extra hours.' using errcode = 'P0001';
  end if;

  select * into b from public.booking bk where bk.booking_ref = upper(trim(p_booking_ref));
  if not found then raise exception 'Booking not found.' using errcode = 'P0001'; end if;
  if not public.is_staff() and b.customer_id is distinct from public.current_customer_id() then
    raise exception 'That is not your booking.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('studio:' || b.studio_id, 0));

  select * into info from public.staff_extension_info(b.booking_ref, p_token);
  if info.max_hours < info.min_hours then
    raise exception '%', info.message using errcode = 'P0001';
  end if;
  if p_extra_hours > info.max_hours or p_extra_hours < info.min_hours then
    raise exception '%', coalesce(info.message, 'Cannot extend: that time is not free.') using errcode = 'P0001';
  end if;

  delete from public.slot_hold where expires_at < now() or token = p_token;
  insert into public.slot_hold (studio_id, start_at, end_at, token, expires_at, held_by_staff)
  values (b.studio_id, b.end_at, b.end_at + make_interval(hours => p_extra_hours), p_token, till, public.is_staff());
  return till;
end $$;

grant execute on function public.staff_hold_extension(text, integer, text) to authenticated;
