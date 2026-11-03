-- =====================================================================
-- 43_onsite_outside_down_payment.sql  (safe to re-run)
-- Onsite OUTSIDE rental picked up on a later day: staff can record a 50% down payment instead of the full payment.
--   * today's rentals and onsite add-ons stay full payment (the server refuses a down payment for them)
--   * the order keeps its down payment, so it shows "Balance PHP x" in Rentals and is NOT issued until staff press
--     "Collect balance & issue" and collect the rest at pick-up (same as an online outside rental paid 50%)
--   * the payment is recorded as a Verified down payment (Payments tab: "down payment"), then fully paid once the rest is collected
-- Run this once in the Supabase SQL Editor (after 42_onsite_receipt_email.sql).
-- =====================================================================

drop function if exists public.staff_create_onsite_rental(text, jsonb, text, text, text, text, timestamptz, text, boolean, text, text, timestamptz);

create or replace function public.staff_create_onsite_rental(
  p_type text, p_items jsonb,
  p_booking_ref text default null,
  p_first_name text default null, p_last_name text default null, p_number text default null,
  p_return_date timestamptz default null, p_id_type text default null, p_id_checked boolean default false,
  p_payment_method text default 'Cash', p_gcash_reference text default null,
  p_pickup_date timestamptz default null,
  p_pay_option text default 'full'
) returns table (rental_order_id bigint, rental_ref text, total_amount numeric)
language plpgsql security definer set search_path = public as $$
declare
  o public.rental_order; bk public.booking; cid bigint; staff_id bigint := public.current_app_user_id();
  it jsonb; eq public.equipment; qty int; rate numeric; hrs numeric; pick timestamptz := coalesce(p_pickup_date, now());
  total numeric; st text := 'Approved'; dp numeric := 0; paid numeric;
begin
  if staff_id is null then raise exception 'Staff only.' using errcode = '42501'; end if;
  if p_type not in ('Add-on', 'Outside') then raise exception 'Choose Add-on or Outside.' using errcode = 'P0001'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one item.' using errcode = 'P0001';
  end if;
  if p_payment_method not in ('GCash', 'Cash') then raise exception 'Choose GCash or Cash.' using errcode = 'P0001'; end if;
  if p_pay_option not in ('full', 'down') then raise exception 'Choose full payment or 50%% down payment.' using errcode = 'P0001'; end if;
  -- a 50% down payment is only for an OUTSIDE rental that is picked up on a later day (the rest is collected at pick-up)
  if p_pay_option = 'down' then
    if p_type <> 'Outside' then raise exception 'A down payment is only for outside rentals.' using errcode = 'P0001'; end if;
    if (pick at time zone 'Asia/Manila')::date <= (now() at time zone 'Asia/Manila')::date then
      raise exception 'A 50%% down payment is only for a pick-up on a later day. Today''s rentals are paid in full.' using errcode = 'P0001';
    end if;
  end if;
  -- the GCash reference is optional; if one is typed it must look real
  if p_payment_method = 'GCash' and nullif(trim(coalesce(p_gcash_reference, '')), '') is not null
     and length(trim(p_gcash_reference)) < 6 then
    raise exception 'The GCash reference must be at least 6 characters, or leave it blank.' using errcode = 'P0001';
  end if;

  if p_type = 'Add-on' then
    select * into bk from public.booking where booking_ref = upper(regexp_replace(coalesce(p_booking_ref, ''), '\s', '', 'g'));
    if not found then raise exception 'Choose a confirmed booking.' using errcode = 'P0001'; end if;
    if bk.status not in ('Approved', 'In Progress') then
      raise exception 'Add-ons need a confirmed or active booking. This one is %.', bk.status using errcode = 'P0001';
    end if;
    cid := bk.customer_id;
    if bk.status = 'In Progress' then st := 'Active'; end if;      -- the session is already running
  else
    if p_return_date is null or p_return_date <= pick then raise exception 'The return time must be after the start time.' using errcode = 'P0001'; end if;
    if nullif(trim(coalesce(p_id_type, '')), '') is null then raise exception 'Choose the ID type.' using errcode = 'P0001'; end if;
    if not coalesce(p_id_checked, false) then raise exception 'Confirm that you checked a valid ID in person.' using errcode = 'P0001'; end if;
    cid := public.resolve_customer(p_first_name, p_last_name, p_number, true);
  end if;

  insert into public.rental_order (rental_ref, customer_id, rental_type, booking_id, status, source,
                                   approved_by, created_by, pickup_date, return_date, contact_number, id_type)
  values ('', cid, p_type, bk.booking_id, st, 'Onsite', staff_id, staff_id,
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
  paid := total;
  if p_pay_option = 'down' then
    dp := public.pay_option_amount(total, 'down');
    paid := dp;
    update public.rental_order ro set down_payment = dp where ro.rental_order_id = o.rental_order_id;   -- the balance is collected at pick-up
  end if;
  insert into public.payment (rental_order_id, method, gcash_reference, amount, status, verified_by, verified_at, payment_option)
  values (o.rental_order_id, p_payment_method, nullif(trim(p_gcash_reference), ''), paid, 'Verified', staff_id, now(), p_pay_option);

  return query select o.rental_order_id, o.rental_ref::text, total;
exception when unique_violation then
  raise exception 'Each item can only be listed once, or that GCash reference was already used.' using errcode = 'P0001';
end $$;
revoke all on function public.staff_create_onsite_rental(text, jsonb, text, text, text, text, timestamptz, text, boolean, text, text, timestamptz, text) from public, anon;
grant execute on function public.staff_create_onsite_rental(text, jsonb, text, text, text, text, timestamptz, text, boolean, text, text, timestamptz, text) to authenticated;
