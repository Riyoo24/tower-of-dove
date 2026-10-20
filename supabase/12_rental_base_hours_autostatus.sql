-- =====================================================================
-- 12_rental_base_hours_autostatus.sql  (safe to re-run)
--  1. Outside rent: 8-hour BASE duration. Returns under 8 hours are allowed (the price stays the base
--     price); every hour beyond 8 adds price / 8. Late fees and "overdue" only start after the full
--     8-hour window from pick-up, even if an earlier return time was scheduled.
--  2. Onsite rentals take a start date and time, and are saved as Approved (shown as "Verified"),
--     not In Use. Add-ons to a session that is already running start In Use.
--  3. Add-on equipment goes In Use at the moment its studio booking starts.
--     Outside rentals go In Use by themselves when their pick-up time arrives.
--  4. Customer accounts can be disabled (and enabled again) by staff.
-- Run this once in the Supabase SQL Editor.
-- =====================================================================

-- 1. base duration ---------------------------------------------------------------------------
update public.equipment set min_hours = 0 where min_hours <> 0;     -- no minimum length any more

create or replace function public.rental_due_at(p_pickup timestamptz, p_return timestamptz) returns timestamptz
language sql immutable as $$
  select case when p_pickup is null or p_return is null then p_return
              else greatest(p_return, p_pickup + interval '8 hours') end;
$$;

create or replace view public.v_rental_lines with (security_invoker = true) as
select
  o.rental_order_id, o.rental_ref, o.rental_type, o.status, o.source,
  o.customer_id, trim(c.first_name || ' ' || c.last_name) as customer_name, c.number as customer_number,
  bk.booking_ref,
  d.rental_detail_id, d.equipment_id, e.name as equipment_name, d.quantity,
  d.unit_price_at_request, d.rental_hours, d.returned_at as line_returned_at,
  o.pickup_date, o.return_date,
  -- overdue only after the full 8-hour window, whatever return time was scheduled
  case when o.rental_type = 'Outside' then public.rental_due_at(o.pickup_date, o.return_date) else bk.end_at end as due_at,
  case
    when o.status = 'Active' and d.returned_at is null
         and now() > case when o.rental_type = 'Outside' then public.rental_due_at(o.pickup_date, o.return_date) else bk.end_at end
    then greatest(1,
      (now() at time zone 'Asia/Manila')::date
      - ((case when o.rental_type = 'Outside' then public.rental_due_at(o.pickup_date, o.return_date) else bk.end_at end) at time zone 'Asia/Manila')::date)
    else 0
  end as days_overdue,
  o.rejected_reason, o.issued_at, o.returned_at, o.created_at,
  d.late_fee, o.down_payment
from public.rental_order o
join public.rental_detail d on d.rental_order_id = o.rental_order_id
join public.equipment e on e.equipment_id = d.equipment_id
join public.customer c on c.customer_id = o.customer_id
left join public.booking bk on bk.booking_id = o.booking_id;

-- late fee on return: counted from the end of the 8-hour window (or the later scheduled return)
create or replace function public.staff_return_rental(p_rental_ref text, p_equipment_id bigint default null)
returns void language plpgsql security definer set search_path = public as $$
declare o public.rental_order; open_lines int; due timestamptz;
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  select * into o from public.rental_order where rental_ref = upper(trim(p_rental_ref)) for update;
  if not found then raise exception 'Rental not found.' using errcode = 'P0001'; end if;
  if o.status <> 'Active' then raise exception 'Only rentals that are in use can be returned (this one is %).', o.status using errcode = 'P0001'; end if;
  due := public.rental_due_at(o.pickup_date, o.return_date);

  update public.rental_detail d
     set returned_at = now(),
         late_fee = case when o.rental_type = 'Outside' and due is not null and now() > due
                         then round(d.quantity * d.unit_price_at_request / 8.0 * ceil(extract(epoch from (now() - due)) / 3600.0), 2)
                         else 0 end
   where d.rental_order_id = o.rental_order_id and d.returned_at is null
     and (p_equipment_id is null or d.equipment_id = p_equipment_id);

  select count(*) into open_lines from public.rental_detail where rental_order_id = o.rental_order_id and returned_at is null;
  if open_lines = 0 then
    update public.rental_order set status = 'Returned' where rental_order_id = o.rental_order_id;
  end if;
end $$;

-- 2. onsite rental: start date and time, saved as Approved ("Verified") ---------------------------
drop function if exists public.staff_create_onsite_rental(text, jsonb, text, text, text, text, timestamptz, text, boolean, text, text);
create or replace function public.staff_create_onsite_rental(
  p_type text, p_items jsonb,
  p_booking_ref text default null,
  p_first_name text default null, p_last_name text default null, p_number text default null,
  p_return_date timestamptz default null, p_id_type text default null, p_id_checked boolean default false,
  p_payment_method text default 'Cash', p_gcash_reference text default null,
  p_pickup_date timestamptz default null
) returns table (rental_order_id bigint, rental_ref text, total_amount numeric)
language plpgsql security definer set search_path = public as $$
declare
  o public.rental_order; bk public.booking; cid bigint; staff_id bigint := public.current_app_user_id();
  it jsonb; eq public.equipment; qty int; rate numeric; hrs numeric; pick timestamptz := coalesce(p_pickup_date, now());
  total numeric; st text := 'Approved';
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
  insert into public.payment (rental_order_id, method, gcash_reference, amount, status, verified_by, verified_at)
  values (o.rental_order_id, p_payment_method, nullif(trim(p_gcash_reference), ''), total, 'Verified', staff_id, now());

  return query select o.rental_order_id, o.rental_ref::text, total;
exception when unique_violation then
  raise exception 'Each item can only be listed once, or that GCash reference was already used.' using errcode = 'P0001';
end $$;
revoke all on function public.staff_create_onsite_rental(text, jsonb, text, text, text, text, timestamptz, text, boolean, text, text, timestamptz) from public, anon;
grant execute on function public.staff_create_onsite_rental(text, jsonb, text, text, text, text, timestamptz, text, boolean, text, text, timestamptz) to authenticated;

-- 3a. start sessions and outside rentals by themselves -------------------------------------------
create or replace function public.start_due_sessions() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer := 0; k integer; o record;
begin
  -- confirmed studio sessions whose time has begun (the booking trigger below moves their add-ons to In Use)
  update public.booking set status = 'In Progress'
   where status = 'Approved' and start_at <= now() and end_at > now();
  get diagnostics k = row_count; n := n + k;

  -- outside rentals: In Use as soon as the pick-up time arrives
  for o in select rental_order_id from public.rental_order
            where rental_type = 'Outside' and status = 'Approved' and pickup_date <= now() loop
    begin
      update public.rental_order set status = 'Active' where rental_order_id = o.rental_order_id;
      n := n + 1;
    exception when others then null;   -- for example the stock check failed: leave it for staff
    end;
  end loop;
  return n;
end $$;

-- 3b. add-ons follow their studio booking -------------------------------------------------------
create or replace function public.booking_started_addons() returns trigger
language plpgsql security definer set search_path = public as $$
declare o record;
begin
  if new.status = 'In Progress' and old.status is distinct from 'In Progress' then
    for o in select rental_order_id from public.rental_order
              where booking_id = new.booking_id and rental_type = 'Add-on' and status = 'Approved' loop
      begin
        update public.rental_order set status = 'Active' where rental_order_id = o.rental_order_id;
      exception when others then null;
      end;
    end loop;
  end if;
  return null;
end $$;
drop trigger if exists trg_booking_started_addons on public.booking;
create trigger trg_booking_started_addons after update of status on public.booking
  for each row execute function public.booking_started_addons();

-- an add-on approved while its session is already running starts In Use right away
create or replace function public.rental_addon_inprogress() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'Approved' and old.status is distinct from 'Approved' and new.rental_type = 'Add-on' and new.booking_id is not null
     and exists (select 1 from public.booking b where b.booking_id = new.booking_id and b.status = 'In Progress') then
    new.status := 'Active';
  end if;
  return new;
end $$;
drop trigger if exists aa_rental_addon_inprogress on public.rental_order;
create trigger aa_rental_addon_inprogress before update of status on public.rental_order
  for each row execute function public.rental_addon_inprogress();

-- 4. disabling customer accounts ---------------------------------------------------------------------
-- only staff may change an account's status (a customer must not re-enable themselves)
create or replace function public.customer_protect_status() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status and not public.is_staff() then new.status := old.status; end if;
  return new;
end $$;
drop trigger if exists trg_customer_protect_status on public.customer;
create trigger trg_customer_protect_status before update on public.customer
  for each row execute function public.customer_protect_status();

-- a disabled account cannot create bookings or rentals
create or replace function public.customer_disabled_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and exists (
       select 1 from public.customer c where c.auth_user_id = auth.uid() and c.status = 'Inactive') then
    raise exception 'This account has been disabled. Please contact the studio.' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists trg_booking_disabled_guard on public.booking;
create trigger trg_booking_disabled_guard before insert on public.booking
  for each row execute function public.customer_disabled_guard();
drop trigger if exists trg_rental_disabled_guard on public.rental_order;
create trigger trg_rental_disabled_guard before insert on public.rental_order
  for each row execute function public.customer_disabled_guard();
