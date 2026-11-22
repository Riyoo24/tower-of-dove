-- =====================================================================
-- 98_audit_log.sql  (safe to re-run)
-- AUDIT LOG: what every staff member did in the admin dashboard. Only the Owner can read it.
--
--   * public.audit_log is APPEND-ONLY. No role can insert, update or delete through the API
--     (no INSERT / UPDATE / DELETE privilege, no such policy, and a trigger refuses changes
--     even for the service role). Rows are written only by the database: triggers on the
--     tables where the action already happens, and by the existing log tables
--     (booking_event, damage_charge_log, late_fee_log, incident_review_log, rental_item_swap,
--     damage_block_override). No browser code writes audit rows, so a modified page cannot skip or fake them.
--   * Reads use the existing helper public.is_owner() in the same RLS pattern as the other tables.
--     Staff get an EMPTY list when they select from it, and "permission denied" when they try to write it.
--   * The actor is always auth.uid() (the signed-in user), read inside the database. Actions with no signed-in
--     staff member (pg_cron jobs, customers, guests, the service role) are not recorded: this log is about STAFF.
--   * Nothing existing is changed: no existing function, view, policy or the per-booking History is touched.
--     Every trigger is an AFTER trigger and FAILS OPEN: if writing an audit row ever raised an error, it becomes a
--     WARNING in the Postgres logs and the booking / payment / rental still goes through.
--
-- Run it in the Supabase SQL Editor AFTER 97_gcash_account_details.sql (files 01 to 97 must already be applied).
-- It can be pasted as one script, or block by block in this order (BLOCK 1 to BLOCK 6). BLOCK 6 must be last.
-- It needs no Edge Function change and no frontend secret.
-- =====================================================================


-- =====================================================================
-- BLOCK 1. The table, its indexes, the append-only guard, and who may read it
-- =====================================================================
create table if not exists public.audit_log (
  audit_id       bigint generated always as identity primary key,
  created_at     timestamptz not null default now(),          -- shown in Asia/Manila by the dashboard
  actor_user_id  bigint,                                      -- app_user.user_id. No foreign key on purpose: a log must outlive the account.
  actor_name     text not null,                               -- name AT THE TIME of the action
  actor_role     text not null,                               -- 'Owner' | 'Staff' AT THE TIME of the action
  action         text not null,                               -- machine code, e.g. payment.verified
  category       text not null,                               -- Payments | Bookings | Rentals | Money overrides | Customers | Settings | Staff accounts | Sign-ins
  description    text not null,                               -- readable sentence
  entity_type    text,                                        -- booking | rental | payment | fee | studio | equipment | setting | staff | auth | flag
  entity_ref     text,                                        -- booking or rental reference (TOD-..., OUT-..., RA-...)
  related_ref    text,                                        -- e.g. the booking an add-on rental belongs to
  item           text,                                        -- equipment, studio or staff name where relevant
  old_values     jsonb,                                       -- BEFORE (edits)
  new_values     jsonb,                                       -- AFTER (edits) or the details of the action
  constraint audit_log_role_chk check (actor_role in ('Owner', 'Staff'))
);

-- filters of the Audit Log tab: date, staff member, action
create index if not exists audit_log_created_idx on public.audit_log (created_at desc, audit_id desc);
create index if not exists audit_log_actor_idx   on public.audit_log (actor_user_id, created_at desc);
create index if not exists audit_log_action_idx  on public.audit_log (action, created_at desc);

-- the reference search box ("contains"): trigram indexes when the extension is available, plain indexes otherwise
do $$
begin
  begin
    create schema if not exists extensions;
    create extension if not exists pg_trgm with schema extensions;
    execute 'create index if not exists audit_log_ref_trgm_idx on public.audit_log using gin (entity_ref extensions.gin_trgm_ops)';
    execute 'create index if not exists audit_log_related_trgm_idx on public.audit_log using gin (related_ref extensions.gin_trgm_ops)';
  exception when others then
    raise notice 'pg_trgm not available (%): using plain indexes for the reference search.', sqlerrm;
    create index if not exists audit_log_ref_idx     on public.audit_log (entity_ref);
    create index if not exists audit_log_related_idx on public.audit_log (related_ref);
  end;
end $$;

-- Append-only guard: nobody changes or deletes a row, not even the service role or the table owner.
-- The ONLY exception is public.audit_purge_old() (retention, BLOCK 5), which switches a transaction-local flag on.
create or replace function public.audit_log_block_change() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('tod.audit_purge', true), '') = 'on' then
    return old;
  end if;
  raise exception 'The audit log is append-only: rows cannot be changed or deleted.' using errcode = '42501';
end $$;

drop trigger if exists trg_audit_log_no_change   on public.audit_log;
drop trigger if exists trg_audit_log_no_truncate on public.audit_log;
create trigger trg_audit_log_no_change   before update or delete on public.audit_log for each row       execute function public.audit_log_block_change();
create trigger trg_audit_log_no_truncate before truncate         on public.audit_log for each statement execute function public.audit_log_block_change();

-- Who can do what: the Owner can SELECT (RLS with the existing is_owner() helper). Nobody can write through the API.
alter table public.audit_log enable row level security;
drop policy if exists audit_log_owner_select on public.audit_log;
create policy audit_log_owner_select on public.audit_log for select to authenticated using (public.is_owner());
-- deliberately NO insert / update / delete policy

revoke all on public.audit_log from public, anon, authenticated;
grant select on public.audit_log to authenticated;      -- RLS above lets only the Owner's rows through
do $$
begin
  execute format('revoke all on sequence %s from public, anon, authenticated', pg_get_serial_sequence('public.audit_log', 'audit_id'));
end $$;


-- =====================================================================
-- BLOCK 2. Helpers and the one writer
--   Every audit_* function is locked away from the API in BLOCK 6 (otherwise anyone could call the writer).
-- =====================================================================
create or replace function public.audit_money(p numeric) returns text
language sql stable as $$ select 'PHP ' || to_char(coalesce(p, 0), 'FM999,999,990.00') $$;

create or replace function public.audit_when(p timestamptz) returns text
language sql stable as $$
  select case when p is null then '-'
              else to_char(p at time zone 'Asia/Manila', 'Dy Mon FMDD, YYYY, FMHH12:MI AM') end
$$;

create or replace function public.audit_range(p_start timestamptz, p_end timestamptz) returns text
language sql stable as $$
  select case
    when p_start is null or p_end is null then public.audit_when(coalesce(p_start, p_end))
    when (p_start at time zone 'Asia/Manila')::date = (p_end at time zone 'Asia/Manila')::date
      then public.audit_when(p_start) || ' to ' || to_char(p_end at time zone 'Asia/Manila', 'FMHH12:MI AM')
    else public.audit_when(p_start) || ' to ' || public.audit_when(p_end)
  end
$$;

-- jsonb of the keys that differ between two rows: { "old": {...}, "new": {...} }
create or replace function public.audit_diff(p_old jsonb, p_new jsonb, p_only text[] default null, p_skip text[] default array['updated_at'])
returns jsonb language sql immutable as $$
  with o as (select coalesce(p_old, '{}'::jsonb) as j),
       n as (select coalesce(p_new, '{}'::jsonb) as j),
       ch as (
         select k.key
           from o, n, jsonb_object_keys(o.j || n.j) as k(key)
          where (p_only is null or k.key = any (p_only))
            and not (k.key = any (coalesce(p_skip, '{}'::text[])))
            and coalesce(o.j -> k.key, 'null'::jsonb) is distinct from coalesce(n.j -> k.key, 'null'::jsonb))
  select jsonb_build_object(
    'old', coalesce((select jsonb_object_agg(ch.key, coalesce(o.j -> ch.key, 'null'::jsonb)) from ch, o), '{}'::jsonb),
    'new', coalesce((select jsonb_object_agg(ch.key, coalesce(n.j -> ch.key, 'null'::jsonb)) from ch, n), '{}'::jsonb));
$$;

-- "hourly rate 200.00 to 250.00; status Available to Maintenance"
create or replace function public.audit_changes_text(p_diff jsonb) returns text
language sql immutable as $$
  select coalesce(string_agg(
           replace(k.key, '_', ' ') || ' ' || coalesce(left(p_diff -> 'old' ->> k.key, 60), '-')
             || ' to ' || coalesce(left(p_diff -> 'new' ->> k.key, 60), '-'),
           '; ' order by k.key), '')
    from jsonb_object_keys(coalesce(p_diff -> 'new', '{}'::jsonb)) as k(key);
$$;

create or replace function public.audit_clean(p_row jsonb) returns jsonb
language sql immutable as $$ select p_row - 'updated_at' - 'created_at' - 'sort_order' $$;

-- THE writer. The actor is given as an auth user id; it must belong to an ACTIVE app_user (Owner or Staff),
-- otherwise nothing is written (customers, guests, cron, service role). Name and role are copied into the row.
create or replace function public.audit_write_for(
  p_actor_auth uuid, p_action text, p_category text, p_description text,
  p_entity_type text default null, p_ref text default null, p_related text default null, p_item text default null,
  p_old jsonb default null, p_new jsonb default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  a_id bigint; a_name text; a_role text;
begin
  if p_actor_auth is null then return; end if;
  select u.user_id,
         coalesce(nullif(trim(coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, '')), ''), u.username),
         u.role
    into a_id, a_name, a_role
    from public.app_user u
   where u.auth_user_id = p_actor_auth and u.status = 'Active';
  if a_id is null then return; end if;

  insert into public.audit_log
    (actor_user_id, actor_name, actor_role, action, category, description, entity_type, entity_ref, related_ref, item, old_values, new_values)
  values
    (a_id, a_name, a_role, p_action, p_category, coalesce(nullif(trim(p_description), ''), p_action), p_entity_type,
     nullif(trim(coalesce(p_ref, '')), ''), nullif(trim(coalesce(p_related, '')), ''), nullif(trim(coalesce(p_item, '')), ''),
     p_old, p_new);
exception when others then
  raise warning 'audit_log: could not record % (%)', p_action, sqlerrm;   -- fails open: the real action is never blocked
end $$;

-- the same for "whoever is signed in right now"
create or replace function public.audit_write(
  p_action text, p_category text, p_description text,
  p_entity_type text default null, p_ref text default null, p_related text default null, p_item text default null,
  p_old jsonb default null, p_new jsonb default null
) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform public.audit_write_for(auth.uid(), p_action, p_category, p_description, p_entity_type, p_ref, p_related, p_item, p_old, p_new);
end $$;


-- =====================================================================
-- BLOCK 3. Trigger functions (one per table). Each starts with the same cheap check: no signed-in staff member = nothing to do.
-- =====================================================================

-- ---- payments: GCash verified / rejected, staff-recorded payments --------------------------------------
create or replace function public.audit_trg_payment() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v jsonb := to_jsonb(new);
  ref text; rel text; what text; act text; verb text; extra text := '';
  oldv jsonb := null;
begin
  if auth.uid() is null or not public.is_staff() then return null; end if;

  if tg_op = 'UPDATE' then
    if new.status is not distinct from old.status or new.status not in ('Verified', 'Rejected') then return null; end if;
    act := case when new.status = 'Verified' then 'payment.verified' else 'payment.rejected' end;
    verb := case when new.status = 'Verified' then 'Verified' else 'Rejected' end;
    oldv := jsonb_build_object('status', old.status);
  else
    if new.status <> 'Verified' then return null; end if;      -- a payment the staff member recorded at the counter
    act := 'payment.recorded';
    verb := 'Recorded';
  end if;

  if new.booking_id is not null then
    select b.booking_ref into ref from public.booking b where b.booking_id = new.booking_id;
  else
    select o.rental_ref, bk.booking_ref into ref, rel
      from public.rental_order o left join public.booking bk on bk.booking_id = o.booking_id
     where o.rental_order_id = new.rental_order_id;
  end if;

  what := case when v ->> 'extension_id' is not null then 'extension payment'
               when new.rental_order_id is not null then 'rental payment'
               else 'booking payment' end;
  if new.method = 'GCash' and new.gcash_reference is not null then
    extra := ' (GCash ref ' || new.gcash_reference || ')';
  elsif new.method = 'Cash' and nullif(v ->> 'cash_tendered', '') is not null then
    extra := ' (cash received ' || public.audit_money((v ->> 'cash_tendered')::numeric) || ')';
  end if;

  perform public.audit_write(act, 'Payments',
    verb || ' ' || new.method || ' ' || what || ' of ' || public.audit_money(new.amount) || extra || ' for ' || coalesce(ref, 'a record'),
    'payment', ref, rel, null, oldv,
    jsonb_strip_nulls(jsonb_build_object('status', new.status, 'method', new.method, 'amount', new.amount,
      'gcash_reference', new.gcash_reference, 'payment_option', v ->> 'payment_option', 'cash_tendered', v ->> 'cash_tendered')));
  return null;
exception when others then
  raise warning 'audit_log: trigger % failed: %', tg_name, sqlerrm;
  return null;
end $$;

-- ---- payments: balance collected (cash with cash tendered, or GCash reference) --------------------------
-- DEFERRED to the end of the transaction on purpose: staff_collect_balance_proof() first records the amount and
-- only afterwards saves the GCash reference / cash tendered in a second UPDATE. Reading the row at COMMIT sees both.
create or replace function public.audit_trg_payment_balance() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  p jsonb; ref text; rel text; amt numeric; m text; extra text := '';
begin
  if auth.uid() is null or not public.is_staff() then return null; end if;
  select to_jsonb(x) into p from public.payment x where x.payment_id = new.payment_id;
  if p is null then return null; end if;

  amt := new.balance_paid_amount - old.balance_paid_amount;
  m := p ->> 'balance_paid_method';
  if (p ->> 'booking_id') is not null then
    select b.booking_ref into ref from public.booking b where b.booking_id = (p ->> 'booking_id')::bigint;
  else
    select o.rental_ref, bk.booking_ref into ref, rel
      from public.rental_order o left join public.booking bk on bk.booking_id = o.booking_id
     where o.rental_order_id = (p ->> 'rental_order_id')::bigint;
  end if;
  if m = 'GCash' and nullif(p ->> 'balance_paid_reference', '') is not null then
    extra := ' (GCash ref ' || (p ->> 'balance_paid_reference') || ')';
  elsif m = 'Cash' and nullif(p ->> 'balance_tendered', '') is not null then
    extra := ' (cash received ' || public.audit_money((p ->> 'balance_tendered')::numeric) || ')';
  end if;

  perform public.audit_write('payment.balance_collected', 'Payments',
    'Collected balance of ' || public.audit_money(amt) || ' by ' || coalesce(m, 'payment') || extra || ' for ' || coalesce(ref, 'a record'),
    'payment', ref, rel, null,
    jsonb_build_object('balance_paid', old.balance_paid_amount),
    jsonb_strip_nulls(jsonb_build_object('balance_paid', new.balance_paid_amount, 'collected', amt, 'method', m,
      'gcash_reference', p ->> 'balance_paid_reference', 'cash_tendered', p ->> 'balance_tendered')));
  return null;
exception when others then
  raise warning 'audit_log: trigger % failed: %', tg_name, sqlerrm;
  return null;
end $$;

-- ---- bookings: approved, rejected, rescheduled, cancelled, extended, started, completed, created onsite -----------
create or replace function public.audit_trg_booking() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  studio text; ref text := new.booking_ref; hrs numeric; hrs_txt text;
begin
  if auth.uid() is null or not public.is_staff() then return null; end if;
  select s.name into studio from public.studio s where s.studio_id = new.studio_id;

  if tg_op = 'INSERT' then
    perform public.audit_write('booking.created', 'Bookings',
      'Recorded ' || lower(coalesce(new.source, 'onsite')) || ' booking ' || ref || ' for ' || coalesce(studio, 'a studio') || ', ' || public.audit_range(new.start_at, new.end_at),
      'booking', ref, null, studio, null,
      jsonb_build_object('status', new.status, 'source', new.source, 'start_at', new.start_at, 'end_at', new.end_at));
    return null;
  end if;

  -- status changes
  if new.status is distinct from old.status then
    if new.status = 'Approved' then
      perform public.audit_write('booking.approved', 'Bookings', 'Approved booking ' || ref || ' (' || coalesce(studio, 'studio') || ', ' || public.audit_range(new.start_at, new.end_at) || ')',
        'booking', ref, null, studio, jsonb_build_object('status', old.status), jsonb_build_object('status', new.status));
    elsif new.status = 'Rejected' then
      perform public.audit_write('booking.rejected', 'Bookings',
        'Rejected booking ' || ref || coalesce('. Reason: ' || nullif(trim(coalesce(new.rejected_reason, '')), ''), ''),
        'booking', ref, null, studio, jsonb_build_object('status', old.status),
        jsonb_strip_nulls(jsonb_build_object('status', new.status, 'reason', new.rejected_reason)));
    elsif new.status = 'Cancelled' then
      if coalesce(new.cancelled_reason, '') not ilike 'No-show%' then      -- a no-show release is recorded from its booking_event line instead
        perform public.audit_write('booking.cancelled', 'Bookings',
          'Cancelled booking ' || ref || coalesce('. Reason: ' || nullif(trim(coalesce(new.cancelled_reason, '')), ''), ''),
          'booking', ref, null, studio, jsonb_build_object('status', old.status),
          jsonb_strip_nulls(jsonb_build_object('status', new.status, 'reason', new.cancelled_reason)));
      end if;
    elsif new.status = 'In Progress' then
      perform public.audit_write('booking.started', 'Bookings', 'Started the session of booking ' || ref || ' (' || coalesce(studio, 'studio') || ')',
        'booking', ref, null, studio, jsonb_build_object('status', old.status), jsonb_build_object('status', new.status, 'actual_start_at', new.actual_start_at));
    elsif new.status = 'Completed' then
      perform public.audit_write('booking.completed', 'Bookings', 'Completed booking ' || ref || ' (' || coalesce(studio, 'studio') || ')',
        'booking', ref, null, studio, jsonb_build_object('status', old.status), jsonb_build_object('status', new.status, 'actual_end_at', new.actual_end_at));
    end if;
  end if;

  -- schedule changes: a new start = rescheduled, only a later end = extended
  if new.start_at is distinct from old.start_at then
    perform public.audit_write('booking.rescheduled', 'Bookings',
      'Rescheduled booking ' || ref || ' (' || coalesce(studio, 'studio') || ') from ' || public.audit_range(old.start_at, old.end_at) || ' to ' || public.audit_range(new.start_at, new.end_at),
      'booking', ref, null, studio,
      jsonb_build_object('start_at', old.start_at, 'end_at', old.end_at),
      jsonb_build_object('start_at', new.start_at, 'end_at', new.end_at));
  elsif new.end_at is distinct from old.end_at then
    hrs := round(extract(epoch from (new.end_at - old.end_at)) / 3600.0, 2);
    hrs_txt := case when hrs = trunc(hrs) then trunc(hrs)::text else hrs::text end;
    if hrs > 0 then
      perform public.audit_write('booking.extended', 'Bookings',
        'Extended booking ' || ref || ' (' || coalesce(studio, 'studio') || ') by ' || hrs_txt || ' hr. New time: ' || public.audit_range(new.start_at, new.end_at),
        'booking', ref, null, studio,
        jsonb_build_object('end_at', old.end_at), jsonb_build_object('end_at', new.end_at, 'extra_hours', hrs));
    else
      perform public.audit_write('booking.rescheduled', 'Bookings',
        'Changed the end time of booking ' || ref || ' (' || coalesce(studio, 'studio') || ') to ' || public.audit_range(new.start_at, new.end_at),
        'booking', ref, null, studio,
        jsonb_build_object('end_at', old.end_at), jsonb_build_object('end_at', new.end_at));
    end if;
  end if;
  return null;
exception when others then
  raise warning 'audit_log: trigger % failed: %', tg_name, sqlerrm;
  return null;
end $$;

-- ---- rentals: created onsite, approved, rejected, cancelled, items issued -------------------------------
create or replace function public.audit_trg_rental_order() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  bref text; items text; ref text := new.rental_ref;
  kind text := case when new.rental_type = 'Outside' then 'outside rental' else 'add-on rental' end;
begin
  if auth.uid() is null or not public.is_staff() then return null; end if;
  select bk.booking_ref into bref from public.booking bk where bk.booking_id = new.booking_id;
  select string_agg(e.name || ' x' || d.quantity, ', ' order by e.name) into items
    from public.rental_detail d join public.equipment e on e.equipment_id = d.equipment_id
   where d.rental_order_id = new.rental_order_id;

  if tg_op = 'INSERT' then
    perform public.audit_write('rental.created', 'Rentals',
      'Recorded ' || lower(coalesce(new.source, 'onsite')) || ' ' || kind || ' ' || ref || coalesce(' for booking ' || bref, ''),
      'rental', ref, bref, items, null, jsonb_strip_nulls(jsonb_build_object('status', new.status, 'source', new.source, 'type', new.rental_type)));
    return null;
  end if;

  if new.status is not distinct from old.status then return null; end if;
  if new.status = 'Approved' then
    perform public.audit_write('rental.approved', 'Rentals', 'Approved ' || kind || ' ' || ref || coalesce(' (' || items || ')', ''),
      'rental', ref, bref, items, jsonb_build_object('status', old.status), jsonb_build_object('status', new.status));
  elsif new.status = 'Rejected' then
    perform public.audit_write('rental.rejected', 'Rentals',
      'Rejected ' || kind || ' ' || ref || coalesce('. Reason: ' || nullif(trim(coalesce(new.rejected_reason, '')), ''), ''),
      'rental', ref, bref, items, jsonb_build_object('status', old.status),
      jsonb_strip_nulls(jsonb_build_object('status', new.status, 'reason', new.rejected_reason)));
  elsif new.status = 'Cancelled' then
    perform public.audit_write('rental.cancelled', 'Rentals', 'Cancelled ' || kind || ' ' || ref,
      'rental', ref, bref, items, jsonb_build_object('status', old.status), jsonb_build_object('status', new.status));
  elsif new.status = 'Active' then
    perform public.audit_write('rental.issued', 'Rentals', 'Issued equipment of ' || kind || ' ' || ref || coalesce(': ' || items, ''),
      'rental', ref, bref, items, jsonb_build_object('status', old.status), jsonb_build_object('status', new.status, 'issued_at', new.issued_at));
  end if;                                   -- 'Returned' is recorded per item by audit_trg_rental_detail
  return null;
exception when others then
  raise warning 'audit_log: trigger % failed: %', tg_name, sqlerrm;
  return null;
end $$;

-- ---- rentals: one line per item returned -----------------------------------------------------------------
create or replace function public.audit_trg_rental_detail() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v jsonb := to_jsonb(new); rref text; bref text; nm text;
begin
  if auth.uid() is null or not public.is_staff() then return null; end if;
  if old.returned_at is not null or new.returned_at is null then return null; end if;
  select ro.rental_ref, bk.booking_ref into rref, bref
    from public.rental_order ro left join public.booking bk on bk.booking_id = ro.booking_id
   where ro.rental_order_id = new.rental_order_id;
  select e.name into nm from public.equipment e where e.equipment_id = new.equipment_id;
  perform public.audit_write('rental.item_returned', 'Rentals',
    'Returned ' || coalesce(nm, 'an item') || ' x' || new.quantity || ' of ' || coalesce(rref, 'a rental')
      || coalesce(' (condition: ' || nullif(v ->> 'return_condition', '') || ')', ''),
    'rental', rref, bref, nm, jsonb_build_object('returned', false),
    jsonb_strip_nulls(jsonb_build_object('returned_at', new.returned_at, 'quantity', new.quantity, 'condition', v ->> 'return_condition',
      'notes', nullif(v ->> 'return_description', ''), 'late_fee', v ->> 'late_fee')));
  return null;
exception when others then
  raise warning 'audit_log: trigger % failed: %', tg_name, sqlerrm;
  return null;
end $$;

-- ---- rentals: item swapped (existing log table rental_item_swap, file 61) --------------------------------
create or replace function public.audit_trg_swap() returns trigger
language plpgsql security definer set search_path = public as $$
declare bref text;
begin
  if auth.uid() is null or not public.is_staff() then return null; end if;
  select bk.booking_ref into bref
    from public.rental_order ro left join public.booking bk on bk.booking_id = ro.booking_id
   where ro.rental_order_id = new.rental_order_id;
  perform public.audit_write('rental.item_swapped', 'Rentals',
    'Swapped ' || new.old_name || ' for ' || new.new_name || ' (x' || new.quantity || ') on ' || new.rental_ref
      || coalesce('. Reason: ' || nullif(trim(coalesce(new.reason, '')), ''), ''),
    'rental', new.rental_ref, bref, new.old_name || ' -> ' || new.new_name,
    jsonb_build_object('item', new.old_name), jsonb_strip_nulls(jsonb_build_object('item', new.new_name, 'quantity', new.quantity, 'reason', new.reason)));
  return null;
exception when others then
  raise warning 'audit_log: trigger % failed: %', tg_name, sqlerrm;
  return null;
end $$;

-- ---- money: damage fee recorded / changed / waived / collected (existing log table damage_charge_log, file 58) ----
create or replace function public.audit_trg_damage_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  dc jsonb; rref text; nm text; act text; amt text;
begin
  if coalesce(new.by_customer, false) or auth.uid() is null or not public.is_staff() then return null; end if;
  select to_jsonb(c) into dc from public.damage_charge c where c.damage_charge_id = new.damage_charge_id;
  select ro.rental_ref into rref from public.rental_order ro where ro.rental_order_id = nullif(dc ->> 'rental_order_id', '')::bigint;
  select e.name into nm
    from public.rental_detail d join public.equipment e on e.equipment_id = d.equipment_id
   where d.rental_detail_id = nullif(dc ->> 'rental_detail_id', '')::bigint;
  act := 'damage.' || regexp_replace(lower(trim(new.action)), '[^a-z0-9]+', '_', 'g');
  amt := case when new.old_amount is distinct from new.new_amount and new.old_amount is not null
              then ': ' || public.audit_money(new.old_amount) || ' to ' || public.audit_money(new.new_amount)
              when new.new_amount is not null then ': ' || public.audit_money(new.new_amount) else '' end;
  perform public.audit_write(act, 'Money overrides',
    'Damage fee ' || lower(new.action) || ' for ' || coalesce(nm, 'an item') || ' on ' || coalesce(rref, 'a rental') || amt
      || coalesce('. ' || nullif(trim(coalesce(new.note, '')), ''), ''),
    'fee', rref, null, nm,
    jsonb_strip_nulls(jsonb_build_object('amount', new.old_amount, 'status', new.old_status)),
    jsonb_strip_nulls(jsonb_build_object('amount', new.new_amount, 'status', new.new_status, 'note', new.note)));
  return null;
exception when others then
  raise warning 'audit_log: trigger % failed: %', tg_name, sqlerrm;
  return null;
end $$;

-- ---- money: late fee left unpaid / collected / waived / payment rejected (existing log table late_fee_log, file 83) ----
create or replace function public.audit_trg_late_fee_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare act text; bref text;
begin
  if coalesce(new.by_customer, false) or auth.uid() is null or not public.is_staff() then return null; end if;
  select bk.booking_ref into bref
    from public.rental_order ro left join public.booking bk on bk.booking_id = ro.booking_id
   where ro.rental_order_id = new.rental_order_id;
  act := 'late_fee.' || regexp_replace(lower(trim(new.action)), '[^a-z0-9]+', '_', 'g');
  perform public.audit_write(act, 'Money overrides',
    'Late fee ' || lower(new.action) || ' on ' || new.rental_ref || coalesce(' (' || public.audit_money(new.amount) || ')', '')
      || coalesce('. ' || nullif(trim(coalesce(new.note, '')), ''), ''),
    'fee', new.rental_ref, bref, null,
    jsonb_strip_nulls(jsonb_build_object('status', new.old_status)),
    jsonb_strip_nulls(jsonb_build_object('status', new.new_status, 'amount', new.amount, 'note', new.note)));
  return null;
exception when others then
  raise warning 'audit_log: trigger % failed: %', tg_name, sqlerrm;
  return null;
end $$;

-- ---- money: Owner defers a fee / lifts the booking block (damage_block_override, file 64) -----------------------------
-- 'waive' rows are skipped on purpose: the waiver is already recorded by damage_charge_log / late_fee_log ('Waived').
create or replace function public.audit_trg_fee_override() returns trigger
language plpgsql security definer set search_path = public as $$
declare cust text; act text; what text;
begin
  if auth.uid() is null or not public.is_staff() then return null; end if;
  select coalesce(nullif(trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''), 'a customer') into cust
    from public.customer c where c.customer_id = new.customer_id;
  cust := coalesce(cust, 'a customer');

  if tg_op = 'INSERT' then
    if new.kind = 'defer' then
      act := 'fee.deferred';
      what := 'Deferred the unpaid fees' || coalesce(' of ' || new.rental_ref, '') || ' for ' || cust || ' until ' || public.audit_when(new.until_at);
    elsif new.kind = 'lift' then
      act := 'fee.block_lifted';
      what := 'Lifted the booking block for ' || cust || case when new.until_at is null then '' else ' until ' || public.audit_when(new.until_at) end;
    else
      return null;
    end if;
  else
    if new.revoked_at is null or old.revoked_at is not null then return null; end if;
    act := 'fee.override_revoked';
    what := 'Cancelled the ' || new.kind || ' override for ' || cust;
  end if;

  perform public.audit_write(act, 'Money overrides',
    what || coalesce('. Reason: ' || nullif(trim(coalesce(new.reason, '')), ''), ''),
    'fee', new.rental_ref, null, cust, null,
    jsonb_strip_nulls(jsonb_build_object('kind', new.kind, 'amount', new.amount, 'until_at', new.until_at, 'reason', new.reason, 'customer', cust)));
  return null;
exception when others then
  raise warning 'audit_log: trigger % failed: %', tg_name, sqlerrm;
  return null;
end $$;

-- ---- no-show held / released, check-in (existing log table booking_event, file 78 and 87) ------------------------------
-- Only lines written by a staff member (by_user_id set). 'System' and 'Customer' lines are not staff actions.
create or replace function public.audit_trg_booking_event() returns trigger
language plpgsql security definer set search_path = public as $$
declare bref text; act text; cat text; studio text;
begin
  if new.by_user_id is null or auth.uid() is null or not public.is_staff() then return null; end if;
  select b.booking_ref, s.name into bref, studio
    from public.booking b left join public.studio s on s.studio_id = b.studio_id
   where b.booking_id = new.booking_id;
  act := case when new.action = 'No-show' then 'noshow.released'
              when new.action like 'Held % more min' then 'noshow.held'
              when new.action = 'Checked in' then 'booking.checked_in'
              when new.action = 'Check-in undone' then 'booking.checkin_undone'
              else 'booking.event' end;
  cat := case when act like 'noshow.%' then 'Money overrides' else 'Bookings' end;
  perform public.audit_write(act, cat,
    case act when 'noshow.released' then 'Released booking ' || coalesce(bref, '') || ' as a no-show'
             when 'noshow.held' then 'Held booking ' || coalesce(bref, '') || ' longer (' || new.action || ')'
             when 'booking.checked_in' then 'Checked in the customer of booking ' || coalesce(bref, '')
             when 'booking.checkin_undone' then 'Undid the check-in of booking ' || coalesce(bref, '')
             else new.action || ' on booking ' || coalesce(bref, '') end
      || coalesce('. ' || nullif(trim(coalesce(new.note, '')), ''), ''),
    'booking', bref, null, studio, null, jsonb_strip_nulls(jsonb_build_object('event', new.action, 'note', new.note)));
  return null;
exception when others then
  raise warning 'audit_log: trigger % failed: %', tg_name, sqlerrm;
  return null;
end $$;

-- ---- customers: reputation flag note / dismissed / restored (existing log table incident_review_log, file 64 and 82) ----
create or replace function public.audit_trg_flag_log() returns trigger
language plpgsql security definer set search_path = public as $$
declare rref text; act text; cust text;
begin
  if new.by_user_id is null or auth.uid() is null or not public.is_staff() then return null; end if;
  if new.incident_kind = 'late' then
    select ro.rental_ref into rref from public.rental_order ro where ro.rental_order_id = new.ref_id;
  elsif new.incident_kind = 'damage' then
    select ro.rental_ref into rref
      from public.damage_charge c join public.rental_order ro on ro.rental_order_id = c.rental_order_id
     where c.damage_charge_id = new.ref_id;
  elsif new.incident_kind = 'noshow' then
    select b.booking_ref into rref
      from public.booking_event e join public.booking b on b.booking_id = e.booking_id
     where e.event_id = new.ref_id;
  end if;
  select nullif(trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), '') into cust
    from public.customer c where c.customer_id = new.customer_id;
  act := 'flag.' || regexp_replace(lower(trim(new.action)), '[^a-z0-9]+', '_', 'g');
  perform public.audit_write(act, 'Customers',
    case new.action when 'Note' then 'Added a note to the ' || new.incident_kind || ' flag'
                    when 'Dismissed' then 'Dismissed the ' || new.incident_kind || ' flag'
                    when 'Restored' then 'Counted the ' || new.incident_kind || ' flag again'
                    else new.action || ' (' || new.incident_kind || ' flag)' end
      || coalesce(' of ' || cust, '') || coalesce(' (' || rref || ')', '')
      || coalesce('. ' || nullif(trim(coalesce(new.note, '')), ''), ''),
    'flag', rref, null, cust, null, jsonb_strip_nulls(jsonb_build_object('kind', new.incident_kind, 'note', new.note)));
  return null;
exception when others then
  raise warning 'audit_log: trigger % failed: %', tg_name, sqlerrm;
  return null;
end $$;

-- ---- settings: studio rates and data (Owner) -------------------------------------------------------------------------
create or replace function public.audit_trg_studio() returns trigger
language plpgsql security definer set search_path = public as $$
declare d jsonb;
begin
  if auth.uid() is null or not public.is_staff() then return null; end if;
  if tg_op = 'INSERT' then
    perform public.audit_write('studio.created', 'Settings', 'Added studio ' || new.name || ' at ' || public.audit_money(new.hourly_rate) || ' per hour',
      'studio', null, null, new.name, null, public.audit_clean(to_jsonb(new)));
  elsif tg_op = 'DELETE' then
    perform public.audit_write('studio.deleted', 'Settings', 'Deleted studio ' || old.name,
      'studio', null, null, old.name, public.audit_clean(to_jsonb(old)), null);
  else
    d := public.audit_diff(to_jsonb(old), to_jsonb(new));
    if d -> 'new' = '{}'::jsonb then return null; end if;
    if d -> 'new' ? 'hourly_rate' then
      perform public.audit_write('studio.rate_changed', 'Settings',
        'Changed the hourly rate of ' || new.name || ' from ' || public.audit_money(old.hourly_rate) || ' to ' || public.audit_money(new.hourly_rate),
        'studio', null, null, new.name, d -> 'old', d -> 'new');
    else
      perform public.audit_write('studio.updated', 'Settings', 'Updated studio ' || new.name || ' (' || public.audit_changes_text(d) || ')',
        'studio', null, null, new.name, d -> 'old', d -> 'new');
    end if;
  end if;
  return null;
exception when others then
  raise warning 'audit_log: trigger % failed: %', tg_name, sqlerrm;
  return null;
end $$;

-- ---- settings: equipment price and stock changes ---------------------------------------------------------------------
create or replace function public.audit_trg_equipment() returns trigger
language plpgsql security definer set search_path = public as $$
declare o jsonb; n jsonb; price jsonb; stock jsonb; other jsonb;
begin
  if auth.uid() is null or not public.is_staff() then return null; end if;
  if tg_op = 'INSERT' then
    perform public.audit_write('equipment.created', 'Settings', 'Added equipment ' || new.name || ' (stock ' || new.total_quantity || ')',
      'equipment', null, null, new.name, null, public.audit_clean(to_jsonb(new)));
  elsif tg_op = 'DELETE' then
    perform public.audit_write('equipment.deleted', 'Settings', 'Deleted equipment ' || old.name,
      'equipment', null, null, old.name, public.audit_clean(to_jsonb(old)), null);
  else
    o := to_jsonb(old);
    n := to_jsonb(new);
    price := public.audit_diff(o, n, array['add_on_rate', 'outside_rate']);
    stock := public.audit_diff(o, n, array['total_quantity', 'owned_quantity', 'out_of_service']);
    other := public.audit_diff(o, n, null, array['updated_at', 'sort_order', 'add_on_rate', 'outside_rate', 'total_quantity', 'owned_quantity', 'out_of_service']);
    if price -> 'new' <> '{}'::jsonb then
      perform public.audit_write('equipment.price_changed', 'Settings', 'Changed the price of ' || new.name || ' (' || public.audit_changes_text(price) || ')',
        'equipment', null, null, new.name, price -> 'old', price -> 'new');
    end if;
    if stock -> 'new' <> '{}'::jsonb then
      perform public.audit_write('equipment.stock_changed', 'Settings', 'Changed the stock of ' || new.name || ' (' || public.audit_changes_text(stock) || ')',
        'equipment', null, null, new.name, stock -> 'old', stock -> 'new');
    end if;
    if other -> 'new' <> '{}'::jsonb then
      perform public.audit_write('equipment.updated', 'Settings', 'Updated equipment ' || new.name || ' (' || public.audit_changes_text(other) || ')',
        'equipment', null, null, new.name, other -> 'old', other -> 'new');
    end if;
  end if;
  return null;
exception when others then
  raise warning 'audit_log: trigger % failed: %', tg_name, sqlerrm;
  return null;
end $$;

-- ---- settings: app_setting rows (GCash account name / number, booking rules, no-show grace, ...) ----------------------
create or replace function public.audit_trg_setting() returns trigger
language plpgsql security definer set search_path = public as $$
declare act text; lbl text;
begin
  if auth.uid() is null or not public.is_staff() then return null; end if;
  if tg_op = 'UPDATE' and new.value is not distinct from old.value then return null; end if;
  if tg_op = 'INSERT' and coalesce(new.value, '') = '' then return null; end if;
  act := case when new.key in ('gcash_account_name', 'gcash_account_number') then 'settings.gcash_account' else 'settings.changed' end;
  lbl := case new.key when 'gcash_account_name' then 'the GCash account name'
                      when 'gcash_account_number' then 'the GCash account number'
                      else 'the setting ' || replace(new.key, '_', ' ') end;
  perform public.audit_write(act, 'Settings',
    'Changed ' || lbl || ' from "' || coalesce(case when tg_op = 'UPDATE' then old.value end, '-') || '" to "' || coalesce(new.value, '-') || '"',
    'setting', null, null, new.key,
    case when tg_op = 'UPDATE' then jsonb_build_object('value', old.value) else null end,
    jsonb_build_object('value', new.value));
  return null;
exception when others then
  raise warning 'audit_log: trigger % failed: %', tg_name, sqlerrm;
  return null;
end $$;

-- ---- staff accounts: created, enabled / disabled, role changed, deleted ---------------------------------------------
-- The create-staff Edge Function inserts with the SERVICE ROLE, so there is no signed-in user in the database for that
-- one insert. When exactly one active Owner exists (the only person allowed to call that function) the entry is credited to
-- the Owner and marked "actor_inferred". Inserts made by a signed-in Owner through the API are credited exactly.
create or replace function public.audit_trg_app_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  actor uuid := auth.uid(); inferred boolean := false; owners int; nm text;
begin
  if actor is null then
    if tg_op <> 'INSERT' then return null; end if;
    select count(*) into owners from public.app_user where role = 'Owner' and status = 'Active';
    if owners <> 1 then return null; end if;
    select auth_user_id into actor from public.app_user where role = 'Owner' and status = 'Active';
    inferred := true;
  elsif not public.is_staff() then
    return null;
  end if;

  if tg_op = 'INSERT' then
    nm := coalesce(nullif(trim(coalesce(new.first_name, '') || ' ' || coalesce(new.last_name, '')), ''), new.username);
    perform public.audit_write_for(actor, 'staff.created', 'Staff accounts',
      'Created the ' || lower(new.role) || ' account of ' || nm || coalesce(' (' || new.email || ')', ''),
      'staff', null, null, nm, null,
      jsonb_strip_nulls(jsonb_build_object('name', nm, 'email', new.email, 'role', new.role, 'status', new.status,
        'actor_inferred', case when inferred then true end)));
  elsif tg_op = 'UPDATE' then
    nm := coalesce(nullif(trim(coalesce(new.first_name, '') || ' ' || coalesce(new.last_name, '')), ''), new.username);
    if new.status is distinct from old.status then
      perform public.audit_write_for(actor, case when new.status = 'Inactive' then 'staff.disabled' else 'staff.enabled' end, 'Staff accounts',
        case when new.status = 'Inactive' then 'Disabled' else 'Enabled' end || ' the account of ' || nm,
        'staff', null, null, nm, jsonb_build_object('status', old.status), jsonb_build_object('status', new.status));
    end if;
    if new.role is distinct from old.role then
      perform public.audit_write_for(actor, 'staff.role_changed', 'Staff accounts',
        'Changed the role of ' || nm || ' from ' || old.role || ' to ' || new.role,
        'staff', null, null, nm, jsonb_build_object('role', old.role), jsonb_build_object('role', new.role));
    end if;
  else
    nm := coalesce(nullif(trim(coalesce(old.first_name, '') || ' ' || coalesce(old.last_name, '')), ''), old.username);
    perform public.audit_write_for(actor, 'staff.deleted', 'Staff accounts', 'Deleted the account of ' || nm,
      'staff', null, null, nm, jsonb_strip_nulls(jsonb_build_object('name', nm, 'email', old.email, 'role', old.role)), null);
  end if;
  return null;
exception when others then
  raise warning 'audit_log: trigger % failed: %', tg_name, sqlerrm;
  return null;
end $$;

-- ---- settings: GCash QR image replaced (Storage object studio-images/payment/gcash-qr) ------------------------------------
create or replace function public.audit_trg_gcash_qr() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.bucket_id <> 'studio-images' or new.name <> 'payment/gcash-qr' then return null; end if;
  if auth.uid() is null or not public.is_staff() then return null; end if;
  if tg_op = 'UPDATE' and coalesce(old.metadata ->> 'eTag', '') = coalesce(new.metadata ->> 'eTag', '') then return null; end if;   -- not a new file
  if exists (select 1 from public.audit_log l where l.action = 'settings.gcash_qr' and l.created_at > now() - interval '20 seconds') then return null; end if;   -- an upsert can fire twice
  perform public.audit_write('settings.gcash_qr', 'Settings', 'Uploaded a new GCash payment QR code',
    'setting', null, null, 'GCash QR code', null,
    jsonb_strip_nulls(jsonb_build_object('path', new.name, 'size_bytes', new.metadata ->> 'size', 'type', new.metadata ->> 'mimetype')));
  return null;
exception when others then
  raise warning 'audit_log: trigger % failed: %', tg_name, sqlerrm;
  return null;
end $$;

-- ---- sign-ins of staff and owner ---------------------------------------------------------------------------------------
-- Supabase Auth stamps auth.users.last_sign_in_at on every password sign-in (not on token refresh). This trigger reads that
-- change, so no browser code is involved. It never raises, so it can never block a login.
create or replace function public.audit_trg_login() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.last_sign_in_at is null or new.last_sign_in_at is not distinct from old.last_sign_in_at then return null; end if;
  if exists (select 1 from public.audit_log l join public.app_user u on u.user_id = l.actor_user_id
              where u.auth_user_id = new.id and l.action = 'auth.login' and l.created_at > now() - interval '60 seconds') then
    return null;
  end if;
  perform public.audit_write_for(new.id, 'auth.login', 'Sign-ins', 'Signed in to the dashboard', 'auth', null, null, null,
    null, jsonb_build_object('signed_in_at', new.last_sign_in_at));
  return null;
exception when others then
  return null;
end $$;


-- =====================================================================
-- BLOCK 4. Attach the triggers. A table that does not exist yet (its migration was not run) is skipped with a notice.
-- =====================================================================
do $$
declare r record;
begin
  for r in
    select * from (values
      ('payment',              'trg_audit_payment',      'after insert or update',            'audit_trg_payment'),
      ('booking',              'trg_audit_booking',      'after insert or update',            'audit_trg_booking'),
      ('rental_order',         'trg_audit_rental_order', 'after insert or update',            'audit_trg_rental_order'),
      ('rental_detail',        'trg_audit_rental_detail','after update of returned_at',       'audit_trg_rental_detail'),
      ('rental_item_swap',     'trg_audit_swap',         'after insert',                      'audit_trg_swap'),
      ('damage_charge_log',    'trg_audit_damage_log',   'after insert',                      'audit_trg_damage_log'),
      ('late_fee_log',         'trg_audit_late_fee_log', 'after insert',                      'audit_trg_late_fee_log'),
      ('damage_block_override','trg_audit_fee_override', 'after insert or update',            'audit_trg_fee_override'),
      ('booking_event',        'trg_audit_booking_event','after insert',                      'audit_trg_booking_event'),
      ('incident_review_log',  'trg_audit_flag_log',     'after insert',                      'audit_trg_flag_log'),
      ('studio',               'trg_audit_studio',       'after insert or update or delete',  'audit_trg_studio'),
      ('equipment',            'trg_audit_equipment',    'after insert or update or delete',  'audit_trg_equipment'),
      ('app_setting',          'trg_audit_setting',      'after insert or update',            'audit_trg_setting'),
      ('app_user',             'trg_audit_app_user',     'after insert or update or delete',  'audit_trg_app_user')
    ) as t(tbl, trg, ev, fn)
  loop
    if to_regclass('public.' || r.tbl) is null then
      raise notice 'Skipped the audit trigger on public.% (table not found). Run its migration, then run this file again.', r.tbl;
      continue;
    end if;
    execute format('drop trigger if exists %I on public.%I', r.trg, r.tbl);
    execute format('create trigger %I %s on public.%I for each row execute function public.%I()', r.trg, r.ev, r.tbl, r.fn);
  end loop;
end $$;

-- balance collected: deferred to commit (see audit_trg_payment_balance)
drop trigger if exists trg_audit_payment_balance on public.payment;
create constraint trigger trg_audit_payment_balance
  after update of balance_paid_amount on public.payment
  deferrable initially deferred
  for each row
  when (new.balance_paid_amount > old.balance_paid_amount)
  execute function public.audit_trg_payment_balance();

-- GCash QR: a trigger on Storage's own table. If this project does not allow it, the rest still works (see the notice).
do $$
begin
  drop trigger if exists trg_audit_gcash_qr on storage.objects;
  create trigger trg_audit_gcash_qr after insert or update on storage.objects
    for each row execute function public.audit_trg_gcash_qr();
exception when others then
  raise notice 'The GCash QR change could not be hooked on storage.objects (%). Everything else is active.', sqlerrm;
end $$;

-- sign-ins: a trigger on Supabase Auth's users table (the project already has one there: on_auth_user_created)
do $$
begin
  drop trigger if exists trg_audit_login on auth.users;
  create trigger trg_audit_login after update of last_sign_in_at on auth.users
    for each row when (new.last_sign_in_at is distinct from old.last_sign_in_at)
    execute function public.audit_trg_login();
exception when others then
  raise notice 'Sign-ins could not be hooked on auth.users (%). Everything else is active.', sqlerrm;
end $$;


-- =====================================================================
-- BLOCK 5. Retention: delete entries older than 12 months, every night (pg_cron)
-- =====================================================================
create or replace function public.audit_purge_old(p_months integer default 12) returns bigint
language plpgsql security definer set search_path = public as $$
declare n bigint;
begin
  if p_months is null or p_months < 1 then
    raise exception 'Keep at least 1 month of audit entries.' using errcode = '22023';
  end if;
  perform set_config('tod.audit_purge', 'on', true);      -- lets audit_log_block_change() allow THIS delete only (transaction-local)
  delete from public.audit_log where created_at < now() - make_interval(months => p_months);
  get diagnostics n = row_count;
  perform set_config('tod.audit_purge', 'off', true);
  return n;
end $$;

-- 03:30 Manila time = 19:30 UTC. If pg_cron cannot be enabled the job is skipped with a notice (see "Dashboard steps").
do $$
begin
  begin
    create extension if not exists pg_cron with schema pg_catalog;
  exception when others then
    raise notice 'pg_cron could not be enabled (%). Enable it under Database > Extensions, then run BLOCK 5 again.', sqlerrm;
  end;
  begin
    perform cron.unschedule(jobid) from cron.job where jobname = 'tod-audit-purge';      -- replace an older copy
    perform cron.schedule('tod-audit-purge', '30 19 * * *', 'select public.audit_purge_old(12)');
  exception when others then
    raise notice 'The retention job was not scheduled (%). You can run  select public.audit_purge_old(12);  by hand now and then.', sqlerrm;
  end;
end $$;


-- =====================================================================
-- BLOCK 6. Lock every audit_* function away from the API (run LAST)
--   New functions in Supabase can be called by anon / authenticated by default. Without this the writer could be called
--   from the browser and a fake entry could be made. Triggers and cron are not affected: they run as the function owner.
-- =====================================================================
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'audit\_%'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
  end loop;
end $$;


-- =====================================================================
-- CHECKS (optional, run by hand)
--   select count(*) from pg_trigger where tgname like 'trg_audit%' and not tgisinternal;      -- 14 on public tables + balance, + qr/login if allowed
--   select * from cron.job where jobname = 'tod-audit-purge';                                  -- the nightly job
--   select policyname, cmd from pg_policies where tablename = 'audit_log';                    -- one policy: SELECT
--   select has_function_privilege('authenticated', 'public.audit_write(text,text,text,text,text,text,text,jsonb,jsonb)', 'execute');   -- false
-- end of 98_audit_log.sql
-- =====================================================================