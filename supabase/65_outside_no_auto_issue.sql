-- =====================================================================
-- 65_outside_no_auto_issue.sql  (safe to re-run)
-- An OUTSIDE rental is never issued by itself, even when it is fully paid and its pick-up time has come.
--   * Staff must issue it from the admin / staff page, where they attach the before photo of every item
--     and the handover proof photo (file 57), and only then hand the equipment over.
--   * Until now start_due_sessions() set an Approved outside rental to Active at its pick-up time when no
--     balance was due. That could issue it without staff, if the photos had been uploaded early.
--   * Studio sessions, extensions and add-ons behave exactly as before (file 41).
-- Run this once in the Supabase SQL Editor (after 64_damage_block_reputation.sql).
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
  update public.booking b set status = 'Completed'
   where b.status = 'In Progress' and b.end_at <= now()
     and not exists (select 1 from public.booking_extension x where x.booking_id = b.booking_id and x.status = 'Pending');
  get diagnostics k = row_count; n := n + k;

  -- outside rentals are NOT started here: staff issue them on the admin page (before photos + handover proof)

  -- add-ons follow their session (issued while it runs, returned when it is completed)
  perform public.sync_addon_orders(null);
  return n;
end $$;
revoke all on function public.start_due_sessions() from public, anon;
grant execute on function public.start_due_sessions() to authenticated;

select public.start_due_sessions();
