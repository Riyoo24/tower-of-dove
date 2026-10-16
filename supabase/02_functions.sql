-- =====================================================================
-- Tower of Dove Music Studio: Supabase schema
-- File 2 of 4: RPC functions (what the website calls) and views
--
-- Call from supabase-js with  supabase.rpc('function_name', { p_... })
-- All of these are SECURITY DEFINER and validate their own input, so the
-- tables themselves stay locked down (see 03_security.sql).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Internal helpers (not exposed to the website)
-- ---------------------------------------------------------------------

-- Opening hours 10:00 to 22:00 Manila, whole hours, 1 to 4 hours, same day.
create or replace function public.validate_slot(p_start timestamptz, p_end timestamptz, p_allow_current_hour boolean default false)
returns void language plpgsql stable set search_path = public as $$
declare
  s timestamp := p_start at time zone 'Asia/Manila';
  e timestamp := p_end   at time zone 'Asia/Manila';
  hrs numeric := extract(epoch from (p_end - p_start)) / 3600.0;
begin
  if p_start is null or p_end is null or p_end <= p_start then
    raise exception 'Choose a valid start and end time.' using errcode = 'P0001';
  end if;
  if extract(minute from s) <> 0 or extract(second from s) <> 0
     or extract(minute from e) <> 0 or extract(second from e) <> 0 then
    raise exception 'Bookings start and end on the hour.' using errcode = 'P0001';
  end if;
  if hrs < 1 or hrs > 4 or hrs <> floor(hrs) then
    raise exception 'Bookings are 1 to 4 whole hours.' using errcode = 'P0001';
  end if;
  if s::date <> e::date or extract(hour from s) < 10 or e::time > '22:00' then
    raise exception 'The studio is open 10:00 AM to 10:00 PM, and a booking must finish the same day.' using errcode = 'P0001';
  end if;
  if p_allow_current_hour then
    if p_start < date_trunc('hour', now()) then
      raise exception 'That time has already passed.' using errcode = 'P0001';
    end if;
  elsif p_start <= now() then
    raise exception 'Choose a time in the future.' using errcode = 'P0001';
  end if;
end $$;

-- Find or create the customer a booking/rental belongs to.
--   * signed-in customer  -> their own row
--   * guest or onsite     -> match on name + phone, or create a guest row
create or replace function public.resolve_customer(p_first text, p_last text, p_number text, p_force_guest boolean default false)
returns bigint language plpgsql security definer set search_path = public as $$
declare cid bigint; fn text := trim(coalesce(p_first, '')); ln text := trim(coalesce(p_last, '')); num text := nullif(trim(coalesce(p_number, '')), '');
begin
  if not p_force_guest then
    cid := public.current_customer_id();
    if cid is not null then
      -- keep the profile phone up to date if it was empty
      if num is not null then
        update public.customer set number = num where customer_id = cid and number is null;
      end if;
      return cid;
    end if;
  end if;

  if fn = '' then
    raise exception 'Enter the customer name.' using errcode = 'P0001';
  end if;
  if num is not null and num !~ '^[0-9+()\s-]{7,20}$' then
    raise exception 'Enter a valid phone number.' using errcode = 'P0001';
  end if;

  select customer_id into cid
  from public.customer
  where auth_user_id is null
    and lower(first_name) = lower(fn) and lower(last_name) = lower(ln)
    and (num is null or public.digits(number) = public.digits(num))
  order by customer_id limit 1;

  if cid is null then
    insert into public.customer (first_name, last_name, number) values (fn, ln, num) returning customer_id into cid;
  end if;
  return cid;
end $$;

-- Is any other person holding part of this slot right now?
create or replace function public.slot_held_by_other(p_studio_id bigint, p_start timestamptz, p_end timestamptz, p_token text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.slot_hold h
    where h.studio_id = p_studio_id
      and h.expires_at > now()
      and h.token is distinct from p_token
      and tstzrange(h.start_at, h.end_at, '[)') && tstzrange(p_start, p_end, '[)')
  );
$$;

-- Insert a booking + its payment. Used by the customer and staff RPCs.
create or replace function public.insert_booking_with_payment(
  p_customer_id bigint, p_studio_id bigint, p_start timestamptz, p_end timestamptz,
  p_method text, p_gcash text, p_source text, p_staff_id bigint, p_token text
) returns public.booking
language plpgsql security definer set search_path = public as $$
declare b public.booking; st public.studio; amount numeric;
begin
  perform pg_advisory_xact_lock(hashtextextended('studio:' || p_studio_id, 0));

  select * into st from public.studio where studio_id = p_studio_id;
  if not found then raise exception 'Studio not found.' using errcode = 'P0001'; end if;
  if p_source = 'Online' and st.status <> 'Available' then
    raise exception '% is not taking bookings right now.', st.name using errcode = 'P0001';
  end if;

  if public.slot_held_by_other(p_studio_id, p_start, p_end, p_token) then
    raise exception 'Those hours were just taken by another customer.' using errcode = 'P0001';
  end if;

  begin
    insert into public.booking (customer_id, studio_id, start_at, end_at, hourly_rate_at_booking,
                                status, source, approved_by, created_by)
    values (p_customer_id, p_studio_id, p_start, p_end, st.hourly_rate,
            case when p_source = 'Onsite' then 'Approved' else 'Pending' end,
            p_source,
            case when p_source = 'Onsite' then p_staff_id end,
            case when p_source = 'Onsite' then p_staff_id end)
    returning * into b;
  exception when exclusion_violation then
    raise exception 'That time is no longer available. Please pick another slot.' using errcode = 'P0001';
  end;

  amount := public.booking_total(b.booking_id);
  insert into public.payment (booking_id, method, gcash_reference, amount, status, verified_by, verified_at)
  values (b.booking_id, p_method, nullif(trim(p_gcash), ''), amount,
          case when p_source = 'Onsite' then 'Verified' else 'Pending' end,
          case when p_source = 'Onsite' then p_staff_id end,
          case when p_source = 'Onsite' then now() end);

  if p_token is not null then
    delete from public.slot_hold where token = p_token;
  end if;
  return b;
end $$;


-- ---------------------------------------------------------------------
-- Availability and slot holds (public: guests need them too)
-- ---------------------------------------------------------------------

-- Occupied ranges for a studio, for the calendar. No customer data returned.
create or replace function public.get_busy_slots(p_studio_id bigint, p_from timestamptz, p_to timestamptz, p_token text default null)
returns table (start_at timestamptz, end_at timestamptz, kind text)
language sql stable security definer set search_path = public as $$
  select b.start_at, b.end_at, 'booked'::text
  from public.booking b
  where b.studio_id = p_studio_id
    and b.status in ('Pending', 'Approved', 'In Progress')
    and b.start_at < p_to and b.end_at > p_from
  union all
  select h.start_at, h.end_at, 'held'::text
  from public.slot_hold h
  where h.studio_id = p_studio_id
    and h.expires_at > now()
    and h.token is distinct from p_token
    and h.start_at < p_to and h.end_at > p_from
  order by 1;
$$;

-- Hold a slot for 2 minutes while someone fills in the booking form.
-- One token (browser session) holds one slot at a time; holding again moves it.
create or replace function public.hold_slot(p_studio_id bigint, p_start_at timestamptz, p_end_at timestamptz, p_token text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if p_token is null or length(p_token) < 8 or length(p_token) > 80 then
    raise exception 'Missing hold token.' using errcode = 'P0001';
  end if;
  perform public.validate_slot(p_start_at, p_end_at, false);
  perform pg_advisory_xact_lock(hashtextextended('studio:' || p_studio_id, 0));

  delete from public.slot_hold where expires_at < now() or token = p_token;

  if exists (select 1 from public.studio where studio_id = p_studio_id and status <> 'Available') then
    return false;
  end if;
  if exists (
    select 1 from public.booking b
    where b.studio_id = p_studio_id and b.status in ('Pending', 'Approved', 'In Progress')
      and tstzrange(b.start_at, b.end_at, '[)') && tstzrange(p_start_at, p_end_at, '[)')
  ) then
    return false;
  end if;
  if public.slot_held_by_other(p_studio_id, p_start_at, p_end_at, p_token) then
    return false;
  end if;

  insert into public.slot_hold (studio_id, start_at, end_at, token, expires_at)
  values (p_studio_id, p_start_at, p_end_at, p_token, now() + interval '2 minutes');
  return true;
end $$;

create or replace function public.release_hold(p_token text) returns void
language sql security definer set search_path = public as $$
  delete from public.slot_hold where token = p_token;
$$;


-- ---------------------------------------------------------------------
-- Customer bookings
-- ---------------------------------------------------------------------

-- Works for guests (no login) and signed-in customers.
create or replace function public.create_booking(
  p_studio_id bigint, p_start_at timestamptz, p_end_at timestamptz,
  p_first_name text, p_last_name text, p_number text,
  p_payment_method text, p_gcash_reference text default null, p_hold_token text default null
) returns table (booking_id bigint, booking_ref text, total_amount numeric, status text)
language plpgsql security definer set search_path = public as $$
declare cid bigint; b public.booking; num text := nullif(trim(coalesce(p_number, '')), '');
begin
  perform public.validate_slot(p_start_at, p_end_at, false);

  if p_payment_method not in ('GCash', 'Cash') then
    raise exception 'Choose GCash or Cash.' using errcode = 'P0001';
  end if;
  if p_payment_method = 'GCash' and length(trim(coalesce(p_gcash_reference, ''))) < 6 then
    raise exception 'Enter your GCash reference number.' using errcode = 'P0001';
  end if;

  -- guests must give a phone number so the studio can reach them
  if public.current_customer_id() is null and (num is null or num !~ '^[0-9+()\s-]{7,20}$') then
    raise exception 'Enter a valid phone number.' using errcode = 'P0001';
  end if;

  cid := public.resolve_customer(p_first_name, p_last_name, p_number, false);

  begin
    b := public.insert_booking_with_payment(cid, p_studio_id, p_start_at, p_end_at,
           p_payment_method, p_gcash_reference, 'Online', null, p_hold_token);
  exception when unique_violation then
    raise exception 'That GCash reference was already used.' using errcode = 'P0001';
  end;

  return query select b.booking_id, b.booking_ref::text, public.booking_total(b.booking_id), b.status::text;
end $$;

-- Customers (and staff) may change or cancel until 24 hours before the session.
create or replace function public.reschedule_booking(p_booking_ref text, p_start_at timestamptz, p_end_at timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare b public.booking; staff boolean := public.is_staff();
begin
  select * into b from public.booking where booking_ref = upper(trim(p_booking_ref)) for update;
  if not found then raise exception 'Booking not found.' using errcode = 'P0001'; end if;
  if not staff and b.customer_id is distinct from public.current_customer_id() then
    raise exception 'That is not your booking.' using errcode = '42501';
  end if;
  if b.status not in ('Pending', 'Approved') then
    raise exception 'A % booking cannot be rescheduled.', b.status using errcode = 'P0001';
  end if;
  if not staff and now() > b.start_at - interval '24 hours' then
    raise exception 'Changes and cancellations close 24 hours before your session.' using errcode = 'P0001';
  end if;
  perform public.validate_slot(p_start_at, p_end_at, staff);

  perform pg_advisory_xact_lock(hashtextextended('studio:' || b.studio_id, 0));
  if public.slot_held_by_other(b.studio_id, p_start_at, p_end_at, null) then
    raise exception 'Those hours were just taken by another customer.' using errcode = 'P0001';
  end if;
  begin
    update public.booking
       set start_at = p_start_at, end_at = p_end_at, reschedule_count = reschedule_count + 1
     where booking_id = b.booking_id;
  exception when exclusion_violation then
    raise exception 'That time is no longer available. Please pick another slot.' using errcode = 'P0001';
  end;
end $$;

create or replace function public.cancel_booking(p_booking_ref text, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare b public.booking; staff boolean := public.is_staff();
begin
  select * into b from public.booking where booking_ref = upper(trim(p_booking_ref)) for update;
  if not found then raise exception 'Booking not found.' using errcode = 'P0001'; end if;
  if not staff and b.customer_id is distinct from public.current_customer_id() then
    raise exception 'That is not your booking.' using errcode = '42501';
  end if;
  if b.status not in ('Pending', 'Approved') then
    raise exception 'A % booking cannot be cancelled.', b.status using errcode = 'P0001';
  end if;
  if not staff and now() > b.start_at - interval '24 hours' then
    raise exception 'Changes and cancellations close 24 hours before your session.' using errcode = 'P0001';
  end if;

  update public.booking set status = 'Cancelled', cancelled_reason = nullif(trim(p_reason), '')
   where booking_id = b.booking_id;
  update public.payment set status = 'Rejected' where booking_id = b.booking_id and status = 'Pending';
end $$;


-- ---------------------------------------------------------------------
-- Guest lookups by reference code (no login)
-- The website currently asks for the reference only. Pass p_phone as well
-- if you want to require the phone number (recommended before launch,
-- because TOD-#### references are sequential and guessable).
-- ---------------------------------------------------------------------
create or replace function public.lookup_booking(p_ref text, p_phone text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r record;
begin
  select b.booking_ref, b.status, b.start_at, b.end_at, s.name as studio_name, s.description as studio_desc,
         public.booking_total(b.booking_id) as total,
         (select p.status from public.payment p where p.booking_id = b.booking_id order by p.payment_id desc limit 1) as payment_status,
         c.number
    into r
  from public.booking b
  join public.studio s on s.studio_id = b.studio_id
  join public.customer c on c.customer_id = b.customer_id
  where b.booking_ref = upper(regexp_replace(coalesce(p_ref, ''), '\s', '', 'g'));

  if not found then return null; end if;
  if p_phone is not null and public.digits(p_phone) <> public.digits(r.number) then return null; end if;

  return jsonb_build_object(
    'booking_ref', r.booking_ref, 'status', r.status, 'start_at', r.start_at, 'end_at', r.end_at,
    'studio', r.studio_name, 'studio_description', r.studio_desc,
    'total', r.total, 'payment_status', r.payment_status);
end $$;

-- OUT-/RA- references return that order; a booking reference returns the
-- add-on rentals attached to that booking.
create or replace function public.lookup_rental(p_ref text, p_phone text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare ref text := upper(regexp_replace(coalesce(p_ref, ''), '\s', '', 'g')); result jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'rental_ref', o.rental_ref,
           'rental_type', o.rental_type,
           'equipment', e.name,
           'quantity', d.quantity,
           'return_by', case when o.rental_type = 'Outside' then o.return_date else b.end_at end,
           'status', o.status,
           'rejected_reason', o.rejected_reason
         ) order by o.rental_order_id, e.name), '[]'::jsonb)
    into result
  from public.rental_order o
  join public.rental_detail d on d.rental_order_id = o.rental_order_id
  join public.equipment e on e.equipment_id = d.equipment_id
  join public.customer c on c.customer_id = o.customer_id
  left join public.booking b on b.booking_id = o.booking_id
  where (o.rental_ref = ref or b.booking_ref = ref)
    and (p_phone is null or public.digits(c.number) = public.digits(p_phone));

  if jsonb_array_length(result) = 0 then return null; end if;
  return result;
end $$;


-- ---------------------------------------------------------------------
-- Customer rental requests
-- p_items example: [{"equipment_id": 1, "quantity": 2}]
-- Add-on:  p_booking_ref is required; the order belongs to that booking's customer.
-- Outside: needs pickup, return, phone, ID type and an uploaded ID image path.
-- ---------------------------------------------------------------------
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


-- ---------------------------------------------------------------------
-- Staff: onsite booking and onsite rental (Onsite pages)
-- ---------------------------------------------------------------------
create or replace function public.staff_create_onsite_booking(
  p_studio_id bigint, p_start_at timestamptz, p_end_at timestamptz,
  p_first_name text, p_last_name text, p_number text,
  p_payment_method text, p_gcash_reference text default null
) returns table (booking_id bigint, booking_ref text, total_amount numeric)
language plpgsql security definer set search_path = public as $$
declare b public.booking; cid bigint;
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  perform public.validate_slot(p_start_at, p_end_at, true);
  if p_payment_method not in ('GCash', 'Cash') then
    raise exception 'Choose GCash or Cash.' using errcode = 'P0001';
  end if;
  if p_payment_method = 'GCash' and length(trim(coalesce(p_gcash_reference, ''))) < 6 then
    raise exception 'Enter the GCash reference.' using errcode = 'P0001';
  end if;

  cid := public.resolve_customer(p_first_name, p_last_name, p_number, true);
  b := public.insert_booking_with_payment(cid, p_studio_id, p_start_at, p_end_at,
         p_payment_method, p_gcash_reference, 'Onsite', public.current_app_user_id(), null);
  return query select b.booking_id, b.booking_ref::text, public.booking_total(b.booking_id);
end $$;

-- Items are issued immediately (status Active) and stock updates.
create or replace function public.staff_create_onsite_rental(
  p_type text, p_items jsonb,
  p_booking_ref text default null,
  p_first_name text default null, p_last_name text default null, p_number text default null,
  p_return_date timestamptz default null, p_id_type text default null, p_id_checked boolean default false,
  p_payment_method text default 'Cash', p_gcash_reference text default null
) returns table (rental_order_id bigint, rental_ref text, total_amount numeric)
language plpgsql security definer set search_path = public as $$
declare
  o public.rental_order; bk public.booking; cid bigint; staff_id bigint := public.current_app_user_id();
  it jsonb; eq public.equipment; qty int; rate numeric; hrs numeric; pick timestamptz := now(); total numeric;
begin
  if staff_id is null then raise exception 'Staff only.' using errcode = '42501'; end if;
  if p_type not in ('Add-on', 'Outside') then raise exception 'Choose Add-on or Outside.' using errcode = 'P0001'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one item.' using errcode = 'P0001';
  end if;
  if p_payment_method not in ('GCash', 'Cash') then raise exception 'Choose GCash or Cash.' using errcode = 'P0001'; end if;
  if p_payment_method = 'GCash' and length(trim(coalesce(p_gcash_reference, ''))) < 6 then
    raise exception 'Enter the GCash reference.' using errcode = 'P0001';
  end if;

  if p_type = 'Add-on' then
    select * into bk from public.booking where booking_ref = upper(regexp_replace(coalesce(p_booking_ref, ''), '\s', '', 'g'));
    if not found then raise exception 'Choose a confirmed booking.' using errcode = 'P0001'; end if;
    if bk.status not in ('Approved', 'In Progress') then
      raise exception 'Add-ons need a confirmed or active booking. This one is %.', bk.status using errcode = 'P0001';
    end if;
    cid := bk.customer_id;
  else
    if p_return_date is null or p_return_date <= pick then raise exception 'Choose a return date in the future.' using errcode = 'P0001'; end if;
    if nullif(trim(coalesce(p_id_type, '')), '') is null then raise exception 'Choose the ID type.' using errcode = 'P0001'; end if;
    if not coalesce(p_id_checked, false) then raise exception 'Confirm that you checked a valid ID in person.' using errcode = 'P0001'; end if;
    cid := public.resolve_customer(p_first_name, p_last_name, p_number, true);
  end if;

  insert into public.rental_order (rental_ref, customer_id, rental_type, booking_id, status, source,
                                   approved_by, created_by, pickup_date, return_date, contact_number, id_type)
  values ('', cid, p_type, bk.booking_id, 'Active', 'Onsite', staff_id, staff_id,
          case when p_type = 'Outside' then pick end, p_return_date, nullif(trim(p_number), ''), nullif(trim(p_id_type), ''))
  returning * into o;

  for it in select * from jsonb_array_elements(p_items) loop
    qty := (it ->> 'quantity')::int;
    select * into eq from public.equipment where equipment_id = (it ->> 'equipment_id')::bigint;
    if not found then raise exception 'Equipment not found.' using errcode = 'P0001'; end if;
    if qty is null or qty < 1 then raise exception 'Quantity must be at least 1.' using errcode = 'P0001'; end if;

    if p_type = 'Add-on' then
      if not eq.allow_addon then raise exception '% cannot be rented as an add-on.', eq.name using errcode = 'P0001'; end if;
      rate := eq.add_on_rate; hrs := null;
    else
      if not eq.allow_outside then raise exception '% cannot be rented outside the studio.', eq.name using errcode = 'P0001'; end if;
      rate := eq.outside_rate; hrs := round(extract(epoch from (p_return_date - pick)) / 3600.0, 2);
    end if;

    -- the stock trigger runs here and rejects the row if there isn't enough
    insert into public.rental_detail (rental_order_id, equipment_id, quantity, unit_price_at_request, rental_hours)
    values (o.rental_order_id, eq.equipment_id, qty, rate, hrs);
  end loop;

  total := public.rental_order_total(o.rental_order_id);
  insert into public.payment (rental_order_id, method, gcash_reference, amount, status, verified_by, verified_at)
  values (o.rental_order_id, p_payment_method, nullif(trim(p_gcash_reference), ''), total, 'Verified', staff_id, now());

  return query select o.rental_order_id, o.rental_ref::text, total;
exception when unique_violation then
  raise exception 'Each item can only be listed once, or that GCash reference was already used.' using errcode = 'P0001';
end $$;

-- Mark one line (or the whole order) as returned. When every line is back,
-- the order becomes Returned.
create or replace function public.staff_return_rental(p_rental_ref text, p_equipment_id bigint default null)
returns void language plpgsql security definer set search_path = public as $$
declare o public.rental_order; open_lines int;
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  select * into o from public.rental_order where rental_ref = upper(trim(p_rental_ref)) for update;
  if not found then raise exception 'Rental not found.' using errcode = 'P0001'; end if;
  if o.status <> 'Active' then raise exception 'Only active rentals can be returned (this one is %).', o.status using errcode = 'P0001'; end if;

  update public.rental_detail set returned_at = now()
   where rental_order_id = o.rental_order_id and returned_at is null
     and (p_equipment_id is null or equipment_id = p_equipment_id);

  select count(*) into open_lines from public.rental_detail where rental_order_id = o.rental_order_id and returned_at is null;
  if open_lines = 0 then
    update public.rental_order set status = 'Returned' where rental_order_id = o.rental_order_id;
  end if;
end $$;


-- =====================================================================
-- Views for the owner/staff dashboard and reports
-- security_invoker = the caller's Row Level Security applies, so customers
-- only ever see their own rows and anonymous users see nothing.
-- =====================================================================

-- Bookings tab / Payments tab
create or replace view public.v_booking_summary with (security_invoker = true) as
select
  b.booking_id, b.booking_ref, b.status, b.source,
  b.studio_id, s.name as studio_name,
  b.customer_id, trim(c.first_name || ' ' || c.last_name) as customer_name, c.number as customer_number,
  (c.auth_user_id is null) as is_guest,
  b.start_at, b.end_at,
  extract(epoch from (b.end_at - b.start_at)) / 3600.0 as hours,
  b.actual_start_at, b.actual_end_at,
  b.hourly_rate_at_booking,
  round(b.hourly_rate_at_booking * extract(epoch from (b.end_at - b.start_at)) / 3600.0, 2) as total_amount,
  p.payment_id, p.method as payment_method, p.gcash_reference, p.status as payment_status,
  b.approved_by, b.created_at
from public.booking b
join public.studio s   on s.studio_id = b.studio_id
join public.customer c on c.customer_id = b.customer_id
left join lateral (
  select * from public.payment p where p.booking_id = b.booking_id order by p.payment_id desc limit 1
) p on true;

-- Equipment tab and the customer rent page: total, in use, available, status
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
  e.add_on_rate, e.outside_rate, e.allow_addon, e.allow_outside, e.min_hours,
  e.is_drum_set, e.drum_kit, e.is_vip
from public.equipment e
join public.equipment_category c on c.category_id = e.category_id;

-- Rentals tab: one row per equipment line, with due date and days overdue (Manila dates)
create or replace view public.v_rental_lines with (security_invoker = true) as
select
  o.rental_order_id, o.rental_ref, o.rental_type, o.status, o.source,
  o.customer_id, trim(c.first_name || ' ' || c.last_name) as customer_name, c.number as customer_number,
  bk.booking_ref,
  d.rental_detail_id, d.equipment_id, e.name as equipment_name, d.quantity,
  d.unit_price_at_request, d.rental_hours, d.returned_at as line_returned_at,
  o.pickup_date, o.return_date,
  case when o.rental_type = 'Outside' then o.return_date else bk.end_at end as due_at,
  case
    when o.status = 'Active' and d.returned_at is null
         and now() > case when o.rental_type = 'Outside' then o.return_date else bk.end_at end
    then greatest(1,
      (now() at time zone 'Asia/Manila')::date
      - ((case when o.rental_type = 'Outside' then o.return_date else bk.end_at end) at time zone 'Asia/Manila')::date)
    else 0
  end as days_overdue,
  o.rejected_reason, o.issued_at, o.returned_at, o.created_at
from public.rental_order o
join public.rental_detail d on d.rental_order_id = o.rental_order_id
join public.equipment e on e.equipment_id = d.equipment_id
join public.customer c on c.customer_id = o.customer_id
left join public.booking bk on bk.booking_id = o.booking_id;

-- Payments tab (bookings and rentals together)
create or replace view public.v_payment_queue with (security_invoker = true) as
select
  p.payment_id, p.status, p.method, p.gcash_reference, p.amount, p.created_at, p.verified_at,
  coalesce(b.booking_ref, o.rental_ref) as reference,
  case when p.booking_id is not null then 'Booking' else 'Rental' end as kind,
  trim(c.first_name || ' ' || c.last_name) as customer_name
from public.payment p
left join public.booking b on b.booking_id = p.booking_id
left join public.rental_order o on o.rental_order_id = p.rental_order_id
join public.customer c on c.customer_id = coalesce(b.customer_id, o.customer_id);

-- Customers tab: registered vs guest, counts and money spent (verified payments only)
create or replace view public.v_customer_spending with (security_invoker = true) as
select
  c.customer_id, trim(c.first_name || ' ' || c.last_name) as customer_name, c.number, c.status,
  case when c.auth_user_id is null then 'Guest' else 'Registered' end as account_type,
  (select count(*) from public.booking b where b.customer_id = c.customer_id and b.status <> 'Cancelled') as bookings,
  (select count(*) from public.rental_order o where o.customer_id = c.customer_id and o.status not in ('Rejected', 'Cancelled')) as rentals,
  coalesce((select sum(p.amount) from public.payment p
            left join public.booking b on b.booking_id = p.booking_id
            left join public.rental_order o on o.rental_order_id = p.rental_order_id
            where p.status = 'Verified' and coalesce(b.customer_id, o.customer_id) = c.customer_id), 0) as total_spent
from public.customer c;

-- Reports: verified money per day (Manila), split into studio and equipment
create or replace view public.v_revenue_daily with (security_invoker = true) as
select
  (coalesce(p.verified_at, p.created_at) at time zone 'Asia/Manila')::date as day,
  case when p.booking_id is not null then 'Studio' else 'Equipment' end as kind,
  s.name as studio_name,
  sum(p.amount) as amount,
  count(*) as payments
from public.payment p
left join public.booking b on b.booking_id = p.booking_id
left join public.studio s on s.studio_id = b.studio_id
where p.status = 'Verified'
group by 1, 2, 3;

-- Overview tab: the headline numbers in one row (Manila "today")
create or replace view public.v_dashboard_counts with (security_invoker = true) as
select
  (select count(*) from public.booking) as total_bookings,
  (select count(*) from public.booking where (start_at at time zone 'Asia/Manila')::date = (now() at time zone 'Asia/Manila')::date
                                         and status not in ('Cancelled', 'Rejected')) as todays_bookings,
  (select count(*) from public.booking where status = 'Approved') as confirmed_bookings,
  (select count(*) from public.booking where status = 'Pending') as pending_bookings,
  (select count(*) from public.payment where status = 'Pending') as pending_payments,
  (select count(*) from public.rental_order where status = 'Pending') as rental_requests,
  (select count(*) from public.booking where status = 'In Progress') as active_sessions,
  (select count(distinct rental_order_id) from public.v_rental_lines where days_overdue > 0) as overdue_rentals;
