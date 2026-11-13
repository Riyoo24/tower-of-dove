-- =====================================================================
-- 79_no_show_emails.sql  (safe to re-run)
-- Emails for the no-show release (file 78):
--   * Confirmation: the existing "Your booking is verified" email now shows the balance deadline and the no-show terms
--     (no database change needed for that, only the Edge Function).
--   * Reminder: about 2 hours before the start, to bookings that still owe a balance. Sent once.
--   * Forfeiture: when a booking is released as a no-show, the customer is told the slot was released and the payment kept. Sent once.
--
-- The reminder and the forfeiture email are sent by the send-receipt Edge Function (kind "noshow"). This file schedules a
-- pg_cron job that calls it every 5 minutes through pg_net. The address always comes from the booking's saved receipt email,
-- so guests get these emails too (they just have no "I'm running late" button).
--
-- Run once in the Supabase SQL Editor, after 78_no_show_release.sql. Then follow the 3 setup steps below.
-- =====================================================================

-- 1. Send-once markers ---------------------------------------------------------------------------------------
alter table public.booking add column if not exists no_show_reminder_sent_at timestamptz;
alter table public.booking add column if not exists forfeit_email_sent_at   timestamptz;

-- 2. pg_net lets the database call the Edge Function -----------------------------------------------------------
create extension if not exists pg_net;

-- 3. Where to call (private: nobody but this file's function can read it) --------------------------------------------
create table if not exists public.email_job_config (
  id            smallint primary key default 1 check (id = 1),
  function_url  text not null,
  anon_key      text not null,
  cron_secret   text not null
);
alter table public.email_job_config enable row level security;    -- no policy: no browser user can read or change it
revoke all on public.email_job_config from public, anon, authenticated;

-- 4. The job --------------------------------------------------------------------------------------------------
create or replace function public.send_no_show_emails() returns void
language plpgsql security definer set search_path = public as $$
declare c public.email_job_config;
begin
  select * into c from public.email_job_config where id = 1;
  if not found or c.function_url like '%PASTE%' or c.anon_key like '%PASTE%' or c.cron_secret like '%PASTE%' then
    return;    -- not set up yet (see step 1 below): do nothing
  end if;
  perform net.http_post(
    url     := c.function_url,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || c.anon_key, 'x-cron-secret', c.cron_secret),
    body    := jsonb_build_object('kind', 'noshow'));
exception when others then null;   -- never let an email problem stop the cron
end $$;
revoke all on function public.send_no_show_emails() from public, anon, authenticated;

do $$
begin
  perform cron.unschedule(jobid) from cron.job where jobname = 'tod-no-show-emails';
  perform cron.schedule('tod-no-show-emails', '*/5 * * * *', 'select public.send_no_show_emails()');
end $$;

-- =====================================================================
-- SETUP (3 steps, once)
--
-- 1. Edge Functions > Secrets: add  CRON_SECRET  = a long random text of your own (for example 40 random letters and digits).
--
-- 2. Edit the 3 values and run this in the SQL Editor (anon key: Project Settings > API; use the SAME text as CRON_SECRET):
--
--      insert into public.email_job_config (id, function_url, anon_key, cron_secret)
--      values (1, 'https://YOUR-PROJECT-REF.supabase.co/functions/v1/send-receipt', 'YOUR-ANON-KEY', 'YOUR-CRON-SECRET')
--      on conflict (id) do update set function_url = excluded.function_url, anon_key = excluded.anon_key, cron_secret = excluded.cron_secret;
--
-- 3. Deploy the new functions/send-receipt/index.ts (leave Verify JWT on).
--
-- Check: select jobid, jobname, schedule, active from cron.job where jobname = 'tod-no-show-emails';
--        select * from net._http_response order by created desc limit 5;     -- status_code 200 = working
-- =====================================================================
