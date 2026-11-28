-- =====================================================================
-- 103_outside_return_buffer.sql  (safe to re-run)
-- A return buffer for OUTSIDE rentals only (studio add-ons are not affected: they stay in the studio).
--   * An outside rental holds its items from pick-up until its return time PLUS the buffer (default 120 minutes).
--     Example: rented 10:00 AM to 6:00 PM -> the same item (no other stock) can be rented from 8:00 PM.
--   * Returned items free the stock IMMEDIATELY (the buffer only covers an item that is not back yet).
--   * Not returned after the buffer: it stays counted until it is returned (as before, file 51).
--   * The customer's own return deadline does not change. The buffer is internal.
--   * Length: app_setting 'outside_return_buffer_minutes' (0 to 1440). Owner-changeable, see below.
--   * Everything that already uses order_window() follows (approve / issue, swaps, stock shortage list, rescheduling).
--   * request_rental(), hold_equipment() and equipment_available_between() pad the NEW outside rental the same way.
-- Run this once in the Supabase SQL Editor (after 102_onsite_customer_account.sql).
-- =====================================================================

-- 1. the setting ------------------------------------------------------------------------------------------------
insert into public.app_setting (key, value) values ('outside_return_buffer_minutes', '120') on conflict (key) do nothing;

create or replace function public.outside_buffer() returns interval
language sql stable security definer set search_path = public as $$
  select make_interval(mins => greatest(0, least(1440, coalesce(
    (select case when trim(value) ~ '^[0-9]{1,4}$' then trim(value)::int end
       from public.app_setting where key = 'outside_return_buffer_minutes'), 120))));
$$;
revoke all on function public.outside_buffer() from public, anon, authenticated;

-- 2. the hours an order needs its equipment: an outside rental also needs it during the buffer ---------------------
create or replace function public.order_window(p_order_id bigint)
returns table (w_start timestamptz, w_end timestamptz)
language sql stable security definer set search_path = public as $$
  select
    case when o.status = 'Active' and s.v is not null then least(s.v, now()) else s.v end,       -- issued early: out from now
    case when o.status = 'Active' and s.v is not null then greatest(e.v, now()) else e.v end      -- overdue: still out until returned (buffer included)
  from public.rental_order o
  left join public.booking b on b.booking_id = o.booking_id
  cross join lateral (select case when o.rental_type = 'Outside' then o.pickup_date else b.start_at end as v) s
  cross join lateral (select case when o.rental_type = 'Outside' then o.return_date + public.outside_buffer()   -- return buffer (outside rentals only)
                                  else greatest(b.end_at - make_interval(hours => o.addon_cut_hours), b.start_at) end as v) e
  where o.rental_order_id = p_order_id;
$$;

-- 3. checkout hold: p_outside = true pads the hold with the buffer ---------------------------------------------------
drop function if exists public.hold_equipment(jsonb, timestamptz, timestamptz, text);
create or replace function public.hold_equipment(p_items jsonb, p_start_at timestamptz, p_end_at timestamptz, p_token text, p_outside boolean default false)
returns boolean language plpgsql security definer set search_path = public as $$
declare it jsonb; eq public.equipment; qty int; taken int; w_e timestamptz;
begin
  if p_token is null or length(p_token) < 8 or length(p_token) > 80 then
    raise exception 'Missing hold token.' using errcode = 'P0001';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 50 then
    raise exception 'Add at least one item.' using errcode = 'P0001';
  end if;
  if p_start_at is null or p_end_at is null or p_end_at <= p_start_at then
    raise exception 'Choose valid hours.' using errcode = 'P0001';
  end if;

  -- an outside rental also holds the item during its return buffer (add-ons: no buffer)
  w_e := case when p_outside then p_end_at + public.outside_buffer() else p_end_at end;

  -- same lock as request_rental(): equipment rows in id order, so two checkouts cannot both take the last item
  perform 1 from public.equipment
   where equipment_id in (select (x ->> 'equipment_id')::bigint from jsonb_array_elements(p_items) x)
   order by equipment_id for update;

  delete from public.equipment_hold where expires_at < now() or token = p_token;

  for it in select * from jsonb_array_elements(p_items) loop
    qty := (it ->> 'quantity')::int;
    select * into eq from public.equipment where equipment_id = (it ->> 'equipment_id')::bigint;
    if not found or qty is null or qty < 1 or eq.status <> 'Available' or qty > eq.total_quantity then
      return false;
    end if;
    taken := public.equipment_in_use_between(eq.equipment_id, p_start_at, w_e, null)
           + public.equipment_held_by_checkout(eq.equipment_id, p_start_at, w_e, p_token);
    if taken + qty > eq.total_quantity then
      return false;
    end if;
  end loop;

  insert into public.equipment_hold (token, equipment_id, quantity, start_at, end_at, expires_at)
  select p_token, (x ->> 'equipment_id')::bigint, (x ->> 'quantity')::int, p_start_at, w_e, now() + interval '2 minutes'
    from jsonb_array_elements(p_items) x;
  return true;
end $$;
revoke all on function public.hold_equipment(jsonb, timestamptz, timestamptz, text, boolean) from public, anon, authenticated;
grant execute on function public.hold_equipment(jsonb, timestamptz, timestamptz, text, boolean) to anon, authenticated;

-- 4. free count for the hours: p_outside = true pads the asked hours with the buffer ----------------------------------
drop function if exists public.equipment_available_between(timestamptz, timestamptz, text);
create or replace function public.equipment_available_between(
  p_from timestamptz, p_to timestamptz, p_token text default null, p_outside boolean default false
) returns table (equipment_id bigint, available integer)
language sql stable security definer set search_path = public as $$
  select e.equipment_id,
         greatest(e.total_quantity
                  - public.equipment_in_use_between(e.equipment_id, p_from,
                      case when p_outside and p_to is not null then p_to + public.outside_buffer() else p_to end, null, true)
                  - public.equipment_held_by_checkout(e.equipment_id, p_from,
                      case when p_outside and p_to is not null then p_to + public.outside_buffer() else p_to end, p_token), 0)::int
    from public.equipment e;
$$;
revoke all on function public.equipment_available_between(timestamptz, timestamptz, text, boolean) from public, anon;
grant execute on function public.equipment_available_between(timestamptz, timestamptz, text, boolean) to anon, authenticated;

-- 5. request_rental(): latest body (file 100) with ONE change: an outside rental is checked with its buffer ----------
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
  tok text := nullif(current_setting('app.eq_hold_token', true), '');   -- this browser's equipment hold (file 89)
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
    -- B-03: the renter's contact number must be a real 11-digit Philippine mobile number
    if nullif(trim(coalesce(p_contact_number, '')), '') is null
       or public.digits(p_contact_number) !~ '^09[0-9]{9}$' then
      raise exception 'Enter a valid 11-digit Philippine mobile number (e.g. 0917 123 4567).' using errcode = 'P0001';
    end if;
    if p_backup_contact is not null and p_backup_contact <> '' and p_backup_contact !~ '^[0-9+()\s-]{7,20}$' then
      raise exception 'Enter a valid backup contact number.' using errcode = 'P0001';
    end if;
    if nullif(public.digits(p_backup_contact), '') is not null
       and public.digits(p_backup_contact) = public.digits(p_contact_number) then
      raise exception 'The backup contact number must be different from your contact number.' using errcode = 'P0001';
    end if;
    if nullif(trim(coalesce(p_id_type, '')), '') is null then
      raise exception 'Choose the type of ID you will show.' using errcode = 'P0001';
    end if;
    if p_id_image_path is null or p_id_image_path !~ '^[A-Za-z0-9/_.-]{5,200}$' or p_id_image_path like '%..%' then
      raise exception 'Attach a photo of your valid ID.' using errcode = 'P0001';
    end if;
    cid := public.resolve_customer(p_first_name, p_last_name, coalesce(p_number, p_contact_number), false);
    w_s := p_pickup_date; w_e := p_return_date + public.outside_buffer();    -- an outside rental is needed from pick-up to return, plus the return buffer (file 103)
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
    -- file 89: other customers' checkout holds count too (this browser's own hold does not)
    taken := public.equipment_in_use_between(eq.equipment_id, w_s, w_e, null)
           + public.equipment_held_by_checkout(eq.equipment_id, w_s, w_e, tok);
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

  -- the order itself holds the items now, so the checkout hold is no longer needed
  if tok is not null then delete from public.equipment_hold where token = tok; end if;

  return query select o.rental_order_id, o.rental_ref::text, public.rental_order_total(o.rental_order_id);
exception when unique_violation then
  raise exception 'Each item can only be listed once per request.' using errcode = 'P0001';
end $$;

-- let the API see the new signatures right away
notify pgrst, 'reload schema';

-- end of 103_outside_return_buffer.sql