-- =====================================================================
-- 42_onsite_receipt_email.sql  (safe to re-run)
-- Onsite bookings and onsite rentals can now email a receipt to the customer.
--   * the onsite forms have an optional "Email for the receipt" box
--   * staff_set_receipt_email() saves that address on the onsite booking / rental (staff only, onsite records only)
--     and returns the id of the verified payment, so the admin page can ask the existing `send-receipt`
--     Edge Function for the "verified" receipt (the same email staff already send after verifying a payment).
--   * an onsite add-on with no typed address uses the address saved with its onsite booking, if there is one
-- The recipient is still never chosen by the browser at send time: the Edge Function reads it from the database.
-- Needs: 34_receipt_emails.sql, 35_verified_emails.sql and the send-receipt Edge Function (already set up for the website).
-- Run this once in the Supabase SQL Editor (after 41_auto_complete_sessions.sql).
-- =====================================================================

create or replace function public.staff_set_receipt_email(p_kind text, p_ref text, p_email text default null)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  mail text := lower(nullif(trim(coalesce(p_email, '')), ''));
  ref  text := upper(regexp_replace(coalesce(p_ref, ''), '\s', '', 'g'));
  b public.booking; o public.rental_order; pid bigint;
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  if mail is not null and (length(mail) > 254 or mail !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    raise exception 'Enter a valid email address, like name@gmail.com.' using errcode = 'P0001';
  end if;

  if p_kind = 'booking' then
    select * into b from public.booking where booking_ref = ref and source = 'Onsite';
    if not found then raise exception 'Onsite booking not found.' using errcode = 'P0001'; end if;
    if mail is null then return null; end if;
    update public.booking set receipt_email = mail where booking_id = b.booking_id;
    select p.payment_id into pid from public.payment p
     where p.booking_id = b.booking_id and p.status = 'Verified' and p.verified_email_sent_at is null
     order by p.payment_id desc limit 1;

  elsif p_kind = 'rental' then
    select * into o from public.rental_order where rental_ref = ref and source = 'Onsite';
    if not found then raise exception 'Onsite rental not found.' using errcode = 'P0001'; end if;
    if mail is null and o.booking_id is not null then
      select receipt_email into mail from public.booking where booking_id = o.booking_id;   -- the add-on's booking
    end if;
    if mail is null then return null; end if;
    update public.rental_order set receipt_email = mail where rental_order_id = o.rental_order_id;
    select p.payment_id into pid from public.payment p
     where p.rental_order_id = o.rental_order_id and p.status = 'Verified' and p.verified_email_sent_at is null
     order by p.payment_id desc limit 1;

  else
    raise exception 'Choose booking or rental.' using errcode = 'P0001';
  end if;
  return pid;
end $$;
revoke all on function public.staff_set_receipt_email(text, text, text) from public, anon;
grant execute on function public.staff_set_receipt_email(text, text, text) to authenticated;
