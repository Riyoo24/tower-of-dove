-- =====================================================================
-- 21_fix_rental_total_8h.sql  (safe to re-run)
-- Restores 8-hour billing for outside rentals, the same as the website:
--   * the item price covers the first 8 hours
--   * every extra hour adds price / 8 (rounded up to whole hours)
-- Migration 19 had replaced this with per-24-hour-day billing, which made the
-- server's total (and the 50% down payment) differ from what the site shows.
-- Run once in the Supabase SQL Editor (after 20_booking_down_payment.sql).
-- =====================================================================
create or replace function public.rental_order_total(p_order_id bigint) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(
    d.quantity * d.unit_price_at_request *
    case when o.rental_type = 'Outside'
         then greatest(8, ceil(coalesce(d.rental_hours, 8)))::numeric / 8
         else 1 end
  ), 0)::numeric(10,2)
  from public.rental_order o
  join public.rental_detail d on d.rental_order_id = o.rental_order_id
  where o.rental_order_id = p_order_id;
$$;
