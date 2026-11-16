-- =====================================================================
-- 93_staff_extend_session_payment.sql  (safe to re-run)
-- STAFF extending a session that is ALREADY RUNNING (booking status 'In Progress') now has the same two payment choices as
-- equipment added to a running session (files 90 / 91):
--   * Full payment (paid now)  -> staff receive the cost of the extra hours at once, Cash (amount tendered, change) or GCash
--                                 (13-digit reference + screenshot). It is saved as a Verified payment of the extension and
--                                 added to the booking's down payment, so there is no balance for the extra hours.
--   * After the session        -> nothing is received now. The cost of the extra hours becomes part of the booking's balance,
--                                 collected with "Collect balance & complete" (files 85, 86), the same as a customer's
--                                 "Pay after my session" (file 91).
-- Both choices extend the booking at once (same studio, closing-time and add-on checks as staff_extend_booking) and are saved
-- in the booking's extension History as Approved.
-- A Confirmed booking (not started yet) still uses staff_extend_booking (file 55), which is NOT changed.
-- A booking that was paid in full (no down payment) is switched to the down-payment model, with what it already paid as its
-- down payment (the same step files 55 and 91 do).
-- Run once in the Supabase SQL Editor (after 91_extension_pay_later.sql). No Edge Function change.
-- =====================================================================

drop function if exists public.staff_extend_session(text, integer, text, boolean, boolean, text, text, numeric);

create function public.staff_extend_session(
  p_booking_ref    text,
  p_extra_hours    integer,
  p_token          text    default null,
  p_without_addons boolean default false,
  p_pay_later      boolean default false,
  p_payment_method text    default 'Cash',
  p_gcash_reference text   default null,
  p_tendered       numeric default null
) returns table (booking_ref text, new_end_at timestamptz, extra_cost numeric, studio_total numeric,
                 pay_option text, paid_now numeric, balance_due numeric, addon_dropped boolean)
language plpgsql security definer set search_path = public as $$
declare
  staff_id bigint := public.current_app_user_id();
  b public.booking; info record; x public.booking_extension;
  cost numeric; stock_msg text; dropped boolean := false; paid numeric := 0;
  later boolean := coalesce(p_pay_later, false);
  pm text := case lower(coalesce(trim(p_payment_method), 'cash')) when 'gcash' then 'GCash' when 'cash' then 'Cash' else null end;
  gref text := regexp_replace(coalesce(p_gcash_reference, ''), '\s', '', 'g');
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  if p_extra_hours is null or p_extra_hours < 1 or p_extra_hours > 4 then
    raise exception 'Choose 1 to 4 extra hours.' using errcode = 'P0001';
  end if;
  if not later then
    if pm is null then raise exception 'Choose how the extra time was paid: Cash or GCash.' using errcode = 'P0001'; end if;
    if pm = 'GCash' and gref !~ '^[0-9]{13}$' then
      raise exception 'Enter the 13-digit GCash reference number.' using errcode = 'P0001';
    end if;
  end if;

  select * into b from public.booking bk where bk.booking_ref = upper(trim(p_booking_ref)) for update;
  if not found then raise exception 'Booking not found.' using errcode = 'P0001'; end if;
  if b.status <> 'In Progress' then
    raise exception 'Paying now or after the session is only for a session that is running (Active). This booking is %.', b.status
      using errcode = 'P0001';
  end if;

  cost := round(b.hourly_rate_at_booking * p_extra_hours, 2);
  if not later and pm = 'Cash' and (p_tendered is null or p_tendered + 0.005 < cost) then
    raise exception 'The cash received is less than the extension cost of PHP %.', to_char(cost, 'FM999,999,990.00') using errcode = 'P0001';
  end if;

  -- same lock the booking functions use, so nobody can book the free hour while we extend
  perform pg_advisory_xact_lock(hashtextextended('studio:' || b.studio_id, 0));

  -- a customer's extension request still waiting for its payment to be verified would no longer fit the new end time
  if exists (select 1 from public.booking_extension e where e.booking_id = b.booking_id and e.status = 'Pending') then
    raise exception 'This booking has an extension request waiting for its payment to be verified. Verify or reject it first.' using errcode = 'P0001';
  end if;

  -- holds by other people block the extension; this staff member's own hold does not
  select * into info from public.staff_extension_info(b.booking_ref, p_token);
  if info.max_hours < info.min_hours then raise exception '%', info.message using errcode = 'P0001'; end if;
  if p_extra_hours > info.max_hours then
    raise exception '%', coalesce(info.message, 'Cannot extend: that time is not free.') using errcode = 'P0001';
  end if;
  if p_extra_hours < info.min_hours then
    raise exception 'The session is already past its end time. Extend by at least % hour(s).', info.min_hours using errcode = 'P0001';
  end if;

  -- the add-on equipment is not free for the extra hours -> only with the staff member's confirmation
  stock_msg := public.booking_stock_conflict(b.booking_id, b.start_at, b.end_at + make_interval(hours => p_extra_hours),
                                             b.start_at, b.end_at);
  if stock_msg is not null and not coalesce(p_without_addons, false) then
    raise exception 'The add-on equipment of this booking is not free for the extra time. % Confirm to extend without the add-on.', stock_msg
      using errcode = 'P0001';
  end if;
  dropped := public.apply_extension_addon_cut(b.booking_id, p_extra_hours, coalesce(p_without_addons, false));

  -- a booking paid in full (no down payment): what it already paid becomes its down payment, so the extra hours are a balance
  if coalesce(b.down_payment, 0) = 0 then
    select coalesce(sum(p.amount), 0) into paid from public.payment p where p.booking_id = b.booking_id and p.status = 'Verified';
  end if;

  begin
    update public.booking bk
       set end_at = bk.end_at + make_interval(hours => p_extra_hours),
           down_payment = case when bk.down_payment > 0 then bk.down_payment else paid end + case when later then 0 else cost end
     where bk.booking_id = b.booking_id;
  exception when exclusion_violation then
    raise exception 'Cannot extend: studio is booked for the next time slot.' using errcode = 'P0001';
  end;

  if p_token is not null then
    delete from public.slot_hold where token = p_token;     -- the hold did its job
  end if;

  insert into public.booking_extension (booking_id, customer_id, extra_hours, hourly_rate, extra_cost, down_payment,
                                        old_end_at, new_end_at, status, approved_by, without_addons)
  values (b.booking_id, b.customer_id, p_extra_hours, b.hourly_rate_at_booking, cost, case when later then 0 else cost end,
          b.end_at, b.end_at + make_interval(hours => p_extra_hours), 'Approved', staff_id, dropped)
  returning * into x;

  if not later then
    insert into public.payment (extension_id, method, gcash_reference, amount, status, verified_by, verified_at, payment_option, cash_tendered)
    values (x.extension_id, pm, case when pm = 'GCash' then gref end, cost, 'Verified', staff_id, now(), 'full',
            case when pm = 'Cash' then round(p_tendered, 2) end);
  end if;

  return query
    select b.booking_ref::text, x.new_end_at, cost, public.booking_total(b.booking_id),
           case when later then 'later' else 'full' end::text,
           case when later then 0 else cost end::numeric,
           case when later then cost else 0 end::numeric,
           dropped;
exception when unique_violation then
  raise exception 'That GCash reference number was already used.' using errcode = 'P0001';
end $$;

revoke all on function public.staff_extend_session(text, integer, text, boolean, boolean, text, text, numeric) from public, anon;
grant execute on function public.staff_extend_session(text, integer, text, boolean, boolean, text, text, numeric) to authenticated;

-- end of 93_staff_extend_session_payment.sql