-- =====================================================================
-- 91_extension_pay_later.sql  (safe to re-run)
-- A customer can EXTEND a session and choose to pay AFTER the session instead of paying now.
--   * Pay now (unchanged, file 55): 50% or 100% with GCash, the extension is applied when staff verify the payment.
--   * Pay later (new): nothing is paid or verified. The extra hours are added to the booking at once and their cost becomes
--     part of the booking's balance, collected with "Collect balance & complete" (files 85, 86) - the same as when staff
--     extend a session. The extra hours are held for the customer (the studio is checked and locked like any extension).
--   * A booking that was paid in full (no down payment) is switched to the down-payment model, with what it already paid as
--     its down payment, so the extra hours show up as a balance (the same step file 55 does when a paid-in-full booking is
--     extended online).
-- Run once in the Supabase SQL Editor (after 90_addon_balance_in_session.sql). No Edge Function change.
-- =====================================================================

create or replace function public.customer_extend_pay_later(
  p_booking_ref text, p_extra_hours integer, p_token text default null, p_without_addons boolean default false
) returns table (extension_id bigint, booking_ref text, new_end_at timestamptz, extra_cost numeric, down_payment numeric,
                 balance_due numeric, pay_option text, without_addons boolean)
language plpgsql security definer set search_path = public as $$
declare
  cid bigint := public.current_customer_id();
  b public.booking; info record; x public.booking_extension;
  cost numeric; stock_msg text; drop_addons boolean := false; paid numeric := 0;
begin
  if cid is null then raise exception 'Please log in to extend your booking.' using errcode = 'P0001'; end if;
  if p_extra_hours is null or p_extra_hours < 1 or p_extra_hours > 4 then
    raise exception 'Choose 1 to 4 extra hours.' using errcode = 'P0001';
  end if;

  select * into b from public.booking bk where bk.booking_ref = upper(trim(p_booking_ref)) for update;
  if not found or b.customer_id is distinct from cid then
    raise exception 'That is not your booking.' using errcode = '42501';
  end if;
  if b.status not in ('Approved', 'In Progress') then
    raise exception 'Only a Confirmed or Active booking can be extended.' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('studio:' || b.studio_id, 0));

  if exists (select 1 from public.booking_extension e where e.booking_id = b.booking_id and e.status = 'Pending') then
    raise exception 'You already have an extension request waiting for staff to verify its payment.' using errcode = 'P0001';
  end if;

  -- the customer's own open Extend window (p_token) does not block the hours
  select * into info from public.staff_extension_info(b.booking_ref, p_token);
  if info.max_hours < info.min_hours then raise exception '%', info.message using errcode = 'P0001'; end if;
  if p_extra_hours > info.max_hours then
    raise exception '%', coalesce(info.message, 'Cannot extend: that time is not free.') using errcode = 'P0001';
  end if;
  if p_extra_hours < info.min_hours then
    raise exception 'The session is already past its end time. Extend by at least % hour(s).', info.min_hours using errcode = 'P0001';
  end if;

  stock_msg := public.booking_stock_conflict(b.booking_id, b.start_at, b.end_at + make_interval(hours => p_extra_hours),
                                             b.start_at, b.end_at);
  if stock_msg is not null then
    if not coalesce(p_without_addons, false) then
      raise exception 'Your add-on equipment is not free for the extra time. % Confirm to extend without the add-on.', stock_msg
        using errcode = 'P0001';
    end if;
    drop_addons := true;
  end if;

  cost := round(b.hourly_rate_at_booking * p_extra_hours, 2);

  -- a booking paid in full (no down payment): what it already paid becomes its down payment, so the extra hours are a balance
  if coalesce(b.down_payment, 0) = 0 then
    select coalesce(sum(p.amount), 0) into paid from public.payment p where p.booking_id = b.booking_id and p.status = 'Verified';
  end if;

  perform public.apply_extension_addon_cut(b.booking_id, p_extra_hours, drop_addons);

  begin
    update public.booking bk
       set end_at = bk.end_at + make_interval(hours => p_extra_hours),
           down_payment = case when bk.down_payment > 0 then bk.down_payment else paid end
     where bk.booking_id = b.booking_id;
  exception when exclusion_violation then
    raise exception 'Cannot extend: studio is booked for the next time slot.' using errcode = 'P0001';
  end;

  if p_token is not null then
    delete from public.slot_hold where token = p_token;     -- the hold did its job
  end if;

  insert into public.booking_extension (booking_id, customer_id, extra_hours, hourly_rate, extra_cost, down_payment,
                                        old_end_at, new_end_at, status, without_addons)
  values (b.booking_id, cid, p_extra_hours, b.hourly_rate_at_booking, cost, 0,
          b.end_at, b.end_at + make_interval(hours => p_extra_hours), 'Approved', drop_addons)
  returning * into x;

  return query select x.extension_id, b.booking_ref::text, x.new_end_at, cost, 0::numeric, cost, 'later'::text, x.without_addons;
end $$;
revoke all on function public.customer_extend_pay_later(text, integer, text, boolean) from public, anon, authenticated;
grant execute on function public.customer_extend_pay_later(text, integer, text, boolean) to authenticated;

-- end of 91_extension_pay_later.sql
