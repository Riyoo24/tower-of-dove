-- =====================================================================
-- 89_equipment_checkout_hold.sql  (safe to re-run)
-- Slot hold for the rental CHECKOUT window (studio add-on and outside rental), the same idea as the studio
-- booking hold (hold_slot): while a customer has the checkout open, the items in their cart are held for 2 minutes
-- for the hours they need, so a second customer cannot reserve the same last item and pay for it too.
--   * public.equipment_hold      one row per held item (token = the browser, like slot_hold). Touched only by the RPCs.
--   * hold_equipment()           holds the cart for the hours; false when someone else holds / has reserved it.
--   * release_equipment_hold()   frees it (also done by release_hold(), which the page already sends when it closes).
--   * equipment_available_between() now also subtracts OTHER customers' holds (new optional p_token = your own).
--   * request_rental() / request_addon_rental() / request_outside_rental() take an optional p_hold_token: other
--     customers' holds count as taken, your own hold never blocks you, and it is released once the request is saved.
-- Holds never block staff approving / issuing an order and never change the staff "In use" numbers.
-- Run this once in the Supabase SQL Editor (after 88_late_fee_preview.sql).
-- =====================================================================

-- 1. table
create table if not exists public.equipment_hold (
  token        text        not null,
  equipment_id bigint      not null references public.equipment(equipment_id) on delete cascade,
  quantity     integer     not null check (quantity > 0),
  start_at     timestamptz not null,
  end_at       timestamptz not null,
  expires_at   timestamptz not null,
  primary key (token, equipment_id),
  constraint equipment_hold_time_chk check (end_at > start_at)
);
create index if not exists equipment_hold_eq_idx on public.equipment_hold (equipment_id, start_at);
alter table public.equipment_hold enable row level security;   -- no policies: only the RPCs touch it
revoke all on public.equipment_hold from anon, authenticated;

-- 2. quantity held by OTHER browsers' checkout windows for these hours
create or replace function public.equipment_held_by_checkout(
  p_equipment_id bigint, p_from timestamptz, p_to timestamptz, p_token text default null
) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(sum(h.quantity), 0)::int
    from public.equipment_hold h
   where h.equipment_id = p_equipment_id
     and h.expires_at > now()
     and h.token is distinct from p_token
     and (p_from is null or p_to is null or (h.start_at < p_to and p_from < h.end_at));
$$;
revoke all on function public.equipment_held_by_checkout(bigint, timestamptz, timestamptz, text) from public, anon, authenticated;

-- 3. hold the cart for the hours (2 minutes). One token holds one cart at a time; holding again replaces it
create or replace function public.hold_equipment(p_items jsonb, p_start_at timestamptz, p_end_at timestamptz, p_token text)
returns boolean language plpgsql security definer set search_path = public as $$
declare it jsonb; eq public.equipment; qty int; taken int;
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
    taken := public.equipment_in_use_between(eq.equipment_id, p_start_at, p_end_at, null)
           + public.equipment_held_by_checkout(eq.equipment_id, p_start_at, p_end_at, p_token);
    if taken + qty > eq.total_quantity then
      return false;
    end if;
  end loop;

  insert into public.equipment_hold (token, equipment_id, quantity, start_at, end_at, expires_at)
  select p_token, (x ->> 'equipment_id')::bigint, (x ->> 'quantity')::int, p_start_at, p_end_at, now() + interval '2 minutes'
    from jsonb_array_elements(p_items) x;
  return true;
end $$;
revoke all on function public.hold_equipment(jsonb, timestamptz, timestamptz, text) from public, anon, authenticated;
grant execute on function public.hold_equipment(jsonb, timestamptz, timestamptz, text) to anon, authenticated;

create or replace function public.release_equipment_hold(p_token text) returns void
language sql security definer set search_path = public as $$
  delete from public.equipment_hold where token = p_token;
$$;
revoke all on function public.release_equipment_hold(text) from public, anon, authenticated;
grant execute on function public.release_equipment_hold(text) to anon, authenticated;

-- release_hold() (called when a form closes or the tab is left) frees the equipment hold of that browser too
create or replace function public.release_hold(p_token text) returns void
language sql security definer set search_path = public as $$
  delete from public.equipment_hold where token = p_token;
  delete from public.slot_hold where token = p_token;
$$;

-- 4. free count for the hours: other customers' holds are subtracted (p_token = your own hold, not counted)
drop function if exists public.equipment_available_between(timestamptz, timestamptz);
create or replace function public.equipment_available_between(p_from timestamptz, p_to timestamptz, p_token text default null)
returns table (equipment_id bigint, available integer)
language sql stable security definer set search_path = public as $$
  select e.equipment_id,
         greatest(e.total_quantity
                  - public.equipment_in_use_between(e.equipment_id, p_from, p_to, null, true)
                  - public.equipment_held_by_checkout(e.equipment_id, p_from, p_to, p_token), 0)::int
    from public.equipment e;
$$;
revoke all on function public.equipment_available_between(timestamptz, timestamptz, text) from public, anon;
grant execute on function public.equipment_available_between(timestamptz, timestamptz, text) to anon, authenticated;

-- 5. request_rental(): same as file 80, plus other customers' holds count and the caller's own hold is released
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

-- 6. the two website entry points take the hold token and pass it on
drop function if exists public.request_addon_rental(text, jsonb, text, text);
create or replace function public.request_addon_rental(
  p_booking_ref text, p_items jsonb, p_pay_option text default 'down', p_gcash_reference text default null,
  p_hold_token text default null
) returns table (rental_ref text, total_amount numeric, down_payment numeric, pay_option text)
language plpgsql security definer set search_path = public as $$
declare
  r record; total numeric; dp numeric; mail text; bk public.booking;
  gref text := regexp_replace(coalesce(p_gcash_reference, ''), '\s', '', 'g');
  opt  text := lower(coalesce(nullif(trim(p_pay_option), ''), 'down'));
begin
  if opt not in ('down', 'full') then
    raise exception 'Choose 50%% down payment or full payment.' using errcode = 'P0001';
  end if;
  if gref !~ '^[0-9]{13}$' then
    raise exception 'Enter the 13-digit GCash reference number of your payment.' using errcode = 'P0001';
  end if;

  -- the session has started: equipment added now is paid in full
  select * into bk from public.booking
   where booking_ref = upper(regexp_replace(coalesce(p_booking_ref, ''), '\s', '', 'g'));
  if found and opt <> 'full' and (bk.status = 'In Progress' or bk.start_at <= now()) then
    raise exception 'Your session has already started, so equipment added now must be paid in full (100%%).' using errcode = 'P0001';
  end if;

  perform set_config('app.eq_hold_token', coalesce(p_hold_token, ''), true);
  select o.rental_order_id, o.rental_ref, o.total_amount into r
    from public.request_rental('Add-on', p_items, p_booking_ref) o;
  perform set_config('app.eq_hold_token', '', true);

  select coalesce(public.current_account_email(), b.receipt_email) into mail
    from public.rental_order ro join public.booking b on b.booking_id = ro.booking_id
   where ro.rental_order_id = r.rental_order_id;

  total := r.total_amount;
  dp := public.pay_option_amount(total, opt);
  update public.rental_order set down_payment = dp, receipt_email = mail where rental_order_id = r.rental_order_id;
  insert into public.payment (rental_order_id, method, gcash_reference, amount, status, payment_option)
  values (r.rental_order_id, 'GCash', gref, dp, 'Pending', opt);

  return query select r.rental_ref::text, total, dp, opt;
exception when unique_violation then
  raise exception 'That GCash reference number was already used.' using errcode = 'P0001';
end $$;
revoke all on function public.request_addon_rental(text, jsonb, text, text, text) from public, anon, authenticated;
grant execute on function public.request_addon_rental(text, jsonb, text, text, text) to anon, authenticated;

drop function if exists public.request_outside_rental(jsonb, text, text, text, timestamptz, timestamptz, text, text, text, text, text, text);
create or replace function public.request_outside_rental(
  p_items jsonb, p_first_name text, p_last_name text, p_number text,
  p_pickup_date timestamptz, p_return_date timestamptz,
  p_contact_number text, p_backup_contact text, p_id_type text, p_id_image_path text,
  p_gcash_reference text,
  p_pay_option text default 'down',
  p_hold_token text default null
) returns table (rental_ref text, total_amount numeric, down_payment numeric, pay_option text)
language plpgsql security definer set search_path = public as $$
declare
  r record; total numeric; dp numeric;
  gref text := regexp_replace(coalesce(p_gcash_reference, ''), '\s', '', 'g');
  opt  text := lower(coalesce(nullif(trim(p_pay_option), ''), 'down'));
begin
  if public.current_customer_id() is null then
    raise exception 'Please log in or register to rent equipment outside the studio.' using errcode = 'P0001';
  end if;
  if opt not in ('down', 'full') then
    raise exception 'Choose 50%% down payment or full payment.' using errcode = 'P0001';
  end if;
  if gref !~ '^[0-9]{13}$' then
    raise exception 'Enter the 13-digit GCash reference number of your payment.' using errcode = 'P0001';
  end if;

  perform set_config('app.outside_ok', '1', true);
  perform set_config('app.eq_hold_token', coalesce(p_hold_token, ''), true);
  select o.rental_order_id, o.rental_ref, o.total_amount into r
    from public.request_rental('Outside', p_items, null, p_first_name, p_last_name, p_number,
                               p_pickup_date, p_return_date, p_contact_number, p_backup_contact,
                               p_id_type, p_id_image_path) o;
  perform set_config('app.outside_ok', '', true);
  perform set_config('app.eq_hold_token', '', true);

  total := r.total_amount;
  dp := public.pay_option_amount(total, opt);
  update public.rental_order set down_payment = dp, receipt_email = public.current_account_email()
   where rental_order_id = r.rental_order_id;
  insert into public.payment (rental_order_id, method, gcash_reference, amount, status, payment_option)
  values (r.rental_order_id, 'GCash', gref, dp, 'Pending', opt);

  return query select r.rental_ref::text, total, dp, opt;
exception when unique_violation then
  raise exception 'That GCash reference number was already used.' using errcode = 'P0001';
end $$;
revoke all on function public.request_outside_rental(jsonb, text, text, text, timestamptz, timestamptz, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.request_outside_rental(jsonb, text, text, text, timestamptz, timestamptz, text, text, text, text, text, text, text) to authenticated;
