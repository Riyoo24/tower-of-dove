-- =====================================================================
-- 44_onsite_booking_down_payment.sql  (safe to re-run)
-- Onsite STUDIO booking for a later day: staff can record a 50% down payment instead of the full payment.
--   * a booking for today stays full payment (the server refuses a down payment for today)
--   * the booking keeps its down payment, so Bookings shows "Balance PHP x" and its Start button reads
--     "Collect balance & start" (staff collect the rest at the studio before the session), exactly like an online booking paid at 50%
--   * the payment is a Verified down payment (Payments tab: "down payment"), then fully paid once the balance is collected
-- Run this once in the Supabase SQL Editor (after 43_onsite_outside_down_payment.sql).
-- =====================================================================

drop function if exists public.staff_create_onsite_booking(bigint, timestamptz, timestamptz, text, text, text, text, text, text);

create or replace function public.staff_create_onsite_booking(
  p_studio_id bigint, p_start_at timestamptz, p_end_at timestamptz,
  p_first_name text, p_last_name text, p_number text,
  p_payment_method text, p_gcash_reference text default null,
  p_token text default null,
  p_pay_option text default 'full'
) returns table (booking_id bigint, booking_ref text, total_amount numeric)
language plpgsql security definer set search_path = public as $$
declare b public.booking; cid bigint; total numeric; dp numeric;
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  perform public.validate_slot(p_start_at, p_end_at, true);
  if p_payment_method not in ('GCash', 'Cash') then
    raise exception 'Choose GCash or Cash.' using errcode = 'P0001';
  end if;
  if p_pay_option not in ('full', 'down') then
    raise exception 'Choose full payment or 50%% down payment.' using errcode = 'P0001';
  end if;
  -- a 50% down payment is only for a booking on a later day (a booking for today is paid in full)
  if p_pay_option = 'down' and (p_start_at at time zone 'Asia/Manila')::date <= (now() at time zone 'Asia/Manila')::date then
    raise exception 'A 50%% down payment is only for a booking on a later day. Today''s bookings are paid in full.' using errcode = 'P0001';
  end if;
  -- the GCash reference is optional; if one is typed it must look real
  if p_payment_method = 'GCash' and nullif(trim(coalesce(p_gcash_reference, '')), '') is not null
     and length(trim(p_gcash_reference)) < 6 then
    raise exception 'The GCash reference must be at least 6 characters, or leave it blank.' using errcode = 'P0001';
  end if;

  cid := public.resolve_customer(p_first_name, p_last_name, p_number, true);
  b := public.insert_booking_with_payment(cid, p_studio_id, p_start_at, p_end_at,
         p_payment_method, p_gcash_reference, 'Onsite', public.current_app_user_id(), p_token);
  total := public.booking_total(b.booking_id);

  if p_pay_option = 'down' then
    dp := public.pay_option_amount(total, 'down');
    update public.booking bk set down_payment = dp where bk.booking_id = b.booking_id;      -- the balance is collected at the studio
    update public.payment pay set amount = dp, payment_option = 'down'
     where pay.booking_id = b.booking_id and pay.status <> 'Rejected';
  else
    update public.payment pay set payment_option = 'full'
     where pay.booking_id = b.booking_id and pay.status <> 'Rejected';
  end if;
  return query select b.booking_id, b.booking_ref::text, total;
end $$;

revoke all on function public.staff_create_onsite_booking(bigint, timestamptz, timestamptz, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.staff_create_onsite_booking(bigint, timestamptz, timestamptz, text, text, text, text, text, text, text) to authenticated;
