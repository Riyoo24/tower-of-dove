-- =====================================================================
-- 20_booking_down_payment.sql  (safe to re-run)
-- Online studio bookings now need a 50% DOWN PAYMENT (GCash), the same way outside rentals do:
--   * the customer pays 50% of the total (studio + add-on equipment) when booking; the server sets the
--     amount, so it cannot be skipped or changed from the browser
--   * the other 50% (the balance) is paid at the studio when the customer arrives
--   * the down payment is non-refundable if the booking is cancelled (same as outside rentals)
--   * anything added later (add-on equipment from the Rent page, session extensions) is paid at the
--     studio as part of the balance: balance = total - down payment
--   * walk-in (onsite) bookings recorded by staff are unchanged: paid in full, down_payment stays 0
--   * bookings made BEFORE this file was run keep down_payment = 0 and behave exactly as before
--   * the revenue report counts the down payment when staff verify it and the balance when the
--     session starts (like the balance of an outside rental, which counts when the equipment is issued)
-- Run once in the Supabase SQL Editor (after 18_booking_reject_reason.sql).
-- =====================================================================

-- 1. New column -------------------------------------------------------------------------------
alter table public.booking add column if not exists down_payment numeric(10,2) not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'booking_down_payment_chk') then
    alter table public.booking add constraint booking_down_payment_chk check (down_payment >= 0);
  end if;
end $$;

-- 2. Total of the active add-on equipment on a booking (used by the revenue report) ------------
create or replace function public.booking_addons_total(p_booking_id bigint) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(d.unit_price_at_request * d.quantity), 0)::numeric(10,2)
    from public.rental_order o
    join public.rental_detail d on d.rental_order_id = o.rental_order_id
   where o.booking_id = p_booking_id and o.rental_type = 'Add-on' and o.status not in ('Rejected', 'Cancelled');
$$;
revoke all on function public.booking_addons_total(bigint) from public, anon, authenticated;
grant execute on function public.booking_addons_total(bigint) to authenticated;

-- 3. Insert a booking + its payment: online bookings pay 50% now -------------------------------
create or replace function public.insert_booking_with_payment(
  p_customer_id bigint, p_studio_id bigint, p_start timestamptz, p_end timestamptz,
  p_method text, p_gcash text, p_source text, p_staff_id bigint, p_token text
) returns public.booking
language plpgsql security definer set search_path = public as $$
declare b public.booking; st public.studio; total numeric; down numeric := 0;
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

  total := round(st.hourly_rate * extract(epoch from (p_end - p_start)) / 3600.0, 2);
  if p_source = 'Online' then down := round(total * 0.5, 2); end if;

  begin
    insert into public.booking (customer_id, studio_id, start_at, end_at, hourly_rate_at_booking,
                                status, source, approved_by, created_by, down_payment)
    values (p_customer_id, p_studio_id, p_start, p_end, st.hourly_rate,
            case when p_source = 'Onsite' then 'Approved' else 'Pending' end,
            p_source,
            case when p_source = 'Onsite' then p_staff_id end,
            case when p_source = 'Onsite' then p_staff_id end,
            down)
    returning * into b;
  exception when exclusion_violation then
    raise exception 'That time is no longer available. Please pick another slot.' using errcode = 'P0001';
  end;

  -- online: the payment is the 50% down payment; onsite: the full amount, already verified by staff
  insert into public.payment (booking_id, method, gcash_reference, amount, status, verified_by, verified_at)
  values (b.booking_id, p_method, nullif(trim(p_gcash), ''),
          case when p_source = 'Online' then down else public.booking_total(b.booking_id) end,
          case when p_source = 'Onsite' then 'Verified' else 'Pending' end,
          case when p_source = 'Onsite' then p_staff_id end,
          case when p_source = 'Onsite' then now() end);

  if p_token is not null then
    delete from public.slot_hold where token = p_token;
  end if;
  return b;
end $$;

-- 4. Book a studio plus add-on equipment: the down payment is 50% of studio + add-ons -----------
drop function if exists public.create_booking_with_addons(bigint, timestamptz, timestamptz, text, text, text, text, text, text, jsonb);
create function public.create_booking_with_addons(
  p_studio_id bigint, p_start_at timestamptz, p_end_at timestamptz,
  p_first_name text, p_last_name text, p_number text,
  p_payment_method text, p_gcash_reference text default null, p_hold_token text default null,
  p_items jsonb default '[]'::jsonb
) returns table (
  booking_ref text, status text, studio_total numeric, addons_total numeric, total_amount numeric, rental_ref text,
  down_payment numeric, balance_due numeric
)
language plpgsql security definer set search_path = public as $$
declare
  bk record;
  studio numeric := 0;
  addons numeric := 0;
  rref   text;
  dp     numeric;
begin
  select * into bk from public.create_booking(
    p_studio_id, p_start_at, p_end_at, p_first_name, p_last_name, p_number,
    p_payment_method, p_gcash_reference, p_hold_token);
  studio := bk.total_amount;

  if p_items is not null and jsonb_typeof(p_items) = 'array' and jsonb_array_length(p_items) > 0 then
    select o.rental_ref, o.total_amount into rref, addons
      from public.request_rental('Add-on', p_items, bk.booking_ref) o;
  end if;

  -- 50% of everything booked now; the other 50% is the balance paid at the studio
  dp := round((studio + coalesce(addons, 0)) * 0.5, 2);
  update public.booking set down_payment = dp where booking_id = bk.booking_id;
  update public.payment pay set amount = dp where pay.booking_id = bk.booking_id and pay.status <> 'Rejected';

  return query select bk.booking_ref::text, bk.status::text, studio, coalesce(addons, 0),
                      studio + coalesce(addons, 0), rref, dp, (studio + coalesce(addons, 0)) - dp;
end $$;

revoke all on function public.create_booking_with_addons(bigint, timestamptz, timestamptz, text, text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.create_booking_with_addons(bigint, timestamptz, timestamptz, text, text, text, text, text, text, jsonb) to anon, authenticated;

-- 5. A pending booking payment only follows the add-ons for bookings WITHOUT a down payment ------
--    (with a down payment the amount is fixed when booking; later add-ons join the balance)
create or replace function public.sync_booking_payment(p_booking_id bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.payment p
     set amount = public.booking_total(p_booking_id) + coalesce((
           select sum(d.unit_price_at_request * d.quantity)
             from public.rental_order o
             join public.rental_detail d on d.rental_order_id = o.rental_order_id
            where o.booking_id = p_booking_id and o.rental_type = 'Add-on'
              and o.status not in ('Rejected', 'Cancelled')), 0)
   where p.booking_id = p_booking_id and p.status = 'Pending'
     and not exists (select 1 from public.booking b where b.booking_id = p_booking_id and b.down_payment > 0);
end $$;

-- 6. Extending a session: the extra cost joins the balance when there is a down payment ---------
create or replace function public.staff_extend_booking(p_booking_ref text, p_extra_hours integer, p_token text default null)
returns table (booking_ref text, new_end_at timestamptz, extra_cost numeric, studio_total numeric, payment_method text, payment_status text)
language plpgsql security definer set search_path = public as $$
declare
  b public.booking; info record; cost numeric; pay public.payment;
begin
  if p_extra_hours is null or p_extra_hours < 1 or p_extra_hours > 4 then
    raise exception 'Choose 1 to 4 extra hours.' using errcode = 'P0001';
  end if;

  select * into b from public.booking bk where bk.booking_ref = upper(trim(p_booking_ref)) for update;
  if not found then raise exception 'Booking not found.' using errcode = 'P0001'; end if;
  if not public.is_staff() and b.customer_id is distinct from public.current_customer_id() then
    raise exception 'That is not your booking.' using errcode = '42501';
  end if;

  -- same lock the booking functions use, so nobody can book the free hour while we extend
  perform pg_advisory_xact_lock(hashtextextended('studio:' || b.studio_id, 0));

  -- holds by other people block the extension; this staff member's own hold does not
  select * into info from public.staff_extension_info(b.booking_ref, p_token);
  if info.max_hours < info.min_hours then
    raise exception '%', info.message using errcode = 'P0001';
  end if;
  if p_extra_hours > info.max_hours then
    raise exception '%', coalesce(info.message, 'Cannot extend: that time is not free.') using errcode = 'P0001';
  end if;
  if p_extra_hours < info.min_hours then
    raise exception 'The session is already past its end time. Extend by at least % hour(s).', info.min_hours using errcode = 'P0001';
  end if;

  cost := round(b.hourly_rate_at_booking * p_extra_hours, 2);

  begin
    update public.booking set end_at = end_at + make_interval(hours => p_extra_hours) where booking_id = b.booking_id;
  exception when exclusion_violation then
    raise exception 'Cannot extend: studio is booked for the next time slot.' using errcode = 'P0001';
  end;

  if p_token is not null then
    delete from public.slot_hold where token = p_token;     -- the hold did its job
  end if;

  select * into pay from public.payment p
   where p.booking_id = b.booking_id and p.status in ('Pending', 'Verified')
   order by p.payment_id desc limit 1;
  -- With a down payment the extra cost is NOT added to the payment: the customer already paid 50% of the
  -- original total, and the extra hours are part of the balance paid at the studio (total - down payment).
  -- Older bookings without a down payment keep the previous behaviour (cost added to the payment amount).
  if found and coalesce(b.down_payment, 0) = 0 then
    update public.payment set amount = amount + cost where payment_id = pay.payment_id;
  end if;

  return query
    select b.booking_ref::text, x.end_at, cost, public.booking_total(b.booking_id), pay.method::text, pay.status::text
      from public.booking x where x.booking_id = b.booking_id;
end $$;

-- 7. Dashboard / My bookings view: one extra column at the end (down_payment) ------------------
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
  b.approved_by, b.created_at,
  b.rejected_reason,
  b.down_payment
from public.booking b
join public.studio s   on s.studio_id = b.studio_id
join public.customer c on c.customer_id = b.customer_id
left join lateral (
  select * from public.payment p where p.booking_id = b.booking_id order by p.payment_id desc limit 1
) p on true;
grant select on public.v_booking_summary to authenticated;

-- 8. Guest reference lookup: also returns the down payment and the balance --------------------
create or replace function public.lookup_booking(p_ref text, p_phone text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r record; ad jsonb; ad_total numeric;
begin
  select b.booking_id, b.booking_ref, b.status, b.start_at, b.end_at, s.name as studio_name, s.description as studio_desc,
         public.booking_total(b.booking_id) as total,
         (select p.status from public.payment p where p.booking_id = b.booking_id order by p.payment_id desc limit 1) as payment_status,
         c.number, c.auth_user_id, b.rejected_reason, b.down_payment
    into r
  from public.booking b
  join public.studio s on s.studio_id = b.studio_id
  join public.customer c on c.customer_id = b.customer_id
  where b.booking_ref = upper(regexp_replace(coalesce(p_ref, ''), '\s', '', 'g'));

  if not found then return null; end if;

  -- registered customers' bookings are private: only the owner of the account or staff may read them
  if r.auth_user_id is not null and r.auth_user_id is distinct from auth.uid() and not public.is_staff() then
    return null;
  end if;
  if p_phone is not null and public.digits(p_phone) <> public.digits(r.number) then return null; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'equipment', e.name, 'quantity', d.quantity,
           'price', d.unit_price_at_request * d.quantity, 'status', o.status) order by e.name), '[]'::jsonb),
         coalesce(sum(d.unit_price_at_request * d.quantity), 0)
    into ad, ad_total
  from public.rental_order o
  join public.rental_detail d on d.rental_order_id = o.rental_order_id
  join public.equipment e on e.equipment_id = d.equipment_id
  where o.booking_id = r.booking_id and o.rental_type = 'Add-on' and o.status not in ('Rejected', 'Cancelled');

  return jsonb_build_object(
    'booking_ref', r.booking_ref, 'status', r.status, 'start_at', r.start_at, 'end_at', r.end_at,
    'studio', r.studio_name, 'studio_description', r.studio_desc,
    'total', r.total,
    'studio_total', r.total, 'addons', ad, 'addons_total', ad_total, 'grand_total', r.total + ad_total,
    'payment_status', r.payment_status, 'rejected_reason', r.rejected_reason,
    'down_payment', r.down_payment, 'balance_due', greatest(0, r.total + ad_total - r.down_payment));
end $$;


-- 9. Revenue report ----------------------------------------------------------------------------
--    Booking payments are counted when staff verify them (the down payment, or the full amount for
--    older and walk-in bookings). The balance of a booking with a down payment is counted on the day
--    its session starts. Everything else is the same as 08_outside_rental.sql.
drop view if exists public.v_revenue_daily;
create view public.v_revenue_daily with (security_invoker = true) as
select day, kind, studio_name, sum(amount) as amount, count(*) as payments
from (
  -- studio part of a booking payment (the down payment, or the full payment of older/walk-in bookings)
  select (coalesce(p.verified_at, p.created_at) at time zone 'Asia/Manila')::date as day,
         'Studio'::text as kind, s.name::varchar(100) as studio_name,
         least(p.amount, public.booking_total(b.booking_id)) as amount
    from public.payment p
    join public.booking b on b.booking_id = p.booking_id
    join public.studio  s on s.studio_id  = b.studio_id
   where p.status = 'Verified'
  union all
  -- add-on equipment paid together with the booking
  select (coalesce(p.verified_at, p.created_at) at time zone 'Asia/Manila')::date,
         'Equipment'::text, null::varchar(100),
         p.amount - public.booking_total(b.booking_id)
    from public.payment p
    join public.booking b on b.booking_id = p.booking_id
   where p.status = 'Verified' and p.amount > public.booking_total(b.booking_id)
  union all
  -- the studio balance of a booking with a down payment, collected when the session starts
  select (b.actual_start_at at time zone 'Asia/Manila')::date,
         'Studio'::text, s.name::varchar(100),
         public.booking_total(b.booking_id) - least(b.down_payment, public.booking_total(b.booking_id))
    from public.booking b
    join public.studio s on s.studio_id = b.studio_id
   where b.down_payment > 0 and b.status in ('In Progress', 'Completed') and b.actual_start_at is not null
     and exists (select 1 from public.payment p where p.booking_id = b.booking_id and p.status = 'Verified')
     and public.booking_total(b.booking_id) - least(b.down_payment, public.booking_total(b.booking_id)) > 0
  union all
  -- the add-on equipment balance of a booking with a down payment, collected when the session starts
  select (b.actual_start_at at time zone 'Asia/Manila')::date,
         'Equipment'::text, null::varchar(100),
         public.booking_addons_total(b.booking_id) - greatest(b.down_payment - public.booking_total(b.booking_id), 0)
    from public.booking b
   where b.down_payment > 0 and b.status in ('In Progress', 'Completed') and b.actual_start_at is not null
     and exists (select 1 from public.payment p where p.booking_id = b.booking_id and p.status = 'Verified')
     and public.booking_addons_total(b.booking_id) - greatest(b.down_payment - public.booking_total(b.booking_id), 0) > 0
  union all
  -- rental payments (outside rental down payments, onsite rentals)
  select (coalesce(p.verified_at, p.created_at) at time zone 'Asia/Manila')::date,
         'Equipment'::text, null::varchar(100), p.amount
    from public.payment p
   where p.status = 'Verified' and p.rental_order_id is not null
  union all
  -- the other 50% of an online outside rental, collected when the equipment is issued
  select (o.issued_at at time zone 'Asia/Manila')::date,
         'Equipment'::text, null::varchar(100),
         public.rental_order_total(o.rental_order_id) - o.down_payment
    from public.rental_order o
   where o.down_payment > 0 and o.status in ('Active', 'Returned') and o.issued_at is not null
  union all
  -- late fees collected when the equipment is returned
  select (d.returned_at at time zone 'Asia/Manila')::date,
         'Equipment'::text, null::varchar(100), d.late_fee
    from public.rental_detail d
   where d.late_fee > 0
) x
group by day, kind, studio_name;

grant select on public.v_revenue_daily to authenticated;
