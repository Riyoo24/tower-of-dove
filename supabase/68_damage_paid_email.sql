-- =====================================================================
-- 68_damage_paid_email.sql  (safe to re-run)
-- Fully paid receipt by email when a customer's damage fee gets paid.
--   * A damage fee (file 58) is paid when staff collect it (Cash or GCash), when staff accept the GCash payment the
--     customer sent from My rentals, or when it is collected right at the return.
--   * After that, the admin page asks the Edge Function `send-receipt` (kind: damage) to email the customer the SAME
--     "fully paid" receipt template used when a booking / rental balance is collected (file 66): what was paid for,
--     how it was paid, the cash received and the change, and that nothing is left to pay.
--   * The email goes to the address saved with the rental (never typed in the browser), only staff can ask for it, it
--     is sent ONCE per payment (damage_charge.paid_email_sent_at) and only within 30 minutes of the payment.
--   * damage_charge.paid_tendered keeps the cash handed over, so the email can show Cash received and Change.
--   * staff_collect_damage() (file 58) and staff_return_rental_with_damage() (file 60) are replaced; the only change in
--     both is that the cash received is saved. Everything else in them is unchanged.
-- Run once in the Supabase SQL Editor (after 67_balance_cash_tendered.sql), then deploy the Edge Function again:
--   supabase functions deploy send-receipt
-- =====================================================================

alter table public.damage_charge add column if not exists paid_email_sent_at timestamptz;
alter table public.damage_charge add column if not exists paid_tendered      numeric(10,2);

-- 1. Staff collect an unpaid fee (or accept the customer's GCash payment): now also saves the cash received ------------
drop function if exists public.staff_collect_damage(text, text, text, numeric, numeric);
create function public.staff_collect_damage(
  p_rental_ref text, p_method text, p_reference text default null,
  p_tendered numeric default null, p_expected numeric default null
) returns numeric
language plpgsql security definer set search_path = public as $$
declare
  o     public.rental_order;
  m     text := case lower(coalesce(trim(p_method), '')) when 'gcash' then 'GCash' when 'cash' then 'Cash' else null end;
  gref  text := regexp_replace(coalesce(p_reference, ''), '\D', '', 'g');
  total numeric;
  r     record;
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  if m is null then raise exception 'Choose how the damage fee was paid: Cash or GCash.' using errcode = 'P0001'; end if;
  select * into o from public.rental_order where rental_ref = upper(trim(p_rental_ref)) for update;
  if not found then raise exception 'Rental not found.' using errcode = 'P0001'; end if;

  select coalesce(sum(amount), 0) into total from public.damage_charge
   where rental_order_id = o.rental_order_id and status in ('Unpaid', 'Pending') and amount > 0;
  if total <= 0 then raise exception 'There is no unpaid damage fee on this rental.' using errcode = 'P0001'; end if;
  if p_expected is not null and abs(p_expected - total) > 0.005 then
    raise exception 'The damage fee changed. Close this window and open it again.' using errcode = 'P0001';
  end if;

  if m = 'GCash' then
    if length(gref) <> 13 then raise exception 'Enter the 13-digit GCash reference number.' using errcode = 'P0001'; end if;
    if not public.damage_gcash_ref_free(gref, o.rental_order_id) then
      raise exception 'That GCash reference number was already used.' using errcode = 'P0001';
    end if;
  elsif p_tendered is null or p_tendered + 0.005 < total then
    raise exception 'The cash received is less than the damage fee of PHP %.', to_char(total, 'FM999,999,990.00') using errcode = 'P0001';
  end if;

  for r in select * from public.damage_charge
            where rental_order_id = o.rental_order_id and status in ('Unpaid', 'Pending') and amount > 0 for update loop
    update public.damage_charge
       set status = 'Paid', paid_method = m, gcash_reference = case when m = 'GCash' then gref end,
           paid_at = now(), collected_by = public.current_app_user_id(), updated_at = now(),
           paid_tendered = case when m = 'Cash' then p_tendered end,
           paid_email_sent_at = null
     where damage_charge_id = r.damage_charge_id;
    perform public.damage_log(r.damage_charge_id, 'Collected', r.amount, r.amount, r.status, 'Paid',
      case when r.status = 'Pending' then 'Customer''s GCash payment checked' else m || ' collected' end
      || case when m = 'GCash' then ' (ref ' || gref || ')' else '' end);
  end loop;
  return total;
end $$;
revoke all on function public.staff_collect_damage(text, text, text, numeric, numeric) from public, anon;
grant execute on function public.staff_collect_damage(text, text, text, numeric, numeric) to authenticated;

-- 2. The return with damage fees (from file 60): "collect now" also saves the cash received -------------------------
drop function if exists public.staff_return_rental_with_damage(text, bigint, text, text, text, jsonb, text, text, numeric);
drop function if exists public.staff_return_rental_with_damage(text, bigint, text, text, text, jsonb, text, text, numeric, jsonb);
create function public.staff_return_rental_with_damage(
  p_rental_ref       text,
  p_equipment_id     bigint,
  p_condition        text,
  p_description      text    default null,
  p_after_photo_path text    default null,
  p_charges          jsonb   default '[]'::jsonb,
  p_method           text    default null,
  p_reference        text    default null,
  p_tendered         numeric default null,
  p_stock_changes    jsonb   default '[]'::jsonb
) returns table (damage_total numeric, unpaid_total numeric, shortage_count integer)
language plpgsql security definer set search_path = public as $$
declare
  o        public.rental_order;
  cond     text := trim(coalesce(p_condition, ''));
  m        text := case lower(coalesce(trim(p_method), '')) when 'gcash' then 'GCash' when 'cash' then 'Cash' else null end;
  gref     text := regexp_replace(coalesce(p_reference, ''), '\D', '', 'g');
  ids      bigint[];
  id       bigint;
  item     jsonb;
  chg      jsonb;
  amt      numeric;
  why      text;
  total    numeric := 0;
  paid     numeric := 0;
  dc_id    bigint;
  rm       int;
  md       text;
  line_q   int;
  eq_id    bigint;
  eq_name  text;
  eq_rent  int;
  eq_owned int;
  eq_oos   int;
  eq_ids   bigint[] := '{}';
  short_n  int := 0;
  line_short int;
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;

  select * into o from public.rental_order where rental_ref = upper(trim(p_rental_ref)) for update;
  if not found then raise exception 'Rental not found.' using errcode = 'P0001'; end if;

  -- the lines this call is about to return
  select coalesce(array_agg(d.rental_detail_id), '{}') into ids
    from public.rental_detail d
   where d.rental_order_id = o.rental_order_id and d.returned_at is null
     and (p_equipment_id is null or d.equipment_id = p_equipment_id);

  if cond <> 'No issue' and cond in ('Scratch', 'Damaged', 'Severely damaged', 'Others') then
    -- validate every fee and stock change BEFORE anything is saved
    foreach id in array ids loop
      select x into item from jsonb_array_elements(coalesce(p_charges, '[]'::jsonb)) x
       where (x ->> 'rental_detail_id')::bigint = id limit 1;
      amt := round(coalesce((item ->> 'amount')::numeric, 0), 2);
      why := nullif(trim(coalesce(item ->> 'reason', '')), '');
      if amt < 0 then raise exception 'A damage fee cannot be negative.' using errcode = 'P0001'; end if;
      if amt > 99999999 then raise exception 'That damage fee is too large.' using errcode = 'P0001'; end if;
      if amt > 0 and why is null then
        raise exception 'Describe the damage: a reason is required when the damage fee is above 0.' using errcode = 'P0001';
      end if;
      total := total + amt;

      select x into chg from jsonb_array_elements(coalesce(p_stock_changes, '[]'::jsonb)) x
       where (x ->> 'rental_detail_id')::bigint = id limit 1;
      rm := coalesce((chg ->> 'qty')::int, 0);
      md := coalesce(chg ->> 'mode', 'service');
      if rm < 0 then
        raise exception 'The quantity to remove cannot be negative.' using errcode = 'P0001';
      elsif rm > 0 then
        if md not in ('service', 'remove') then
          raise exception 'Choose Out of service or Remove permanently.' using errcode = 'P0001';
        end if;
        select d.quantity, e.name, e.total_quantity into line_q, eq_name, eq_rent
          from public.rental_detail d join public.equipment e on e.equipment_id = d.equipment_id
         where d.rental_detail_id = id;
        if rm > line_q then
          raise exception 'You can take out at most % of %, the quantity in this rental.', line_q, eq_name using errcode = 'P0001';
        end if;
        if rm > eq_rent then
          raise exception 'Only % of % can still be rented, so % cannot be taken out of stock.', eq_rent, eq_name, rm using errcode = 'P0001';
        end if;
      end if;
    end loop;
    if m = 'GCash' and length(gref) <> 13 then
      raise exception 'Enter the 13-digit GCash reference number.' using errcode = 'P0001';
    end if;
    if m = 'Cash' and total > 0 and (p_tendered is null or p_tendered + 0.005 < total) then
      raise exception 'The cash received is less than the damage fee of PHP %.', to_char(total, 'FM999,999,990.00') using errcode = 'P0001';
    end if;
    if m = 'GCash' and total > 0 and not public.damage_gcash_ref_free(gref, o.rental_order_id) then
      raise exception 'That GCash reference number was already used.' using errcode = 'P0001';
    end if;
  end if;

  -- 1) the normal return (condition, photo, late fee, stock, order status): unchanged, from 46
  perform public.staff_return_rental_with_condition(p_rental_ref, p_equipment_id, p_condition, p_description, p_after_photo_path);

  -- 2) the damage fees and the stock changes
  total := 0;
  if cond <> 'No issue' then
    foreach id in array ids loop
      select x into item from jsonb_array_elements(coalesce(p_charges, '[]'::jsonb)) x
       where (x ->> 'rental_detail_id')::bigint = id limit 1;
      amt := round(coalesce((item ->> 'amount')::numeric, 0), 2);
      why := nullif(trim(coalesce(item ->> 'reason', '')), '');

      insert into public.damage_charge (rental_detail_id, rental_order_id, condition, amount, reason, status, recorded_by)
      values (id, o.rental_order_id, cond, amt, why, case when amt = 0 then 'Waived' else 'Unpaid' end, public.current_app_user_id())
      returning damage_charge_id into dc_id;
      perform public.damage_log(dc_id, case when amt = 0 then 'Waived' else 'Recorded' end, null, amt, null,
                                case when amt = 0 then 'Waived' else 'Unpaid' end,
                                case when amt = 0 then 'Recorded with no charge.' else why end);
      total := total + amt;

      -- "collect now"
      if m is not null and amt > 0 then
        update public.damage_charge
           set status = 'Paid', paid_method = m, gcash_reference = case when m = 'GCash' then gref end,
               paid_at = now(), collected_by = public.current_app_user_id(), updated_at = now(),
               paid_tendered = case when m = 'Cash' then p_tendered end
         where damage_charge_id = dc_id;
        perform public.damage_log(dc_id, 'Collected', amt, amt, 'Unpaid', 'Paid',
                                  m || ' collected at the return' || case when m = 'GCash' then ' (ref ' || gref || ')' else '' end);
        paid := paid + amt;
      end if;

      -- take damaged units out of the rentable stock
      select x into chg from jsonb_array_elements(coalesce(p_stock_changes, '[]'::jsonb)) x
       where (x ->> 'rental_detail_id')::bigint = id limit 1;
      rm := coalesce((chg ->> 'qty')::int, 0);
      md := coalesce(chg ->> 'mode', 'service');
      if rm > 0 then
        select d.equipment_id into eq_id from public.rental_detail d where d.rental_detail_id = id;
        -- lock the row, then re-check (two lines of the same item may be changed in one return)
        select e.name, e.total_quantity into eq_name, eq_rent from public.equipment e where e.equipment_id = eq_id for update;
        if rm > eq_rent then
          raise exception 'Only % of % can still be rented, so % cannot be taken out of stock.', eq_rent, eq_name, rm using errcode = 'P0001';
        end if;
        if md = 'remove' then
          update public.equipment set owned_quantity = owned_quantity - rm where equipment_id = eq_id
            returning owned_quantity, out_of_service, total_quantity into eq_owned, eq_oos, eq_rent;
        else
          update public.equipment set out_of_service = out_of_service + rm where equipment_id = eq_id
            returning owned_quantity, out_of_service, total_quantity into eq_owned, eq_oos, eq_rent;
        end if;

        -- do upcoming rentals / bookings still have enough?  (never blocks the return, only reported)
        select count(distinct c.rental_ref)::int into line_short from public.equipment_stock_conflicts(eq_id) c;
        if not (eq_id = any (eq_ids)) then
          eq_ids := eq_ids || eq_id;
          short_n := short_n + coalesce(line_short, 0);
        end if;

        perform public.damage_log(dc_id,
          case when md = 'remove' then 'Stock removed' else 'Out of service' end, null, null, null, null,
          case when md = 'remove'
               then rm || ' x ' || eq_name || ' removed permanently (owned ' || (eq_owned + rm) || ' to ' || eq_owned || ').'
               else rm || ' x ' || eq_name || ' marked out of service (rentable ' || (eq_rent + rm) || ' to ' || eq_rent
                    || ', ' || eq_oos || ' out of service). Lower Out of service in Equipment once it is repaired.'
          end
          || case when coalesce(line_short, 0) > 0
                  then ' ' || line_short || ' upcoming rental(s) or booking(s) now need more than is rentable.' else '' end);
      end if;
    end loop;
  end if;

  return query select total, total - paid, short_n;
end $$;
revoke all on function public.staff_return_rental_with_damage(text, bigint, text, text, text, jsonb, text, text, numeric, jsonb) from public, anon;
grant execute on function public.staff_return_rental_with_damage(text, bigint, text, text, text, jsonb, text, text, numeric, jsonb) to authenticated;

-- end of 68_damage_paid_email.sql
