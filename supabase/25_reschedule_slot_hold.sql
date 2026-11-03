-- 25_reschedule_slot_hold.sql
-- Rescheduling now HOLDS the new hours (2 minutes, renewed by the page) while the customer is choosing,
-- the same way booking a studio does.
--   * hold_reschedule_slot(): like hold_slot, but the booking's own current hours do not block the hold
--   * reschedule_booking() takes the customer's hold token, so their own hold never blocks the move,
--     refuses the same start time, and frees the hold once the booking has moved
-- Run once in the Supabase SQL Editor (after 24_onsite_gcash_optional.sql). Safe to re-run.

-- 1. hold the new hours for a booking that is being rescheduled
create or replace function public.hold_reschedule_slot(p_booking_ref text, p_start_at timestamptz, p_end_at timestamptz, p_token text)
returns boolean language plpgsql security definer set search_path = public as $$
declare b public.booking; staff boolean := public.is_staff();
begin
  if p_token is null or length(p_token) < 8 or length(p_token) > 80 then
    raise exception 'Missing hold token.' using errcode = 'P0001';
  end if;
  select * into b from public.booking where booking_ref = upper(trim(p_booking_ref));
  if not found then raise exception 'Booking not found.' using errcode = 'P0001'; end if;
  if not staff and b.customer_id is distinct from public.current_customer_id() then
    raise exception 'That is not your booking.' using errcode = '42501';
  end if;
  if b.status not in ('Pending', 'Approved') then
    raise exception 'A % booking cannot be rescheduled.', b.status using errcode = 'P0001';
  end if;
  perform public.validate_slot(p_start_at, p_end_at, false);
  perform pg_advisory_xact_lock(hashtextextended('studio:' || b.studio_id, 0));

  delete from public.slot_hold where expires_at < now() or token = p_token;

  if exists (select 1 from public.studio where studio_id = b.studio_id and status <> 'Available') then
    return false;
  end if;
  if exists (
    select 1 from public.booking o
    where o.studio_id = b.studio_id and o.booking_id <> b.booking_id
      and o.status in ('Pending', 'Approved', 'In Progress')
      and tstzrange(o.start_at, o.end_at, '[)') && tstzrange(p_start_at, p_end_at, '[)')
  ) then
    return false;
  end if;
  if public.slot_held_by_other(b.studio_id, p_start_at, p_end_at, p_token) then
    return false;
  end if;

  insert into public.slot_hold (studio_id, start_at, end_at, token, expires_at)
  values (b.studio_id, p_start_at, p_end_at, p_token, now() + interval '2 minutes');
  return true;
end $$;
revoke all on function public.hold_reschedule_slot(text, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.hold_reschedule_slot(text, timestamptz, timestamptz, text) to authenticated;

-- 2. reschedule_booking with the hold token (replaces the 3-argument version from file 23)
drop function if exists public.reschedule_booking(text, timestamptz, timestamptz);
create or replace function public.reschedule_booking(p_booking_ref text, p_start_at timestamptz, p_end_at timestamptz, p_token text default null)
returns void language plpgsql security definer set search_path = public as $$
declare b public.booking; staff boolean := public.is_staff();
begin
  select * into b from public.booking where booking_ref = upper(trim(p_booking_ref)) for update;
  if not found then raise exception 'Booking not found.' using errcode = 'P0001'; end if;
  if not staff and b.customer_id is distinct from public.current_customer_id() then
    raise exception 'That is not your booking.' using errcode = '42501';
  end if;
  if b.status not in ('Pending', 'Approved') then
    raise exception 'A % booking cannot be rescheduled.', b.status using errcode = 'P0001';
  end if;
  if not staff and now() > b.start_at - interval '24 hours' then
    raise exception 'Changes and cancellations close 24 hours before your session.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.booking_extension e where e.booking_id = b.booking_id and e.status = 'Pending') then
    raise exception 'This booking has an extension request waiting for payment verification. Please wait until staff verify or reject it.' using errcode = 'P0001';
  end if;
  if p_start_at = b.start_at and p_end_at = b.end_at then
    raise exception 'That is your current time. Pick a different start time.' using errcode = 'P0001';
  end if;
  perform public.validate_slot(p_start_at, p_end_at, staff);

  perform pg_advisory_xact_lock(hashtextextended('studio:' || b.studio_id, 0));
  -- the customer's own hold (same token) does not count as "someone else"
  if public.slot_held_by_other(b.studio_id, p_start_at, p_end_at, p_token) then
    raise exception 'Those hours were just taken by another customer.' using errcode = 'P0001';
  end if;
  begin
    update public.booking
       set start_at = p_start_at, end_at = p_end_at, reschedule_count = reschedule_count + 1
     where booking_id = b.booking_id;
  exception when exclusion_violation then
    raise exception 'That time is no longer available. Please pick another slot.' using errcode = 'P0001';
  end;

  if p_token is not null then
    delete from public.slot_hold where token = p_token;
  end if;
end $$;
revoke all on function public.reschedule_booking(text, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.reschedule_booking(text, timestamptz, timestamptz, text) to authenticated;
