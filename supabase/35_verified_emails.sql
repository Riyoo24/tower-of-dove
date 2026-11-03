-- =====================================================================
-- 35_verified_emails.sql  (safe to re-run)
-- When staff verify a customer's payment, the customer is emailed that their booking / rental /
-- session extension is verified. This column marks the payments whose email was already sent, so each
-- verification sends exactly one email even if the button is pressed twice.
-- Run once in the Supabase SQL Editor (after 34_receipt_emails.sql).
-- =====================================================================
alter table public.payment add column if not exists verified_email_sent_at timestamptz;

-- end of 35_verified_emails.sql
