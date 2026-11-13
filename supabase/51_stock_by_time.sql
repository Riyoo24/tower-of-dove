-- =====================================================================
-- 51_stock_by_time.sql  (safe to re-run)
-- Equipment stock is now checked FOR THE HOURS it is needed, for studio add-ons AND outside rentals.
--   Before: every Approved / In Use order counted against the stock until it was returned, whatever the day or
--           hour, and the check happened only when staff approved the order, after the customer had paid.
--   Now:    * an add-on is needed during its booking's hours, an outside rental from pick-up to return
--             (an item that is already out and overdue stays counted until it is returned)
--           * two orders only compete for the same items when their hours OVERLAP
--           * the check also runs when the customer submits the request, so "not enough" is shown BEFORE paying
--           * staff approving / issuing / recording an onsite rental are checked the same way
--           * the website asks equipment_available_between(from, to) how many are free for the chosen hours
--           * "available / in use" on the staff Equipment page now means right now (orders for later days do not
--             lower it until their hours begin)
--   Counted as holding stock: orders that are Approved (verified, waiting) or Active (issued) and not returned.
--   Pending (unverified) requests do not hold stock.
-- Run this once in the Supabase SQL Editor (after 50_addon_full_payment_when_started.sql).
-- =====================================================================

-- 1. The hours an order needs its equipment (null = unknown: such an order counts against every hour, as before) ----
create or replace function public.order_window(p_order_id bigint)
returns table (w_start timestamptz, w_end timestamptz)
language sql stable security definer set search_path = public as $$
  select
    case when o.status = 'Active' and s.v is not null then least(s.v, now()) else s.v end,       -- issued early: out from now
    case when o.status = 'Active' and s.v is not null then greatest(e.v, now()) else e.v end      -- overdue: still out until returned
  from public.rental_order o
  left join public.booking b on b.booking_id = o.booking_id
  cross join lateral (select case when o.rental_type = 'Outside' then o.pickup_date else b.start_at end as v) s
  cross join lateral (select case when o.rental_type = 'Outside' then o.return_date else b.end_at end as v) e
  where o.rental_order_id = p_order_id;
$$;
revoke all on function public.order_window(bigint) from public, anon;
grant execute on function public.order_window(bigint) to authenticated;

-- 2. Quantity held by other orders that overlap [p_from, p_to) ----------------------------------------------------
create or replace function public.equipment_in_use_between(
  p_equipment_id bigint, p_from timestamptz, p_to timestamptz, p_exclude_order bigint default null
) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(sum(d.quantity), 0)::int
    from public.rental_detail d
    join public.rental_order o on o.rental_order_id = d.rental_order_id
    cross join lateral public.order_window(o.rental_order_id) w
   where d.equipment_id = p_equipment_id
     and o.status in ('Approved', 'Active')
     and d.returned_at is null
     and (p_exclude_order is null or o.rental_order_id <> p_exclude_order)
     and (w.w_start is null or w.w_end is null
          or p_from is null or p_to is null
          or (w.w_start < p_to and p_from < w.w_end));
$$;
revoke all on function public.equipment_in_use_between(bigint, timestamptz, timestamptz, bigint) from public, anon;
grant execute on function public.equipment_in_use_between(bigint, timestamptz, timestamptz, bigint) to anon, authenticated;

-- 3. "In use" for the stock list = right now (v_equipment_stock and the staff Equipment page use this) -------------
create or replace function public.equipment_in_use(p_equipment_id bigint, p_exclude_order bigint default null)
returns integer language sql stable security definer set search_path = public as $$
  select public.equipment_in_use_between(p_equipment_id, now(), now() + interval '1 minute', p_exclude_order);
$$;

-- 4. How many of each item are free for the given hours (the website calls this) ----------------------------------
create or replace function public.equipment_available_between(p_from timestamptz, p_to timestamptz)
returns table (equipment_id bigint, available integer)
language sql stable security definer set search_path = public as $$
  select e.equipment_id,
         greatest(e.total_quantity - public.equipment_in_use_between(e.equipment_id, p_from, p_to, null), 0)::int
    from public.equipment e;
$$;
revoke all on function public.equipment_available_between(timestamptz, timestamptz) from public, anon;
grant execute on function public.equipment_available_between(timestamptz, timestamptz) to anon, authenticated;

-- 5. Approving / issuing an order is checked for ITS hours --------------------------------------------------------
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
    in_use := public.equipment_in_use_between(r.equipment_id, w.w_start, w.w_end, p_order_id);
    if r.status <> 'Available' then
      raise exception '% is not available for rent right now.', r.name using errcode = 'P0001';
    end if;
    if in_use + r.quantity > r.total_quantity then
      raise exception 'Only % of % available for the hours of this order, but it needs %.',
        greatest(r.total_quantity - in_use, 0), r.name, r.quantity using errcode = 'P0001';
    end if;
  end loop;
end $$;

-- 6. The customer's request is checked when it is submitted (same function as file 02, plus the hours check) ------
create or replace function public.request_rental(
  p_type text, p_items jsonb,
  p_booking_ref text default null,
  p_first_name text default null, p_last_name text default null, p_number text default null,
  p_pickup_date timestamptz default null, p_return_date timestamptz default null,
  p_contact_number text default null, p_backup_contact text default null,
  p_id_type text default null, p_id_image_path text default null
) returns table (rental_order_id bigint, rental_ref text, total_amount numeric)
language plpgsql security definer set search_path = public as $$
declare
  o public.rental_order; bk public.booking; cid bigint;
  it jsonb; eq public.equipment; qty int; rate numeric; hrs numeric; min_h int := 0;
  w_s timestamptz; w_e timestamptz; taken int;   -- the hours the equipment is needed
begin
  if p_type not in ('Add-on', 'Outside') then
    raise exception 'Choose Add-on or Outside.' using errcode = 'P0001';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one item.' using errcode = 'P0001';
  end if;

  if p_type = 'Add-on' then
    select * into bk from public.booking where booking_ref = upper(regexp_replace(coalesce(p_booking_ref, ''), '\s', '', 'g'));
    if not found then raise exception 'Booking reference not found.' using errcode = 'P0001'; end if;
    if bk.status not in ('Pending', 'Approved', 'In Progress') then
      raise exception 'Add-ons need an active booking. This one is %.', bk.status using errcode = 'P0001';
    end if;
    if public.current_customer_id() is not null and bk.customer_id <> public.current_customer_id() then
      raise exception 'That is not your booking.' using errcode = '42501';
    end if;
    cid := bk.customer_id;
    w_s := bk.start_at; w_e := bk.end_at;          -- an add-on is needed for the whole session
  else
    if p_pickup_date is null or p_return_date is null or p_return_date <= p_pickup_date then
      raise exception 'Choose valid pickup and return times.' using errcode = 'P0001';
    end if;
    if p_pickup_date < now() - interval '1 hour' then
      raise exception 'Pickup cannot be in the past.' using errcode = 'P0001';
    end if;
    if nullif(trim(coalesce(p_contact_number, '')), '') is null
       or p_contact_number !~ '^[0-9+()\s-]{7,20}$' then
      raise exception 'Enter a valid contact number.' using errcode = 'P0001';
    end if;
    if p_backup_contact is not null and p_backup_contact <> '' and p_backup_contact !~ '^[0-9+()\s-]{7,20}$' then
      raise exception 'Enter a valid backup contact number.' using errcode = 'P0001';
    end if;
    if nullif(trim(coalesce(p_id_type, '')), '') is null then
      raise exception 'Choose the type of ID you will show.' using errcode = 'P0001';
    end if;
    if p_id_image_path is null or p_id_image_path !~ '^[A-Za-z0-9/_.-]{5,200}$' or p_id_image_path like '%..%' then
      raise exception 'Attach a photo of your valid ID.' using errcode = 'P0001';
    end if;
    cid := public.resolve_customer(p_first_name, p_last_name, coalesce(p_number, p_contact_number), false);
    w_s := p_pickup_date; w_e := p_return_date;    -- an outside rental is needed from pick-up to return
  end if;

  insert into public.rental_order (rental_ref, customer_id, rental_type, booking_id, status, source,
                                   pickup_date, return_date, contact_number, backup_contact, id_type, id_image_path)
  values ('', cid, p_type, bk.booking_id, 'Pending', 'Online',
          p_pickup_date, p_return_date, nullif(trim(p_contact_number), ''), nullif(trim(p_backup_contact), ''),
          nullif(trim(p_id_type), ''), p_id_image_path)
  returning * into o;

  for it in select * from jsonb_array_elements(p_items) loop
    qty := (it ->> 'quantity')::int;
    select * into eq from public.equipment where equipment_id = (it ->> 'equipment_id')::bigint;
    if not found then raise exception 'Equipment not found.' using errcode = 'P0001'; end if;
    if qty is null or qty < 1 then raise exception 'Quantity must be at least 1.' using errcode = 'P0001'; end if;
    if eq.status <> 'Available' then raise exception '% is not available for rent.', eq.name using errcode = 'P0001'; end if;
    if qty > eq.total_quantity then raise exception 'We only own % of %.', eq.total_quantity, eq.name using errcode = 'P0001'; end if;
    -- NEW: enough must be free for THOSE hours (other approved / issued add-ons and outside rentals that overlap them count)
    taken := public.equipment_in_use_between(eq.equipment_id, w_s, w_e, null);
    if taken + qty > eq.total_quantity then
      raise exception 'Only % of % available for those hours (the rest is already reserved by another booking or rental). Choose a smaller quantity, other hours, or another item.',
        greatest(eq.total_quantity - taken, 0), eq.name using errcode = 'P0001';
    end if;

    if p_type = 'Add-on' then
      if not eq.allow_addon then raise exception '% cannot be rented as an add-on.', eq.name using errcode = 'P0001'; end if;
      rate := eq.add_on_rate; hrs := null;
    else
      if not eq.allow_outside then raise exception '% cannot be rented outside the studio.', eq.name using errcode = 'P0001'; end if;
      rate := eq.outside_rate;
      hrs  := round(extract(epoch from (p_return_date - p_pickup_date)) / 3600.0, 2);
      min_h := greatest(min_h, eq.min_hours);
    end if;

    insert into public.rental_detail (rental_order_id, equipment_id, quantity, unit_price_at_request, rental_hours)
    values (o.rental_order_id, eq.equipment_id, qty, rate, hrs);
  end loop;

  if p_type = 'Outside' and extract(epoch from (p_return_date - p_pickup_date)) / 3600.0 < min_h then
    raise exception 'Outside rentals are at least % hours.', min_h using errcode = 'P0001';
  end if;

  return query select o.rental_order_id, o.rental_ref::text, public.rental_order_total(o.rental_order_id);
exception when unique_violation then
  raise exception 'Each item can only be listed once per request.' using errcode = 'P0001';
end $$;

-- keeps the same permissions as before (re-stated so the file is safe to run on its own)
revoke all on function public.request_rental(text, jsonb, text, text, text, text, timestamptz, timestamptz, text, text, text, text) from public, anon, authenticated;
grant execute on function public.request_rental(text, jsonb, text, text, text, text, timestamptz, timestamptz, text, text, text, text) to anon, authenticated;
