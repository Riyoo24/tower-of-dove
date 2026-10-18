-- =====================================================================
-- 10_guest_lookup_privacy.sql  (safe to re-run)
-- The reference-code lookup is for GUEST bookings and rentals only.
-- A booking or rental made with an account can only be read by that account
-- (My Bookings / My Rental) or by staff, even if someone knows the code.
-- It answers "not found" in that case, so it does not confirm the code exists.
-- Run this once in the Supabase SQL Editor.
-- =====================================================================

create or replace function public.lookup_booking(p_ref text, p_phone text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r record; ad jsonb; ad_total numeric;
begin
  select b.booking_id, b.booking_ref, b.status, b.start_at, b.end_at, s.name as studio_name, s.description as studio_desc,
         public.booking_total(b.booking_id) as total,
         (select p.status from public.payment p where p.booking_id = b.booking_id order by p.payment_id desc limit 1) as payment_status,
         c.number, c.auth_user_id
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
    'payment_status', r.payment_status);
end $$;

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
    -- registered customers' rentals are private: only the account owner or staff may read them
    and (c.auth_user_id is null or c.auth_user_id = auth.uid() or public.is_staff())
    and (p_phone is null or public.digits(c.number) = public.digits(p_phone));

  if jsonb_array_length(result) = 0 then return null; end if;
  return result;
end $$;
