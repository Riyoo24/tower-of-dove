-- =====================================================================
-- 85_collect_balance_on_complete.sql  (safe to re-run)
-- Mark completed collects the balance of an extended session.
--   When staff extend an Active session, the extra hours are added to the bill (the Payment column shows "Balance P...").
--   Mark completed now opens the same window as Collect balance & start: the amount due, Cash (amount tendered and
--   change) or GCash (13-digit reference). The page saves the balance and marks the booking Completed.
--   * staff_collect_balance() (file 45) accepted only a Confirmed booking. With p_start = false it now also accepts one
--     that is In Progress, records the balance and leaves the status alone (the page completes it right after).
--     Starting a session (p_start = true) still needs a Confirmed booking, exactly as before.
--   * Each collection clears payment.balance_email_sent_at, so the "fully paid" receipt (file 66) is emailed again when a
--     balance was already collected at the start and a second one is collected at the end.
--   * staff_collect_balance_proof() (file 67) is unchanged: it keeps calling this function.
-- Run once in the Supabase SQL Editor (after 84_late_fee_block.sql). No Edge Function change.
-- =====================================================================

create or replace function public.staff_collect_balance(
  p_kind text, p_ref text, p_method text default 'Cash', p_expected numeric default null, p_start boolean default true
) returns table (kind text, ref text, collected numeric, new_status text)
language plpgsql security definer set search_path = public as $$
declare
  k   text := lower(coalesce(trim(p_kind), ''));
  m   text := case lower(coalesce(trim(p_method), 'cash')) when 'gcash' then 'GCash' when 'cash' then 'Cash' else null end;
  b   public.booking;
  o   public.rental_order;
  pay public.payment;
  bal numeric := 0;
  addon_part numeric := 0;
  ap  record;
  r   text := upper(regexp_replace(coalesce(p_ref, ''), '\s', '', 'g'));
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  if m is null then raise exception 'Choose how the balance was paid: Cash or GCash.' using errcode = 'P0001'; end if;

  if k = 'booking' then
    select * into b from public.booking where booking_ref = r for update;
    if not found then raise exception 'Booking % was not found.', r using errcode = 'P0001'; end if;
    -- NEW (85): a session that is already running (In Progress, e.g. after staff extended it) can have its balance
    -- collected with p_start = false. The admin page then marks it Completed in the same step.
    if b.status <> 'Approved' and not (b.status = 'In Progress' and not coalesce(p_start, true)) then
      raise exception 'Booking % is % now. Only a Confirmed booking can be started.', r, b.status using errcode = 'P0001';
    end if;
    select * into pay from public.payment where booking_id = b.booking_id and status <> 'Rejected' order by payment_id desc limit 1 for update;
    if coalesce(b.down_payment, 0) > 0 and (not found or pay.status <> 'Verified') then
      raise exception 'Verify the customer''s down payment first.' using errcode = 'P0001';
    end if;

    bal := public.booking_balance_due(b.booking_id);
    if p_expected is not null and abs(bal - p_expected) > 0.005 then
      raise exception 'The balance changed to PHP %. Close this window and open it again.', to_char(bal, 'FM999,999,990.00') using errcode = 'P0001';
    end if;

    -- add-on orders the customer paid 50% for later: their rest is recorded on THEIR payment (it becomes fully paid)
    for ap in
      select p2.payment_id, greatest(0, public.rental_order_total(o2.rental_order_id) - coalesce(o2.down_payment, 0) - p2.balance_paid_amount) as rest
        from public.rental_order o2
        join public.payment p2 on p2.rental_order_id = o2.rental_order_id and p2.status = 'Verified'
       where o2.booking_id = b.booking_id and o2.rental_type = 'Add-on' and o2.status not in ('Rejected', 'Cancelled')
         and coalesce(o2.down_payment, 0) > 0
    loop
      if ap.rest > 0.005 then
        update public.payment
           set balance_paid_amount = balance_paid_amount + ap.rest,
               balance_paid_at     = now(),
               balance_paid_by     = public.current_app_user_id(),
               balance_paid_method = m,
               payment_option      = 'full',
               balance_email_sent_at = null   -- NEW (85): a second collection is emailed again (file 66)
         where payment_id = ap.payment_id;
        addon_part := addon_part + ap.rest;
      end if;
    end loop;

    -- what is left is the studio session (and add-ons ordered with the booking): recorded on the booking's payment
    if bal - addon_part > 0.005 and pay.payment_id is not null then
      update public.payment
         set balance_paid_amount = balance_paid_amount + (bal - addon_part),
             balance_paid_at     = now(),
             balance_paid_by     = public.current_app_user_id(),
             balance_paid_method = m,
             payment_option      = 'full',
               balance_email_sent_at = null   -- NEW (85): a second collection is emailed again (file 66)
       where payment_id = pay.payment_id;
    end if;

    if p_start then
      update public.booking set status = 'In Progress' where booking_id = b.booking_id;   -- stamps actual_start_at, starts the add-ons
    end if;
    return query select 'booking'::text, b.booking_ref::text, bal, case when p_start then 'In Progress' else b.status end::text;

  elsif k = 'rental' then
    select * into o from public.rental_order where rental_ref = r for update;
    if not found then raise exception 'Rental % was not found.', r using errcode = 'P0001'; end if;
    if o.status <> 'Approved' then
      raise exception 'Rental % is % now. Only a verified rental can be issued.', r, o.status using errcode = 'P0001';
    end if;
    select * into pay from public.payment where rental_order_id = o.rental_order_id and status <> 'Rejected' order by payment_id desc limit 1 for update;
    if coalesce(o.down_payment, 0) > 0 and (not found or pay.status <> 'Verified') then
      raise exception 'Verify the customer''s down payment first.' using errcode = 'P0001';
    end if;

    bal := public.rental_balance_due(o.rental_order_id);
    if p_expected is not null and abs(bal - p_expected) > 0.005 then
      raise exception 'The balance changed to PHP %. Close this window and open it again.', to_char(bal, 'FM999,999,990.00') using errcode = 'P0001';
    end if;

    if bal > 0.005 then
      update public.payment
         set balance_paid_amount = balance_paid_amount + bal,
             balance_paid_at     = now(),
             balance_paid_by     = public.current_app_user_id(),
             balance_paid_method = m,
             payment_option      = 'full',
               balance_email_sent_at = null   -- NEW (85): a second collection is emailed again (file 66)
       where payment_id = pay.payment_id;
    end if;

    update public.rental_order set status = 'Active' where rental_order_id = o.rental_order_id;   -- stock is checked here; stamps issued_at
    return query select 'rental'::text, o.rental_ref::text, bal, 'Active'::text;

  else
    raise exception 'Unknown kind. Use booking or rental.' using errcode = 'P0001';
  end if;
end $$;
revoke all on function public.staff_collect_balance(text, text, text, numeric, boolean) from public, anon;
grant execute on function public.staff_collect_balance(text, text, text, numeric, boolean) to authenticated;

-- end of 85_collect_balance_on_complete.sql
