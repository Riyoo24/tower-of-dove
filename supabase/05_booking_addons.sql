-- =====================================================================
-- 05_booking_addons.sql  (safe to re-run)
-- Lets a customer book a studio AND add equipment in one step, and pay one
-- combined amount. Run this once in the Supabase SQL Editor.
-- =====================================================================

-- 1. Book a studio plus optional add-on equipment in one transaction.
--    If anything fails (for example an add-on item is not available), nothing is saved.
--    The payment amount becomes studio total + add-on total, so staff verify one payment.
create or replace function public.create_booking_with_addons(
  p_studio_id bigint, p_start_at timestamptz, p_end_at timestamptz,
  p_first_name text, p_last_name text, p_number text,
  p_payment_method text, p_gcash_reference text default null, p_hold_token text default null,
  p_items jsonb default '[]'::jsonb
) returns table (
  booking_ref text, status text, studio_total numeric, addons_total numeric, total_amount numeric, rental_ref text
)
language plpgsql security definer set search_path = public as $$
declare
  bk record;
  studio numeric := 0;
  addons numeric := 0;
  rref   text;
begin
  select * into bk from public.create_booking(
    p_studio_id, p_start_at, p_end_at, p_first_name, p_last_name, p_number,
    p_payment_method, p_gcash_reference, p_hold_token);
  studio := bk.total_amount;

  if p_items is not null and jsonb_typeof(p_items) = 'array' and jsonb_array_length(p_items) > 0 then
    select o.rental_ref, o.total_amount into rref, addons
      from public.request_rental('Add-on', p_items, bk.booking_ref) o;

    update public.payment pay
       set amount = studio + coalesce(addons, 0)
     where pay.booking_id = bk.booking_id and pay.status <> 'Rejected';
  end if;

  return query select bk.booking_ref::text, bk.status::text, studio, coalesce(addons, 0), studio + coalesce(addons, 0), rref;
end $$;

revoke all on function public.create_booking_with_addons(bigint, timestamptz, timestamptz, text, text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.create_booking_with_addons(bigint, timestamptz, timestamptz, text, text, text, text, text, text, jsonb) to anon, authenticated;


-- 2. Revenue report: split a booking payment into its studio part and its add-on equipment part,
--    so "Studio revenue" and "Equipment revenue" stay correct.
-- (dropped and recreated because the column types are fixed once a view exists)
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
  -- rentals paid on their own (outside rentals, onsite rentals)
  select (coalesce(p.verified_at, p.created_at) at time zone 'Asia/Manila')::date,
         'Equipment'::text, null::varchar(100), p.amount
    from public.payment p
   where p.status = 'Verified' and p.rental_order_id is not null
) x
group by day, kind, studio_name;

grant select on public.v_revenue_daily to authenticated;
