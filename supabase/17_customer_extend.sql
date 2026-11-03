-- =====================================================================
-- 17_customer_extend.sql  (safe to re-run)
-- Customers can extend their OWN Confirmed or Active studio booking from My bookings.
--
-- It uses the same three functions staff use (file 16). They now accept either staff or the customer who
-- owns the booking, and nobody else:
--   staff_extension_info(booking_ref, token)            how many extra hours are free right now
--   staff_hold_extension(booking_ref, hours, token)     holds the hours (3 minutes, renewed by the window)
--   staff_extend_booking(booking_ref, hours, token)     moves the end time and adds the cost to the bill
-- A hold made by staff shows as "Held by Staff"; a hold made by a customer is an ordinary hold
-- ("someone is booking this time"). Either way nobody else can book or extend those hours meanwhile.
-- The extra cost is added to the booking's bill and is paid at the studio.
-- Run once in the Supabase SQL Editor (after 16_extension_slot_hold.sql).
-- =====================================================================

create or replace function public.staff_extension_info(p_booking_ref text, p_token text default null)
returns table (
  min_hours integer, max_hours integer, message text,
  current_end_at timestamptz, hourly_rate numeric, next_start timestamptz, booking_status text
)
language plpgsql stable security definer set search_path = public as $$
declare
  b public.booking; st public.studio;
  closing timestamptz; nxt timestamptz; held timestamptz; held_staff boolean := false;
  free_until timestamptz; lo integer := 1; hi integer; msg text;
begin

  select * into b from public.booking bk where bk.booking_ref = upper(trim(p_booking_ref));
  if not found then raise exception 'Booking not found.' using errcode = 'P0001'; end if;
  if not public.is_staff() and b.customer_id is distinct from public.current_customer_id() then
    raise exception 'That is not your booking.' using errcode = '42501';
  end if;
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

  -- the earliest hold by somebody else (a customer filling in the form, or another staff member extending)
  select h.start_at, h.held_by_staff into held, held_staff from public.slot_hold h
   where h.studio_id = b.studio_id and h.expires_at > now()
     and h.token is distinct from p_token and h.end_at > b.end_at
   order by h.start_at limit 1;

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
      msg := case when held_staff
               then 'Cannot extend: this time is Held by Staff. Another staff member is extending this session right now. Try again in a few minutes.'
               else 'Cannot extend: someone is booking the next time slot right now. Try again in a couple of minutes.' end;
    elsif closing <= b.end_at + make_interval(hours => lo) then
      msg := 'Cannot extend: the studio closes at 10:00 PM.';
    else
      msg := 'Cannot extend: that time is not free.';
    end if;
  elsif hi < 4 then
    if nxt is not null and nxt = free_until then
      msg := 'The studio is booked from ' || to_char(nxt at time zone 'Asia/Manila', 'FMHH12:MI AM') || ', so it can be extended by up to ' || hi || ' hour' || case when hi > 1 then 's' else '' end || '.';
    elsif held is not null and held = free_until then
      msg := case when held_staff
               then 'Held by Staff: another staff member is holding the time from '
               else 'Someone is holding the time from ' end
             || to_char(held at time zone 'Asia/Manila', 'FMHH12:MI AM') || case when held_staff then '' else ' in the booking form' end
             || ', so the limit is ' || hi || ' hour' || case when hi > 1 then 's' else '' end || ' for now.';
    else
      msg := 'The studio closes at 10:00 PM, so it can be extended by up to ' || hi || ' hour' || case when hi > 1 then 's' else '' end || '.';
    end if;
  end if;

  return query select lo, hi, msg, b.end_at, b.hourly_rate_at_booking, nxt, b.status::text;
end $$;

create or replace function public.staff_hold_extension(p_booking_ref text, p_extra_hours integer, p_token text)
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare b public.booking; info record; till timestamptz := now() + interval '3 minutes';
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

create or replace function public.staff_extend_booking(p_booking_ref text, p_extra_hours integer, p_token text default null)
returns table (booking_ref text, new_end_at timestamptz, extra_cost numeric, studio_total numeric, payment_method text, payment_status text)
language plpgsql security definer set search_path = public as $$
declare
  b public.booking; info record; cost numeric; pay public.payment;
begin
  if p_extra_hours is null or p_extra_hours < 1 or p_extra_hours > 4 then
    raise exception 'Choose 1 to 4 extra hours.' using errcode = 'P0001';
  end if;

  select * into b from public.booking bk where bk.booking_ref = upper(trim(p_booking_ref)) for update;
  if not found then raise exception 'Booking not found.' using errcode = 'P0001'; end if;
  if not public.is_staff() and b.customer_id is distinct from public.current_customer_id() then
    raise exception 'That is not your booking.' using errcode = '42501';
  end if;

  -- same lock the booking functions use, so nobody can book the free hour while we extend
  perform pg_advisory_xact_lock(hashtextextended('studio:' || b.studio_id, 0));

  -- holds by other people block the extension; this staff member's own hold does not
  select * into info from public.staff_extension_info(b.booking_ref, p_token);
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

  if p_token is not null then
    delete from public.slot_hold where token = p_token;     -- the hold did its job
  end if;

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

revoke all on function public.staff_extension_info(text, text) from public, anon, authenticated;
revoke all on function public.staff_hold_extension(text, integer, text) from public, anon, authenticated;
revoke all on function public.staff_extend_booking(text, integer, text) from public, anon, authenticated;
grant execute on function public.staff_extension_info(text, text) to authenticated;
grant execute on function public.staff_hold_extension(text, integer, text) to authenticated;
grant execute on function public.staff_extend_booking(text, integer, text) to authenticated;
