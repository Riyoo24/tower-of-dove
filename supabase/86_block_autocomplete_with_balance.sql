-- =====================================================================
-- 86_block_autocomplete_with_balance.sql  (safe to re-run)
-- A session that still owes a balance is never completed by itself.
--   * start_due_sessions() (file 78, run every 30 seconds by pg_cron (file 49) and by the admin page) completed every
--     In Progress session at its end time. A session staff extended, with the extra hours not paid yet, was completed that
--     way and its balance was never collected (the Payment column then showed "Fully Paid").
--   * Now the auto-complete step skips a booking whose balance_due is above zero. It stays In Progress ("Over time" on
--     the Studio Sessions tab, with the amount due) until staff press Collect balance & complete (file 85), which saves
--     the payment and completes it. Sessions with nothing owed complete at their end time exactly as before.
--   * Nothing else in the function changed (it is file 78's version). No trigger is added, on purpose: a trigger that
--     raises an error would roll back the whole batch and stop OTHER sessions from completing.
-- Run once in the Supabase SQL Editor (after 85_collect_balance_on_complete.sql). No Edge Function change.
-- =====================================================================

create or replace function public.start_due_sessions() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer := 0; k integer;
begin
  -- confirmed studio sessions whose time has begun and that have no balance left to collect
  update public.booking set status = 'In Progress'
   where status = 'Approved' and start_at <= now() and end_at > now()
     and public.booking_balance_due(booking_id) <= 0.005;
  get diagnostics k = row_count; n := n + k;

  -- sessions that reached their end time are completed (not while an extension is waiting to be verified)
  -- NEW (86): and not while a balance is still owed (for example the extra hours of an extension): staff collect it with
  -- Mark completed, which saves the payment and then completes the session. Such a session stays In Progress, over time.
  update public.booking b set status = 'Completed'
   where b.status = 'In Progress' and b.end_at <= now()
     and not exists (select 1 from public.booking_extension x where x.booking_id = b.booking_id and x.status = 'Pending')
     and public.booking_balance_due(b.booking_id) <= 0.005;
  get diagnostics k = row_count; n := n + k;

  -- NEW: bookings that still owe a balance after the grace period are released (add-ons with them)
  begin
    n := n + public.release_no_show_bookings();
  exception when others then null;
  end;

  -- outside rentals are NOT started here: staff issue them on the admin page (before photos + handover proof)

  -- add-ons follow their session (issued while it runs, returned when it is completed)
  perform public.sync_addon_orders(null);
  return n;
end $$;
revoke all on function public.start_due_sessions() from public, anon;
grant execute on function public.start_due_sessions() to authenticated;

-- Catch-up now (sessions that owe nothing and already ended are completed; the others stay open)
select public.start_due_sessions();

-- end of 86_block_autocomplete_with_balance.sql
