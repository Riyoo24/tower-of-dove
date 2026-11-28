-- =====================================================================
-- 101_guest_device_bookings.sql
-- Guests: show the bookings saved on their own device (My bookings / My rental)
-- the same way a signed-in customer sees them.
--
-- The browser remembers { ref, phone } of every booking a guest made. This function
-- takes that list and returns the same columns the account pages read from
-- v_booking_summary and v_rental_lines, but ONLY for guest bookings (no account)
-- whose phone number matches the one on the booking. A wrong phone, an unknown
-- reference, or a booking that belongs to an account returns nothing.
-- Safe to run more than once.
-- =====================================================================

create or replace function public.guest_device_bookings(p_items jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_refs     text[];
  v_bookings jsonb;
  v_rentals  jsonb;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    return jsonb_build_object('bookings', '[]'::jsonb, 'rentals', '[]'::jsonb);
  end if;

  -- booking references that exist as GUEST bookings and whose phone matches (at most 20 per call)
  select coalesce(array_agg(v.booking_ref), '{}')
    into v_refs
  from (select x from jsonb_array_elements(p_items) with ordinality as t(x, n) order by n limit 20) it
  join public.v_booking_summary v
    on v.booking_ref = upper(regexp_replace(coalesce(it.x ->> 'ref', ''), '\s', '', 'g'))
  where v.is_guest
    and public.digits(it.x ->> 'phone') <> ''
    and public.digits(v.customer_number) = public.digits(it.x ->> 'phone');

  select coalesce(jsonb_agg(to_jsonb(v) order by v.start_at), '[]'::jsonb)
    into v_bookings
  from public.v_booking_summary v
  where v.booking_ref = any (v_refs);

  -- the add-on equipment of those bookings
  select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at desc), '[]'::jsonb)
    into v_rentals
  from public.v_rental_lines r
  where r.rental_type = 'Add-on'
    and r.booking_ref = any (v_refs);

  return jsonb_build_object('bookings', v_bookings, 'rentals', v_rentals);
end $$;

revoke all on function public.guest_device_bookings(jsonb) from public;
grant execute on function public.guest_device_bookings(jsonb) to anon, authenticated;