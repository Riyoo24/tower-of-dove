-- =====================================================================
-- 66_balance_receipt_email.sql  (safe to re-run)
-- Fully paid receipt by email when staff collect the remaining balance.
--   * Bookings: "Collect balance & start session". Rentals: "Collect balance & issue".
--   * After the balance is saved, the admin page asks the Edge Function `send-receipt` (kind: balance) to email the
--     customer a "fully paid" receipt: what was collected, how it was paid, and that nothing is left to pay.
--   * The email goes to the address saved with the booking / rental (never typed in the browser), only staff can ask
--     for it, and it is sent ONCE per collection (payment.balance_email_sent_at).
-- Run once in the Supabase SQL Editor (after 65_outside_no_auto_issue.sql), then deploy the Edge Function again:
--   supabase functions deploy send-receipt
-- =====================================================================

alter table public.payment add column if not exists balance_email_sent_at timestamptz;

-- end of 66_balance_receipt_email.sql
