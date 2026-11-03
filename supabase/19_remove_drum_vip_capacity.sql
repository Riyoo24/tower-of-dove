-- =====================================================================
-- Migration 19: Remove is_drum_set, drum_kit, is_vip from equipment;
--               Remove capacity from studio;
--               Consolidate drum categories into 'Drums'.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Step 1: Ensure a single canonical 'Drums' category exists
-- ---------------------------------------------------------------------
insert into public.equipment_category (category_name)
values ('Drums')
on conflict (category_name) do nothing;

-- ---------------------------------------------------------------------
-- Step 2: Migrate drum model info into description before dropping columns.
-- ---------------------------------------------------------------------
do $$
declare
  drums_id bigint;
begin
  select category_id into drums_id from public.equipment_category where category_name = 'Drums';

  -- Reassign any equipment from other drum-named categories to 'Drums'
  update public.equipment
     set category_id = drums_id
   where category_id in (
     select category_id from public.equipment_category
      where lower(category_name) like '%drum%'
        and category_id <> drums_id
   );

  -- Merge drum_kit + is_vip into description for drum-set equipment
  update public.equipment
     set description = case
       when drum_kit is not null
            and description is not null
            and description ilike ('%' || drum_kit || '%')
         then case
                when is_vip and description not ilike '%vip%' and description not ilike '%splash%'
                  then description || ' 2 crash, 1 ride, hi-hat, splash.'
                else description
              end
       when drum_kit is not null and (description is null or trim(description) = '')
         then drum_kit || '. ' ||
              case when is_vip then '2 crash, 1 ride, hi-hat, splash.'
                               else '1 crash, 1 ride, hi-hat.' end
       when is_drum_set and drum_kit is null and is_vip
            and (description is null or description not ilike '%vip%')
         then coalesce(description || ' ', '') || '2 crash, 1 ride, hi-hat, splash.'
       else description
     end
   where is_drum_set = true;
end $$;

-- ---------------------------------------------------------------------
-- Step 3: Drop now-redundant drum-named categories (no equipment left)
-- ---------------------------------------------------------------------
delete from public.equipment_category
 where lower(category_name) like '%drum%'
   and category_name <> 'Drums'
   and not exists (
     select 1 from public.equipment where category_id = equipment_category.category_id
   );

-- ---------------------------------------------------------------------
-- Step 4: Drop the view that depends on is_drum_set BEFORE dropping the column
-- ---------------------------------------------------------------------
drop view if exists public.v_equipment_stock;

-- ---------------------------------------------------------------------
-- Step 5: Drop the deprecated columns from equipment
-- ---------------------------------------------------------------------
alter table public.equipment
  drop column if exists is_drum_set,
  drop column if exists drum_kit,
  drop column if exists is_vip;

alter table public.equipment
  drop constraint if exists equipment_drum_chk;

-- ---------------------------------------------------------------------
-- Step 6: Drop capacity from studio
-- ---------------------------------------------------------------------
alter table public.studio
  drop column if exists capacity;

alter table public.studio
  drop constraint if exists studio_capacity_chk;

-- ---------------------------------------------------------------------
-- Step 7: Recreate v_equipment_stock without the dropped columns
-- ---------------------------------------------------------------------
create or replace view public.v_equipment_stock with (security_invoker = true) as
select
  e.equipment_id, e.name, e.image, e.description, c.category_name,
  e.total_quantity,
  public.equipment_in_use(e.equipment_id) as in_use,
  greatest(e.total_quantity - public.equipment_in_use(e.equipment_id), 0) as available,
  case
    when e.status <> 'Available' then 'Unavailable'
    when e.total_quantity - public.equipment_in_use(e.equipment_id) <= 0 then 'In Use'
    when e.total_quantity - public.equipment_in_use(e.equipment_id) = 1 and e.total_quantity > 1 then 'Low'
    else 'Available'
  end as stock_status,
  e.add_on_rate, e.outside_rate, e.allow_addon, e.allow_outside, e.min_hours
from public.equipment e
join public.equipment_category c on c.category_id = e.category_id;

-- ---------------------------------------------------------------------
-- Step 8: Update rental_order_total to remove is_drum_set dependency
-- ---------------------------------------------------------------------
create or replace function public.rental_order_total(p_order_id bigint) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(
    d.quantity * d.unit_price_at_request *
    case when o.rental_type = 'Outside'
         then greatest(1, ceil(coalesce(d.rental_hours, 24) / 24.0))
         else 1 end
  ), 0)::numeric(10,2)
  from public.rental_order o
  join public.rental_detail d on d.rental_order_id = o.rental_order_id
  where o.rental_order_id = p_order_id;
$$;
