-- =====================================================================
-- 60_out_of_service_stock.sql - damaged stock: "Out of service" (repairable) or "Remove permanently" (written off),
--                              checked against upcoming rentals and bookings BY DATE, and it never blocks a return.
-- Run once in the Supabase SQL Editor (after 59_remove_damaged_stock.sql). Safe to re-run.
--
-- What changes
--   1. Equipment gets two real numbers:  owned_quantity (everything the studio owns)  and  out_of_service (broken / in repair).
--        Rentable = owned - out of service.  The existing column total_quantity now simply HOLDS the rentable number
--        (a trigger keeps it equal to owned - out_of_service), so every availability check that already reads total_quantity
--        (website, approvals, extensions, reschedules) keeps working with no other change.
--        Example: owned 4, out of service 1  ->  rentable (total_quantity) 3.
--      Old code that still writes total_quantity directly keeps working: the trigger moves owned_quantity to match.
--   2. The return window now offers, for each damaged item:  Back in stock (default) | Out of service | Remove permanently.
--        Out of service      = out_of_service goes UP by the quantity. When it is repaired, staff lower it in Equipment.
--        Remove permanently  = owned_quantity goes DOWN by the quantity (written off).
--   3. The return is no longer cancelled when the removed units are needed by other customers. The unit really is broken, so
--      the stock change is always saved, and the app then lists the upcoming rentals / bookings that no longer have enough
--      (equipment_stock_conflicts) so staff can swap the item, contact the customer or cancel.
--      The check is by DATE: for every moment, the quantity reserved by Approved / Active / Pending orders is compared with
--      what is rentable. (59 only looked at what was in use at this very second.)
--   4. The Damage fee history gets an "Out of service" or "Stock removed" line with the old and new numbers.
--   5. staff_return_rental_with_damage takes p_stock_changes (replaces 59's p_stock_removals) with a mode per item:
--        [{"rental_detail_id": 12, "qty": 2, "mode": "service" | "remove"}]
--      Until this file is run, the site shows "run 60_out_of_service_stock.sql" instead of changing stock the wrong way.
-- =====================================================================

-- 1. Columns ----------------------------------------------------------------------------------------------------------
alter table public.equipment add column if not exists owned_quantity integer;
alter table public.equipment add column if not exists out_of_service integer not null default 0;

update public.equipment set owned_quantity = total_quantity + out_of_service where owned_quantity is null;

alter table public.equipment alter column owned_quantity set default 0;
alter table public.equipment alter column owned_quantity set not null;

alter table public.equipment drop constraint if exists equipment_owned_chk;
alter table public.equipment add constraint equipment_owned_chk check (owned_quantity >= 0);
alter table public.equipment drop constraint if exists equipment_oos_chk;
alter table public.equipment add constraint equipment_oos_chk check (out_of_service >= 0 and out_of_service <= owned_quantity);

-- 2. total_quantity (rentable) = owned - out of service, kept in sync by a trigger --------------------------------------
create or replace function public.equipment_sync_qty() returns trigger
language plpgsql as $$
begin
  new.out_of_service := coalesce(new.out_of_service, 0);
  if tg_op = 'INSERT' then
    if coalesce(new.owned_quantity, 0) = 0 and new.total_quantity > 0 then
      new.owned_quantity := new.total_quantity + new.out_of_service;      -- inserted the old way (total only)
    end if;
  elsif new.owned_quantity is not distinct from old.owned_quantity
    and new.out_of_service is not distinct from old.out_of_service
    and new.total_quantity is distinct from old.total_quantity then
    new.owned_quantity := new.total_quantity + new.out_of_service;        -- edited the old way (total only)
  end if;
  if new.out_of_service > new.owned_quantity then
    raise exception 'Out of service (%) cannot be more than the quantity owned (%).', new.out_of_service, new.owned_quantity
      using errcode = 'P0001';
  end if;
  new.total_quantity := new.owned_quantity - new.out_of_service;
  return new;
end $$;

drop trigger if exists equipment_sync_qty_trg on public.equipment;
create trigger equipment_sync_qty_trg before insert or update on public.equipment
  for each row execute function public.equipment_sync_qty();

-- 3. The stock list: add owned + out of service at the END (the other columns keep their order) -----------------------
create or replace view public.v_equipment_stock with (security_invoker = true) as
select
  e.equipment_id, e.name, e.image, e.description, c.category_name,
  e.total_quantity,
  public.equipment_in_use(e.equipment_id) as in_use,
  greatest(e.total_quantity - public.equipment_in_use(e.equipment_id), 0) as available,
  case
    when e.status <> 'Available' then 'Unavailable'
    when e.total_quantity - public.equipment_in_use(e.equipment_id) <= 0 then 'In Use'
    when e.total_quantity - public.equipment_in_use(e.equipment_id) = 1 and e.total_quantity > 1 then 'Low'
    else 'Available'
  end as stock_status,
  e.add_on_rate, e.outside_rate, e.allow_addon, e.allow_outside, e.min_hours,
  e.owned_quantity, e.out_of_service
from public.equipment e
join public.equipment_category c on c.category_id = e.category_id;

-- 4. Which upcoming rentals / bookings no longer have enough of an item?  (staff only) ----------------------------------
--    Looks at every Approved / Active / Pending order that is not returned and has not ended, finds the moments when the
--    quantity reserved at the same time is MORE than what is rentable, and returns every order that covers such a moment.
--    p_equipment_id null = all equipment. Pending orders count (they hold stock, see 53). An order with no dates counts from now.
create or replace function public.equipment_stock_conflicts(p_equipment_id bigint default null)
returns table (
  equipment_id   bigint,
  equipment_name text,
  rentable       integer,
  short_by       integer,
  rental_ref     text,
  rental_type    text,
  order_status   text,
  customer_name  text,
  w_start        timestamptz,
  w_end          timestamptz,
  quantity       integer
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;

  return query
  with ln as (
    select d.equipment_id as eid, o.rental_order_id as oid, o.rental_ref as ref, o.rental_type::text as rtype,
           o.status::text as ostatus, o.customer_id as cid, sum(d.quantity)::int as qty,
           greatest(coalesce(w.w_start, now()), now()) as s0,
           coalesce(w.w_end, 'infinity'::timestamptz)  as e0
      from public.rental_order o
      join public.rental_detail d on d.rental_order_id = o.rental_order_id
      cross join lateral public.order_window(o.rental_order_id) w
     where d.returned_at is null
       and (p_equipment_id is null or d.equipment_id = p_equipment_id)
       and (o.status in ('Approved', 'Active')
            or (o.status = 'Pending'
                and (o.booking_id is null
                     or exists (select 1 from public.booking bk
                                 where bk.booking_id = o.booking_id
                                   and bk.status in ('Pending', 'Approved', 'In Progress')))))
       and coalesce(w.w_end, 'infinity'::timestamptz) > now()
     group by d.equipment_id, o.rental_order_id, o.rental_ref, o.rental_type, o.status, o.customer_id, w.w_start, w.w_end
  ),
  hot as (                       -- start moments where more is reserved than is rentable
    select a.eid, a.s0 as p, (x.demand - e.total_quantity)::int as over
      from ln a
      join public.equipment e on e.equipment_id = a.eid
      cross join lateral (select coalesce(sum(b.qty), 0) as demand from ln b
                           where b.eid = a.eid and b.s0 <= a.s0 and a.s0 < b.e0) x
     where x.demand > e.total_quantity
  ),
  worst as (select h.eid, max(h.over) as over from hot h group by h.eid)
  select ln.eid, e.name::text, e.total_quantity::int, wr.over::int,
         ln.ref::text, ln.rtype, ln.ostatus,
         btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, ''))::text,
         ln.s0, nullif(ln.e0, 'infinity'::timestamptz), ln.qty
    from ln
    join public.equipment e on e.equipment_id = ln.eid
    join worst wr on wr.eid = ln.eid
    left join public.customer c on c.customer_id = ln.cid
   where exists (select 1 from hot h where h.eid = ln.eid and ln.s0 <= h.p and h.p < ln.e0)
   order by e.name, ln.s0, ln.ref;
end $$;
revoke all on function public.equipment_stock_conflicts(bigint) from public, anon;
grant execute on function public.equipment_stock_conflicts(bigint) to authenticated;

-- 5. The return, with damage fees and the new stock choices, in ONE transaction -----------------------------------------
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
               paid_at = now(), collected_by = public.current_app_user_id(), updated_at = now()
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

-- end of 60_out_of_service_stock.sql
