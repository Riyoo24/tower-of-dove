-- =====================================================================
-- 80_lock_equipment_on_request.sql  (safe to re-run)
-- Fixes a last-item race in request_rental(): the stock check and the insert were not serialised, so two
-- simultaneous requests could both pass the check. Only the lock is new; the rest is the unchanged function
-- from 51_stock_by_time.sql.
-- =====================================================================

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

  -- QA fix: lock the requested equipment rows (always in id order, so two requests cannot deadlock) BEFORE counting
  -- what is free. Without this, two customers asking for the last item at the same moment (even for two different
  -- studios) both saw it free and both got a Pending request.
  perform 1 from public.equipment
   where equipment_id in (select (x ->> 'equipment_id')::bigint from jsonb_array_elements(p_items) x)
   order by equipment_id for update;

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
