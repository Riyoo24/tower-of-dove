-- =====================================================================
-- 97_gcash_account_details.sql  (safe to re-run)
-- Adds the studio's GCash account name and number to the public settings, so a
-- customer paying on the same phone (who cannot scan a QR shown on their own
-- screen) can send the money to the account directly.
--
--   * two new app_setting rows (empty until the owner fills them in under
--     Dashboard > Settings > GCash payment QR code)
--   * get_public_settings() also returns them as gcash_name / gcash_number.
--     They are not secret: the same account is printed on the QR code.
--
-- Run once in the Supabase SQL Editor. No new tables, policies, buckets or jobs.
-- The owner can already write app_setting (policy app_setting_owner_write).
-- =====================================================================

insert into public.app_setting (key, value) values
  ('gcash_account_name', ''),
  ('gcash_account_number', '')
on conflict (key) do nothing;

create or replace function public.get_public_settings() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'window_days',   public.booking_window_days(),
    'cutoff_hours',  public.change_cutoff_hours(),
    'hold_minutes',  public.slot_hold_minutes(),
    'grace_minutes', public.no_show_grace_minutes(),
    'gcash_name',    coalesce((select trim(value) from public.app_setting where key = 'gcash_account_name'), ''),
    'gcash_number',  coalesce((select trim(value) from public.app_setting where key = 'gcash_account_number'), ''));
$$;
revoke all on function public.get_public_settings() from public, anon, authenticated;
grant execute on function public.get_public_settings() to anon, authenticated;

-- check:  select public.get_public_settings();