-- =====================================================================
-- 78_no_show_release.sql  (safe to re-run)
-- No-show release for studio bookings that still owe a balance.
--
--   * A confirmed (Approved) booking with a balance due is held for a grace period after its start time
--     (default 15 minutes, owner-changeable in app_setting 'no_show_grace_minutes').
--   * If the customer has not paid the balance and started the session by then, the database cancels the
--     booking by itself (cancelled_reason 'No-show: ...') and the time slot is free for other clients.
--   * ADD-ONS ARE RELEASED WITH THE BOOKING: whenever a booking becomes Cancelled (no-show, customer,
--     or staff), its Pending and Approved add-on orders are Cancelled too, so their equipment is free
--     again. Before this file only Pending add-ons were closed; Approved add-ons kept holding stock.
--   * The payments already made are NOT refunded (the terms say the down payment is non-refundable).
--   * Staff can hold a booking longer (staff_hold_booking: staff once, owner up to 3 times) before the deadline,
--     because a Cancelled booking cannot be brought back. Staff can also release it at once (staff_release_booking).
--   * Every hold / release is written to booking_event, which feeds the booking's History on the admin page, and
--     staff_no_show_counts() gives the no-shows of the last 12 months per customer (people sharing a phone number count together).
--   * Only bookings with a balance due are released. Fully paid bookings are not touched.
--
--   * Customer side: customer_running_late(ref) gives the signed-in customer ONE extra 15 minutes (from 2 hours before the
--     start until the release time); my_booking_release() gives them the release time of their confirmed bookings with a
--     balance due and tells which cancelled bookings were no-shows (for "Slot released at 3:15 PM" and "Book again").
--
-- Run once in the Supabase SQL Editor, after 77_equipment_sort_order.sql.
-- start_due_sessions() (pg_cron, file 49) calls the release every 30 seconds: no new cron job.
-- =====================================================================

-- 1. Settings: grace minutes ---------------------------------------------------------------------------------
create table if not exists public.app_setting (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
alter table public.app_setting enable row level security;
drop policy if exists app_setting_staff_read on public.app_setting;
create policy app_setting_staff_read on public.app_setting for select to authenticated using (public.is_staff());
drop policy if exists app_setting_owner_write on public.app_setting;
create policy app_setting_owner_write on public.app_setting for all to authenticated
  using (public.is_owner()) with check (public.is_owner());
insert into public.app_setting (key, value) values ('no_show_grace_minutes', '15') on conflict (key) do nothing;

create or replace function public.no_show_grace_minutes() returns integer
language sql stable security definer set search_path = public as $$
  select greatest(5, least(120, coalesce(
    (select nullif(trim(value), '')::int from public.app_setting where key = 'no_show_grace_minutes'), 15)));
$$;
revoke all on function public.no_show_grace_minutes() from public;
grant execute on function public.no_show_grace_minutes() to anon, authenticated;   -- not secret: the booking terms show it, also to guests

-- 2. Booking columns for a staff hold ------------------------------------------------------------------------
alter table public.booking add column if not exists hold_until timestamptz;
alter table public.booking add column if not exists hold_count smallint not null default 0;
alter table public.booking add column if not exists hold_note  text;
alter table public.booking add column if not exists customer_late_used boolean not null default false;   -- the customer's one "I'm running late" 

-- 2b. Booking events (audit log shown in the booking's History) --------------------------------------------------
create table if not exists public.booking_event (
  event_id    bigint generated always as identity primary key,
  booking_id  bigint not null references public.booking (booking_id) on delete cascade,
  at          timestamptz not null default now(),
  action      text not null,
  note        text,
  by_user_id  bigint references public.app_user (user_id) on delete set null,
  by_name     text
);
create index if not exists booking_event_booking_idx on public.booking_event (booking_id, at);
create index if not exists booking_event_noshow_idx  on public.booking_event (at) where action = 'No-show';
alter table public.booking_event enable row level security;
drop policy if exists booking_event_staff_read on public.booking_event;
create policy booking_event_staff_read on public.booking_event for select to authenticated using (public.is_staff());
-- no insert / update / delete policy: rows are written only by the functions below

-- 3. When is a booking released? -------------------------------------------------------------------------------
--    start time (or, for a last-minute booking, when its payment was verified, whichever is later) + grace,
--    or the staff hold if that is later.
create or replace function public.booking_release_at(p_booking_id bigint) returns timestamptz
language sql stable security definer set search_path = public as $$
  select greatest(
           base.v + make_interval(mins => public.no_show_grace_minutes()),
           coalesce(b.hold_until, base.v))
    from public.booking b
    cross join lateral (
      select greatest(b.start_at,
                      coalesce((select max(coalesce(p.verified_at, p.created_at)) from public.payment p
                                 where p.booking_id = b.booking_id and p.status = 'Verified'), b.start_at)) as v) base
   where b.booking_id = p_booking_id;
$$;
revoke all on function public.booking_release_at(bigint) from public, anon, authenticated;

-- Readable by staff, or by the customer who owns the booking (for the "slot held until" line)
create or replace function public.booking_release_time(p_booking_ref text) returns timestamptz
language plpgsql stable security definer set search_path = public as $$
declare b public.booking;
begin
  select * into b from public.booking where booking_ref = upper(trim(p_booking_ref));
  if not found then return null; end if;
  if not public.is_staff() and b.customer_id is distinct from public.current_customer_id() then return null; end if;
  if b.status <> 'Approved' or public.booking_balance_due(b.booking_id) <= 0.005 then return null; end if;
  return public.booking_release_at(b.booking_id);
end $$;
revoke all on function public.booking_release_time(text) from public, anon;
grant execute on function public.booking_release_time(text) to authenticated;

-- 4. A cancelled booking releases its add-ons (any way it was cancelled) -------------------------------------
create or replace function public.booking_cancelled_addons() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'Cancelled' and old.status is distinct from 'Cancelled' then
    -- an unverified add-on payment is rejected, like cancel_booking does for the booking's own payment
    update public.payment set status = 'Rejected'
     where status = 'Pending'
       and rental_order_id in (select ro.rental_order_id from public.rental_order ro
                                where ro.booking_id = new.booking_id and ro.rental_type = 'Add-on'
                                  and ro.status in ('Pending', 'Approved'));
    -- Pending and Approved add-ons are cancelled, so their equipment is free again (Active = already issued: untouched)
    update public.rental_order set status = 'Cancelled'
     where booking_id = new.booking_id and rental_type = 'Add-on' and status in ('Pending', 'Approved');
  end if;
  return null;
end $$;
drop trigger if exists trg_booking_cancelled_addons on public.booking;
create trigger trg_booking_cancelled_addons after update of status on public.booking
  for each row execute function public.booking_cancelled_addons();

-- 5. The no-show release ---------------------------------------------------------------------------------------
create or replace function public.release_no_show_bookings() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer := 0; r record;
begin
  for r in
    select b.booking_id from public.booking b
     where b.status = 'Approved' and b.start_at <= now()
       and public.booking_balance_due(b.booking_id) > 0.005
       and public.booking_release_at(b.booking_id) <= now()
  loop
    begin
      update public.booking
         set status = 'Cancelled',
             cancelled_reason = 'No-show: balance not paid within ' || public.no_show_grace_minutes() || ' minutes of the start time (released automatically). Payments made are non-refundable.'
       where booking_id = r.booking_id and status = 'Approved';   -- the trigger above releases the add-ons
      update public.payment set status = 'Rejected' where booking_id = r.booking_id and status = 'Pending';
      insert into public.booking_event (booking_id, action, note, by_name)
      values (r.booking_id, 'No-show',
              'Balance not paid within ' || public.no_show_grace_minutes() || ' minutes of the start time. Slot and add-ons released automatically. Payments made are non-refundable.',
              'System');
      n := n + 1;
    exception when others then null;   -- leave it for staff, try again on the next run
    end;
  end loop;

  -- catch-up: add-ons still Pending / Approved on a booking that is already Cancelled (older data)
  update public.rental_order ro set status = 'Cancelled'
    from public.booking b
   where b.booking_id = ro.booking_id and b.status = 'Cancelled'
     and ro.rental_type = 'Add-on' and ro.status in ('Pending', 'Approved');
  return n;
end $$;
revoke all on function public.release_no_show_bookings() from public, anon;
grant execute on function public.release_no_show_bookings() to authenticated;

-- 6. Staff: hold a booking longer (the customer called) -------------------------------------------------------------
--    Staff can hold once, the owner up to 3 times. The note is required: it is shown in the booking's History.
create or replace function public.staff_hold_booking(p_booking_ref text, p_minutes integer default 15, p_note text default null)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare b public.booking; m integer := greatest(5, least(60, coalesce(p_minutes, 15))); t timestamptz; max_holds integer;
begin
  if not public.is_staff() then raise exception 'Only staff can hold a booking.' using errcode = '42501'; end if;
  if length(trim(coalesce(p_note, ''))) < 3 then raise exception 'Add a short note (for example: customer called, 10 minutes away).' using errcode = 'P0001'; end if;
  select * into b from public.booking where booking_ref = upper(trim(p_booking_ref)) for update;
  if not found then raise exception 'Booking not found.' using errcode = 'P0001'; end if;
  if b.status <> 'Approved' then raise exception 'Only a confirmed booking that has not started can be held.' using errcode = 'P0001'; end if;
  max_holds := case when public.is_owner() then 3 else 1 end;
  if b.hold_count >= max_holds then
    raise exception 'This booking was already held%.', case when public.is_owner() then '' else '. Ask the owner to hold it again' end using errcode = 'P0001';
  end if;
  if public.booking_release_at(b.booking_id) <= now() then
    raise exception 'The release time has already passed.' using errcode = 'P0001';
  end if;
  t := public.booking_release_at(b.booking_id) + make_interval(mins => m);
  update public.booking set hold_until = t, hold_count = hold_count + 1, hold_note = trim(p_note)
   where booking_id = b.booking_id;
  insert into public.booking_event (booking_id, action, note, by_user_id, by_name)
  values (b.booking_id, 'Held ' || m || ' more min',
          'Release moved to ' || to_char(t at time zone 'Asia/Manila', 'FMHH12:MI AM') || '. ' || trim(p_note),
          public.current_app_user_id(), public.staff_display_name());
  return t;
end $$;
revoke all on function public.staff_hold_booking(text, integer, text) from public, anon;
grant execute on function public.staff_hold_booking(text, integer, text) to authenticated;

-- 6b. Staff: release a booking now (the customer did not come) ------------------------------------------------------
create or replace function public.staff_release_booking(p_booking_ref text, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare b public.booking;
begin
  if not public.is_staff() then raise exception 'Only staff can release a booking.' using errcode = '42501'; end if;
  select * into b from public.booking where booking_ref = upper(trim(p_booking_ref)) for update;
  if not found then raise exception 'Booking not found.' using errcode = 'P0001'; end if;
  if b.status <> 'Approved' or b.start_at > now() then
    raise exception 'Only a confirmed booking whose start time has come can be released as a no-show.' using errcode = 'P0001';
  end if;
  if public.booking_balance_due(b.booking_id) <= 0.005 then
    raise exception 'This booking has no balance due. Start the session or cancel it from Bookings.' using errcode = 'P0001';
  end if;
  update public.booking set status = 'Cancelled',
         cancelled_reason = 'No-show: released by staff. Payments made are non-refundable.'
   where booking_id = b.booking_id;               -- the trigger releases the add-ons
  update public.payment set status = 'Rejected' where booking_id = b.booking_id and status = 'Pending';
  insert into public.booking_event (booking_id, action, note, by_user_id, by_name)
  values (b.booking_id, 'No-show', 'Released by staff. Slot and add-ons released. Payments made are non-refundable.'
          || coalesce(' ' || nullif(trim(p_note), ''), ''), public.current_app_user_id(), public.staff_display_name());
end $$;
revoke all on function public.staff_release_booking(text, text) from public, anon;
grant execute on function public.staff_release_booking(text, text) to authenticated;

-- 6c. For the admin page: release time of every confirmed booking that still owes a balance -------------------------
create or replace function public.staff_release_times()
returns table (booking_ref text, release_at timestamptz, hold_count smallint, hold_note text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  return query
    select b.booking_ref::text, public.booking_release_at(b.booking_id), b.hold_count, b.hold_note
      from public.booking b
     where b.status = 'Approved' and public.booking_balance_due(b.booking_id) > 0.005;
end $$;
revoke all on function public.staff_release_times() from public, anon;
grant execute on function public.staff_release_times() to authenticated;

-- 6d. No-shows of the last 12 months per customer (customers with the same phone number are counted together) --------
create or replace function public.staff_no_show_counts()
returns table (customer_id bigint, no_shows integer, last_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  return query
  with cust as (
    select c.customer_id as cid, coalesce(public.phone_key(c.number), 'c' || c.customer_id::text) as gk from public.customer c
  ), ev as (
    select cu.gk, e.at from public.booking_event e
      join public.booking b on b.booking_id = e.booking_id
      join cust cu on cu.cid = b.customer_id
     where e.action = 'No-show' and e.at >= now() - interval '12 months'
  ), g as (
    select ev.gk, count(*)::int as n, max(ev.at) as last_at from ev group by ev.gk
  )
  select cu.cid, g.n, g.last_at from cust cu join g on g.gk = cu.gk;
end $$;
revoke all on function public.staff_no_show_counts() from public, anon;
grant execute on function public.staff_no_show_counts() to authenticated;

-- 6e. Customer: "I'm running late" (one time, +15 minutes, the session still ends on time) ---------------------------
--     Allowed from 2 hours before the start until the release time, on the customer's own confirmed booking with a balance due.
create or replace function public.customer_running_late(p_booking_ref text) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare b public.booking; t timestamptz;
begin
  select * into b from public.booking where booking_ref = upper(trim(p_booking_ref)) for update;
  if not found or b.customer_id is distinct from public.current_customer_id() then
    raise exception 'That is not your booking.' using errcode = '42501';
  end if;
  if b.status <> 'Approved' or public.booking_balance_due(b.booking_id) <= 0.005 then
    raise exception 'This booking does not need this. It is not waiting for a balance.' using errcode = 'P0001';
  end if;
  if b.customer_late_used then
    raise exception 'You already used your extra 15 minutes. Please call the studio.' using errcode = 'P0001';
  end if;
  if now() < b.start_at - interval '2 hours' then
    raise exception 'You can tell us you are running late from 2 hours before your start time.' using errcode = 'P0001';
  end if;
  if public.booking_release_at(b.booking_id) <= now() then
    raise exception 'Your slot has already been released. Please call the studio.' using errcode = 'P0001';
  end if;
  t := public.booking_release_at(b.booking_id) + interval '15 minutes';
  update public.booking set hold_until = t, customer_late_used = true where booking_id = b.booking_id;
  insert into public.booking_event (booking_id, action, note, by_name)
  values (b.booking_id, 'Customer running late',
          'The customer pressed "I''m running late". Release moved to ' || to_char(t at time zone 'Asia/Manila', 'FMHH12:MI AM') || '. The session still ends at its booked time.',
          'Customer');
  return t;
end $$;
revoke all on function public.customer_running_late(text) from public, anon;
grant execute on function public.customer_running_late(text) to authenticated;

-- 6f. Customer: release time of my confirmed bookings with a balance due, and which cancelled ones were no-shows -----------
create or replace function public.my_booking_release()
returns table (booking_ref text, release_at timestamptz, late_used boolean, no_show boolean, grace_minutes integer)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  return query
    select b.booking_ref::text,
           case when b.status = 'Approved' and public.booking_balance_due(b.booking_id) > 0.005
                then public.booking_release_at(b.booking_id) end,
           b.customer_late_used,
           (b.status = 'Cancelled' and exists (select 1 from public.booking_event e where e.booking_id = b.booking_id and e.action = 'No-show')),
           public.no_show_grace_minutes()
      from public.booking b
     where b.customer_id = public.current_customer_id()
       and (b.status = 'Approved'
            or (b.status = 'Cancelled' and exists (select 1 from public.booking_event e where e.booking_id = b.booking_id and e.action = 'No-show')));
end $$;
revoke all on function public.my_booking_release() from public, anon;
grant execute on function public.my_booking_release() to authenticated;

-- 7. start_due_sessions(): file 65 + the no-show release -----------------------------------------------------------
create or replace function public.start_due_sessions() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer := 0; k integer;
begin
  -- confirmed studio sessions whose time has begun and that have no balance left to collect
  update public.booking set status = 'In Progress'
   where status = 'Approved' and start_at <= now() and end_at > now()
     and public.booking_balance_due(booking_id) <= 0.005;
  get diagnostics k = row_count; n := n + k;

  -- sessions that reached their end time are completed (not while an extension is waiting to be verified)
  update public.booking b set status = 'Completed'
   where b.status = 'In Progress' and b.end_at <= now()
     and not exists (select 1 from public.booking_extension x where x.booking_id = b.booking_id and x.status = 'Pending');
  get diagnostics k = row_count; n := n + k;

  -- NEW: bookings that still owe a balance after the grace period are released (add-ons with them)
  begin
    n := n + public.release_no_show_bookings();
  exception when others then null;
  end;

  -- outside rentals are NOT started here: staff issue them on the admin page (before photos + handover proof)

  -- add-ons follow their session (issued while it runs, returned when it is completed)
  perform public.sync_addon_orders(null);
  return n;
end $$;
revoke all on function public.start_due_sessions() from public, anon;
grant execute on function public.start_due_sessions() to authenticated;

-- 8. Catch-up now ---------------------------------------------------------------------------------------------------
select public.start_due_sessions();
