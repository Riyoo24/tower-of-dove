-- =====================================================================
-- 102_onsite_customer_account.sql  (safe to re-run)
-- Onsite booking and onsite OUTSIDE rental: staff can pick an existing registered account.
--   * the booking / rental is saved on that account (customer_id), so it shows in the customer's
--     My bookings / My rental and counts toward their history, instead of a new guest row
--   * no account picked = the same walk-in guest behaviour as before
--   * staff_search_accounts(p_q): staff-only search of registered, active accounts
--   * onsite_account_id(p_customer_id): checks the id is a registered, active account
-- Run once in the Supabase SQL Editor (after 101_guest_device_bookings.sql).
-- =====================================================================

-- 1. Search registered accounts (staff only) -------------------------------------------------------
create or replace function public.staff_search_accounts(p_q text)
returns table (customer_id bigint, first_name text, last_name text, username text, number text, email text)
language plpgsql stable security definer set search_path = public as $$
declare q text := trim(coalesce(p_q, ''));
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  if length(q) < 2 then return; end if;
  q := replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_');
  return query
    select c.customer_id, c.first_name::text, c.last_name::text, c.username::text, c.number::text, c.email::text
      from public.customer c
     where c.auth_user_id is not null
       and c.status = 'Active'
       and (   trim(c.first_name || ' ' || c.last_name) ilike '%' || q || '%'
            or coalesce(c.username, '') ilike '%' || q || '%'
            or coalesce(c.email, '')    ilike '%' || q || '%'
            or (public.digits(q) <> '' and public.digits(c.number) like '%' || public.digits(q) || '%'))
     order by lower(c.first_name), lower(c.last_name)
     limit 15;
end $$;
revoke all on function public.staff_search_accounts(text) from public, anon;
grant execute on function public.staff_search_accounts(text) to authenticated;

-- 2. Check a chosen account ------------------------------------------------------------------------
create or replace function public.onsite_account_id(p_customer_id bigint)
returns bigint
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from public.customer c
                  where c.customer_id = p_customer_id and c.auth_user_id is not null and c.status = 'Active') then
    raise exception 'That customer account was not found or is inactive.' using errcode = 'P0001';
  end if;
  return p_customer_id;
end $$;
revoke all on function public.onsite_account_id(bigint) from public, anon, authenticated;

-- 3. Onsite studio booking: optional account ----------------------------------------------------------
drop function if exists public.staff_create_onsite_booking(bigint, timestamptz, timestamptz, text, text, text, text, text, text, text);

create or replace function public.staff_create_onsite_booking(
  p_studio_id bigint, p_start_at timestamptz, p_end_at timestamptz,
  p_first_name text, p_last_name text, p_number text,
  p_payment_method text, p_gcash_reference text default null,
  p_token text default null,
  p_pay_option text default 'full',
  p_customer_id bigint default null            -- NEW (102): a registered account chosen by staff; null = walk-in guest
) returns table (booking_id bigint, booking_ref text, total_amount numeric)
language plpgsql security definer set search_path = public as $$
declare b public.booking; cid bigint; total numeric; dp numeric;
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  perform public.validate_slot(p_start_at, p_end_at, true);
  if p_payment_method not in ('GCash', 'Cash') then
    raise exception 'Choose GCash or Cash.' using errcode = 'P0001';
  end if;
  if p_pay_option not in ('full', 'down') then
    raise exception 'Choose full payment or 50%% down payment.' using errcode = 'P0001';
  end if;
  -- a 50% down payment is only for a booking on a later day (a booking for today is paid in full)
  if p_pay_option = 'down' and (p_start_at at time zone 'Asia/Manila')::date <= (now() at time zone 'Asia/Manila')::date then
    raise exception 'A 50%% down payment is only for a booking on a later day. Today''s bookings are paid in full.' using errcode = 'P0001';
  end if;
  -- the GCash reference is REQUIRED when the payment is GCash: exactly 13 digits (same rule as online payments)
  if p_payment_method = 'GCash' and regexp_replace(coalesce(p_gcash_reference, ''), '\s', '', 'g') !~ '^[0-9]{13}$' then
    raise exception 'Enter the 13-digit GCash reference number.' using errcode = 'P0001';
  end if;

  if p_customer_id is not null then
    cid := public.onsite_account_id(p_customer_id);   -- booking is recorded on that account
  else
    cid := public.resolve_customer(p_first_name, p_last_name, p_number, true);
  end if;
  b := public.insert_booking_with_payment(cid, p_studio_id, p_start_at, p_end_at,
         p_payment_method, p_gcash_reference, 'Onsite', public.current_app_user_id(), p_token);
  total := public.booking_total(b.booking_id);

  if p_pay_option = 'down' then
    dp := public.pay_option_amount(total, 'down');
    update public.booking bk set down_payment = dp where bk.booking_id = b.booking_id;      -- the balance is collected at the studio
    update public.payment pay set amount = dp, payment_option = 'down'
     where pay.booking_id = b.booking_id and pay.status <> 'Rejected';
  else
    update public.payment pay set payment_option = 'full'
     where pay.booking_id = b.booking_id and pay.status <> 'Rejected';
  end if;
  return query select b.booking_id, b.booking_ref::text, total;
end $$;

revoke all on function public.staff_create_onsite_booking(bigint, timestamptz, timestamptz, text, text, text, text, text, text, text, bigint) from public, anon;
grant execute on function public.staff_create_onsite_booking(bigint, timestamptz, timestamptz, text, text, text, text, text, text, text, bigint) to authenticated;

-- 4. Onsite rental: optional account (used for OUTSIDE rentals; an add-on always follows its booking's customer) ----
drop function if exists public.staff_create_onsite_rental(text, jsonb, text, text, text, text, timestamptz, text, boolean, text, text, timestamptz, text, boolean);

create or replace function public.staff_create_onsite_rental(
  p_type text, p_items jsonb,
  p_booking_ref text default null,
  p_first_name text default null, p_last_name text default null, p_number text default null,
  p_return_date timestamptz default null, p_id_type text default null, p_id_checked boolean default false,
  p_payment_method text default 'Cash', p_gcash_reference text default null,
  p_pickup_date timestamptz default null,
  p_pay_option text default 'full',
  p_pay_later boolean default false,         -- (90): add-on for a running session, paid with the balance at the end
  p_customer_id bigint default null          -- NEW (102): a registered account chosen by staff (outside rentals); null = walk-in guest
) returns table (rental_order_id bigint, rental_ref text, total_amount numeric)
language plpgsql security definer set search_path = public as $$
declare
  o public.rental_order; bk public.booking; cid bigint; staff_id bigint := public.current_app_user_id();
  it jsonb; eq public.equipment; qty int; rate numeric; hrs numeric; pick timestamptz := coalesce(p_pickup_date, now());
  total numeric; st text := 'Approved'; dp numeric := 0; paid numeric;
  later boolean := coalesce(p_pay_later, false);
  pm text := p_payment_method; gref text := p_gcash_reference;
begin
  if staff_id is null then raise exception 'Staff only.' using errcode = '42501'; end if;
  if p_type not in ('Add-on', 'Outside') then raise exception 'Choose Add-on or Outside.' using errcode = 'P0001'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one item.' using errcode = 'P0001';
  end if;
  if later and p_type <> 'Add-on' then
    raise exception 'Paying after the session is only for add-on equipment of a running session.' using errcode = 'P0001';
  end if;
  if later then
    pm := 'Cash'; gref := null;               -- nothing is received now
  end if;
  if pm not in ('GCash', 'Cash') then raise exception 'Choose GCash or Cash.' using errcode = 'P0001'; end if;
  if p_pay_option not in ('full', 'down') then raise exception 'Choose full payment or 50%% down payment.' using errcode = 'P0001'; end if;
  -- a 50% down payment is only for an OUTSIDE rental that is picked up on a later day (the rest is collected at pick-up)
  if p_pay_option = 'down' then
    if p_type <> 'Outside' then raise exception 'A down payment is only for outside rentals.' using errcode = 'P0001'; end if;
    if (pick at time zone 'Asia/Manila')::date <= (now() at time zone 'Asia/Manila')::date then
      raise exception 'A 50%% down payment is only for a pick-up on a later day. Today''s rentals are paid in full.' using errcode = 'P0001';
    end if;
  end if;
  -- the GCash reference is REQUIRED when the payment is GCash: exactly 13 digits (same rule as online payments)
  if pm = 'GCash' and regexp_replace(coalesce(gref, ''), '\s', '', 'g') !~ '^[0-9]{13}$' then
    raise exception 'Enter the 13-digit GCash reference number.' using errcode = 'P0001';
  end if;

  if p_type = 'Add-on' then
    select * into bk from public.booking where booking_ref = upper(regexp_replace(coalesce(p_booking_ref, ''), '\s', '', 'g'));
    if not found then raise exception 'Choose a confirmed booking.' using errcode = 'P0001'; end if;
    if bk.status not in ('Approved', 'In Progress') then
      raise exception 'Add-ons need a confirmed or active booking. This one is %.', bk.status using errcode = 'P0001';
    end if;
    if later and bk.status <> 'In Progress' then
      raise exception 'Paying at the end of the session is only for a session that is running now (Active).' using errcode = 'P0001';
    end if;
    cid := bk.customer_id;
    if bk.status = 'In Progress' then st := 'Active'; end if;      -- the session is already running
  else
    if p_return_date is null or p_return_date <= pick then raise exception 'The return time must be after the start time.' using errcode = 'P0001'; end if;
    if nullif(trim(coalesce(p_id_type, '')), '') is null then raise exception 'Choose the ID type.' using errcode = 'P0001'; end if;
    if not coalesce(p_id_checked, false) then raise exception 'Confirm that you checked a valid ID in person.' using errcode = 'P0001'; end if;
    if p_customer_id is not null then
      cid := public.onsite_account_id(p_customer_id);   -- rental is recorded on that account
    else
      cid := public.resolve_customer(p_first_name, p_last_name, p_number, true);
    end if;
  end if;

  insert into public.rental_order (rental_ref, customer_id, rental_type, booking_id, status, source,
                                   approved_by, created_by, pickup_date, return_date, contact_number, id_type, balance_deferred)
  values ('', cid, p_type, bk.booking_id, st, 'Onsite', staff_id, staff_id,
          case when p_type = 'Outside' then pick end, p_return_date, nullif(trim(p_number), ''), nullif(trim(p_id_type), ''), later)
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
  paid := total;
  if later then
    paid := 0;                                                   -- the whole price is the booking's balance
  elsif p_pay_option = 'down' then
    dp := public.pay_option_amount(total, 'down');
    paid := dp;
    update public.rental_order ro set down_payment = dp where ro.rental_order_id = o.rental_order_id;   -- the balance is collected at pick-up
  end if;
  insert into public.payment (rental_order_id, method, gcash_reference, amount, status, verified_by, verified_at, payment_option)
  values (o.rental_order_id, pm, nullif(trim(gref), ''), paid, 'Verified', staff_id, now(),
          case when later then 'down' else p_pay_option end);

  return query select o.rental_order_id, o.rental_ref::text, total;
exception when unique_violation then
  raise exception 'Each item can only be listed once, or that GCash reference was already used.' using errcode = 'P0001';
end $$;
revoke all on function public.staff_create_onsite_rental(text, jsonb, text, text, text, text, timestamptz, text, boolean, text, text, timestamptz, text, boolean, bigint) from public, anon;
grant execute on function public.staff_create_onsite_rental(text, jsonb, text, text, text, text, timestamptz, text, boolean, text, text, timestamptz, text, boolean, bigint) to authenticated;