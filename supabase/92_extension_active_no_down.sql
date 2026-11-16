-- =====================================================================
-- 92_extension_active_no_down.sql  (safe to re-run)
-- Extending a session WHILE IT IS ACTIVE (booking status 'In Progress') has only two payment choices:
--   * Pay after my session  -> customer_extend_pay_later()  (file 91, unchanged: the cost is added to the balance paid at the studio)
--   * Full Payment (100%)   -> customer_request_extension() with p_pay_option = 'full' (GCash, verified by staff)
-- The 50% down payment is no longer accepted for an active session. Before the session starts (Confirmed) 50% / 100% / pay later
-- work exactly as before. The Extend window (js/customer/myBookings.js) already hides the 50% option; this makes the database
-- refuse it too, so it cannot be sent by another route.
-- Run once in the Supabase SQL Editor (after 91_extension_pay_later.sql). No Edge Function change.
-- =====================================================================

drop function if exists public.customer_request_extension(text, integer, text, text, text);
drop function if exists public.customer_request_extension(text, integer, text, text, text, boolean);
create function public.customer_request_extension(
  p_booking_ref text, p_extra_hours integer, p_token text, p_gcash_reference text,
  p_pay_option text default 'down', p_without_addons boolean default false
) returns table (extension_id bigint, booking_ref text, new_end_at timestamptz, extra_cost numeric, down_payment numeric,
                 balance_due numeric, pay_option text, without_addons boolean)
language plpgsql security definer set search_path = public as $$
declare
  cid bigint := public.current_customer_id();
  b public.booking; info record; x public.booking_extension;
  cost numeric; dp numeric; tok text; stock_msg text; drop_addons boolean := false;
  gref text := regexp_replace(coalesce(p_gcash_reference, ''), '\s', '', 'g');
  opt text := lower(coalesce(nullif(trim(p_pay_option), ''), 'down'));
begin
  if opt not in ('down', 'full') then
    raise exception 'Choose 50%% down payment or full payment.' using errcode = 'P0001';
  end if;
  if cid is null then raise exception 'Please log in to extend your booking.' using errcode = 'P0001'; end if;
  if p_extra_hours is null or p_extra_hours < 1 or p_extra_hours > 4 then
    raise exception 'Choose 1 to 4 extra hours.' using errcode = 'P0001';
  end if;
  if gref !~ '^[0-9]{13}$' then
    raise exception 'Enter the 13-digit GCash reference number of your payment.' using errcode = 'P0001';
  end if;

  select * into b from public.booking bk where bk.booking_ref = upper(trim(p_booking_ref)) for update;
  if not found or b.customer_id is distinct from cid then
    raise exception 'That is not your booking.' using errcode = '42501';
  end if;

  -- NEW (file 92): once the session is running there is no 50% down payment - only full payment here, or "pay after the session"
  -- (customer_extend_pay_later, file 91)
  if b.status = 'In Progress' and opt = 'down' then
    raise exception 'While your session is active, choose Pay after my session or Full Payment (100%%).' using errcode = 'P0001';
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

  -- NEW: the add-on equipment is not free for the extra hours -> only with the customer's confirmation
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
  dp   := public.pay_option_amount(cost, opt);
  tok  := 'e' || replace(gen_random_uuid()::text, '-', '');

  insert into public.booking_extension (booking_id, customer_id, extra_hours, hourly_rate, extra_cost, down_payment,
                                        old_end_at, new_end_at, hold_token, without_addons)
  values (b.booking_id, cid, p_extra_hours, b.hourly_rate_at_booking, cost, dp,
          b.end_at, b.end_at + make_interval(hours => p_extra_hours), tok, drop_addons)
  returning * into x;

  insert into public.payment (extension_id, method, gcash_reference, amount, status, payment_option)
  values (x.extension_id, 'GCash', gref, dp, 'Pending', opt);

  -- reserve the extra hours until staff decide (an ordinary hold: nobody else can book or extend them)
  delete from public.slot_hold where expires_at < now() or token = p_token;
  insert into public.slot_hold (studio_id, start_at, end_at, token, expires_at, held_by_staff)
  values (b.studio_id, x.old_end_at, x.new_end_at, tok, x.new_end_at, false);

  return query select x.extension_id, b.booking_ref::text, x.new_end_at, cost, dp, cost - dp, opt, x.without_addons;
exception when unique_violation then
  raise exception 'That GCash reference number was already used.' using errcode = 'P0001';
end $$;

revoke all on function public.customer_request_extension(text, integer, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.customer_request_extension(text, integer, text, text, text, boolean) to authenticated;

-- end of 92_extension_active_no_down.sql