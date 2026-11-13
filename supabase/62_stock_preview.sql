-- =====================================================================
-- 62_stock_preview.sql - "what would be short if I take N of this item out of stock?"  (before the return is confirmed)
-- Run once in the Supabase SQL Editor (after 61_swap_rental_item.sql). Safe to re-run.
-- The return window calls it when staff tick "Remove from stock", so they can swap the affected rentals right there.
--   p_equipment_id  the item
--   p_remove        how many units would be taken out (out of service or removed permanently)
--   p_exclude_ref   the rental being returned right now (its units are coming back, so it is left out of the count)
-- Same columns as equipment_stock_conflicts(), but rentable / short_by are worked out AFTER the removal. Nothing is changed.
-- =====================================================================
drop function if exists public.equipment_stock_preview(bigint, integer, text);
create function public.equipment_stock_preview(p_equipment_id bigint, p_remove integer, p_exclude_ref text default null)
returns table (
  equipment_id     bigint,
  equipment_name   text,
  rentable         integer,
  short_by         integer,
  rental_ref       text,
  rental_type      text,
  order_status     text,
  customer_name    text,
  w_start          timestamptz,
  w_end            timestamptz,
  quantity         integer,
  rental_detail_id bigint,
  booked_at        timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;

  return query
  with eq as (
    select e.equipment_id as eid, e.name as nm,
           greatest(e.total_quantity - greatest(coalesce(p_remove, 0), 0), 0) as cap
      from public.equipment e where e.equipment_id = p_equipment_id
  ),
  ln as (
    select d.equipment_id as eid, o.rental_order_id as ord_id, o.rental_ref as ref, o.rental_type::text as rtype,
           o.status::text as ostatus, o.customer_id as cid, sum(d.quantity)::int as qty,
           min(d.rental_detail_id) as did, o.created_at as cat,
           greatest(coalesce(w.w_start, now()), now()) as s0,
           coalesce(w.w_end, 'infinity'::timestamptz)  as e0
      from public.rental_order o
      join public.rental_detail d on d.rental_order_id = o.rental_order_id
      cross join lateral public.order_window(o.rental_order_id) w
     where d.returned_at is null
       and d.equipment_id = p_equipment_id
       and (p_exclude_ref is null or o.rental_ref <> upper(trim(p_exclude_ref)))
       and (o.status in ('Approved', 'Active')
            or (o.status = 'Pending'
                and (o.booking_id is null
                     or exists (select 1 from public.booking bk
                                 where bk.booking_id = o.booking_id
                                   and bk.status in ('Pending', 'Approved', 'In Progress')))))
       and coalesce(w.w_end, 'infinity'::timestamptz) > now()
     group by d.equipment_id, o.rental_order_id, o.rental_ref, o.rental_type, o.status, o.customer_id, o.created_at, w.w_start, w.w_end
  ),
  hot as (
    select a.s0 as p, (x.demand - q.cap)::int as over
      from ln a
      cross join eq q
      cross join lateral (select coalesce(sum(b.qty), 0) as demand from ln b
                           where b.s0 <= a.s0 and a.s0 < b.e0) x
     where x.demand > q.cap
  ),
  worst as (select max(h.over) as over from hot h)
  select ln.eid, q.nm::text, q.cap::int, wr.over::int,
         ln.ref::text, ln.rtype, ln.ostatus,
         btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, ''))::text,
         ln.s0, nullif(ln.e0, 'infinity'::timestamptz), ln.qty, ln.did, ln.cat
    from ln
    cross join eq q
    cross join worst wr
    left join public.customer c on c.customer_id = ln.cid
   where exists (select 1 from hot h where ln.s0 <= h.p and h.p < ln.e0)
   order by ln.s0, ln.ref;
end $$;
revoke all on function public.equipment_stock_preview(bigint, integer, text) from public, anon;
grant execute on function public.equipment_stock_preview(bigint, integer, text) to authenticated;

-- end of 62_stock_preview.sql
