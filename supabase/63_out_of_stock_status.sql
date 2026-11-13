-- =====================================================================
-- 63_out_of_stock_status.sql  (safe to re-run)
-- Equipment whose rentable quantity is 0 (every unit is Out of service / removed) used to show "In Use" in Equipment.
-- It now shows "Out of Stock". "In Use" is kept for items that have units rented out right now and none left.
-- Run once in the Supabase SQL Editor (after 62_stock_preview.sql). Same columns as before, only stock_status changes.
-- =====================================================================
create or replace view public.v_equipment_stock with (security_invoker = true) as
select
  e.equipment_id, e.name, e.image, e.description, c.category_name,
  e.total_quantity,
  public.equipment_in_use(e.equipment_id) as in_use,
  greatest(e.total_quantity - public.equipment_in_use(e.equipment_id), 0) as available,
  case
    when e.status <> 'Available' then 'Unavailable'
    when e.total_quantity <= 0 then 'Out of Stock'
    when e.total_quantity - public.equipment_in_use(e.equipment_id) <= 0 then 'In Use'
    when e.total_quantity - public.equipment_in_use(e.equipment_id) = 1 and e.total_quantity > 1 then 'Low'
    else 'Available'
  end as stock_status,
  e.add_on_rate, e.outside_rate, e.allow_addon, e.allow_outside, e.min_hours,
  e.owned_quantity, e.out_of_service
from public.equipment e
join public.equipment_category c on c.category_id = e.category_id;

-- end of 63_out_of_stock_status.sql
