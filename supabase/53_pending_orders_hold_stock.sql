-- =====================================================================
-- 53_pending_orders_hold_stock.sql  (safe to re-run)
-- A Pending add-on / outside-rental request now HOLDS its equipment, so a customer who has submitted and paid
-- can no longer lose the items just because staff were slow to verify.
--   Before (file 51): only Approved / Active orders held stock. Two customers could both be told "available",
--                     both pay, and the second one was refused only when staff verified the payment.
--   Now:    * a Pending order holds its items for its hours (studio add-on: the booking's hours, outside rental:
--             pick-up to return) from the moment it is submitted, until staff verify it (Approved) or it is
--             Rejected / Cancelled. There is NO time limit, so slow staff never cost the customer the items.
--           * a Pending add-on whose booking is Rejected / Cancelled / Completed holds nothing (no stale holds).
--           * the next customer sees "not enough" when they submit, BEFORE paying.
--           * extending / rescheduling a booking also respects other customers' Pending orders, and the
--             booking's own Pending add-on is re-checked for the new hours.
--           * staff approving an order are checked against Approved / Active orders only (the Pending ones were
--             already checked when submitted), so approving never fails because of another waiting request.
--           * the staff Equipment page "In use" still means items actually Approved / issued right now.
-- Run this once in the Supabase SQL Editor (after 52_stock_on_booking_time_change.sql).
-- =====================================================================

-- 1. Quantity held by other orders that overlap [p_from, p_to). Pending orders count unless p_include_pending = false -----
drop function if exists public.equipment_in_use_between(bigint, timestamptz, timestamptz, bigint);

create or replace function public.equipment_in_use_between(
  p_equipment_id bigint, p_from timestamptz, p_to timestamptz, p_exclude_order bigint default null,
  p_include_pending boolean default true
) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(sum(d.quantity), 0)::int
    from public.rental_detail d
    join public.rental_order o on o.rental_order_id = d.rental_order_id
    cross join lateral public.order_window(o.rental_order_id) w
   where d.equipment_id = p_equipment_id
     and (o.status in ('Approved', 'Active')
          or (p_include_pending and o.status = 'Pending'
              and (o.booking_id is null
                   or exists (select 1 from public.booking bk
                               where bk.booking_id = o.booking_id
                                 and bk.status in ('Pending', 'Approved', 'In Progress')))))
     and d.returned_at is null
     and (p_exclude_order is null or o.rental_order_id <> p_exclude_order)
     and (w.w_start is null or w.w_end is null
          or p_from is null or p_to is null
          or (w.w_start < p_to and p_from < w.w_end));
$$;
revoke all on function public.equipment_in_use_between(bigint, timestamptz, timestamptz, bigint, boolean) from public, anon;
grant execute on function public.equipment_in_use_between(bigint, timestamptz, timestamptz, bigint, boolean) to anon, authenticated;

-- 2. "In use" for the stock list = Approved / issued orders right now (Pending requests are not "in use") --------------
create or replace function public.equipment_in_use(p_equipment_id bigint, p_exclude_order bigint default null)
returns integer language sql stable security definer set search_path = public as $$
  select public.equipment_in_use_between(p_equipment_id, now(), now() + interval '1 minute', p_exclude_order, false);
$$;

-- 3. How many of each item are free for the given hours (the website calls this): Pending requests count --------------
create or replace function public.equipment_available_between(p_from timestamptz, p_to timestamptz)
returns table (equipment_id bigint, available integer)
language sql stable security definer set search_path = public as $$
  select e.equipment_id,
         greatest(e.total_quantity - public.equipment_in_use_between(e.equipment_id, p_from, p_to, null, true), 0)::int
    from public.equipment e;
$$;
revoke all on function public.equipment_available_between(timestamptz, timestamptz) from public, anon;
grant execute on function public.equipment_available_between(timestamptz, timestamptz) to anon, authenticated;

-- 4. Approving / issuing an order: compared with Approved / Active orders only (Pending ones were checked on submit) ---
create or replace function public.assert_order_stock(p_order_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare r record; in_use int; w record;
begin
  select * into w from public.order_window(p_order_id);
  for r in
    select d.equipment_id, d.quantity, e.name, e.total_quantity, e.status
    from public.rental_detail d
    join public.equipment e on e.equipment_id = d.equipment_id
    where d.rental_order_id = p_order_id and d.returned_at is null
    order by d.equipment_id
  loop
    -- lock the equipment row so two approvals cannot both take the last item
    perform 1 from public.equipment where equipment_id = r.equipment_id for update;
    in_use := public.equipment_in_use_between(r.equipment_id, w.w_start, w.w_end, p_order_id, false);
    if r.status <> 'Available' then
      raise exception '% is not available for rent right now.', r.name using errcode = 'P0001';
    end if;
    if in_use + r.quantity > r.total_quantity then
      raise exception 'Only % of % available for the hours of this order, but it needs %.',
        greatest(r.total_quantity - in_use, 0), r.name, r.quantity using errcode = 'P0001';
    end if;
  end loop;
end $$;

-- 5. Held by OTHER bookings' / rentals' orders (extend / reschedule check): Pending orders count ----------------------
create or replace function public.equipment_held_by_others(
  p_equipment_id bigint, p_from timestamptz, p_to timestamptz, p_exclude_booking bigint
) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(sum(d.quantity), 0)::int
    from public.rental_detail d
    join public.rental_order o on o.rental_order_id = d.rental_order_id
    cross join lateral public.order_window(o.rental_order_id) w
   where d.equipment_id = p_equipment_id
     and (o.status in ('Approved', 'Active')
          or (o.status = 'Pending'
              and (o.booking_id is null
                   or exists (select 1 from public.booking bk
                               where bk.booking_id = o.booking_id
                                 and bk.status in ('Pending', 'Approved', 'In Progress')))))
     and d.returned_at is null
     and o.booking_id is distinct from p_exclude_booking
     and (w.w_start is null or w.w_end is null
          or p_from is null or p_to is null
          or (w.w_start < p_to and p_from < w.w_end));
$$;
revoke all on function public.equipment_held_by_others(bigint, timestamptz, timestamptz, bigint) from public, anon, authenticated;

-- 6. Is the add-on equipment of a booking free for its new hours?  The booking's own Pending add-on is included now ----
create or replace function public.booking_stock_conflict(
  p_booking_id bigint, p_new_start timestamptz, p_new_end timestamptz,
  p_old_start timestamptz default null, p_old_end timestamptz default null
) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  r record;
  seg_from timestamptz[] := array[]::timestamptz[];
  seg_to   timestamptz[] := array[]::timestamptz[];
  i integer; held integer;
begin
  if p_booking_id is null or p_new_start is null or p_new_end is null then
    return null;
  end if;

  if p_old_start is null or p_old_end is null then
    seg_from := array[p_new_start];
    seg_to   := array[p_new_end];
  else
    if p_new_start < p_old_start then                       -- the session now starts earlier
      seg_from := seg_from || p_new_start;
      seg_to   := seg_to   || least(p_old_start, p_new_end);
    end if;
    if p_new_end > p_old_end then                           -- the session now ends later
      seg_from := seg_from || greatest(p_old_end, p_new_start);
      seg_to   := seg_to   || p_new_end;
    end if;
  end if;

  -- the equipment this booking holds right now (its Pending, Approved and issued add-on orders, per item)
  for r in
    select d.equipment_id, e.name, e.total_quantity, sum(d.quantity)::int as qty
      from public.rental_order o
      join public.rental_detail d on d.rental_order_id = o.rental_order_id
      join public.equipment e on e.equipment_id = d.equipment_id
     where o.booking_id = p_booking_id
       and o.status in ('Pending', 'Approved', 'Active')
       and d.returned_at is null
     group by d.equipment_id, e.name, e.total_quantity
     order by e.name
  loop
    for i in 1 .. coalesce(array_length(seg_from, 1), 0) loop
      held := public.equipment_held_by_others(r.equipment_id, seg_from[i], seg_to[i], p_booking_id);
      if held + r.qty > r.total_quantity then
        return 'Only ' || greatest(r.total_quantity - held, 0) || ' of ' || r.name || ' would be free from '
               || to_char(seg_from[i] at time zone 'Asia/Manila', 'FMMon FMDD, FMHH12:MI AM') || ' to '
               || to_char(seg_to[i] at time zone 'Asia/Manila', 'FMHH12:MI AM')
               || ' (the rest is reserved by another booking or rental), but this booking''s add-on needs ' || r.qty || '.';
      end if;
    end loop;
  end loop;

  return null;
end $$;
revoke all on function public.booking_stock_conflict(bigint, timestamptz, timestamptz, timestamptz, timestamptz) from public, anon, authenticated;

-- end of 53_pending_orders_hold_stock.sql
