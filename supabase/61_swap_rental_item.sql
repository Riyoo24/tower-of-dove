-- =====================================================================
-- 61_swap_rental_item.sql - swap an item on a rental for an equivalent one, at no extra charge
-- Run once in the Supabase SQL Editor (after 60_out_of_service_stock.sql). Safe to re-run.
--
-- Why: when a unit is damaged and other customers have already booked it, there are no refunds, so the fix is to give those
-- customers a similar (or better) item instead. Staff pick the rental and the replacement; the customer keeps the price they
-- agreed to (nothing is charged and nothing is refunded). The old unit's place is simply taken by the new item.
--
-- What it adds
--   1. rental_item_swap          a log of every swap (who, when, why, old item, new item). Shown in the rental's History.
--   2. staff_swap_options()      the items that can replace a rental line: allowed for that rental type, rentable, and FREE for
--                                the hours of that rental (same category first).
--   3. staff_swap_rental_item()  does the swap in one transaction. Only a rental that has not been issued yet (Pending / Approved).
--   4. equipment_stock_conflicts() is replaced: it now also returns rental_detail_id (to swap straight from the warning) and
--                                booked_at (when the order was made, so staff can keep the earliest bookings first).
-- =====================================================================

-- 1. log ------------------------------------------------------------------------------------------------------------
create table if not exists public.rental_item_swap (
  swap_id          bigint generated always as identity primary key,
  rental_order_id  bigint not null references public.rental_order (rental_order_id) on delete cascade,
  rental_ref       varchar(30) not null,
  rental_detail_id bigint references public.rental_detail (rental_detail_id) on delete set null,
  old_equipment_id bigint references public.equipment (equipment_id) on delete set null,
  new_equipment_id bigint references public.equipment (equipment_id) on delete set null,
  old_name         text not null,
  new_name         text not null,
  quantity         integer not null,
  reason           text,
  by_user_id       bigint references public.app_user (user_id) on delete set null,
  created_at       timestamptz not null default now()
);
create index if not exists rental_item_swap_order_idx on public.rental_item_swap (rental_order_id);

alter table public.rental_item_swap enable row level security;
drop policy if exists rental_item_swap_select on public.rental_item_swap;
create policy rental_item_swap_select on public.rental_item_swap for select to authenticated using (public.is_staff());
revoke all on public.rental_item_swap from anon;
grant select on public.rental_item_swap to authenticated;

-- 2. what can replace this line? ------------------------------------------------------------------------------------------
drop function if exists public.staff_swap_options(bigint);
create function public.staff_swap_options(p_rental_detail_id bigint)
returns table (equipment_id bigint, name text, category_name text, same_category boolean, free integer, rate numeric)
language plpgsql stable security definer set search_path = public as $$
declare
  ln record;
  w  record;
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;

  select d.rental_order_id as ord_id, d.equipment_id as eid, d.quantity as qty, o.rental_type::text as rtype, e.category_id as cid
    into ln
    from public.rental_detail d
    join public.rental_order o on o.rental_order_id = d.rental_order_id
    join public.equipment e on e.equipment_id = d.equipment_id
   where d.rental_detail_id = p_rental_detail_id;
  if not found then raise exception 'Rental item not found.' using errcode = 'P0001'; end if;

  select * into w from public.order_window(ln.ord_id);

  return query
  select q.eqid, q.nm, q.cat, q.same, q.fr, q.rt
    from (
      select e.equipment_id as eqid, e.name::text as nm, c.category_name::text as cat,
             (e.category_id = ln.cid) as same,
             greatest(e.total_quantity - public.equipment_in_use_between(e.equipment_id, w.w_start, w.w_end, ln.ord_id, true), 0)::int as fr,
             (case when ln.rtype = 'Add-on' then e.add_on_rate else e.outside_rate end)::numeric as rt
        from public.equipment e
        join public.equipment_category c on c.category_id = e.category_id
       where e.status = 'Available'
         and e.equipment_id <> ln.eid
         and ((ln.rtype = 'Add-on' and e.allow_addon) or (ln.rtype = 'Outside' and e.allow_outside))
         and not exists (select 1 from public.rental_detail x
                          where x.rental_order_id = ln.ord_id and x.equipment_id = e.equipment_id)
    ) q
   where q.fr >= ln.qty
   order by q.same desc, q.nm;
end $$;
revoke all on function public.staff_swap_options(bigint) from public, anon;
grant execute on function public.staff_swap_options(bigint) to authenticated;

-- 3. the swap ------------------------------------------------------------------------------------------------------------
drop function if exists public.staff_swap_rental_item(bigint, bigint, text);
create function public.staff_swap_rental_item(
  p_rental_detail_id bigint,
  p_new_equipment_id bigint,
  p_reason           text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  ln   record;
  o    public.rental_order;
  oe   public.equipment;
  ne   public.equipment;
  w    record;
  used int;
  why  text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  if why is null then raise exception 'Enter a reason for the swap.' using errcode = 'P0001'; end if;

  select d.rental_detail_id as did, d.rental_order_id as ord_id, d.equipment_id as eid, d.quantity as qty,
         d.returned_at as ret, d.before_photo_path as bpath
    into ln from public.rental_detail d where d.rental_detail_id = p_rental_detail_id;
  if not found then raise exception 'Rental item not found.' using errcode = 'P0001'; end if;

  select * into o from public.rental_order where rental_order_id = ln.ord_id for update;
  if o.status not in ('Pending', 'Approved') then
    raise exception 'Only a rental that has not been issued yet can have an item swapped (this one is %).', o.status using errcode = 'P0001';
  end if;
  if ln.ret is not null or ln.bpath is not null then
    raise exception 'This item was already issued or returned, so it cannot be swapped.' using errcode = 'P0001';
  end if;
  if p_new_equipment_id is null or p_new_equipment_id = ln.eid then
    raise exception 'Choose a different item to swap in.' using errcode = 'P0001';
  end if;

  -- lock both items (in id order, so two staff swapping at once cannot deadlock)
  perform 1 from public.equipment where equipment_id in (ln.eid, p_new_equipment_id) order by equipment_id for update;
  select * into oe from public.equipment where equipment_id = ln.eid;
  select * into ne from public.equipment where equipment_id = p_new_equipment_id;
  if not found then raise exception 'Equipment not found.' using errcode = 'P0001'; end if;

  if ne.status <> 'Available' then raise exception '% is not available for rent.', ne.name using errcode = 'P0001'; end if;
  if o.rental_type = 'Add-on' and not ne.allow_addon then
    raise exception '% cannot be rented as an add-on.', ne.name using errcode = 'P0001';
  end if;
  if o.rental_type = 'Outside' and not ne.allow_outside then
    raise exception '% cannot be rented outside the studio.', ne.name using errcode = 'P0001';
  end if;
  if exists (select 1 from public.rental_detail x where x.rental_order_id = o.rental_order_id and x.equipment_id = ne.equipment_id) then
    raise exception '% is already on this rental. Choose another item.', ne.name using errcode = 'P0001';
  end if;

  -- enough must be free for THE HOURS of this rental
  select * into w from public.order_window(o.rental_order_id);
  used := public.equipment_in_use_between(ne.equipment_id, w.w_start, w.w_end, o.rental_order_id, true);
  if used + ln.qty > ne.total_quantity then
    raise exception 'Only % of % are free for the hours of this rental, but it needs %.',
      greatest(ne.total_quantity - used, 0), ne.name, ln.qty using errcode = 'P0001';
  end if;

  -- the swap: the line keeps its quantity, price and hours, so the customer pays and is owed nothing extra
  update public.rental_detail set equipment_id = ne.equipment_id where rental_detail_id = ln.did;

  insert into public.rental_item_swap
    (rental_order_id, rental_ref, rental_detail_id, old_equipment_id, new_equipment_id, old_name, new_name, quantity, reason, by_user_id)
  values (o.rental_order_id, o.rental_ref, ln.did, oe.equipment_id, ne.equipment_id, oe.name, ne.name, ln.qty, why, public.current_app_user_id());
end $$;
revoke all on function public.staff_swap_rental_item(bigint, bigint, text) from public, anon;
grant execute on function public.staff_swap_rental_item(bigint, bigint, text) to authenticated;

-- 4. the shortage list, now with the line id and when the order was made -----------------------------------------------
drop function if exists public.equipment_stock_conflicts(bigint);
create function public.equipment_stock_conflicts(p_equipment_id bigint default null)
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
  with ln as (
    select d.equipment_id as eid, o.rental_order_id as ord_id, o.rental_ref as ref, o.rental_type::text as rtype,
           o.status::text as ostatus, o.customer_id as cid, sum(d.quantity)::int as qty,
           min(d.rental_detail_id) as did, o.created_at as cat,
           greatest(coalesce(w.w_start, now()), now()) as s0,
           coalesce(w.w_end, 'infinity'::timestamptz)  as e0
      from public.rental_order o
      join public.rental_detail d on d.rental_order_id = o.rental_order_id
      cross join lateral public.order_window(o.rental_order_id) w
     where d.returned_at is null
       and (p_equipment_id is null or d.equipment_id = p_equipment_id)
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
    select a.eid, a.s0 as p, (x.demand - e.total_quantity)::int as over
      from ln a
      join public.equipment e on e.equipment_id = a.eid
      cross join lateral (select coalesce(sum(b.qty), 0) as demand from ln b
                           where b.eid = a.eid and b.s0 <= a.s0 and a.s0 < b.e0) x
     where x.demand > e.total_quantity
  ),
  worst as (select h.eid, max(h.over) as over from hot h group by h.eid)
  select ln.eid, e.name::text, e.total_quantity::int, wr.over::int,
         ln.ref::text, ln.rtype, ln.ostatus,
         btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, ''))::text,
         ln.s0, nullif(ln.e0, 'infinity'::timestamptz), ln.qty, ln.did, ln.cat
    from ln
    join public.equipment e on e.equipment_id = ln.eid
    join worst wr on wr.eid = ln.eid
    left join public.customer c on c.customer_id = ln.cid
   where exists (select 1 from hot h where h.eid = ln.eid and ln.s0 <= h.p and h.p < ln.e0)
   order by e.name, ln.s0, ln.ref;
end $$;
revoke all on function public.equipment_stock_conflicts(bigint) from public, anon;
grant execute on function public.equipment_stock_conflicts(bigint) to authenticated;

-- end of 61_swap_rental_item.sql
