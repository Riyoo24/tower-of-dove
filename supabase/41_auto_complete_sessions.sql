-- =====================================================================
-- 41_auto_complete_sessions.sql  (safe to re-run)
-- A studio session that reaches its end time is marked Completed by itself.
--   * runs in start_due_sessions(), which the admin / staff page already calls every 30 seconds
--     (and when the page is opened), so the status changes within about 30 seconds of the end time
--   * completing a session also returns its add-on equipment (file 39 / 40) and releases the studio
--   * a session with an extension request still waiting for verification is NOT completed yet:
--     staff verify or reject the extension first (the end time may move)
-- Run this once in the Supabase SQL Editor (after 40_addon_balance_collection.sql).
-- =====================================================================

create or replace function public.start_due_sessions() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer := 0; k integer; o record;
begin
  -- confirmed studio sessions whose time has begun and that have no balance left to collect
  update public.booking set status = 'In Progress'
   where status = 'Approved' and start_at <= now() and end_at > now()
     and public.booking_balance_due(booking_id) <= 0.005;
  get diagnostics k = row_count; n := n + k;

  -- NEW: sessions that reached their end time are completed (not while an extension is waiting to be verified)
  update public.booking b set status = 'Completed'
   where b.status = 'In Progress' and b.end_at <= now()
     and not exists (select 1 from public.booking_extension x where x.booking_id = b.booking_id and x.status = 'Pending');
  get diagnostics k = row_count; n := n + k;

  -- outside rentals: In Use as soon as the pick-up time arrives, unless a balance is still due
  for o in select rental_order_id from public.rental_order
            where rental_type = 'Outside' and status = 'Approved' and pickup_date <= now()
              and public.rental_balance_due(rental_order_id) <= 0.005 loop
    begin
      update public.rental_order set status = 'Active' where rental_order_id = o.rental_order_id;
      n := n + 1;
    exception when others then null;   -- for example the stock check failed: leave it for staff
    end;
  end loop;

  -- add-ons follow their session (issued while it runs, returned when it is completed)
  perform public.sync_addon_orders(null);
  return n;
end $$;
revoke all on function public.start_due_sessions() from public, anon;
grant execute on function public.start_due_sessions() to authenticated;

-- One-time catch-up: sessions that already ended but are still In Progress are completed now
select public.start_due_sessions();
