-- =====================================================================
-- 50_addon_full_payment_when_started.sql  (safe to re-run)
-- Equipment added to a studio session that has ALREADY STARTED must be paid in full (100%).
--   Why: a 50% down payment leaves a balance, the item is not handed out until staff collect it, and a band in
--        the middle of a session would wait (or the balance could be forgotten). With full payment nothing is left
--        to collect: the equipment is issued by itself as soon as staff verify the GCash payment.
--   * online (customer / guest): request_addon_rental() refuses 'down' when the booking is In Progress or its start
--     time has passed (the website only offers full payment in that case)
--   * onsite (staff): onsite add-ons were already full payment only (staff_create_onsite_rental refuses a down
--     payment for an add-on, file 43), so nothing changes there
--   * before the session starts, a customer can still choose 50% or 100% as before
-- Run this once in the Supabase SQL Editor (after 49_cron_auto_complete.sql).
-- =====================================================================

create or replace function public.request_addon_rental(
  p_booking_ref text, p_items jsonb, p_pay_option text default 'down', p_gcash_reference text default null
) returns table (rental_ref text, total_amount numeric, down_payment numeric, pay_option text)
language plpgsql security definer set search_path = public as $$
declare
  r record; total numeric; dp numeric; mail text; bk public.booking;
  gref text := regexp_replace(coalesce(p_gcash_reference, ''), '\s', '', 'g');
  opt  text := lower(coalesce(nullif(trim(p_pay_option), ''), 'down'));
begin
  if opt not in ('down', 'full') then
    raise exception 'Choose 50%% down payment or full payment.' using errcode = 'P0001';
  end if;
  if gref !~ '^[0-9]{13}$' then
    raise exception 'Enter the 13-digit GCash reference number of your payment.' using errcode = 'P0001';
  end if;

  -- the session has started: equipment added now is paid in full
  select * into bk from public.booking
   where booking_ref = upper(regexp_replace(coalesce(p_booking_ref, ''), '\s', '', 'g'));
  if found and opt <> 'full' and (bk.status = 'In Progress' or bk.start_at <= now()) then
    raise exception 'Your session has already started, so equipment added now must be paid in full (100%%).' using errcode = 'P0001';
  end if;

  select o.rental_order_id, o.rental_ref, o.total_amount into r
    from public.request_rental('Add-on', p_items, p_booking_ref) o;

  select coalesce(public.current_account_email(), b.receipt_email) into mail
    from public.rental_order ro join public.booking b on b.booking_id = ro.booking_id
   where ro.rental_order_id = r.rental_order_id;

  total := r.total_amount;
  dp := public.pay_option_amount(total, opt);
  update public.rental_order set down_payment = dp, receipt_email = mail where rental_order_id = r.rental_order_id;
  insert into public.payment (rental_order_id, method, gcash_reference, amount, status, payment_option)
  values (r.rental_order_id, 'GCash', gref, dp, 'Pending', opt);

  return query select r.rental_ref::text, total, dp, opt;
exception when unique_violation then
  raise exception 'That GCash reference number was already used.' using errcode = 'P0001';
end $$;
revoke all on function public.request_addon_rental(text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.request_addon_rental(text, jsonb, text, text) to anon, authenticated;
