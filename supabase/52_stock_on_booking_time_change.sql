-- =====================================================================
-- 52_stock_on_booking_time_change.sql  (safe to re-run)
-- Closes a gap left by 51_stock_by_time.sql:
--   Before: equipment added to a studio session (an add-on) was checked against stock for the session's hours
--           only when the add-on was requested / approved. If the session was LATER extended or rescheduled,
--           the new hours were never checked, so two bands could end up holding the same item at the same time.
--   Now:    * every change of a booking's start / end time re-checks the add-on equipment of that booking for the
--             NEW hours. Only the hours that are new are checked (the hours it already held stay as they were).
--             If an item is not free, the change is refused and nothing is saved.
--           * the extension check (staff_extension_info) also looks at stock, so the Extend window shows the
--             problem BEFORE the customer pays the 50% down payment, and only offers the hours that are free.
--           * rescheduling is refused with a clear message when the add-on is not free at the new time.
--           * the same check runs when staff verify an extension payment, in case another order took the
--             equipment while the payment was waiting (the staff member is told to reject that payment).
--   Counted as holding stock (same as file 51): orders Approved or Active and not returned. Pending do not.
-- Run this once in the Supabase SQL Editor (after 51_stock_by_time.sql).
-- =====================================================================

-- 1. Quantity of an item held by OTHER bookings' / rentals' orders during [p_from, p_to) ----------------------------
--    (same rule as equipment_in_use_between, but every order of one booking is left out, so a booking never
--     competes with its own add-on orders while its hours are being changed)
create or replace function public.equipment_held_by_others(
  p_equipment_id bigint, p_from timestamptz, p_to timestamptz, p_exclude_booking bigint
) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(sum(d.quantity), 0)::int
    from public.rental_detail d
    join public.rental_order o on o.rental_order_id = d.rental_order_id
    cross join lateral public.order_window(o.rental_order_id) w
   where d.equipment_id = p_equipment_id
     and o.status in ('Approved', 'Active')
     and d.returned_at is null
     and o.booking_id is distinct from p_exclude_booking
     and (w.w_start is null or w.w_end is null
          or p_from is null or p_to is null
          or (w.w_start < p_to and p_from < w.w_end));
$$;
revoke all on function public.equipment_held_by_others(bigint, timestamptz, timestamptz, bigint) from public, anon, authenticated;

-- 2. Is the add-on equipment of a booking free for its new hours?  null = yes, otherwise the reason (text) ----------
--    p_old_start / p_old_end = the hours the booking had before. Only the hours that are NEW are checked
--    (for an extension that is just the extra time). Leave them out to check the whole window.
create or replace function public.booking_stock_conflict(
  p_booking_id bigint, p_new_start timestamptz, p_new_end timestamptz,
  p_old_start timestamptz default null, p_old_end timestamptz default null
) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  r record;
  seg_from timestamptz[] := array[]::timestamptz[];
  seg_to   timestamptz[] := array[]::timestamptz[];
  i integer; held integer;
begin
  if p_booking_id is null or p_new_start is null or p_new_end is null then
    return null;
  end if;

  if p_old_start is null or p_old_end is null then
    seg_from := array[p_new_start];
    seg_to   := array[p_new_end];
  else
    if p_new_start < p_old_start then                       -- the session now starts earlier
      seg_from := seg_from || p_new_start;
      seg_to   := seg_to   || least(p_old_start, p_new_end);
    end if;
    if p_new_end > p_old_end then                           -- the session now ends later
      seg_from := seg_from || greatest(p_old_end, p_new_start);
      seg_to   := seg_to   || p_new_end;
    end if;
  end if;

  -- the equipment this booking holds right now (all its approved / issued add-on orders, per item)
  for r in
    select d.equipment_id, e.name, e.total_quantity, sum(d.quantity)::int as qty
      from public.rental_order o
      join public.rental_detail d on d.rental_order_id = o.rental_order_id
      join public.equipment e on e.equipment_id = d.equipment_id
     where o.booking_id = p_booking_id
       and o.status in ('Approved', 'Active')
       and d.returned_at is null
     group by d.equipment_id, e.name, e.total_quantity
     order by e.name
  loop
    for i in 1 .. coalesce(array_length(seg_from, 1), 0) loop
      held := public.equipment_held_by_others(r.equipment_id, seg_from[i], seg_to[i], p_booking_id);
      if held + r.qty > r.total_quantity then
        return 'Only ' || greatest(r.total_quantity - held, 0) || ' of ' || r.name || ' would be free from '
               || to_char(seg_from[i] at time zone 'Asia/Manila', 'FMMon FMDD, FMHH12:MI AM') || ' to '
               || to_char(seg_to[i] at time zone 'Asia/Manila', 'FMHH12:MI AM')
               || ' (the rest is reserved by another booking or rental), but this booking''s add-on needs ' || r.qty || '.';
      end if;
    end loop;
  end loop;

  return null;
end $$;
revoke all on function public.booking_stock_conflict(bigint, timestamptz, timestamptz, timestamptz, timestamptz) from public, anon, authenticated;

-- 3. Safety net: any change of a booking's hours (extend, extension payment verified, reschedule, ...) is checked ----
create or replace function public.booking_time_stock_trg() returns trigger
language plpgsql security definer set search_path = public as $$
declare c text;
begin
  if new.status in ('Pending', 'Approved', 'In Progress')
     and (new.start_at is distinct from old.start_at or new.end_at is distinct from old.end_at) then
    c := public.booking_stock_conflict(new.booking_id, new.start_at, new.end_at, old.start_at, old.end_at);
    if c is not null then
      if exists (select 1 from public.booking_extension x
                  where x.booking_id = new.booking_id and x.status = 'Pending' and x.new_end_at = new.end_at) then
        -- staff are verifying an extension payment: the equipment was taken by someone else while it was waiting
        raise exception 'Cannot verify: the add-on equipment of this booking is no longer free for the extra time. % Reject the extension payment with the reason "Equipment not available for the extra time".', c
          using errcode = 'P0001';
      end if;
      raise exception 'The equipment added to this booking is not free for those hours. % Choose other hours, or ask staff to change the add-on.', c
        using errcode = 'P0001';
    end if;
  end if;
  return null;
end $$;
revoke all on function public.booking_time_stock_trg() from public, anon, authenticated;

drop trigger if exists trg_booking_time_stock on public.booking;
create trigger trg_booking_time_stock after update of start_at, end_at on public.booking
  for each row execute function public.booking_time_stock_trg();

-- 4. The extension check (same function as file 23, plus the stock check) --------------------------------------------
--    staff_extend_booking, customer_request_extension and staff_hold_extension all ask this function how many extra
--    hours are possible, so the Extend window now only offers hours whose equipment is free.
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
  hi_time integer; stock_msg text; i integer;      -- NEW: the limit from the equipment stock
begin

  select * into b from public.booking bk where bk.booking_ref = upper(trim(p_booking_ref));
  if not found then raise exception 'Booking not found.' using errcode = 'P0001'; end if;
  if not public.is_staff() and b.customer_id is distinct from public.current_customer_id() then
    raise exception 'That is not your booking.' using errcode = '42501';
  end if;
  select * into st from public.studio where studio_id = b.studio_id;

  -- only one extension request at a time (it must be verified or rejected first)
  if exists (select 1 from public.booking_extension e where e.booking_id = b.booking_id and e.status = 'Pending') then
    return query select 1, 0, 'Cannot extend: an extension request for this booking is waiting for its down payment to be verified.'::text,
                        b.end_at, b.hourly_rate_at_booking, null::timestamptz, b.status::text;
    return;
  end if;

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
  hi_time := hi;

  -- NEW: the equipment already added to this session must also be free for the extra hours
  if hi >= 1 then
    for i in 1 .. hi loop
      stock_msg := public.booking_stock_conflict(b.booking_id, b.start_at, b.end_at + make_interval(hours => i),
                                                 b.start_at, b.end_at);
      if stock_msg is not null then
        hi := i - 1;
        exit;
      end if;
    end loop;
  end if;

  -- a session already running past its end time must be extended far enough to cover the time used
  if b.status = 'In Progress' and now() >= b.end_at then
    lo := floor(extract(epoch from (now() - b.end_at)) / 3600.0)::integer + 1;
  end if;

  if hi < lo then
    if stock_msg is not null and hi_time >= lo then
      msg := 'Cannot extend: ' || stock_msg;
    elsif nxt is not null and nxt <= b.end_at + make_interval(hours => lo) then
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
    if stock_msg is not null then
      msg := 'The add-on equipment of this booking is not free for longer, so it can be extended by up to '
             || hi || ' hour' || case when hi > 1 then 's' else '' end || '. ' || stock_msg;
    elsif nxt is not null and nxt = free_until then
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

-- keeps the same permissions as before (re-stated so the file is safe to run on its own)
revoke all on function public.staff_extension_info(text, text) from public, anon, authenticated;
grant execute on function public.staff_extension_info(text, text) to authenticated;
