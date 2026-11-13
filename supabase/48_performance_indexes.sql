-- 48_performance_indexes.sql  (OPTIONAL, safe to re-run)
-- The site now loads the newest rows first with a cap (newest 1000 bookings, etc.).
-- These indexes let the database find "the newest N" without sorting the whole table.
-- Nothing else changes: no columns, policies, views or functions.
create index if not exists booking_start_desc_idx           on public.booking (start_at desc);
create index if not exists payment_created_desc_idx         on public.payment (created_at desc);
create index if not exists rental_order_created_desc_idx    on public.rental_order (created_at desc);
create index if not exists booking_extension_created_desc_idx on public.booking_extension (created_at desc);
