-- =====================================================================
-- 30_claim_guest_bookings.sql  (safe to re-run)
-- A customer who booked as a guest and then registers (or logs in) can move those
-- bookings onto their account, so they show up under My Bookings / My Rental.
--
-- The website calls claim_guest_bookings() right after the customer logs in, with the booking
-- code and the phone number used for each guest booking (the same two things the guest
-- "find my booking" lookup asks for). A booking is moved only when
--   * it was made online without an account (its customer row has no login), and
--   * the booking code exists and the phone number matches the one on the booking.
-- Its add-on equipment and extension requests move with it. Payments follow the booking.
-- Run this once in the Supabase SQL Editor.
-- =====================================================================

create or replace function public.claim_guest_bookings(p_items jsonb)
returns text[]
language plpgsql security definer set search_path = public as $$
declare
  cid     bigint := public.current_customer_id();
  it      jsonb;
  v_ref   text;
  v_phone text;
  b       record;
  claimed text[] := '{}';
begin
  if cid is null then
    raise exception 'Log in to save your bookings to your account.' using errcode = 'P0001';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    return claimed;
  end if;

  for it in select value from jsonb_array_elements(p_items) limit 25 loop
    v_ref   := upper(regexp_replace(coalesce(it ->> 'ref', ''), '\s', '', 'g'));
    v_phone := public.digits(it ->> 'phone');
    continue when v_ref = '' or length(v_phone) < 7;

    select bk.booking_id, bk.booking_ref into b
      from public.booking bk
      join public.customer c on c.customer_id = bk.customer_id
     where bk.booking_ref = v_ref
       and bk.source = 'Online'
       and c.auth_user_id is null
       and public.digits(c.number) = v_phone
     for update of bk;
    if not found then
      continue;
    end if;

    update public.booking           set customer_id = cid where booking_id = b.booking_id;
    update public.rental_order      set customer_id = cid where booking_id = b.booking_id;
    update public.booking_extension set customer_id = cid where booking_id = b.booking_id;
    claimed := claimed || b.booking_ref::text;
  end loop;

  return claimed;
end $$;

revoke all on function public.claim_guest_bookings(jsonb) from public, anon;
grant execute on function public.claim_guest_bookings(jsonb) to authenticated;
