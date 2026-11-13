-- =====================================================================
-- 64_damage_block_reputation.sql  (safe to re-run)
--
-- FEATURE 1  Customers with an unpaid damage fee cannot book or rent again.
--   * Blocking fees = damage_charge rows with status Unpaid or Pending (GCash sent, staff have not checked it yet)
--     and an amount above 0. Paid and Waived fees never block.
--   * Enforced in the database by BEFORE INSERT triggers on booking and rental_order. Every creation path goes through
--     them: create_booking / create_booking_with_addons, request_rental, request_outside_rental, request_addon_rental,
--     staff_create_onsite_booking, staff_create_onsite_rental (and any direct insert). Those functions are NOT redefined,
--     so their existing behaviour (stock checks, payments, receipts, slot holds) is untouched.
--   * Matching: the same customer row OR any other customer row with the same phone number (last 10 digits, so
--     0917... and +63917... match). That covers guest bookings made with a phone number that belongs to a debtor.
--   * Existing bookings, extensions, reschedules, cancellations and returns are not affected (only INSERTs are checked).
--   * Message for the customer who owes the fee:
--       "You have an unpaid damage fee of (peso sign)X for rental OUT-XXXX. Please pay it before booking or renting again."
--     A guest (or another account) that only matches by phone number gets a generic message with NO amount or rental
--     reference, so nobody can look up what a phone number owes.
--   * The customer pays with the existing GCash flow (customer_pay_damage from 58). my_damage_block() tells the
--     customer pages what to show.
--   * The OWNER can waive a fee, defer it until a date, or lift the block for a customer, always with a reason.
--     Every override is logged (who, when, why) in damage_block_override; defer / lift can be cancelled (also logged).
--
-- FEATURE 2  Customer reputation flags (staff and owner only).
--   * Late return = an Outside rental line returned after its due time (rental_due_at: the same rule the Rentals tab
--     uses for "Returned N hours late"). One incident per rental order. Damage incident = one damage_charge row with a fee.
--   * Only the last 12 months count (late returns and PAID damage fees). An UNPAID damage fee always counts, whatever its age.
--   * Red    : any unpaid damage fee, or 3+ late returns.     Yellow : 1-2 late returns, or a damage fee that is paid.
--   * Staff can add a note to an incident or dismiss it (a note is required to dismiss) so it stops counting.
--     An unpaid damage fee cannot be dismissed (waive it instead). Every note / dismissal is logged with who and when.
--   * Customers can never read any of it: the data lives in new tables with row level security that only lets staff
--     read them, and in staff_* functions that raise "Staff only" for everyone else.
--
-- New tables : damage_block_override, incident_review, incident_review_log
-- New RPCs   : my_damage_block, owner_waive_damage_fee, owner_defer_damage_fee, owner_lift_damage_block,
--              owner_revoke_damage_override, staff_damage_overrides, staff_customer_reputation,
--              staff_customer_incidents, staff_review_incident
-- Internal   : phone_key, damage_peso_text, staff_display_name, damage_block_fees, damage_block_message, guard_unpaid_damage_fee
-- Run once in the Supabase SQL Editor (after 63_out_of_stock_status.sql; 58 must have been run).
-- =====================================================================

-- ---- 0. helpers --------------------------------------------------------------------------------------
-- phone number -> comparable key: the last 10 digits (null when fewer than 7 digits were typed)
drop index if exists public.customer_phone_key_idx;
drop function if exists public.phone_key(text);
create function public.phone_key(p text) returns text
language sql immutable as $$
  select case when length(public.digits(p)) >= 7 then right(public.digits(p), 10) end;
$$;
grant execute on function public.phone_key(text) to anon, authenticated;   -- the index below calls it for every customer insert / update
create index if not exists customer_phone_key_idx on public.customer (public.phone_key(number));

-- 1234.5 -> peso sign + "1,234.50" (the sign is written with chr(8369) so this file stays plain ASCII); whole amounts have no decimals
drop function if exists public.damage_peso_text(numeric);
create function public.damage_peso_text(p numeric) returns text
language sql immutable as $$
  select chr(8369) || regexp_replace(trim(to_char(coalesce(p, 0), 'FM999,999,990.00')), '\.00$', '');
$$;
revoke all on function public.damage_peso_text(numeric) from public, anon, authenticated;

-- name of the signed-in staff member, saved with every log line so the log still reads well if the account is removed later
drop function if exists public.staff_display_name();
create function public.staff_display_name() returns text
language sql stable security definer set search_path = public as $$
  select trim(u.first_name || ' ' || u.last_name) from public.app_user u where u.auth_user_id = auth.uid() and u.status = 'Active';
$$;
revoke all on function public.staff_display_name() from public, anon, authenticated;

-- ---- 1. tables ---------------------------------------------------------------------------------------
-- Owner overrides of the damage-fee block. One row per action; it is both the audit log and the state:
--   waive : the fee was set to 0 (the fee row itself also gets a line in damage_charge_log)
--   defer : the rental's open fees do not block until until_at (they stay owed and the customer stays flagged red)
--   lift  : the customer (and anyone with the same phone number) is not blocked until until_at (null = until cancelled)
create table if not exists public.damage_block_override (
  override_id      bigint generated always as identity primary key,
  kind             text not null,
  customer_id      bigint not null references public.customer (customer_id) on delete cascade,
  rental_order_id  bigint references public.rental_order (rental_order_id) on delete set null,
  rental_ref       text,
  amount           numeric(10,2),
  until_at         timestamptz,
  reason           text not null,
  by_user_id       bigint references public.app_user (user_id) on delete set null,
  by_name          text,
  created_at       timestamptz not null default now(),
  revoked_at       timestamptz,
  revoked_by       bigint references public.app_user (user_id) on delete set null,
  revoked_by_name  text,
  revoke_reason    text,
  constraint damage_block_override_kind_chk   check (kind in ('waive', 'defer', 'lift')),
  constraint damage_block_override_reason_chk check (length(trim(reason)) > 0),
  constraint damage_block_override_defer_chk  check (kind <> 'defer' or until_at is not null)
);
create index if not exists damage_block_override_customer_idx on public.damage_block_override (customer_id, created_at desc);
create index if not exists damage_block_override_order_idx    on public.damage_block_override (rental_order_id) where kind = 'defer' and revoked_at is null;
create index if not exists damage_block_override_lift_idx     on public.damage_block_override (customer_id) where kind = 'lift' and revoked_at is null;

-- Staff notes / dismissals of reputation incidents. incident_kind 'late' -> ref_id is the rental_order_id,
-- 'damage' -> ref_id is the damage_charge_id. (No foreign key: one table serves both kinds.)
create table if not exists public.incident_review (
  incident_kind     text not null,
  ref_id            bigint not null,
  note              text,
  dismissed         boolean not null default false,
  dismissed_at      timestamptz,
  updated_by        bigint references public.app_user (user_id) on delete set null,
  updated_by_name   text,
  updated_at        timestamptz not null default now(),
  primary key (incident_kind, ref_id),
  constraint incident_review_kind_chk check (incident_kind in ('late', 'damage'))
);

create table if not exists public.incident_review_log (
  log_id         bigint generated always as identity primary key,
  incident_kind  text not null,
  ref_id         bigint not null,
  customer_id    bigint,
  action         text not null,         -- Note | Dismissed | Restored
  note           text,
  by_user_id     bigint references public.app_user (user_id) on delete set null,
  by_name        text,
  created_at     timestamptz not null default now()
);
create index if not exists incident_review_log_idx on public.incident_review_log (incident_kind, ref_id, log_id);

-- ---- 2. row level security: STAFF ONLY. Customers (and guests) read nothing here -------------------------
alter table public.damage_block_override enable row level security;
alter table public.incident_review       enable row level security;
alter table public.incident_review_log   enable row level security;

drop policy if exists damage_block_override_select on public.damage_block_override;
create policy damage_block_override_select on public.damage_block_override for select to authenticated using (public.is_staff());
drop policy if exists incident_review_select on public.incident_review;
create policy incident_review_select on public.incident_review for select to authenticated using (public.is_staff());
drop policy if exists incident_review_log_select on public.incident_review_log;
create policy incident_review_log_select on public.incident_review_log for select to authenticated using (public.is_staff());

-- no insert / update / delete policy and no such grant: rows are written only by the functions below
revoke all on public.damage_block_override, public.incident_review, public.incident_review_log from anon, authenticated;
grant select on public.damage_block_override, public.incident_review, public.incident_review_log to authenticated;

-- ---- 3. the block: which fees stop this customer, and what do we tell them -----------------------------
-- One row per rental that still has an open (Unpaid / Pending) fee for this customer or anyone with the same phone number.
-- Returns NOTHING when the block is lifted. Fees of a rental that is deferred (until a future date) are left out.
drop function if exists public.damage_block_fees(bigint, text);
create function public.damage_block_fees(p_customer_id bigint, p_phone text default null)
returns table (f_order_id bigint, f_ref text, f_owner_id bigint, f_unpaid numeric, f_pending numeric, f_first_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare k1 text; k2 text := public.phone_key(p_phone);
begin
  select public.phone_key(c.number) into k1 from public.customer c where c.customer_id = p_customer_id;

  -- an active "lift" for this customer or anyone with the same phone number
  if exists (
    select 1 from public.damage_block_override v
      join public.customer c on c.customer_id = v.customer_id
     where v.kind = 'lift' and v.revoked_at is null and (v.until_at is null or v.until_at > now())
       and (c.customer_id = p_customer_id
            or (k1 is not null and public.phone_key(c.number) = k1)
            or (k2 is not null and public.phone_key(c.number) = k2))
  ) then
    return;
  end if;

  return query
  select o.rental_order_id, o.rental_ref::text, o.customer_id,
         coalesce(sum(dc.amount) filter (where dc.status = 'Unpaid'), 0),
         coalesce(sum(dc.amount) filter (where dc.status = 'Pending'), 0),
         min(dc.created_at)
    from public.damage_charge dc
    join public.rental_order o on o.rental_order_id = dc.rental_order_id
    join public.customer c on c.customer_id = o.customer_id
   where dc.status in ('Unpaid', 'Pending') and dc.amount > 0
     and (c.customer_id = p_customer_id
          or (k1 is not null and public.phone_key(c.number) = k1)
          or (k2 is not null and public.phone_key(c.number) = k2))
     and not exists (select 1 from public.damage_block_override v
                      where v.kind = 'defer' and v.rental_order_id = o.rental_order_id
                        and v.revoked_at is null and v.until_at > now())
   group by o.rental_order_id, o.rental_ref, o.customer_id
   order by min(dc.created_at);
end $$;
revoke all on function public.damage_block_fees(bigint, text) from public, anon, authenticated;

-- The text shown when a booking / rental is refused (null = not blocked). What it says depends on who is asking:
--   the customer who owes the fee : amount + rental reference (the message the customer pages show)
--   staff / owner                 : the same facts, plus what to do about it
--   a guest or another account that only matches by phone number : generic text, no amount, no reference
drop function if exists public.damage_block_message(bigint, text);
create function public.damage_block_message(p_customer_id bigint, p_phone text default null)
returns text
language plpgsql stable security definer set search_path = public as $$
declare
  me     bigint := public.current_customer_id();
  staff  boolean := public.is_staff();
  rows_n int; own_n int;
  unpaid numeric := 0; pend numeric := 0; refs_u text; refs_p text; n_u int; n_p int;
begin
  select count(*) into rows_n from public.damage_block_fees(p_customer_id, p_phone);
  if rows_n = 0 then return null; end if;

  select count(*) into own_n from public.damage_block_fees(p_customer_id, p_phone) f where me is not null and f.f_owner_id = me;

  if not staff and own_n = 0 then
    return 'This phone number has an unpaid damage fee from an earlier rental. Please log in to your account or visit the studio to settle it before booking or renting again.';
  end if;

  select coalesce(sum(f.f_unpaid), 0), coalesce(sum(f.f_pending), 0),
         string_agg(f.f_ref, ', ' order by f.f_first_at) filter (where f.f_unpaid > 0),
         string_agg(f.f_ref, ', ' order by f.f_first_at) filter (where f.f_pending > 0 and f.f_unpaid = 0),
         count(*) filter (where f.f_unpaid > 0),
         count(*) filter (where f.f_pending > 0 and f.f_unpaid = 0)
    into unpaid, pend, refs_u, refs_p, n_u, n_p
    from public.damage_block_fees(p_customer_id, p_phone) f
   where staff or f.f_owner_id = me;

  if unpaid > 0 then
    if staff then
      return 'This customer has ' || case when n_u = 1 then 'an unpaid damage fee' else 'unpaid damage fees' end
        || ' of ' || public.damage_peso_text(unpaid) || ' for ' || case when n_u = 1 then 'rental ' else 'rentals ' end || refs_u
        || '. Collect it first (Rentals, Damage fee) or ask the owner to lift the block.';
    end if;
    return 'You have ' || case when n_u = 1 then 'an unpaid damage fee' else 'unpaid damage fees' end
      || ' of ' || public.damage_peso_text(unpaid) || ' for ' || case when n_u = 1 then 'rental ' else 'rentals ' end || refs_u
      || '. Please pay ' || case when n_u = 1 then 'it' else 'them' end || ' before booking or renting again.';
  end if;

  if staff then
    return 'This customer sent a GCash payment of ' || public.damage_peso_text(pend) || ' for the damage fee on '
      || case when n_p = 1 then 'rental ' else 'rentals ' end || refs_p
      || '. Check it first (Payments) or ask the owner to lift the block.';
  end if;
  return 'Your damage fee payment of ' || public.damage_peso_text(pend) || ' for '
    || case when n_p = 1 then 'rental ' else 'rentals ' end || refs_p
    || ' is waiting for staff to check it. You can book or rent again once it is confirmed.';
end $$;
revoke all on function public.damage_block_message(bigint, text) from public, anon, authenticated;

-- The guard. Runs inside every function that creates a booking or a rental, and for any direct insert.
drop trigger if exists trg_guard_unpaid_damage_booking on public.booking;
drop trigger if exists trg_guard_unpaid_damage_rental  on public.rental_order;
drop function if exists public.guard_unpaid_damage_fee();
create function public.guard_unpaid_damage_fee() returns trigger
language plpgsql security definer set search_path = public as $$
declare msg text; ph text;
begin
  if tg_table_name = 'rental_order' then ph := new.contact_number; end if;   -- the contact number typed for the rental also counts
  msg := public.damage_block_message(new.customer_id, ph);
  if msg is not null then
    raise exception '%', msg using errcode = 'P0001';
  end if;
  return new;
end $$;
revoke all on function public.guard_unpaid_damage_fee() from public, anon, authenticated;

create trigger trg_guard_unpaid_damage_booking before insert on public.booking
  for each row execute function public.guard_unpaid_damage_fee();
create trigger trg_guard_unpaid_damage_rental before insert on public.rental_order
  for each row execute function public.guard_unpaid_damage_fee();

-- ---- 4. customer: "am I blocked, and by what?" (own fees only) -------------------------------------------
-- refs = [{"ref": "OUT-2001", "unpaid": 500, "pending": 0}, ...] only the rentals that belong to THIS account,
-- so the page can offer "Pay now" for each. generic = true when only a phone-number match blocks the account.
drop function if exists public.my_damage_block();
create function public.my_damage_block()
returns table (blocked boolean, message text, owed numeric, waiting numeric, refs jsonb, generic boolean)
language plpgsql stable security definer set search_path = public as $$
declare me bigint := public.current_customer_id(); msg text;
begin
  if me is null then
    return query select false, null::text, 0::numeric, 0::numeric, '[]'::jsonb, false;
    return;
  end if;
  msg := public.damage_block_message(me, null);
  return query
  select msg is not null,
         msg,
         coalesce(sum(f.f_unpaid), 0),
         coalesce(sum(f.f_pending), 0),
         coalesce(jsonb_agg(jsonb_build_object('ref', f.f_ref, 'unpaid', f.f_unpaid, 'pending', f.f_pending) order by f.f_first_at), '[]'::jsonb),
         msg is not null and not exists (select 1 from public.damage_block_fees(me, null) g where g.f_owner_id = me)
    from public.damage_block_fees(me, null) f
   where f.f_owner_id = me;
end $$;
revoke all on function public.my_damage_block() from public, anon;
grant execute on function public.my_damage_block() to authenticated;

-- ---- 5. owner overrides (every one is logged; a reason is required) --------------------------------------
-- 5a. waive the open fees of a rental (their amount becomes 0, status Waived)
drop function if exists public.owner_waive_damage_fee(text, text);
create function public.owner_waive_damage_fee(p_rental_ref text, p_reason text)
returns numeric
language plpgsql security definer set search_path = public as $$
declare
  o public.rental_order; r record; total numeric := 0; why text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if not public.is_owner() then raise exception 'Only the owner can waive a damage fee.' using errcode = '42501'; end if;
  if why is null then raise exception 'Write the reason for waiving this damage fee.' using errcode = 'P0001'; end if;
  select * into o from public.rental_order where rental_ref = upper(trim(p_rental_ref)) for update;
  if not found then raise exception 'Rental not found.' using errcode = 'P0001'; end if;
  if exists (select 1 from public.damage_charge where rental_order_id = o.rental_order_id and status = 'Pending') then
    raise exception 'The customer sent a GCash payment for this rental. Verify or reject it first.' using errcode = 'P0001';
  end if;
  for r in select * from public.damage_charge where rental_order_id = o.rental_order_id and status = 'Unpaid' and amount > 0 for update loop
    update public.damage_charge set amount = 0, status = 'Waived', updated_at = now() where damage_charge_id = r.damage_charge_id;
    perform public.damage_log(r.damage_charge_id, 'Waived', r.amount, 0, 'Unpaid', 'Waived', 'Owner waived: ' || why);
    total := total + r.amount;
  end loop;
  if total <= 0 then raise exception 'There is no unpaid damage fee on this rental.' using errcode = 'P0001'; end if;
  insert into public.damage_block_override (kind, customer_id, rental_order_id, rental_ref, amount, reason, by_user_id, by_name)
  values ('waive', o.customer_id, o.rental_order_id, o.rental_ref, total, why, public.current_app_user_id(), public.staff_display_name());
  return total;
end $$;
revoke all on function public.owner_waive_damage_fee(text, text) from public, anon;
grant execute on function public.owner_waive_damage_fee(text, text) to authenticated;

-- 5b. defer: the open fees of a rental stop blocking until a date (at most one year ahead). They stay owed.
drop function if exists public.owner_defer_damage_fee(text, timestamptz, text);
create function public.owner_defer_damage_fee(p_rental_ref text, p_until timestamptz, p_reason text)
returns numeric
language plpgsql security definer set search_path = public as $$
declare
  o public.rental_order; total numeric; why text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if not public.is_owner() then raise exception 'Only the owner can defer a damage fee.' using errcode = '42501'; end if;
  if why is null then raise exception 'Write the reason for deferring this damage fee.' using errcode = 'P0001'; end if;
  if p_until is null or p_until <= now() then raise exception 'Choose a date in the future.' using errcode = 'P0001'; end if;
  if p_until > now() + interval '1 year' then raise exception 'A fee can be deferred for one year at most.' using errcode = 'P0001'; end if;
  select * into o from public.rental_order where rental_ref = upper(trim(p_rental_ref)) for update;
  if not found then raise exception 'Rental not found.' using errcode = 'P0001'; end if;
  select coalesce(sum(amount), 0) into total from public.damage_charge
   where rental_order_id = o.rental_order_id and status in ('Unpaid', 'Pending') and amount > 0;
  if total <= 0 then raise exception 'There is no unpaid damage fee on this rental.' using errcode = 'P0001'; end if;
  if exists (select 1 from public.damage_block_override v where v.kind = 'defer' and v.rental_order_id = o.rental_order_id
                and v.revoked_at is null and v.until_at > now()) then
    raise exception 'This fee is already deferred. Cancel that deferral first.' using errcode = 'P0001';
  end if;
  insert into public.damage_block_override (kind, customer_id, rental_order_id, rental_ref, amount, until_at, reason, by_user_id, by_name)
  values ('defer', o.customer_id, o.rental_order_id, o.rental_ref, total, p_until, why, public.current_app_user_id(), public.staff_display_name());
  return total;
end $$;
revoke all on function public.owner_defer_damage_fee(text, timestamptz, text) from public, anon;
grant execute on function public.owner_defer_damage_fee(text, timestamptz, text) to authenticated;

-- 5c. lift the block for a customer (p_until null = until the owner cancels it). Only while the customer is blocked.
drop function if exists public.owner_lift_damage_block(bigint, timestamptz, text);
create function public.owner_lift_damage_block(p_customer_id bigint, p_until timestamptz, p_reason text)
returns void
language plpgsql security definer set search_path = public as $$
declare why text := nullif(trim(coalesce(p_reason, '')), ''); total numeric;
begin
  if not public.is_owner() then raise exception 'Only the owner can lift the block.' using errcode = '42501'; end if;
  if why is null then raise exception 'Write the reason for lifting the block.' using errcode = 'P0001'; end if;
  if not exists (select 1 from public.customer where customer_id = p_customer_id) then
    raise exception 'Customer not found.' using errcode = 'P0001';
  end if;
  if p_until is not null and p_until <= now() then raise exception 'Choose a date in the future.' using errcode = 'P0001'; end if;
  if p_until is not null and p_until > now() + interval '1 year' then raise exception 'The block can be lifted for one year at most.' using errcode = 'P0001'; end if;
  select coalesce(sum(f.f_unpaid + f.f_pending), 0) into total from public.damage_block_fees(p_customer_id, null) f;
  if total <= 0 then raise exception 'This customer is not blocked.' using errcode = 'P0001'; end if;
  insert into public.damage_block_override (kind, customer_id, amount, until_at, reason, by_user_id, by_name)
  values ('lift', p_customer_id, total, p_until, why, public.current_app_user_id(), public.staff_display_name());
end $$;
revoke all on function public.owner_lift_damage_block(bigint, timestamptz, text) from public, anon;
grant execute on function public.owner_lift_damage_block(bigint, timestamptz, text) to authenticated;

-- 5d. cancel a deferral or a lift (a waiver cannot be undone)
drop function if exists public.owner_revoke_damage_override(bigint, text);
create function public.owner_revoke_damage_override(p_override_id bigint, p_reason text)
returns void
language plpgsql security definer set search_path = public as $$
declare v public.damage_block_override; why text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if not public.is_owner() then raise exception 'Only the owner can cancel an override.' using errcode = '42501'; end if;
  if why is null then raise exception 'Write the reason for cancelling this override.' using errcode = 'P0001'; end if;
  select * into v from public.damage_block_override where override_id = p_override_id for update;
  if not found then raise exception 'Override not found.' using errcode = 'P0001'; end if;
  if v.kind = 'waive' then raise exception 'A waived fee cannot be brought back here. Add a new damage fee from the rental instead.' using errcode = 'P0001'; end if;
  if v.revoked_at is not null then raise exception 'This override was already cancelled.' using errcode = 'P0001'; end if;
  update public.damage_block_override
     set revoked_at = now(), revoked_by = public.current_app_user_id(), revoked_by_name = public.staff_display_name(), revoke_reason = why
   where override_id = v.override_id;
end $$;
revoke all on function public.owner_revoke_damage_override(bigint, text) from public, anon;
grant execute on function public.owner_revoke_damage_override(bigint, text) to authenticated;

-- 5e. the override log for one customer (and anyone with the same phone number), newest first; staff and owner may read it
drop function if exists public.staff_damage_overrides(bigint);
create function public.staff_damage_overrides(p_customer_id bigint default null)
returns table (
  override_id bigint, kind text, customer_id bigint, customer_name text, rental_ref text, amount numeric, until_at timestamptz,
  reason text, by_name text, created_at timestamptz, revoked_at timestamptz, revoked_by_name text, revoke_reason text, active boolean
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare k text;
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  if p_customer_id is not null then
    select public.phone_key(c.number) into k from public.customer c where c.customer_id = p_customer_id;
  end if;
  return query
  select v.override_id, v.kind, v.customer_id, trim(c.first_name || ' ' || c.last_name), v.rental_ref, v.amount, v.until_at,
         v.reason, v.by_name, v.created_at, v.revoked_at, v.revoked_by_name, v.revoke_reason,
         (v.kind <> 'waive' and v.revoked_at is null and (v.until_at is null or v.until_at > now()))
    from public.damage_block_override v
    join public.customer c on c.customer_id = v.customer_id
   where p_customer_id is null
      or v.customer_id = p_customer_id
      or (k is not null and public.phone_key(c.number) = k)
   order by v.created_at desc, v.override_id desc
   limit 200;
end $$;
revoke all on function public.staff_damage_overrides(bigint) from public, anon;
grant execute on function public.staff_damage_overrides(bigint) to authenticated;

-- ---- 6. reputation (staff / owner only) ---------------------------------------------------------------
-- One row for every customer who has something to show. People who share a phone number are treated as one person,
-- the same way the block treats them, so the flag and the block always agree.
drop function if exists public.staff_customer_reputation();
create function public.staff_customer_reputation()
returns table (
  customer_id bigint, late_count integer, damage_unpaid integer, damage_paid integer, unpaid_amount numeric,
  flag text, summary text, blocked boolean, block_amount numeric, block_fees jsonb, lifted boolean, lift_until timestamptz
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  return query
  with cust as (
    select c.customer_id as cid, coalesce(public.phone_key(c.number), 'c' || c.customer_id::text) as gk from public.customer c
  ),
  late as (
    select o.customer_id as cid, o.rental_order_id as ref_id, max(d.returned_at) as occ
      from public.rental_order o
      join public.rental_detail d on d.rental_order_id = o.rental_order_id
     where o.rental_type = 'Outside' and d.returned_at is not null
       and d.returned_at > public.rental_due_at(o.pickup_date, o.return_date)
     group by o.customer_id, o.rental_order_id
  ),
  dmg as (
    select o.customer_id as cid, dc.damage_charge_id as ref_id, dc.created_at as occ, dc.status
      from public.damage_charge dc
      join public.rental_order o on o.rental_order_id = dc.rental_order_id
     where dc.status in ('Unpaid', 'Pending', 'Paid') and dc.amount > 0
  ),
  inc as (
    select cu.gk, 'late'::text as kind, l.ref_id, l.occ, null::text as status, coalesce(r.dismissed, false) as dis
      from late l join cust cu on cu.cid = l.cid
      left join public.incident_review r on r.incident_kind = 'late' and r.ref_id = l.ref_id
    union all
    select cu.gk, 'damage'::text, m.ref_id, m.occ, m.status::text, coalesce(r.dismissed, false)
      from dmg m join cust cu on cu.cid = m.cid
      left join public.incident_review r on r.incident_kind = 'damage' and r.ref_id = m.ref_id
  ),
  agg as (
    select i.gk,
           (count(*) filter (where i.kind = 'late' and not i.dis and i.occ >= now() - interval '12 months'))::int as late_n,
           (count(*) filter (where i.kind = 'damage' and i.status in ('Unpaid', 'Pending')))::int as unpaid_n,
           (count(*) filter (where i.kind = 'damage' and i.status = 'Paid' and not i.dis and i.occ >= now() - interval '12 months'))::int as paid_n
      from inc i group by i.gk
  ),
  fee as (
    select cu.gk, o.rental_order_id as oid, o.rental_ref::text as ref, dc.amount, dc.status, dc.created_at,
           (select max(v.until_at) from public.damage_block_override v
             where v.kind = 'defer' and v.rental_order_id = dc.rental_order_id and v.revoked_at is null and v.until_at > now()) as deferred_until
      from public.damage_charge dc
      join public.rental_order o on o.rental_order_id = dc.rental_order_id
      join cust cu on cu.cid = o.customer_id
     where dc.status in ('Unpaid', 'Pending') and dc.amount > 0
  ),
  feeagg as (
    select f.gk, f.oid, f.ref,
           coalesce(sum(f.amount) filter (where f.status = 'Unpaid'), 0) as unpaid,
           coalesce(sum(f.amount) filter (where f.status = 'Pending'), 0) as pending,
           min(f.created_at) as first_at, max(f.deferred_until) as deferred_until
      from fee f group by f.gk, f.oid, f.ref
  ),
  blk as (
    select g.gk,
           sum(g.unpaid + g.pending) as total_amt,
           coalesce(sum(g.unpaid + g.pending) filter (where g.deferred_until is null), 0) as live_amt,
           count(*) filter (where g.deferred_until is null) as live_n,
           jsonb_agg(jsonb_build_object('ref', g.ref, 'unpaid', g.unpaid, 'pending', g.pending, 'deferred_until', g.deferred_until) order by g.first_at) as fees
      from feeagg g group by g.gk
  ),
  lift as (
    select cu.gk, bool_or(v.until_at is null) as forever, max(v.until_at) as until_at
      from public.damage_block_override v
      join cust cu on cu.cid = v.customer_id
     where v.kind = 'lift' and v.revoked_at is null and (v.until_at is null or v.until_at > now())
     group by cu.gk
  )
  select cu.cid,
         coalesce(a.late_n, 0), coalesce(a.unpaid_n, 0), coalesce(a.paid_n, 0),
         coalesce(b.total_amt, 0),
         case when coalesce(a.unpaid_n, 0) > 0 or coalesce(a.late_n, 0) >= 3 then 'red'
              when coalesce(a.late_n, 0) >= 1 or coalesce(a.paid_n, 0) >= 1 then 'yellow'
              else 'none' end,
         case when coalesce(a.late_n, 0) = 0 and coalesce(a.unpaid_n, 0) + coalesce(a.paid_n, 0) = 0
              then 'No late returns or damage fees in the last 12 months'
              else concat_ws(', ',
                case when coalesce(a.late_n, 0) > 0 then a.late_n || ' late return' || case when a.late_n = 1 then '' else 's' end end,
                case when coalesce(a.unpaid_n, 0) + coalesce(a.paid_n, 0) > 0 then
                  (a.unpaid_n + a.paid_n) || ' damage fee' || case when a.unpaid_n + a.paid_n = 1 then '' else 's' end || ' ('
                  || case when a.unpaid_n > 0 and a.paid_n > 0 then a.unpaid_n || ' unpaid, ' || a.paid_n || ' paid'
                          when a.unpaid_n > 0 then case when a.unpaid_n = 1 then 'unpaid' else a.unpaid_n || ' unpaid' end
                          else case when a.paid_n = 1 then 'paid' else a.paid_n || ' paid' end end
                  || ')' end)
         end,
         (coalesce(b.live_n, 0) > 0 and l.gk is null),
         case when coalesce(b.live_n, 0) > 0 and l.gk is null then b.live_amt else 0 end,
         coalesce(b.fees, '[]'::jsonb),
         (l.gk is not null),
         case when l.forever then null else l.until_at end
    from cust cu
    left join agg a on a.gk = cu.gk
    left join blk b on b.gk = cu.gk
    left join lift l on l.gk = cu.gk
   where a.gk is not null or b.gk is not null;
end $$;
revoke all on function public.staff_customer_reputation() from public, anon;
grant execute on function public.staff_customer_reputation() to authenticated;

-- The incidents behind one customer's flag (late returns and damage fees, counted or not), newest first.
drop function if exists public.staff_customer_incidents(bigint);
create function public.staff_customer_incidents(p_customer_id bigint)
returns table (
  incident_kind text, ref_id bigint, rental_ref text, customer_id bigint, customer_name text, occurred_at timestamptz,
  detail text, status text, amount numeric, counts boolean, dismissed boolean, note text,
  reviewed_by text, reviewed_at timestamptz, history jsonb
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare k text;
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  select coalesce(public.phone_key(c.number), 'c' || c.customer_id::text) into k from public.customer c where c.customer_id = p_customer_id;
  if k is null then return; end if;

  return query
  with grp as (
    select c.customer_id as cid, trim(c.first_name || ' ' || c.last_name) as nm from public.customer c
     where coalesce(public.phone_key(c.number), 'c' || c.customer_id::text) = k
  ),
  late as (
    select o.rental_order_id, o.rental_ref::text as ref, g.cid, g.nm,
           max(d.returned_at) as occ,
           ceil(extract(epoch from (max(d.returned_at) - public.rental_due_at(o.pickup_date, o.return_date))) / 3600.0)::int as hrs
      from public.rental_order o
      join public.rental_detail d on d.rental_order_id = o.rental_order_id
      join grp g on g.cid = o.customer_id
     where o.rental_type = 'Outside' and d.returned_at is not null
       and d.returned_at > public.rental_due_at(o.pickup_date, o.return_date)
     group by o.rental_order_id, o.rental_ref, g.cid, g.nm, o.pickup_date, o.return_date
  ),
  rows_all as (
    select 'late'::text as kind, l.rental_order_id as rid, l.ref, l.cid, l.nm, l.occ,
           'Returned ' || l.hrs || case when l.hrs = 1 then ' hour late' else ' hours late' end as detail,
           null::text as status, null::numeric as amount
      from late l
    union all
    select 'damage'::text, dc.damage_charge_id, o.rental_ref::text, g.cid, g.nm, dc.created_at,
           e.name || ' (' || dc.condition || ')' || coalesce(': ' || nullif(trim(dc.reason), ''), ''),
           dc.status::text, dc.amount
      from public.damage_charge dc
      join public.rental_order o on o.rental_order_id = dc.rental_order_id
      join public.rental_detail d on d.rental_detail_id = dc.rental_detail_id
      join public.equipment e on e.equipment_id = d.equipment_id
      join grp g on g.cid = o.customer_id
  )
  select x.kind, x.rid, x.ref, x.cid, x.nm, x.occ, x.detail, x.status, x.amount,
         case when x.kind = 'late' then (not coalesce(r.dismissed, false)) and x.occ >= now() - interval '12 months'
              when x.status in ('Unpaid', 'Pending') then true
              when x.status = 'Paid' then (not coalesce(r.dismissed, false)) and x.occ >= now() - interval '12 months'
              else false end,
         coalesce(r.dismissed, false), r.note, r.updated_by_name, r.updated_at,
         coalesce((select jsonb_agg(jsonb_build_object('action', l.action, 'note', l.note, 'by', l.by_name, 'at', l.created_at) order by l.log_id)
                     from public.incident_review_log l where l.incident_kind = x.kind and l.ref_id = x.rid), '[]'::jsonb)
    from rows_all x
    left join public.incident_review r on r.incident_kind = x.kind and r.ref_id = x.rid
   order by x.occ desc;
end $$;
revoke all on function public.staff_customer_incidents(bigint) from public, anon;
grant execute on function public.staff_customer_incidents(bigint) to authenticated;

-- Add a note to an incident and / or dismiss it (so it stops counting) or bring it back.
--   p_note    : null = leave the note alone, text = save it ('' clears it)
--   p_dismiss : null = leave as is, true = dismiss (a note is required), false = count it again
drop function if exists public.staff_review_incident(text, bigint, text, boolean);
create function public.staff_review_incident(p_kind text, p_ref_id bigint, p_note text default null, p_dismiss boolean default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  cid bigint; st text; cur public.incident_review; note_new text; dis_new boolean;
  uid bigint := public.current_app_user_id(); nm text := public.staff_display_name();
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  if p_kind not in ('late', 'damage') then raise exception 'Unknown incident type.' using errcode = 'P0001'; end if;
  if p_note is null and p_dismiss is null then raise exception 'Write a note or choose to dismiss the incident.' using errcode = 'P0001'; end if;

  if p_kind = 'late' then
    select o.customer_id into cid from public.rental_order o
     where o.rental_order_id = p_ref_id and o.rental_type = 'Outside'
       and exists (select 1 from public.rental_detail d where d.rental_order_id = o.rental_order_id and d.returned_at is not null
                      and d.returned_at > public.rental_due_at(o.pickup_date, o.return_date));
  else
    select o.customer_id, dc.status into cid, st from public.damage_charge dc
      join public.rental_order o on o.rental_order_id = dc.rental_order_id where dc.damage_charge_id = p_ref_id;
  end if;
  if cid is null then raise exception 'Incident not found.' using errcode = 'P0001'; end if;

  select * into cur from public.incident_review where incident_kind = p_kind and ref_id = p_ref_id for update;
  note_new := case when p_note is null then cur.note else nullif(trim(p_note), '') end;
  dis_new  := coalesce(p_dismiss, coalesce(cur.dismissed, false));

  if dis_new and not coalesce(cur.dismissed, false) then
    if p_kind = 'damage' and st in ('Unpaid', 'Pending') then
      raise exception 'This damage fee is still unpaid, so it cannot be dismissed. Ask the owner to waive it or lift the block.' using errcode = 'P0001';
    end if;
    if note_new is null then raise exception 'Write a note saying why you are dismissing this incident.' using errcode = 'P0001'; end if;
  end if;

  insert into public.incident_review (incident_kind, ref_id, note, dismissed, dismissed_at, updated_by, updated_by_name, updated_at)
  values (p_kind, p_ref_id, note_new, dis_new, case when dis_new then now() end, uid, nm, now())
  on conflict (incident_kind, ref_id) do update
    set note = excluded.note, dismissed = excluded.dismissed,
        dismissed_at = case when excluded.dismissed then coalesce(public.incident_review.dismissed_at, now()) end,
        updated_by = excluded.updated_by, updated_by_name = excluded.updated_by_name, updated_at = now();

  if p_note is not null and note_new is distinct from cur.note then
    insert into public.incident_review_log (incident_kind, ref_id, customer_id, action, note, by_user_id, by_name)
    values (p_kind, p_ref_id, cid, 'Note', note_new, uid, nm);
  end if;
  if dis_new is distinct from coalesce(cur.dismissed, false) then
    insert into public.incident_review_log (incident_kind, ref_id, customer_id, action, note, by_user_id, by_name)
    values (p_kind, p_ref_id, cid, case when dis_new then 'Dismissed' else 'Restored' end, note_new, uid, nm);
  end if;
end $$;
revoke all on function public.staff_review_incident(text, bigint, text, boolean) from public, anon;
grant execute on function public.staff_review_incident(text, bigint, text, boolean) to authenticated;

-- end of 64_damage_block_reputation.sql
