-- =====================================================================
-- 49_cron_auto_complete.sql  (safe to re-run)
-- Studio sessions start and end by themselves, even when nobody has the admin / staff page open.
--   * Until now start_due_sessions() (file 41) only ran while the admin / staff page was open.
--   * This file schedules it inside Supabase with pg_cron, so the database itself completes a session
--     (and returns its add-on equipment, and frees the studio) at its end time.
--   * The admin page keeps calling it too: harmless, both do the same idempotent work.
-- Run this once in the Supabase SQL Editor (after 48_performance_indexes.sql; file 41 must have been run).
-- =====================================================================

-- 1. Turn on the scheduler (Database > Extensions > pg_cron does the same thing)
create extension if not exists pg_cron with schema pg_catalog;

-- 2. (Re)create the job. Runs every 30 seconds; if this pg_cron version has no seconds support, every minute.
do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'tod-start-sessions';   -- remove the old copy
  begin
    perform cron.schedule('tod-start-sessions', '30 seconds', 'select public.start_due_sessions()');
  exception when others then
    perform cron.schedule('tod-start-sessions', '* * * * *', 'select public.start_due_sessions()');
  end;
end $$;

-- 3. Catch-up right now: anything that already ended is completed
select public.start_due_sessions();

-- 4. Check: shows the job (active = true). Run it again a minute later to see "succeeded" runs.
select jobid, jobname, schedule, active from cron.job where jobname = 'tod-start-sessions';
