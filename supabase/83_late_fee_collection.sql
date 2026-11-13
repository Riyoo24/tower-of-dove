-- =====================================================================
-- 83_late_fee_collection.sql  (safe to re-run; run after 82_no_show_in_flag.sql)
-- The late fee of an outside rental is now collected when the equipment is returned, together with any damage fee.
--   * The Return window works out the late fee by itself (price / 8 per hour, per item, a started hour counts as a full
--     hour, counted from the end of the 8-hour window: the same time the rental shows as Overdue) and adds the damage fee
--     the staff enter. One payment covers both: Cash (the amount tendered must cover it, the change is shown) or GCash
--     (13-digit reference number).
--   * rental_detail keeps how the late fee was paid (method, GCash reference, cash tendered, when, by whom).
--   * staff_return_rental_with_fees() does the return, the late fee and the damage fee in ONE transaction. It calls the
--     existing staff_return_rental_with_damage() (file 68) for the condition, photo, damage fee and stock changes, so all
--     of that is unchanged. p_late_expected is the late fee the staff saw: if an hour ticked over meanwhile, nothing is
--     saved and they are asked to open the window again, so the customer never pays a different amount than the one shown.
--   * "Not now": the late fee may be left unpaid at the return (the damage fee too). It is then flagged late_fee_deferred so it is
--     never forgotten: the Rentals list shows "Late fee unpaid" and staff collect it later with staff_collect_late_fee().
--   * A deferred late fee can be paid by the customer in My Rentals with GCash (customer_pay_late_fee): it goes to Pending, staff
--     check the reference and screenshot, then accept it (staff_collect_late_fee) or reject it with a reason
--     (staff_reject_late_fee_payment, the fee goes back to unpaid). Same flow as the damage fee.
--   * damage_gcash_ref_free() (file 58) also refuses a GCash reference that is already on another rental's late fee.
--   * History: every step of a late fee (left unpaid, customer payment sent / rejected, collected, waived) is written to
--     late_fee_log (staff read it in the rental's History), like damage_charge_log does for the damage fee.
--   * Receipt email: when a late fee is paid (at the return or later) the admin page asks the Edge Function send-receipt
--     (kind: latefee) to email the customer a "fully paid" receipt. Sent once per payment (late_fee_paid_email_sent_at).
--     Deploy the function again:  supabase functions deploy send-receipt
--   * The late fee is counted from the end of the 8-hour window (rental_due_at), the same moment the Rentals list starts
--     to say "Overdue". (File 46 counted it from the scheduled return time, which is earlier for a rental shorter than
--     8 hours; the fee is corrected to match the Overdue time here.)
-- =====================================================================

alter table public.rental_detail
  add column if not exists late_fee_paid_at      timestamptz,
  add column if not exists late_fee_paid_method  text,
  add column if not exists late_fee_reference    text,
  add column if not exists late_fee_tendered     numeric(10,2),
  add column if not exists late_fee_collected_by bigint references public.app_user (user_id) on delete set null,
  add column if not exists late_fee_deferred     boolean not null default false,   -- true = staff chose "Not now": owed until late_fee_paid_at is set
  add column if not exists late_fee_pending_reference text,         -- customer sent a GCash payment: staff still have to check it
  add column if not exists late_fee_customer_paid_at  timestamptz,
  add column if not exists late_fee_reject_reason     text,         -- why staff rejected the customer's last GCash payment
  add column if not exists late_fee_paid_email_sent_at timestamptz;  -- the paid receipt was emailed (send-receipt, kind latefee)

-- the History of a late fee (one line per step, per rental order). Staff read it; rows are written only by the functions below.
create table if not exists public.late_fee_log (
  log_id          bigint generated always as identity primary key,
  rental_order_id bigint not null references public.rental_order (rental_order_id) on delete cascade,
  rental_ref      text   not null,
  action          text   not null,      -- Left unpaid | Payment sent | Payment rejected | Collected | Waived
  amount          numeric(10,2),
  old_status      text,
  new_status      text,
  note            text,
  by_user_id      bigint references public.app_user (user_id) on delete set null,
  by_customer     boolean not null default false,
  created_at      timestamptz not null default now()
);
create index if not exists late_fee_log_order_idx on public.late_fee_log (rental_order_id, log_id);
alter table public.late_fee_log enable row level security;
drop policy if exists late_fee_log_select on public.late_fee_log;
create policy late_fee_log_select on public.late_fee_log for select to authenticated using (public.is_staff());
revoke all on public.late_fee_log from anon, authenticated;
grant select on public.late_fee_log to authenticated;

create or replace function public.late_fee_log_add(
  p_order_id bigint, p_action text, p_amount numeric, p_old text, p_new text, p_note text, p_by_customer boolean default false
) returns void language sql security definer set search_path = public as $$
  insert into public.late_fee_log (rental_order_id, rental_ref, action, amount, old_status, new_status, note, by_user_id, by_customer)
  select o.rental_order_id, o.rental_ref, p_action, p_amount, p_old, p_new, nullif(trim(coalesce(p_note, '')), ''),
         case when p_by_customer then null else public.current_app_user_id() end, p_by_customer
    from public.rental_order o where o.rental_order_id = p_order_id;
$$;
revoke all on function public.late_fee_log_add(bigint, text, numeric, text, text, text, boolean) from public, anon, authenticated;

alter table public.rental_detail drop constraint if exists rental_detail_late_fee_method_chk;
alter table public.rental_detail add constraint rental_detail_late_fee_method_chk
  check (late_fee_paid_method is null or late_fee_paid_method in ('Cash', 'GCash'));

-- 1. v_rental_lines: the eight new columns are appended at the end (same view as file 57, nothing else changed) ---------
create or replace view public.v_rental_lines with (security_invoker = true) as
select
  o.rental_order_id, o.rental_ref, o.rental_type, o.status, o.source,
  o.customer_id, trim(c.first_name || ' ' || c.last_name) as customer_name, c.number as customer_number,
  bk.booking_ref,
  d.rental_detail_id, d.equipment_id, e.name as equipment_name, d.quantity,
  d.unit_price_at_request, d.rental_hours, d.returned_at as line_returned_at,
  o.pickup_date, o.return_date,
  case when o.rental_type = 'Outside' then public.rental_due_at(o.pickup_date, o.return_date) else bk.end_at end as due_at,
  case
    when o.status = 'Active' and d.returned_at is null
         and now() > case when o.rental_type = 'Outside' then public.rental_due_at(o.pickup_date, o.return_date) else bk.end_at end
    then greatest(1,
      (now() at time zone 'Asia/Manila')::date
      - ((case when o.rental_type = 'Outside' then public.rental_due_at(o.pickup_date, o.return_date) else bk.end_at end) at time zone 'Asia/Manila')::date)
    else 0
  end as days_overdue,
  o.rejected_reason, o.issued_at, o.returned_at, o.created_at,
  d.late_fee, o.down_payment,
  case
    when o.status = 'Active' and d.returned_at is null
         and now() > case when o.rental_type = 'Outside' then public.rental_due_at(o.pickup_date, o.return_date) else bk.end_at end
    then greatest(1, ceil(extract(epoch from (now() - (case when o.rental_type = 'Outside' then public.rental_due_at(o.pickup_date, o.return_date) else bk.end_at end))) / 3600.0))::int
    else 0
  end as hours_overdue,
  pb.balance_paid_amount, pb.balance_paid_at,
  public.rental_balance_due(o.rental_order_id) as balance_due,
  d.before_photo_path,
  d.return_condition,
  d.return_description,
  d.after_photo_path,
  o.handover_photo_path,
  -- NEW (83): how the late fee was paid, and whether it was left unpaid
  d.late_fee_paid_method,
  d.late_fee_reference,
  d.late_fee_paid_at,
  d.late_fee_tendered,
  d.late_fee_deferred,
  d.late_fee_pending_reference,
  d.late_fee_customer_paid_at,
  d.late_fee_reject_reason
from public.rental_order o
join public.rental_detail d on d.rental_order_id = o.rental_order_id
join public.equipment e on e.equipment_id = d.equipment_id
join public.customer c on c.customer_id = o.customer_id
left join public.booking bk on bk.booking_id = o.booking_id
left join lateral (
  select p.balance_paid_amount, p.balance_paid_at from public.payment p
   where p.rental_order_id = o.rental_order_id and p.status <> 'Rejected'
   order by p.payment_id desc limit 1
) pb on true;

grant select on public.v_rental_lines to authenticated;

-- 1b. a GCash reference may be used once: this also looks at the late fees of other rentals (replaces the function of file 58)
create or replace function public.damage_gcash_ref_free(p_ref text, p_order_id bigint) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from public.payment p where lower(p.gcash_reference) = lower(p_ref) and p.status <> 'Rejected')
     and not exists (select 1 from public.damage_charge d where d.gcash_reference = p_ref
                      and d.status in ('Pending', 'Paid') and d.rental_order_id <> p_order_id)
     and not exists (select 1 from public.rental_detail x where x.rental_order_id <> p_order_id
                      and (x.late_fee_reference = p_ref or x.late_fee_pending_reference = p_ref));
$$;
revoke all on function public.damage_gcash_ref_free(text, bigint) from public, anon, authenticated;

-- 2. return + late fee + damage fee, collected with ONE payment ---------------------------------------------------------
drop function if exists public.staff_return_rental_with_fees(text, bigint, text, text, text, jsonb, text, text, numeric, jsonb, numeric);
create function public.staff_return_rental_with_fees(
  p_rental_ref       text,
  p_equipment_id     bigint,
  p_condition        text,
  p_description      text    default null,
  p_after_photo_path text    default null,
  p_charges          jsonb   default '[]'::jsonb,
  p_method           text    default null,     -- 'Cash' or 'GCash' = the customer pays the late fee + damage fee now
  p_reference        text    default null,     -- GCash: 13-digit reference
  p_tendered         numeric default null,     -- Cash: amount given (must cover late fee + damage fee)
  p_stock_changes    jsonb   default '[]'::jsonb,
  p_late_expected    numeric default null      -- the late fee the staff saw in the window
) returns table (damage_total numeric, unpaid_total numeric, shortage_count integer, late_total numeric)
language plpgsql security definer set search_path = public as $$
declare
  o     public.rental_order;
  cond  text := trim(coalesce(p_condition, ''));
  m     text := case lower(coalesce(trim(p_method), '')) when 'gcash' then 'GCash' when 'cash' then 'Cash' else null end;
  gref  text := regexp_replace(coalesce(p_reference, ''), '\D', '', 'g');
  due   timestamptz;
  ids   bigint[];
  late  numeric := 0;
  dmg   numeric := 0;
  grand numeric;
  res   record;
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;

  select * into o from public.rental_order where rental_ref = upper(trim(p_rental_ref)) for update;
  if not found then raise exception 'Rental not found.' using errcode = 'P0001'; end if;
  if o.rental_type <> 'Outside' then raise exception 'Use this function only for outside rentals.' using errcode = 'P0001'; end if;

  select coalesce(array_agg(d.rental_detail_id), '{}') into ids
    from public.rental_detail d
   where d.rental_order_id = o.rental_order_id and d.returned_at is null
     and (p_equipment_id is null or d.equipment_id = p_equipment_id);

  -- the late fee that will be charged now (counted from the end of the 8-hour window; now() is the same all through this call)
  due := public.rental_due_at(o.pickup_date, o.return_date);
  if due is not null and now() > due then
    select coalesce(sum(round(d.quantity * d.unit_price_at_request / 8.0 * ceil(extract(epoch from (now() - due)) / 3600.0), 2)), 0)
      into late from public.rental_detail d where d.rental_detail_id = any (ids);
  end if;
  if p_late_expected is not null and abs(p_late_expected - late) > 0.005 then
    raise exception 'The late fee is now PHP % (it was PHP % when you opened this window). Close the window and open it again.',
      to_char(late, 'FM999,999,990.00'), to_char(p_late_expected, 'FM999,999,990.00') using errcode = 'P0001';
  end if;

  -- the damage fee the staff typed (only when the item has an issue)
  if cond <> 'No issue' then
    select coalesce(sum(round(coalesce((x ->> 'amount')::numeric, 0), 2)), 0) into dmg
      from jsonb_array_elements(coalesce(p_charges, '[]'::jsonb)) x
     where (x ->> 'rental_detail_id')::bigint = any (ids);
  end if;
  grand := late + dmg;

  -- the payment: checked BEFORE anything is saved
  if m is not null and grand > 0 then
    if m = 'GCash' then
      if length(gref) <> 13 then raise exception 'Enter the 13-digit GCash reference number.' using errcode = 'P0001'; end if;
      if not public.damage_gcash_ref_free(gref, o.rental_order_id)
         or exists (select 1 from public.rental_detail x where x.late_fee_reference = gref and x.rental_order_id <> o.rental_order_id) then
        raise exception 'That GCash reference number was already used.' using errcode = 'P0001';
      end if;
    elsif p_tendered is null or p_tendered + 0.005 < grand then
      raise exception 'The cash received is less than the amount to collect of PHP %.', to_char(grand, 'FM999,999,990.00') using errcode = 'P0001';
    end if;
  end if;   -- no method = "Not now": the late fee and the damage fee are saved as unpaid

  -- 1) the return, the damage fee and the stock changes (file 68). The damage fee is collected there; the cash given to it
  --    is what is left after the late fee, so the change in the damage receipt stays right.
  select * into res from public.staff_return_rental_with_damage(
    p_rental_ref, p_equipment_id, p_condition, p_description, p_after_photo_path, p_charges,
    case when dmg > 0 then m end,
    case when dmg > 0 and m = 'GCash' then gref end,
    case when dmg > 0 and m = 'Cash' then p_tendered - late end,
    p_stock_changes);

  -- 2) the late fee: counted from the end of the 8-hour window (the same time the Rentals list says Overdue) and its payment saved
  update public.rental_detail d
     set late_fee = case when due is not null and now() > due
                         then round(d.quantity * d.unit_price_at_request / 8.0 * ceil(extract(epoch from (now() - due)) / 3600.0), 2)
                         else 0 end
   where d.rental_detail_id = any (ids);

  if m is null and late > 0 then   -- "Not now": flag it so it shows as unpaid until it is collected
    update public.rental_detail d
       set late_fee_deferred = true, late_fee_paid_method = null, late_fee_reference = null,
           late_fee_tendered = null, late_fee_paid_at = null, late_fee_collected_by = null,
           late_fee_pending_reference = null, late_fee_customer_paid_at = null, late_fee_reject_reason = null
     where d.rental_detail_id = any (ids) and d.late_fee > 0;
  elsif m is not null and late > 0 then
    update public.rental_detail d
       set late_fee_paid_method = m,
           late_fee_reference = case when m = 'GCash' then gref end,
           late_fee_tendered = case when m = 'Cash' then p_tendered - dmg end,   -- the cash that is left after the damage fee, so the receipt's change is right
           late_fee_paid_at = now(),
           late_fee_collected_by = public.current_app_user_id(),
           late_fee_paid_email_sent_at = null
     where d.rental_detail_id = any (ids) and d.late_fee > 0;
  end if;

  if late > 0 then
    perform public.late_fee_log_add(o.rental_order_id,
      case when m is null then 'Left unpaid' else 'Collected' end, late, null, case when m is null then 'Unpaid' else 'Paid' end,
      case when m is null then 'Staff chose Not now at the return'
           else m || ' collected at the return' || case when m = 'GCash' then ' (ref ' || gref || ')' else '' end end);
  end if;

  return query select res.damage_total, res.unpaid_total, res.shortage_count, late;
end $$;
revoke all on function public.staff_return_rental_with_fees(text, bigint, text, text, text, jsonb, text, text, numeric, jsonb, numeric) from public, anon;
grant execute on function public.staff_return_rental_with_fees(text, bigint, text, text, text, jsonb, text, text, numeric, jsonb, numeric) to authenticated;

-- 3. collect a late fee that was left unpaid at the return ("Not now") -------------------------------------------------
drop function if exists public.staff_collect_late_fee(text, text, text, numeric, numeric);
create function public.staff_collect_late_fee(
  p_rental_ref text,
  p_method     text,
  p_reference  text    default null,   -- GCash: 13-digit reference
  p_tendered   numeric default null,   -- Cash: amount given (must cover the late fee)
  p_expected   numeric default null    -- the unpaid late fee the staff saw
) returns numeric
language plpgsql security definer set search_path = public as $$
declare
  o     public.rental_order;
  m     text := case lower(coalesce(trim(p_method), '')) when 'gcash' then 'GCash' when 'cash' then 'Cash' else null end;
  gref  text := regexp_replace(coalesce(p_reference, ''), '\D', '', 'g');
  ids   bigint[];
  owed  numeric;
  was_pending boolean;
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  if m is null then raise exception 'Choose Cash or GCash.' using errcode = 'P0001'; end if;

  select * into o from public.rental_order where rental_ref = upper(trim(p_rental_ref)) for update;
  if not found then raise exception 'Rental not found.' using errcode = 'P0001'; end if;

  select coalesce(array_agg(d.rental_detail_id), '{}'), coalesce(sum(d.late_fee), 0) into ids, owed
    from public.rental_detail d
   where d.rental_order_id = o.rental_order_id and d.returned_at is not null
     and d.late_fee > 0 and d.late_fee_deferred and d.late_fee_paid_at is null;
  if owed <= 0 then raise exception 'There is no unpaid late fee on this rental.' using errcode = 'P0001'; end if;
  select exists (select 1 from public.rental_detail d where d.rental_detail_id = any (ids) and d.late_fee_pending_reference is not null) into was_pending;
  if p_expected is not null and abs(p_expected - owed) > 0.005 then
    raise exception 'The unpaid late fee is PHP % (it was PHP % when you opened this window). Close the window and open it again.',
      to_char(owed, 'FM999,999,990.00'), to_char(p_expected, 'FM999,999,990.00') using errcode = 'P0001';
  end if;

  if m = 'GCash' then
    if length(gref) <> 13 then raise exception 'Enter the 13-digit GCash reference number.' using errcode = 'P0001'; end if;
    if not public.damage_gcash_ref_free(gref, o.rental_order_id)
       or exists (select 1 from public.rental_detail x where x.late_fee_reference = gref and x.rental_order_id <> o.rental_order_id) then
      raise exception 'That GCash reference number was already used.' using errcode = 'P0001';
    end if;
  elsif p_tendered is null or p_tendered + 0.005 < owed then
    raise exception 'The cash received is less than the late fee of PHP %.', to_char(owed, 'FM999,999,990.00') using errcode = 'P0001';
  end if;

  update public.rental_detail d
     set late_fee_paid_method = m,
         late_fee_reference = case when m = 'GCash' then gref end,
         late_fee_tendered = case when m = 'Cash' then p_tendered end,
         late_fee_paid_at = now(),
         late_fee_collected_by = public.current_app_user_id(),
         late_fee_pending_reference = null,
         late_fee_reject_reason = null,
         late_fee_paid_email_sent_at = null
   where d.rental_detail_id = any (ids);
  perform public.late_fee_log_add(o.rental_order_id, 'Collected', owed, case when was_pending then 'Pending' else 'Unpaid' end, 'Paid',
    case when was_pending then 'Customer''s GCash payment checked' else m || ' collected' end
    || case when m = 'GCash' then ' (ref ' || gref || ')' else '' end);

  return owed;
end $$;
revoke all on function public.staff_collect_late_fee(text, text, text, numeric, numeric) from public, anon;
grant execute on function public.staff_collect_late_fee(text, text, text, numeric, numeric) to authenticated;

-- 4. the customer pays a deferred late fee NOW with GCash (staff check it) ---------------------------------------------
create or replace function public.customer_pay_late_fee(p_rental_ref text, p_gcash_reference text)
returns numeric language plpgsql security definer set search_path = public as $$
declare
  o     public.rental_order;
  gref  text := regexp_replace(coalesce(p_gcash_reference, ''), '\D', '', 'g');
  ids   bigint[];
  owed  numeric;
begin
  select * into o from public.rental_order
   where rental_ref = upper(trim(p_rental_ref)) and customer_id = public.current_customer_id() for update;
  if not found then raise exception 'Rental not found.' using errcode = 'P0001'; end if;
  if length(gref) <> 13 then raise exception 'Enter the 13-digit GCash reference number.' using errcode = 'P0001'; end if;

  select coalesce(array_agg(d.rental_detail_id), '{}'), coalesce(sum(d.late_fee), 0) into ids, owed
    from public.rental_detail d
   where d.rental_order_id = o.rental_order_id and d.returned_at is not null
     and d.late_fee > 0 and d.late_fee_deferred and d.late_fee_paid_at is null and d.late_fee_pending_reference is null;
  if owed <= 0 then raise exception 'There is no unpaid late fee on this rental.' using errcode = 'P0001'; end if;
  if not public.damage_gcash_ref_free(gref, o.rental_order_id) then
    raise exception 'That GCash reference number was already used.' using errcode = 'P0001';
  end if;

  update public.rental_detail d
     set late_fee_pending_reference = gref, late_fee_customer_paid_at = now(), late_fee_reject_reason = null
   where d.rental_detail_id = any (ids);
  perform public.late_fee_log_add(o.rental_order_id, 'Payment sent', owed, 'Unpaid', 'Pending',
    'Customer sent a GCash payment (ref ' || gref || ')', true);
  return owed;
end $$;
revoke all on function public.customer_pay_late_fee(text, text) from public, anon;
grant execute on function public.customer_pay_late_fee(text, text) to authenticated;

-- 5. staff reject the customer's GCash payment (the late fee goes back to unpaid; the customer sees the reason) -----------
create or replace function public.staff_reject_late_fee_payment(p_rental_ref text, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare o public.rental_order; n integer; old_ref text; amt numeric;
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  if nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'Say why the payment is rejected.' using errcode = 'P0001';
  end if;
  select * into o from public.rental_order where rental_ref = upper(trim(p_rental_ref)) for update;
  if not found then raise exception 'Rental not found.' using errcode = 'P0001'; end if;
  select max(d.late_fee_pending_reference), coalesce(sum(d.late_fee), 0) into old_ref, amt from public.rental_detail d
   where d.rental_order_id = o.rental_order_id and d.late_fee_deferred and d.late_fee_paid_at is null and d.late_fee_pending_reference is not null;
  update public.rental_detail d
     set late_fee_pending_reference = null, late_fee_customer_paid_at = null, late_fee_reject_reason = trim(p_reason)
   where d.rental_order_id = o.rental_order_id and d.late_fee_deferred and d.late_fee_paid_at is null
     and d.late_fee_pending_reference is not null;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'There is no late fee payment to reject on this rental.' using errcode = 'P0001'; end if;
  perform public.late_fee_log_add(o.rental_order_id, 'Payment rejected', amt, 'Pending', 'Unpaid', trim(p_reason) || ' (ref ' || coalesce(old_ref, '-') || ')');
end $$;
revoke all on function public.staff_reject_late_fee_payment(text, text) from public, anon;
grant execute on function public.staff_reject_late_fee_payment(text, text) to authenticated;

-- end of 83_late_fee_collection.sql
