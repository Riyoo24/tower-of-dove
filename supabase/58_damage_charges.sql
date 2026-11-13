-- =====================================================================
-- 58_damage_charges.sql  (safe to re-run)
-- Damage fees for OUTSIDE rentals.
--
--   * A damage fee is money OWED, not money received. It lives in its own table (damage_charge), one row per
--     rental item line. It does NOT touch the payment table, rental_balance_due(), the 50% down payment -> fully paid
--     logic or v_rental_lines, so none of the existing balance math changes.
--   * Status: Unpaid -> Pending (customer sent a GCash payment, staff still have to check it) -> Paid.
--             Waived = amount of 0 (nothing charged). An unpaid fee can be changed or waived later; every
--             change is written to damage_charge_log (who, when, old and new amount, the reason for the change).
--   * The return never depends on payment: staff confirm the return, the fee is saved as Unpaid, and they may
--     "collect now" (Cash or GCash) in the same step. The customer can also pay later, in My rentals (GCash)
--     or at the studio (cash).
--   * Reports count a damage fee only once it is Paid, as its own line (never inside rental revenue).
--
-- New tables : damage_charge, damage_charge_log
-- New view   : v_damage_charge
-- New RPCs   : staff_return_rental_with_damage, staff_collect_damage, staff_reject_damage_payment,
--              staff_update_damage_charge, customer_pay_damage
-- staff_return_rental_with_condition() from 46 is NOT changed: the new function calls it in the same transaction.
-- Run once in the Supabase SQL Editor (after 57_handover_proof.sql; 46 must have been run).
-- =====================================================================

-- ---- 1. tables -------------------------------------------------------
create table if not exists public.damage_charge (
  damage_charge_id  bigint generated always as identity primary key,
  rental_detail_id  bigint not null references public.rental_detail (rental_detail_id) on delete cascade,
  rental_order_id   bigint not null references public.rental_order (rental_order_id) on delete cascade,
  condition         text   not null,
  amount            numeric(10,2) not null,
  reason            text,
  status            varchar(10) not null default 'Unpaid',
  paid_method       varchar(10),
  gcash_reference   varchar(13),
  customer_paid_at  timestamptz,          -- when the customer sent a GCash payment (status Pending)
  paid_at           timestamptz,          -- when the fee became Paid
  recorded_by       bigint references public.app_user (user_id) on delete set null,
  collected_by      bigint references public.app_user (user_id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint damage_charge_detail_uq unique (rental_detail_id),
  constraint damage_charge_amount_chk check (amount >= 0),
  constraint damage_charge_status_chk check (status in ('Unpaid', 'Pending', 'Paid', 'Waived')),
  constraint damage_charge_method_chk check (paid_method is null or paid_method in ('Cash', 'GCash')),
  constraint damage_charge_waived_chk check ((amount = 0) = (status = 'Waived')),
  constraint damage_charge_reason_chk check (amount = 0 or nullif(trim(coalesce(reason, '')), '') is not null)
);
create index if not exists damage_charge_order_idx  on public.damage_charge (rental_order_id);
create index if not exists damage_charge_status_idx on public.damage_charge (status);
-- not unique on purpose: one GCash payment may cover several items of the same rental (damage_gcash_ref_free() guards reuse)
drop index if exists public.damage_charge_gcash_uq;
create index if not exists damage_charge_gcash_idx on public.damage_charge (gcash_reference) where gcash_reference is not null;

create table if not exists public.damage_charge_log (
  log_id            bigint generated always as identity primary key,
  damage_charge_id  bigint not null references public.damage_charge (damage_charge_id) on delete cascade,
  action            text not null,         -- Recorded | Amount changed | Waived | Payment sent | Payment rejected | Collected
  old_amount        numeric(10,2),
  new_amount        numeric(10,2),
  old_status        text,
  new_status        text,
  note              text,
  by_user_id        bigint references public.app_user (user_id) on delete set null,
  by_customer       boolean not null default false,
  created_at        timestamptz not null default now()
);
create index if not exists damage_charge_log_charge_idx on public.damage_charge_log (damage_charge_id, log_id);

-- ---- 2. row level security: staff everything (through the RPCs), customers read their own fees ----------
alter table public.damage_charge     enable row level security;
alter table public.damage_charge_log enable row level security;

drop policy if exists damage_charge_select on public.damage_charge;
create policy damage_charge_select on public.damage_charge for select to authenticated
  using (public.is_staff() or exists (
    select 1 from public.rental_order o
     where o.rental_order_id = damage_charge.rental_order_id and o.customer_id = public.current_customer_id()));

drop policy if exists damage_charge_log_select on public.damage_charge_log;
create policy damage_charge_log_select on public.damage_charge_log for select to authenticated
  using (public.is_staff());

revoke all on public.damage_charge, public.damage_charge_log from anon;
grant select on public.damage_charge, public.damage_charge_log to authenticated;

-- ---- 3. internal helper: one line in the audit trail -------------------------------------------
create or replace function public.damage_log(
  p_id bigint, p_action text, p_old_amount numeric, p_new_amount numeric,
  p_old_status text, p_new_status text, p_note text, p_by_customer boolean default false
) returns void language sql security definer set search_path = public as $$
  insert into public.damage_charge_log
    (damage_charge_id, action, old_amount, new_amount, old_status, new_status, note, by_user_id, by_customer)
  values (p_id, p_action, p_old_amount, p_new_amount, p_old_status, p_new_status,
          nullif(trim(coalesce(p_note, '')), ''),
          case when p_by_customer then null else public.current_app_user_id() end, p_by_customer);
$$;
revoke all on function public.damage_log(bigint, text, numeric, numeric, text, text, text, boolean) from public, anon, authenticated;

-- a GCash reference may be used once, across rental / booking payments and damage fees
create or replace function public.damage_gcash_ref_free(p_ref text, p_order_id bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from public.payment p where lower(p.gcash_reference) = lower(p_ref) and p.status <> 'Rejected')
     and not exists (select 1 from public.damage_charge d where d.gcash_reference = p_ref
                      and d.status in ('Pending', 'Paid') and d.rental_order_id <> p_order_id);
$$;
revoke all on function public.damage_gcash_ref_free(text, bigint) from public, anon, authenticated;

-- ---- 4. return + damage fee (+ optional "collect now") in ONE transaction -----------------------
-- p_charges : [{"rental_detail_id": 12, "amount": 500, "reason": "Cracked body"}, ...]   (ignored for "No issue")
--             a returned line with no entry is saved with a fee of 0 (waived)
-- p_method  : null = leave the fee Unpaid; 'Cash' or 'GCash' = collect it now (Cash needs p_tendered, GCash the 13-digit p_reference)
drop function if exists public.staff_return_rental_with_damage(text, bigint, text, text, text, jsonb, text, text, numeric);
create function public.staff_return_rental_with_damage(
  p_rental_ref       text,
  p_equipment_id     bigint,
  p_condition        text,
  p_description      text    default null,
  p_after_photo_path text    default null,
  p_charges          jsonb   default '[]'::jsonb,
  p_method           text    default null,
  p_reference        text    default null,
  p_tendered         numeric default null
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
    end loop;
  end if;

  return query select total, total - paid;
end $$;
revoke all on function public.staff_return_rental_with_damage(text, bigint, text, text, text, jsonb, text, text, numeric) from public, anon;
grant execute on function public.staff_return_rental_with_damage(text, bigint, text, text, text, jsonb, text, text, numeric) to authenticated;

-- ---- 5. staff collect (Unpaid, or a customer's GCash payment that staff checked) -------------------
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
           paid_at = now(), collected_by = public.current_app_user_id(), updated_at = now()
     where damage_charge_id = r.damage_charge_id;
    perform public.damage_log(r.damage_charge_id, 'Collected', r.amount, r.amount, r.status, 'Paid',
      case when r.status = 'Pending' then 'Customer''s GCash payment checked' else m || ' collected' end
      || case when m = 'GCash' then ' (ref ' || gref || ')' else '' end);
  end loop;
  return total;
end $$;
revoke all on function public.staff_collect_damage(text, text, text, numeric, numeric) from public, anon;
grant execute on function public.staff_collect_damage(text, text, text, numeric, numeric) to authenticated;

-- ---- 6. staff reject a customer's GCash payment (the fee goes back to Unpaid) ----------------------
create or replace function public.staff_reject_damage_payment(p_rental_ref text, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare o public.rental_order; r record;
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'Say why the payment is rejected.' using errcode = 'P0001';
  end if;
  select * into o from public.rental_order where rental_ref = upper(trim(p_rental_ref)) for update;
  if not found then raise exception 'Rental not found.' using errcode = 'P0001'; end if;
  for r in select * from public.damage_charge where rental_order_id = o.rental_order_id and status = 'Pending' for update loop
    update public.damage_charge set status = 'Unpaid', paid_method = null, gcash_reference = null,
           customer_paid_at = null, updated_at = now() where damage_charge_id = r.damage_charge_id;
    perform public.damage_log(r.damage_charge_id, 'Payment rejected', r.amount, r.amount, 'Pending', 'Unpaid',
                              p_reason || ' (ref ' || coalesce(r.gcash_reference, '-') || ')');
  end loop;
end $$;
revoke all on function public.staff_reject_damage_payment(text, text) from public, anon;
grant execute on function public.staff_reject_damage_payment(text, text) to authenticated;

-- ---- 7. staff change or waive a fee that is not paid yet (reason for the change is required) -------
create or replace function public.staff_update_damage_charge(
  p_charge_id bigint, p_amount numeric, p_reason text, p_note text
) returns void language plpgsql security definer set search_path = public as $$
declare c public.damage_charge; amt numeric := round(coalesce(p_amount, -1), 2); newstatus text;
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  select * into c from public.damage_charge where damage_charge_id = p_charge_id for update;
  if not found then raise exception 'Damage fee not found.' using errcode = 'P0001'; end if;
  if c.status = 'Paid' then raise exception 'A paid damage fee cannot be changed.' using errcode = 'P0001'; end if;
  if c.status = 'Pending' then
    raise exception 'The customer sent a GCash payment for this fee. Verify or reject it first.' using errcode = 'P0001';
  end if;
  if amt < 0 or amt > 99999999 then raise exception 'Enter a valid amount.' using errcode = 'P0001'; end if;
  if nullif(trim(coalesce(p_note, '')), '') is null then
    raise exception 'Write why you are changing or waiving this fee.' using errcode = 'P0001';
  end if;
  if amt > 0 and coalesce(nullif(trim(p_reason), ''), nullif(trim(c.reason), '')) is null then
    raise exception 'Describe the damage: a reason is required when the damage fee is above 0.' using errcode = 'P0001';
  end if;
  if amt = c.amount and coalesce(trim(p_reason), '') in ('', coalesce(c.reason, '')) then
    raise exception 'Nothing was changed.' using errcode = 'P0001';
  end if;
  newstatus := case when amt = 0 then 'Waived' else 'Unpaid' end;
  update public.damage_charge
     set amount = amt, status = newstatus, reason = coalesce(nullif(trim(p_reason), ''), reason), updated_at = now()
   where damage_charge_id = c.damage_charge_id;
  perform public.damage_log(c.damage_charge_id, case when amt = 0 then 'Waived' else 'Amount changed' end,
                            c.amount, amt, c.status, newstatus, p_note);
end $$;
revoke all on function public.staff_update_damage_charge(bigint, numeric, text, text) from public, anon;
grant execute on function public.staff_update_damage_charge(bigint, numeric, text, text) to authenticated;

-- ---- 8. customer pays NOW with GCash (staff verify it). "Pay later" needs no call: the fee just stays Unpaid ----
create or replace function public.customer_pay_damage(p_rental_ref text, p_gcash_reference text)
returns numeric language plpgsql security definer set search_path = public as $$
declare
  o     public.rental_order;
  gref  text := regexp_replace(coalesce(p_gcash_reference, ''), '\D', '', 'g');
  total numeric;
  r     record;
begin
  select * into o from public.rental_order
   where rental_ref = upper(trim(p_rental_ref)) and customer_id = public.current_customer_id() for update;
  if not found then raise exception 'Rental not found.' using errcode = 'P0001'; end if;
  if length(gref) <> 13 then raise exception 'Enter the 13-digit GCash reference number.' using errcode = 'P0001'; end if;
  select coalesce(sum(amount), 0) into total from public.damage_charge
   where rental_order_id = o.rental_order_id and status = 'Unpaid' and amount > 0;
  if total <= 0 then raise exception 'There is no unpaid damage fee on this rental.' using errcode = 'P0001'; end if;
  if not public.damage_gcash_ref_free(gref, o.rental_order_id) then
    raise exception 'That GCash reference number was already used.' using errcode = 'P0001';
  end if;
  for r in select * from public.damage_charge where rental_order_id = o.rental_order_id and status = 'Unpaid' and amount > 0 for update loop
    update public.damage_charge set status = 'Pending', paid_method = 'GCash', gcash_reference = gref,
           customer_paid_at = now(), updated_at = now() where damage_charge_id = r.damage_charge_id;
    perform public.damage_log(r.damage_charge_id, 'Payment sent', r.amount, r.amount, 'Unpaid', 'Pending',
                              'Customer sent a GCash payment (ref ' || gref || ')', true);
  end loop;
  return total;
end $$;
revoke all on function public.customer_pay_damage(text, text) from public, anon;
grant execute on function public.customer_pay_damage(text, text) to authenticated;

-- ---- 9. view used by the Payments tab, Rentals tab, Reports and the customer's My rentals ------------
create or replace view public.v_damage_charge with (security_invoker = true) as
select
  dc.damage_charge_id, dc.rental_detail_id, dc.rental_order_id, o.rental_ref, o.customer_id,
  trim(c.first_name || ' ' || c.last_name) as customer_name,
  d.equipment_id, e.name as equipment_name, d.quantity,
  dc.condition, dc.reason, dc.amount, dc.status, dc.paid_method, dc.gcash_reference,
  dc.customer_paid_at, dc.paid_at, dc.recorded_by, dc.collected_by, dc.created_at, dc.updated_at,
  d.returned_at as line_returned_at, d.return_description,
  d.before_photo_path, d.after_photo_path, o.handover_photo_path,
  round(d.quantity * d.unit_price_at_request * greatest(8, ceil(coalesce(d.rental_hours, 8))) / 8.0, 2) as line_rental_value
from public.damage_charge dc
join public.rental_detail d on d.rental_detail_id = dc.rental_detail_id
join public.rental_order  o on o.rental_order_id  = dc.rental_order_id
join public.equipment     e on e.equipment_id     = d.equipment_id
join public.customer      c on c.customer_id      = o.customer_id;
grant select on public.v_damage_charge to authenticated;

-- end of 58_damage_charges.sql
