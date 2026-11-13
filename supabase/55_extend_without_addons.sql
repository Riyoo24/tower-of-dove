-- =====================================================================
-- 55_extend_without_addons.sql  (safe to re-run)
-- A session can still be EXTENDED when the equipment added to it is not free for the extra hours.
--   Before (file 52): the Extend window only offered the hours whose add-on equipment was free, so a band that
--                     needed 2 more hours could be told "Cannot extend" just because one amp was reserved later.
--   Now:    * the Extend window (customer AND staff) offers every hour the studio itself is free for
--           * when the add-on equipment is not free for the chosen extra hours, the window asks for a confirmation:
--             "Extend without the add-on?". If the answer is yes, ONLY THE BOOKING is extended. The add-on keeps
--             its original hours and is NOT recorded for the extra time (it must be returned when the original
--             hours end). If the answer is no, nothing changes.
--           * the add-on order stays as it was (same items, same price). Only its hours are shorter than the session:
--             rental_order.addon_cut_hours = how many hours at the END of the session the add-on does not cover.
--           * a later extension of a booking whose add-on was already shortened never brings the add-on back
--             (its equipment is already returned), so it stays out of the extra hours.
--           * for a customer's extension request the choice is saved with the request (booking_extension.without_addons)
--             and applied when staff verify the payment.
--   If the equipment is free for the extra hours nothing changes: the add-on is extended together with the session.
-- Run this once in the Supabase SQL Editor (after 54_reschedule_stock_slots.sql).
-- =====================================================================

-- 1. New columns -----------------------------------------------------------------------------------------------
alter table public.rental_order add column if not exists addon_cut_hours integer not null default 0;
alter table public.rental_order drop constraint if exists rental_order_addon_cut_chk;
alter table public.rental_order add constraint rental_order_addon_cut_chk check (addon_cut_hours >= 0);

alter table public.booking_extension add column if not exists without_addons boolean not null default false;

-- 2. The hours an order needs its equipment: an add-on ends addon_cut_hours before its session ends -------------
create or replace function public.order_window(p_order_id bigint)
returns table (w_start timestamptz, w_end timestamptz)
language sql stable security definer set search_path = public as $$
  select
    case when o.status = 'Active' and s.v is not null then least(s.v, now()) else s.v end,       -- issued early: out from now
    case when o.status = 'Active' and s.v is not null then greatest(e.v, now()) else e.v end      -- overdue: still out until returned
  from public.rental_order o
  left join public.booking b on b.booking_id = o.booking_id
  cross join lateral (select case when o.rental_type = 'Outside' then o.pickup_date else b.start_at end as v) s
  cross join lateral (select case when o.rental_type = 'Outside' then o.return_date
                                  else greatest(b.end_at - make_interval(hours => o.addon_cut_hours), b.start_at) end as v) e
  where o.rental_order_id = p_order_id;
$$;
revoke all on function public.order_window(bigint) from public, anon;
grant execute on function public.order_window(bigint) to authenticated;

-- 3. Is the add-on equipment of a booking free for its new hours?  null = yes, otherwise the reason (text) ----------
--    (file 53 version, now aware of add-ons that were shortened)
--    A pure EXTENSION (same start, later end) never needs equipment for an add-on that was already shortened.
create or replace function public.booking_stock_conflict(
  p_booking_id bigint, p_new_start timestamptz, p_new_end timestamptz,
  p_old_start timestamptz default null, p_old_end timestamptz default null
) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  r record;
  seg_from timestamptz[] := array[]::timestamptz[];
  seg_to   timestamptz[] := array[]::timestamptz[];
  i integer; held integer; qty integer; need_end timestamptz; seg_end timestamptz;
  is_ext boolean := false;
begin
  if p_booking_id is null or p_new_start is null or p_new_end is null then
    return null;
  end if;

  if p_old_start is null or p_old_end is null then
    seg_from := array[p_new_start];
    seg_to   := array[p_new_end];
  else
    is_ext := (p_new_start = p_old_start and p_new_end > p_old_end);
    if p_new_start < p_old_start then                       -- the session now starts earlier
      seg_from := seg_from || p_new_start;
      seg_to   := seg_to   || least(p_old_start, p_new_end);
    end if;
    if p_new_end > p_old_end then                           -- the session now ends later
      seg_from := seg_from || greatest(p_old_end, p_new_start);
      seg_to   := seg_to   || p_new_end;
    end if;
  end if;

  -- every item this booking holds (its Pending, Approved and issued add-on orders)
  for r in
    select distinct d.equipment_id, e.name, e.total_quantity
      from public.rental_order o
      join public.rental_detail d on d.rental_order_id = o.rental_order_id
      join public.equipment e on e.equipment_id = d.equipment_id
     where o.booking_id = p_booking_id
       and o.status in ('Pending', 'Approved', 'Active')
       and d.returned_at is null
     order by e.name
  loop
    for i in 1 .. coalesce(array_length(seg_from, 1), 0) loop
      -- the part of the booking's add-on orders that needs this item inside the segment
      select coalesce(sum(d.quantity), 0)::int,
             max(p_new_end - make_interval(hours => o.addon_cut_hours))
        into qty, need_end
        from public.rental_order o
        join public.rental_detail d on d.rental_order_id = o.rental_order_id
       where o.booking_id = p_booking_id
         and o.status in ('Pending', 'Approved', 'Active')
         and d.equipment_id = r.equipment_id
         and d.returned_at is null
         and not (is_ext and o.addon_cut_hours > 0)
         and p_new_end - make_interval(hours => o.addon_cut_hours) > seg_from[i];
      continue when qty = 0;
      seg_end := least(seg_to[i], need_end);
      held := public.equipment_held_by_others(r.equipment_id, seg_from[i], seg_end, p_booking_id);
      if held + qty > r.total_quantity then
        return 'Only ' || greatest(r.total_quantity - held, 0) || ' of ' || r.name || ' would be free from '
               || to_char(seg_from[i] at time zone 'Asia/Manila', 'FMMon FMDD, FMHH12:MI AM') || ' to '
               || to_char(seg_end at time zone 'Asia/Manila', 'FMHH12:MI AM')
               || ' (the rest is reserved by another booking or rental), but this booking''s add-on needs ' || qty || '.';
      end if;
    end loop;
  end loop;

  return null;
end $$;
revoke all on function public.booking_stock_conflict(bigint, timestamptz, timestamptz, timestamptz, timestamptz) from public, anon, authenticated;

-- 4. Decides what happens to the add-on when a session is extended by p_hours (call BEFORE the booking end changes) ---
--    * an add-on that was already shortened stays shortened (it does not get the extra hours)
--    * when the equipment is not free for the extra hours and p_without_addons is true, the add-on is shortened too
--    returns true when this call shortened an add-on that would otherwise have been extended
create or replace function public.apply_extension_addon_cut(
  p_booking_id bigint, p_hours integer, p_without_addons boolean
) returns boolean
language plpgsql security definer set search_path = public as $$
declare b public.booking; conflict text; dropped boolean := false;
begin
  select * into b from public.booking where booking_id = p_booking_id;
  if not found or p_hours is null or p_hours < 1 then return false; end if;

  conflict := public.booking_stock_conflict(b.booking_id, b.start_at, b.end_at + make_interval(hours => p_hours),
                                            b.start_at, b.end_at);

  -- add-ons already shortened earlier: the extra hours are not theirs either
  update public.rental_order
     set addon_cut_hours = addon_cut_hours + p_hours
   where booking_id = b.booking_id and rental_type = 'Add-on' and addon_cut_hours > 0
     and status in ('Pending', 'Approved', 'Active');

  if conflict is not null and p_without_addons then
    update public.rental_order
       set addon_cut_hours = addon_cut_hours + p_hours
     where booking_id = b.booking_id and rental_type = 'Add-on' and addon_cut_hours = 0
       and status in ('Pending', 'Approved', 'Active');
    dropped := true;
  end if;
  return dropped;
end $$;
revoke all on function public.apply_extension_addon_cut(bigint, integer, boolean) from public, anon, authenticated;

-- 5. The extension check: the studio decides how many hours can be added; the equipment only adds a note ------------
--    New columns: addon_max_hours = how many extra hours the add-on equipment is free for (smaller than max_hours when
--    the equipment is the limit), addon_message = the reason.
drop function if exists public.staff_extension_info(text, text);
create or replace function public.staff_extension_info(p_booking_ref text, p_token text default null)
returns table (
  min_hours integer, max_hours integer, message text,
  current_end_at timestamptz, hourly_rate numeric, next_start timestamptz, booking_status text,
  addon_max_hours integer, addon_message text
)
language plpgsql stable security definer set search_path = public as $$
declare
  b public.booking; st public.studio;
  closing timestamptz; nxt timestamptz; held timestamptz; held_staff boolean := false;
  free_until timestamptz; lo integer := 1; hi integer; msg text;
  addon_hi integer; addon_msg text; stock_msg text; i integer;
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
                        b.end_at, b.hourly_rate_at_booking, null::timestamptz, b.status::text, 0, null::text;
    return;
  end if;

  if b.status not in ('Approved', 'In Progress') then
    return query select 1, 0, 'Cannot extend: only Confirmed or Active bookings can be extended.'::text,
                        b.end_at, b.hourly_rate_at_booking, null::timestamptz, b.status::text, 0, null::text;
    return;
  end if;
  if st.status <> 'Available' then
    return query select 1, 0, ('Cannot extend: ' || st.name || ' is ' || lower(st.status) || '.')::text,
                        b.end_at, b.hourly_rate_at_booking, null::timestamptz, b.status::text, 0, null::text;
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

  -- the equipment added to this session: how many of the extra hours is it free for? (it does NOT limit the extension)
  addon_hi := hi; addon_msg := null;
  if hi >= 1 then
    for i in 1 .. hi loop
      stock_msg := public.booking_stock_conflict(b.booking_id, b.start_at, b.end_at + make_interval(hours => i),
                                                 b.start_at, b.end_at);
      if stock_msg is not null then
        addon_hi := i - 1;
        addon_msg := stock_msg;
        exit;
      end if;
    end loop;
  end if;

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

  return query select lo, hi, msg, b.end_at, b.hourly_rate_at_booking, nxt, b.status::text, addon_hi, addon_msg;
end $$;
revoke all on function public.staff_extension_info(text, text) from public, anon, authenticated;
grant execute on function public.staff_extension_info(text, text) to authenticated;

-- 6. Staff extend a session (same as file 23, plus p_without_addons) ------------------------------------------------
drop function if exists public.staff_extend_booking(text, integer, text);
create or replace function public.staff_extend_booking(
  p_booking_ref text, p_extra_hours integer, p_token text default null, p_without_addons boolean default false
)
returns table (booking_ref text, new_end_at timestamptz, extra_cost numeric, studio_total numeric,
               payment_method text, payment_status text, addon_dropped boolean)
language plpgsql security definer set search_path = public as $$
declare
  b public.booking; info record; cost numeric; pay public.payment; stock_msg text; dropped boolean := false;
begin
  if not public.is_staff() then raise exception 'Staff only. Customers request an extension with a down payment.' using errcode = '42501'; end if;
  if p_extra_hours is null or p_extra_hours < 1 or p_extra_hours > 4 then
    raise exception 'Choose 1 to 4 extra hours.' using errcode = 'P0001';
  end if;

  select * into b from public.booking bk where bk.booking_ref = upper(trim(p_booking_ref)) for update;
  if not found then raise exception 'Booking not found.' using errcode = 'P0001'; end if;

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

  -- NEW: the add-on equipment is not free for the extra hours -> only with the staff member's confirmation
  stock_msg := public.booking_stock_conflict(b.booking_id, b.start_at, b.end_at + make_interval(hours => p_extra_hours),
                                             b.start_at, b.end_at);
  if stock_msg is not null and not coalesce(p_without_addons, false) then
    raise exception 'The add-on equipment of this booking is not free for the extra time. % Confirm to extend without the add-on.', stock_msg
      using errcode = 'P0001';
  end if;
  dropped := public.apply_extension_addon_cut(b.booking_id, p_extra_hours, coalesce(p_without_addons, false));

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
  -- With a down payment the extra cost is NOT added to the payment (it is part of the balance paid at the studio).
  -- Older bookings without a down payment keep the previous behaviour (cost added to the payment amount).
  if found and coalesce(b.down_payment, 0) = 0 then
    update public.payment set amount = amount + cost where payment_id = pay.payment_id;
  end if;

  return query
    select b.booking_ref::text, x.end_at, cost, public.booking_total(b.booking_id), pay.method::text, pay.status::text, dropped
      from public.booking x where x.booking_id = b.booking_id;
end $$;
revoke all on function public.staff_extend_booking(text, integer, text, boolean) from public, anon, authenticated;
grant execute on function public.staff_extend_booking(text, integer, text, boolean) to authenticated;

-- 7. Customer asks for an extension (same as file 31, plus p_without_addons) -----------------------------------------
drop function if exists public.customer_request_extension(text, integer, text, text, text);
create function public.customer_request_extension(
  p_booking_ref text, p_extra_hours integer, p_token text, p_gcash_reference text,
  p_pay_option text default 'down', p_without_addons boolean default false
) returns table (extension_id bigint, booking_ref text, new_end_at timestamptz, extra_cost numeric, down_payment numeric,
                 balance_due numeric, pay_option text, without_addons boolean)
language plpgsql security definer set search_path = public as $$
declare
  cid bigint := public.current_customer_id();
  b public.booking; info record; x public.booking_extension;
  cost numeric; dp numeric; tok text; stock_msg text; drop_addons boolean := false;
  gref text := regexp_replace(coalesce(p_gcash_reference, ''), '\s', '', 'g');
  opt text := lower(coalesce(nullif(trim(p_pay_option), ''), 'down'));
begin
  if opt not in ('down', 'full') then
    raise exception 'Choose 50%% down payment or full payment.' using errcode = 'P0001';
  end if;
  if cid is null then raise exception 'Please log in to extend your booking.' using errcode = 'P0001'; end if;
  if p_extra_hours is null or p_extra_hours < 1 or p_extra_hours > 4 then
    raise exception 'Choose 1 to 4 extra hours.' using errcode = 'P0001';
  end if;
  if gref !~ '^[0-9]{13}$' then
    raise exception 'Enter the 13-digit GCash reference number of your payment.' using errcode = 'P0001';
  end if;

  select * into b from public.booking bk where bk.booking_ref = upper(trim(p_booking_ref)) for update;
  if not found or b.customer_id is distinct from cid then
    raise exception 'That is not your booking.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('studio:' || b.studio_id, 0));

  if exists (select 1 from public.booking_extension e where e.booking_id = b.booking_id and e.status = 'Pending') then
    raise exception 'You already have an extension request waiting for staff to verify its payment.' using errcode = 'P0001';
  end if;

  -- the customer's own open Extend window (p_token) does not block the hours
  select * into info from public.staff_extension_info(b.booking_ref, p_token);
  if info.max_hours < info.min_hours then raise exception '%', info.message using errcode = 'P0001'; end if;
  if p_extra_hours > info.max_hours then
    raise exception '%', coalesce(info.message, 'Cannot extend: that time is not free.') using errcode = 'P0001';
  end if;
  if p_extra_hours < info.min_hours then
    raise exception 'The session is already past its end time. Extend by at least % hour(s).', info.min_hours using errcode = 'P0001';
  end if;

  -- NEW: the add-on equipment is not free for the extra hours -> only with the customer's confirmation
  stock_msg := public.booking_stock_conflict(b.booking_id, b.start_at, b.end_at + make_interval(hours => p_extra_hours),
                                             b.start_at, b.end_at);
  if stock_msg is not null then
    if not coalesce(p_without_addons, false) then
      raise exception 'Your add-on equipment is not free for the extra time. % Confirm to extend without the add-on.', stock_msg
        using errcode = 'P0001';
    end if;
    drop_addons := true;
  end if;

  cost := round(b.hourly_rate_at_booking * p_extra_hours, 2);
  dp   := public.pay_option_amount(cost, opt);
  tok  := 'e' || replace(gen_random_uuid()::text, '-', '');

  insert into public.booking_extension (booking_id, customer_id, extra_hours, hourly_rate, extra_cost, down_payment,
                                        old_end_at, new_end_at, hold_token, without_addons)
  values (b.booking_id, cid, p_extra_hours, b.hourly_rate_at_booking, cost, dp,
          b.end_at, b.end_at + make_interval(hours => p_extra_hours), tok, drop_addons)
  returning * into x;

  insert into public.payment (extension_id, method, gcash_reference, amount, status, payment_option)
  values (x.extension_id, 'GCash', gref, dp, 'Pending', opt);

  -- reserve the extra hours until staff decide (an ordinary hold: nobody else can book or extend them)
  delete from public.slot_hold where expires_at < now() or token = p_token;
  insert into public.slot_hold (studio_id, start_at, end_at, token, expires_at, held_by_staff)
  values (b.studio_id, x.old_end_at, x.new_end_at, tok, x.new_end_at, false);

  return query select x.extension_id, b.booking_ref::text, x.new_end_at, cost, dp, cost - dp, opt, x.without_addons;
exception when unique_violation then
  raise exception 'That GCash reference number was already used.' using errcode = 'P0001';
end $$;
revoke all on function public.customer_request_extension(text, integer, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.customer_request_extension(text, integer, text, text, text, boolean) to authenticated;

-- 8. Verifying the extension payment applies the customer's choice (same as file 23, plus the add-on step) -----------
create or replace function public.apply_booking_extension(p_extension_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare x public.booking_extension; b public.booking; paid numeric := 0;
begin
  select * into x from public.booking_extension where extension_id = p_extension_id for update;
  if not found or x.status <> 'Pending' then return; end if;

  select * into b from public.booking where booking_id = x.booking_id for update;
  perform pg_advisory_xact_lock(hashtextextended('studio:' || b.studio_id, 0));

  if b.status not in ('Approved', 'In Progress') then
    raise exception 'This booking is % now, so the extension cannot be applied. Reject the extension payment instead.', b.status using errcode = 'P0001';
  end if;
  if b.end_at is distinct from x.old_end_at then
    raise exception 'The booking time changed after this request was made. Reject the extension payment and ask the customer to request it again.' using errcode = 'P0001';
  end if;

  -- an older booking paid in full has no down payment: what it already paid counts as paid
  if coalesce(b.down_payment, 0) = 0 then
    select coalesce(sum(p.amount), 0) into paid from public.payment p where p.booking_id = b.booking_id and p.status = 'Verified';
  end if;

  -- NEW: the customer agreed to extend without the add-on -> its hours stay as they were
  perform public.apply_extension_addon_cut(b.booking_id, x.extra_hours, x.without_addons);

  begin
    update public.booking
       set end_at = x.new_end_at,
           down_payment = case when down_payment > 0 then down_payment else paid end + x.down_payment
     where booking_id = b.booking_id;
  exception when exclusion_violation then
    raise exception 'Cannot verify: the extra time is no longer free (another booking took it). Reject the extension payment with the reason "Time slot is no longer available".' using errcode = 'P0001';
  end;

  delete from public.slot_hold where token = x.hold_token;
  update public.booking_extension set status = 'Approved', approved_by = public.current_app_user_id() where extension_id = x.extension_id;
end $$;
revoke all on function public.apply_booking_extension(bigint) from public, anon, authenticated;

-- end of 55_extend_without_addons.sql
