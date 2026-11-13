-- =====================================================================
-- 75_onsite_cash_tendered.sql  (safe to re-run)
-- Onsite STUDIO booking and onsite RENTAL paid in CASH: staff now type the cash tendered (cash given) in the form.
--   * payment.cash_tendered keeps the amount, so the receipt email can show "Cash received" and "Change"
--   * staff_set_receipt_email() gets an optional 4th argument p_tendered (the forms call it right after saving)
--   * only saved for a Cash payment, and only when it covers the amount of that payment
-- Run this once in the Supabase SQL Editor (after 73_approve_after_swap.sql). Then deploy the send-receipt Edge Function again.
-- =====================================================================

alter table public.payment add column if not exists cash_tendered numeric(10,2);

drop function if exists public.staff_set_receipt_email(text, text, text);

create or replace function public.staff_set_receipt_email(p_kind text, p_ref text, p_email text default null, p_tendered numeric default null)
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

  -- the cash given by the customer, kept for the receipt (Cash payments only, and only if it covers the payment)
  if pid is not null and p_tendered is not null then
    update public.payment set cash_tendered = round(p_tendered, 2)
     where payment_id = pid and method = 'Cash' and p_tendered + 0.005 >= amount;
  end if;
  return pid;
end $$;
revoke all on function public.staff_set_receipt_email(text, text, text, numeric) from public, anon;
grant execute on function public.staff_set_receipt_email(text, text, text, numeric) to authenticated;

-- end of 75_onsite_cash_tendered.sql
