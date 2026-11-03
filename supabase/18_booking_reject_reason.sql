-- =====================================================================
-- 18_booking_reject_reason.sql  (safe to re-run)
-- Rejecting a booking now needs a reason, and the customer sees it.
--   * staff_reject_booking(booking_ref, reason)  rejects a Pending booking (and its pending payment) with a reason
--   * v_booking_summary gets a rejected_reason column (My bookings reads it)
--   * lookup_booking (guest reference lookup) returns rejected_reason too
-- Run once in the Supabase SQL Editor (after 17_customer_extend.sql).
-- =====================================================================

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
  b.rejected_reason
from public.booking b
join public.studio s   on s.studio_id = b.studio_id
join public.customer c on c.customer_id = b.customer_id
left join lateral (
  select * from public.payment p where p.booking_id = b.booking_id order by p.payment_id desc limit 1
) p on true;
grant select on public.v_booking_summary to authenticated;

create or replace function public.staff_reject_booking(p_booking_ref text, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare b public.booking; why text := trim(coalesce(p_reason, ''));
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  if length(why) < 3 then raise exception 'Enter the reason for rejecting this booking.' using errcode = 'P0001'; end if;
  if length(why) > 300 then raise exception 'Keep the reason under 300 characters.' using errcode = 'P0001'; end if;

  select * into b from public.booking bk where bk.booking_ref = upper(trim(p_booking_ref)) for update;
  if not found then raise exception 'Booking not found.' using errcode = 'P0001'; end if;
  if b.status <> 'Pending' then
    raise exception 'Only a Pending booking can be rejected (this one is %).', b.status using errcode = 'P0001';
  end if;

  update public.booking set status = 'Rejected', rejected_reason = why where booking_id = b.booking_id;
  update public.payment set status = 'Rejected' where booking_id = b.booking_id and status = 'Pending';
end $$;

revoke all on function public.staff_reject_booking(text, text) from public, anon, authenticated;
grant execute on function public.staff_reject_booking(text, text) to authenticated;

create or replace function public.lookup_booking(p_ref text, p_phone text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r record; ad jsonb; ad_total numeric;
begin
  select b.booking_id, b.booking_ref, b.status, b.start_at, b.end_at, s.name as studio_name, s.description as studio_desc,
         public.booking_total(b.booking_id) as total,
         (select p.status from public.payment p where p.booking_id = b.booking_id order by p.payment_id desc limit 1) as payment_status,
         c.number, c.auth_user_id, b.rejected_reason
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
    'payment_status', r.payment_status, 'rejected_reason', r.rejected_reason);
end $$;
