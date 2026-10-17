-- =====================================================================
-- 08_outside_rental.sql  (safe to re-run)
-- Outside (take-home) rentals:
--   * logged-in customers only (guests are blocked)
--   * priced per hour: the item price covers 8 hours, every extra hour adds price / 8
--   * 50% down payment (GCash) is paid with the request; the balance is paid at pick-up
--   * late returns add the same hourly charge (price / 8) for every hour late
-- Customers can cancel their own rentals (same 24-hour rule as bookings).
-- Run this once in the Supabase SQL Editor.
-- =====================================================================

-- 1. New columns -------------------------------------------------------
alter table public.rental_detail add column if not exists late_fee     numeric(10,2) not null default 0;
alter table public.rental_order  add column if not exists down_payment numeric(10,2) not null default 0;

-- 2. Pricing: min 8 hours, then price / 8 for every extra hour (rounded up to whole hours)
create or replace function public.rental_order_total(p_order_id bigint) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(
    d.quantity * d.unit_price_at_request *
    case when o.rental_type = 'Outside'
         then greatest(8, ceil(coalesce(d.rental_hours, 8)))::numeric / 8
         else 1 end
  ), 0)::numeric(10,2)
  from public.rental_order o
  join public.rental_detail d on d.rental_order_id = o.rental_order_id
  where o.rental_order_id = p_order_id;
$$;

-- 3. Guests cannot create online outside rentals, and nobody can skip the down payment:
--    an online outside rental can only be created by request_outside_rental() below.
create or replace function public.rental_outside_guard() returns trigger
language plpgsql as $$
begin
  if new.rental_type = 'Outside' and new.source = 'Online'
     and coalesce(current_setting('app.outside_ok', true), '') <> '1' then
    raise exception 'Outside rentals need an account and a down payment. Please log in and use the Rent equipment page.' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists trg_rental_outside_guard on public.rental_order;
create trigger trg_rental_outside_guard before insert on public.rental_order
  for each row execute function public.rental_outside_guard();

-- 4. Request an outside rental with the 50% down payment ------------------
create or replace function public.request_outside_rental(
  p_items jsonb, p_first_name text, p_last_name text, p_number text,
  p_pickup_date timestamptz, p_return_date timestamptz,
  p_contact_number text, p_backup_contact text, p_id_type text, p_id_image_path text,
  p_gcash_reference text
) returns table (rental_ref text, total_amount numeric, down_payment numeric)
language plpgsql security definer set search_path = public as $$
declare
  r record; total numeric; dp numeric;
  gref text := regexp_replace(coalesce(p_gcash_reference, ''), '\s', '', 'g');
begin
  if public.current_customer_id() is null then
    raise exception 'Please log in or register to rent equipment outside the studio.' using errcode = 'P0001';
  end if;
  if gref !~ '^[0-9]{13}$' then
    raise exception 'Enter the 13-digit GCash reference number of your down payment.' using errcode = 'P0001';
  end if;

  perform set_config('app.outside_ok', '1', true);
  select o.rental_order_id, o.rental_ref, o.total_amount into r
    from public.request_rental('Outside', p_items, null, p_first_name, p_last_name, p_number,
                               p_pickup_date, p_return_date, p_contact_number, p_backup_contact,
                               p_id_type, p_id_image_path) o;
  perform set_config('app.outside_ok', '', true);

  total := r.total_amount;
  dp := round(total * 0.5, 2);
  update public.rental_order set down_payment = dp where rental_order_id = r.rental_order_id;
  insert into public.payment (rental_order_id, method, gcash_reference, amount, status)
  values (r.rental_order_id, 'GCash', gref, dp, 'Pending');

  return query select r.rental_ref::text, total, dp;
exception when unique_violation then
  raise exception 'That GCash reference number was already used.' using errcode = 'P0001';
end $$;

-- 5. Cancel a rental (customer: own rentals, until 24 hours before pick-up / the session)
create or replace function public.cancel_rental(p_rental_ref text, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare o public.rental_order; staff boolean := public.is_staff(); due timestamptz;
begin
  select * into o from public.rental_order where rental_ref = upper(trim(p_rental_ref)) for update;
  if not found then raise exception 'Rental not found.' using errcode = 'P0001'; end if;
  if not staff and o.customer_id is distinct from public.current_customer_id() then
    raise exception 'That is not your rental.' using errcode = '42501';
  end if;
  if o.status not in ('Pending', 'Approved') then
    raise exception 'A % rental cannot be cancelled.', o.status using errcode = 'P0001';
  end if;

  if o.rental_type = 'Outside' then
    due := o.pickup_date;
  else
    select b.start_at into due from public.booking b where b.booking_id = o.booking_id;
  end if;
  if not staff and due is not null and now() > due - interval '24 hours' then
    raise exception 'Changes and cancellations close 24 hours before %.',
      case when o.rental_type = 'Outside' then 'pick-up' else 'your session' end using errcode = 'P0001';
  end if;

  update public.rental_order set status = 'Cancelled' where rental_order_id = o.rental_order_id;
  -- an unpaid (still Pending) payment is closed; a verified down payment is NOT refunded
  update public.payment set status = 'Rejected' where rental_order_id = o.rental_order_id and status = 'Pending';
end $$;

-- 6. Returning equipment: late fee = quantity x price / 8 x each hour late (rounded up) -----
create or replace function public.staff_return_rental(p_rental_ref text, p_equipment_id bigint default null)
returns void language plpgsql security definer set search_path = public as $$
declare o public.rental_order; open_lines int;
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  select * into o from public.rental_order where rental_ref = upper(trim(p_rental_ref)) for update;
  if not found then raise exception 'Rental not found.' using errcode = 'P0001'; end if;
  if o.status <> 'Active' then raise exception 'Only active rentals can be returned (this one is %).', o.status using errcode = 'P0001'; end if;

  update public.rental_detail d
     set returned_at = now(),
         late_fee = case when o.rental_type = 'Outside' and o.return_date is not null and now() > o.return_date
                         then round(d.quantity * d.unit_price_at_request / 8.0
                                    * ceil(extract(epoch from (now() - o.return_date)) / 3600.0), 2)
                         else 0 end
   where d.rental_order_id = o.rental_order_id and d.returned_at is null
     and (p_equipment_id is null or d.equipment_id = p_equipment_id);

  select count(*) into open_lines from public.rental_detail where rental_order_id = o.rental_order_id and returned_at is null;
  if open_lines = 0 then
    update public.rental_order set status = 'Returned' where rental_order_id = o.rental_order_id;
  end if;
end $$;

-- 7. Dashboard view: two extra columns at the end (late fee and down payment) ----------------
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
  o.rejected_reason, o.issued_at, o.returned_at, o.created_at,
  d.late_fee, o.down_payment
from public.rental_order o
join public.rental_detail d on d.rental_order_id = o.rental_order_id
join public.equipment e on e.equipment_id = d.equipment_id
join public.customer c on c.customer_id = o.customer_id
left join public.booking bk on bk.booking_id = o.booking_id;

-- 8. Revenue report: also count the balance paid at pick-up and late fees -------------------
drop view if exists public.v_revenue_daily;
create view public.v_revenue_daily with (security_invoker = true) as
select day, kind, studio_name, sum(amount) as amount, count(*) as payments
from (
  -- studio part of a booking payment
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

-- 9. Permissions ------------------------------------------------------------------------------
grant select on public.v_revenue_daily to authenticated;
revoke all on function public.request_outside_rental(jsonb, text, text, text, timestamptz, timestamptz, text, text, text, text, text) from public, anon;
grant execute on function public.request_outside_rental(jsonb, text, text, text, timestamptz, timestamptz, text, text, text, text, text) to authenticated;
revoke all on function public.cancel_rental(text, text) from public, anon;
grant execute on function public.cancel_rental(text, text) to authenticated;
