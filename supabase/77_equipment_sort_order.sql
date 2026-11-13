-- =====================================================================
-- 77_equipment_sort_order.sql  (safe to re-run)
-- Lets the owner drag equipment rows in Admin > Equipment to set the order customers see
-- (Rent page, booking "Browse equipment" window and the home page).
-- Adds equipment.sort_order. Existing items keep their current order; new items go to the end.
-- Run once in the Supabase SQL Editor. v_equipment_stock is NOT changed.
-- =====================================================================
alter table public.equipment add column if not exists sort_order integer;

update public.equipment e
   set sort_order = x.rn
  from (select equipment_id, row_number() over (order by equipment_id) as rn from public.equipment) x
 where e.equipment_id = x.equipment_id and e.sort_order is null;

create sequence if not exists public.equipment_sort_order_seq;
select setval('public.equipment_sort_order_seq', coalesce((select max(sort_order) from public.equipment), 0) + 1, false);

alter table public.equipment alter column sort_order set default nextval('public.equipment_sort_order_seq');
alter table public.equipment alter column sort_order set not null;
alter sequence public.equipment_sort_order_seq owned by public.equipment.sort_order;

-- end of 77_equipment_sort_order.sql
