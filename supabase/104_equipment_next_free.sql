-- =====================================================================
-- 104_equipment_next_free.sql  (safe to re-run)
-- "Available again from 8:00 PM": for the hours a customer picked, the earliest pick-up time (not before the hours they
-- chose) at which an item that is fully reserved for those hours would be free for a rental of the SAME length.
--   * Only items with nothing free for the chosen hours are returned. free_at is null when no later time was found.
--   * Tries the end of every other order's hours (an outside rental's end includes its return buffer, file 103).
--   * p_outside = true: the shifted rental is also padded with the return buffer, like equipment_available_between.
--   * An order that is overdue is not a candidate (it is out until it is returned, so no time can be promised).
--   * Informational only: nothing is reserved. Stock is checked again when the request is sent.
-- Run this once in the Supabase SQL Editor (after 103_outside_return_buffer.sql).
-- =====================================================================
create or replace function public.equipment_next_free(p_from timestamptz, p_to timestamptz, p_outside boolean default false)
returns table (equipment_id bigint, free_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  pad interval := case when p_outside then public.outside_buffer() else interval '0' end;
  dur interval;
begin
  if p_from is null or p_to is null or p_to <= p_from then
    return;
  end if;
  dur := p_to - p_from;

  return query
  select e.equipment_id,
         (select min(c.t)
            from (select w.w_end as t
                    from public.rental_detail d
                    join public.rental_order o on o.rental_order_id = d.rental_order_id
                    cross join lateral public.order_window(o.rental_order_id) w
                   where d.equipment_id = e.equipment_id
                     and d.returned_at is null
                     and o.status in ('Pending', 'Approved', 'Active')
                     and w.w_end > p_from) c
           where e.total_quantity
                 - public.equipment_in_use_between(e.equipment_id, c.t, c.t + dur + pad, null, true) >= 1)
    from public.equipment e
   where e.status = 'Available'
     and e.total_quantity - public.equipment_in_use_between(e.equipment_id, p_from, p_to + pad, null, true) < 1;
end $$;
revoke all on function public.equipment_next_free(timestamptz, timestamptz, boolean) from public, anon;
grant execute on function public.equipment_next_free(timestamptz, timestamptz, boolean) to anon, authenticated;

notify pgrst, 'reload schema';

-- end of 104_equipment_next_free.sql