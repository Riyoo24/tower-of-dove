-- =====================================================================
-- 54_reschedule_stock_slots.sql  (safe to re-run)
-- The Reschedule window now GREYS OUT start times where the equipment added to the booking is not free,
-- instead of letting the customer pick the time and only then showing an error.
--   reschedule_blocked_slots(p_booking_ref, p_date) returns, for one day, every start time (slot index 0 = 10:00 AM)
--   at which the booking's add-on equipment would NOT be free for the booking's whole length, with the reason.
--   It uses the same check as the safety net in file 52 (booking_stock_conflict), so what the window greys out is
--   exactly what the save would refuse. Pending add-on requests count too (file 53).
--   Only the booking's owner (or staff) can ask. A booking without add-on equipment returns nothing.
-- Run this once in the Supabase SQL Editor (after 53_pending_orders_hold_stock.sql).
-- =====================================================================

create or replace function public.reschedule_blocked_slots(p_booking_ref text, p_date date)
returns table (slot integer, reason text)
language plpgsql stable security definer set search_path = public as $$
declare
  b public.booking; hrs integer; i integer; s timestamptz; c text;
begin
  select * into b from public.booking where booking_ref = upper(trim(p_booking_ref));
  if not found then raise exception 'Booking not found.' using errcode = 'P0001'; end if;
  if not public.is_staff() and b.customer_id is distinct from public.current_customer_id() then
    raise exception 'That is not your booking.' using errcode = '42501';
  end if;

  hrs := greatest(1, round(extract(epoch from (b.end_at - b.start_at)) / 3600.0)::integer);

  -- start times 10:00 AM .. 9:00 PM (12 slots); a session must end by the 10:00 PM closing time
  for i in 0 .. 11 loop
    exit when i + hrs > 12;
    s := ((p_date::timestamp) + make_interval(hours => 10 + i)) at time zone 'Asia/Manila';
    -- whole new window is checked (no "old" hours), the booking's own orders are left out of "others"
    c := public.booking_stock_conflict(b.booking_id, s, s + make_interval(hours => hrs), null, null);
    if c is not null then
      slot := i;
      reason := c;
      return next;
    end if;
  end loop;
end $$;

revoke all on function public.reschedule_blocked_slots(text, date) from public, anon;
grant execute on function public.reschedule_blocked_slots(text, date) to authenticated;

-- end of 54_reschedule_stock_slots.sql
