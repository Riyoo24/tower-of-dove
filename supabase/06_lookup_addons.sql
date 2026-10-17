-- =====================================================================
-- 06_lookup_addons.sql  (safe to re-run)
-- The guest "find my booking" lookup now also returns the add-on equipment
-- on the booking and a grand total (studio + add-ons).
-- Run this once in the Supabase SQL Editor.
-- =====================================================================
create or replace function public.lookup_booking(p_ref text, p_phone text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r record; ad jsonb; ad_total numeric;
begin
  select b.booking_id, b.booking_ref, b.status, b.start_at, b.end_at, s.name as studio_name, s.description as studio_desc,
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

  -- add-on equipment on this booking (rejected or cancelled requests are not counted)
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
    'total', r.total,                         -- studio only (kept for older pages)
    'studio_total', r.total, 'addons', ad, 'addons_total', ad_total, 'grand_total', r.total + ad_total,
    'payment_status', r.payment_status);
end $$;
