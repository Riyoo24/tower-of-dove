-- =====================================================================
-- 15_extend_booking.sql  (safe to re-run)
-- Staff can extend a Confirmed or Active studio booking by 1 to 4 extra hours.
--
--   staff_extension_info(booking_ref)           -> how many extra hours are free right now (and why not more)
--   staff_extend_booking(booking_ref, hours)    -> moves the end time and adds the cost to the bill
--
-- Rules checked by the database (so two staff members can't both take the same free hour):
--   * only Confirmed (Approved) or Active (In Progress) bookings
--   * the extra hours must not overlap the next Pending / Confirmed / Active booking of the same studio
--   * nobody else may be holding that time in the booking form right now
--   * the studio must be Available, and the session must still end by the 10:00 PM closing time
-- The studio price is always worked out from start and end time, so the customer's booking page shows the
-- new end time and total on its own. The booking's payment amount goes up by the extra cost, so the
-- Payments tab and the revenue report include it.
-- Run this once in the Supabase SQL Editor (after 14_email_login_names_id_view.sql).
-- =====================================================================

create or replace function public.staff_extension_info(p_booking_ref text)
returns table (
  min_hours integer, max_hours integer, message text,
  current_end_at timestamptz, hourly_rate numeric, next_start timestamptz, booking_status text
)
language plpgsql stable security definer set search_path = public as $$
declare
  b public.booking; st public.studio;
  closing timestamptz; nxt timestamptz; held timestamptz;
  free_until timestamptz; lo integer := 1; hi integer; msg text;
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;

  select * into b from public.booking where booking_ref = upper(trim(p_booking_ref));
  if not found then raise exception 'Booking not found.' using errcode = 'P0001'; end if;
  select * into st from public.studio where studio_id = b.studio_id;

  if b.status not in ('Approved', 'In Progress') then
    return query select 1, 0, 'Cannot extend: only Confirmed or Active bookings can be extended.'::text,
                        b.end_at, b.hourly_rate_at_booking, null::timestamptz, b.status::text;
    return;
  end if;
  if st.status <> 'Available' then
    return query select 1, 0, ('Cannot extend: ' || st.name || ' is ' || lower(st.status) || '.')::text,
                        b.end_at, b.hourly_rate_at_booking, null::timestamptz, b.status::text;
    return;
  end if;

  -- 10:00 PM closing on the day the session ends (Manila time)
  closing := (date_trunc('day', b.end_at at time zone 'Asia/Manila') + interval '22 hours') at time zone 'Asia/Manila';

  select min(o.start_at) into nxt from public.booking o
   where o.studio_id = b.studio_id and o.booking_id <> b.booking_id
     and o.status in ('Pending', 'Approved', 'In Progress') and o.end_at > b.end_at;

  select min(h.start_at) into held from public.slot_hold h
   where h.studio_id = b.studio_id and h.expires_at > now() and h.end_at > b.end_at;

  free_until := least(closing, coalesce(nxt, 'infinity'::timestamptz), coalesce(held, 'infinity'::timestamptz));
  hi := least(4, greatest(0, floor(extract(epoch from (free_until - b.end_at)) / 3600.0)::integer));

  -- a session already running past its end time must be extended far enough to cover the time used
  if b.status = 'In Progress' and now() >= b.end_at then
    lo := floor(extract(epoch from (now() - b.end_at)) / 3600.0)::integer + 1;
  end if;

  if hi < lo then
    if nxt is not null and nxt <= b.end_at + make_interval(hours => lo) then
      msg := 'Cannot extend: studio is booked for the next time slot.';
    elsif held is not null and held <= b.end_at + make_interval(hours => lo) then
      msg := 'Cannot extend: someone is booking the next time slot right now. Try again in a couple of minutes.';
    elsif closing <= b.end_at + make_interval(hours => lo) then
      msg := 'Cannot extend: the studio closes at 10:00 PM.';
    else
      msg := 'Cannot extend: that time is not free.';
    end if;
  elsif hi < 4 then
    if nxt is not null and nxt = free_until then
      msg := 'The studio is booked from ' || to_char(nxt at time zone 'Asia/Manila', 'FMHH12:MI AM') || ', so it can be extended by up to ' || hi || ' hour' || case when hi > 1 then 's' else '' end || '.';
    elsif held is not null and held = free_until then
      msg := 'Someone is holding the time from ' || to_char(held at time zone 'Asia/Manila', 'FMHH12:MI AM') || ' in the booking form, so the limit is ' || hi || ' hour' || case when hi > 1 then 's' else '' end || ' for now.';
    else
      msg := 'The studio closes at 10:00 PM, so it can be extended by up to ' || hi || ' hour' || case when hi > 1 then 's' else '' end || '.';
    end if;
  end if;

  return query select lo, hi, msg, b.end_at, b.hourly_rate_at_booking, nxt, b.status::text;
end $$;

create or replace function public.staff_extend_booking(p_booking_ref text, p_extra_hours integer)
returns table (booking_ref text, new_end_at timestamptz, extra_cost numeric, studio_total numeric, payment_method text, payment_status text)
language plpgsql security definer set search_path = public as $$
declare
  b public.booking; info record; cost numeric; pay public.payment;
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  if p_extra_hours is null or p_extra_hours < 1 or p_extra_hours > 4 then
    raise exception 'Choose 1 to 4 extra hours.' using errcode = 'P0001';
  end if;

  select * into b from public.booking bk where bk.booking_ref = upper(trim(p_booking_ref)) for update;
  if not found then raise exception 'Booking not found.' using errcode = 'P0001'; end if;

  -- same lock the booking functions use, so nobody can book the free hour while we extend
  perform pg_advisory_xact_lock(hashtextextended('studio:' || b.studio_id, 0));

  select * into info from public.staff_extension_info(b.booking_ref);
  if info.max_hours < info.min_hours then
    raise exception '%', info.message using errcode = 'P0001';
  end if;
  if p_extra_hours > info.max_hours then
    raise exception '%', coalesce(info.message, 'Cannot extend: that time is not free.') using errcode = 'P0001';
  end if;
  if p_extra_hours < info.min_hours then
    raise exception 'The session is already past its end time. Extend by at least % hour(s).', info.min_hours using errcode = 'P0001';
  end if;

  cost := round(b.hourly_rate_at_booking * p_extra_hours, 2);

  begin
    update public.booking set end_at = end_at + make_interval(hours => p_extra_hours) where booking_id = b.booking_id;
  exception when exclusion_violation then
    raise exception 'Cannot extend: studio is booked for the next time slot.' using errcode = 'P0001';
  end;

  -- the bill: the booking's payment (Pending or already Verified) goes up by the extra cost
  select * into pay from public.payment p
   where p.booking_id = b.booking_id and p.status in ('Pending', 'Verified')
   order by p.payment_id desc limit 1;
  if found then
    update public.payment set amount = amount + cost where payment_id = pay.payment_id;
  end if;

  return query
    select b.booking_ref::text, x.end_at, cost, public.booking_total(b.booking_id), pay.method::text, pay.status::text
      from public.booking x where x.booking_id = b.booking_id;
end $$;

revoke all on function public.staff_extension_info(text) from public, anon, authenticated;
revoke all on function public.staff_extend_booking(text, integer) from public, anon, authenticated;
grant execute on function public.staff_extension_info(text) to authenticated;
grant execute on function public.staff_extend_booking(text, integer) to authenticated;
