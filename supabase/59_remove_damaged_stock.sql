-- =====================================================================
-- 59_remove_damaged_stock.sql - take a damaged item out of stock when it is returned
-- In the "Record return condition" window, staff can tick "Remove from stock" for a damaged item and choose how many.
-- Confirming the return then lowers the item's Total stock (Equipment tab) by that number in the SAME transaction, and the
-- Damage fee history shows a "Stock removed" line. Nothing changes when the box is not ticked (the item goes back in stock).
-- Run once in the Supabase SQL Editor (after 58_damage_charges.sql). Safe to re-run.
-- =====================================================================

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
  p_stock_removals   jsonb   default '[]'::jsonb
) returns table (damage_total numeric, unpaid_total numeric)
language plpgsql security definer set search_path = public as $$
declare
  o       public.rental_order;
  cond    text := trim(coalesce(p_condition, ''));
  m       text := case lower(coalesce(trim(p_method), '')) when 'gcash' then 'GCash' when 'cash' then 'Cash' else null end;
  gref    text := regexp_replace(coalesce(p_reference, ''), '\D', '', 'g');
  ids     bigint[];
  id      bigint;
  item    jsonb;
  amt     numeric;
  why     text;
  total   numeric := 0;
  paid    numeric := 0;
  dc_id   bigint;
  rm      int;
  line_q  int;
  eq_id   bigint;
  eq_name text;
  eq_tot  int;
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
    -- validate every fee BEFORE anything is saved
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

      -- stock to remove for this line (the item can no longer be rented)
      rm := coalesce((select (x ->> 'qty')::int from jsonb_array_elements(coalesce(p_stock_removals, '[]'::jsonb)) x
                       where (x ->> 'rental_detail_id')::bigint = id limit 1), 0);
      if rm > 0 then
        select d.quantity, d.equipment_id, e.name, e.total_quantity into line_q, eq_id, eq_name, eq_tot
          from public.rental_detail d join public.equipment e on e.equipment_id = d.equipment_id
         where d.rental_detail_id = id;
        if rm > line_q then
          raise exception 'You can remove at most % of %, the quantity in this rental.', line_q, eq_name using errcode = 'P0001';
        end if;
        if rm > eq_tot then
          raise exception 'There are only % of % in stock.', eq_tot, eq_name using errcode = 'P0001';
        end if;
      elsif rm < 0 then
        raise exception 'The quantity to remove cannot be negative.' using errcode = 'P0001';
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

  -- 2) the damage fees
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
               paid_at = now(), collected_by = public.current_app_user_id(), updated_at = now()
         where damage_charge_id = dc_id;
        perform public.damage_log(dc_id, 'Collected', amt, amt, 'Unpaid', 'Paid',
                                  m || ' collected at the return' || case when m = 'GCash' then ' (ref ' || gref || ')' else '' end);
        paid := paid + amt;
      end if;

      -- take the item out of stock (it was damaged and cannot be rented again until staff add it back in Equipment)
      rm := coalesce((select (x ->> 'qty')::int from jsonb_array_elements(coalesce(p_stock_removals, '[]'::jsonb)) x
                       where (x ->> 'rental_detail_id')::bigint = id limit 1), 0);
      if rm > 0 then
        select d.equipment_id into eq_id from public.rental_detail d where d.rental_detail_id = id;
        update public.equipment set total_quantity = total_quantity - rm where equipment_id = eq_id
          returning name, total_quantity into eq_name, eq_tot;
        if public.equipment_in_use(eq_id) > eq_tot then
          raise exception 'Other rentals or bookings are using % right now, so % cannot be removed yet. Remove it from Equipment after they are returned.', eq_name, rm using errcode = 'P0001';
        end if;
        perform public.damage_log(dc_id, 'Stock removed', null, null, null, null,
                                  rm || ' x ' || eq_name || ' removed from stock (total ' || (eq_tot + rm) || ' to ' || eq_tot || ').');
      end if;
    end loop;
  end if;

  return query select total, total - paid;
end $$;
revoke all on function public.staff_return_rental_with_damage(text, bigint, text, text, text, jsonb, text, text, numeric, jsonb) from public, anon;
grant execute on function public.staff_return_rental_with_damage(text, bigint, text, text, text, jsonb, text, text, numeric, jsonb) to authenticated;

