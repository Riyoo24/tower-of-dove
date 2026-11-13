-- =====================================================================
-- 76_replacement_emails.sql  (safe to re-run)
-- Automatic email to the customer when their scheduled rental item became unavailable (for example it came back damaged):
--   * Let customer choose: the email lists the offered items with their prices, the deadline and the default item
--   * Swap item:           the email says the item was replaced, with the new item and its price
-- Each offer / swap is emailed once: customer_emailed_at remembers it. Run once in the Supabase SQL Editor
-- (after 75_onsite_cash_tendered.sql), then deploy the send-receipt Edge Function again.
-- =====================================================================
alter table public.rental_swap_offer add column if not exists customer_emailed_at timestamptz;
alter table public.rental_item_swap  add column if not exists customer_emailed_at timestamptz;
-- end of 76_replacement_emails.sql
