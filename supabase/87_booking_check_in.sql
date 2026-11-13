-- =====================================================================
-- 87_booking_check_in.sql  (safe to re-run; run after 86_block_autocomplete_with_balance.sql)
-- Check-in of a studio booking: the staff records the time the customer ARRIVED.
--
--   * Works for every booking, 50% down payment or fully paid. Check-in is a record; it does not start the session.
--     (A fully paid booking still starts by itself at its start time, and a booking with a balance is still started
--      from the Sessions tab with "Collect balance & start".)
--   * Stored on the booking: checked_in_at (server clock), checked_in_by (staff user) and checked_in_by_name.
--   * A customer who has checked in is NOT a no-show: the release countdown (file 78) stops for that booking and the
--     Hold / Release buttons disappear. (Only while the booking is still running or upcoming; see release_no_show_bookings.)
--   * Walk-ins: an onsite booking that starts now (or within 15 minutes) is checked in automatically when it is created.
--   * Every check-in (and every undo) is written to booking_event, so it shows in the booking's History:
--       "Checked in - Arrived 7 min late" / "Arrived 10 min early" / "Arrived on time".
--   * Staff can check in once (a second tap changes nothing and keeps the first time).
--     Only the OWNER can undo a check-in, with a note (for a misclick).
--   * The admin page reads the times with staff_check_in_times(); if this file is not installed the page works as before
--     and the check-in buttons are hidden.
-- =====================================================================

-- 1. Columns ---------------------------------------------------------------------------------------------------
alter table public.booking add column if not exists checked_in_at      timestamptz;
alter table public.booking add column if not exists checked_in_by      bigint references public.app_user (user_id) on delete set null;
alter table public.booking add column if not exists checked_in_by_name text;

-- 2. Only staff can change the check-in (a customer can never set it on their own booking) ----------------------
create or replace function public.guard_booking_check_in() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (new.checked_in_at is distinct from old.checked_in_at
      or new.checked_in_by is distinct from old.checked_in_by
      or new.checked_in_by_name is distinct from old.checked_in_by_name)
     and auth.uid() is not null and not public.is_staff() then
    raise exception 'Only staff can change the check-in.' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists trg_booking_check_in_guard on public.booking;
create trigger trg_booking_check_in_guard before update on public.booking
  for each row execute function public.guard_booking_check_in();

-- 3. Walk-ins are checked in when the booking is created -------------------------------------------------------
create or replace function public.booking_walkin_check_in() returns trigger
language plpgsql as $$
begin
  if new.source = 'Onsite' and new.checked_in_at is null and new.start_at <= now() + interval '15 minutes' then
    new.checked_in_at := now();
    new.checked_in_by_name := 'Walk-in';
  end if;
  return new;
end $$;
drop trigger if exists trg_booking_walkin_check_in on public.booking;
create trigger trg_booking_walkin_check_in before insert on public.booking
  for each row execute function public.booking_walkin_check_in();

-- 4. Staff: check a customer in ----------------------------------------------------------------------------------
create or replace function public.staff_check_in(p_booking_ref text)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare b public.booking; t timestamptz := now(); diff integer; note text;
begin
  if not public.is_staff() then raise exception 'Only staff can check a customer in.' using errcode = '42501'; end if;
  select * into b from public.booking where booking_ref = upper(trim(p_booking_ref)) for update;
  if not found then raise exception 'Booking not found.' using errcode = 'P0001'; end if;
  if b.checked_in_at is not null then return b.checked_in_at; end if;   -- already checked in: keep the first time
  if b.status not in ('Approved', 'In Progress') then
    raise exception 'Only a confirmed or running booking can be checked in.' using errcode = 'P0001';
  end if;
  diff := round(extract(epoch from (t - b.start_at)) / 60.0);
  note := case when diff >= 2 then 'Arrived ' || diff || ' min late'
               when diff <= -2 then 'Arrived ' || (-diff) || ' min early'
               else 'Arrived on time' end;
  update public.booking
     set checked_in_at = t, checked_in_by = public.current_app_user_id(), checked_in_by_name = public.staff_display_name()
   where booking_id = b.booking_id;
  insert into public.booking_event (booking_id, action, note, by_user_id, by_name)
  values (b.booking_id, 'Checked in', note, public.current_app_user_id(), public.staff_display_name());
  return t;
end $$;
revoke all on function public.staff_check_in(text) from public, anon;
grant execute on function public.staff_check_in(text) to authenticated;

-- 5. Owner: undo a check-in (a note is required) -------------------------------------------------------------------
create or replace function public.staff_undo_check_in(p_booking_ref text, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare b public.booking;
begin
  if not public.is_owner() then raise exception 'Only the owner can undo a check-in.' using errcode = '42501'; end if;
  if length(trim(coalesce(p_note, ''))) < 3 then raise exception 'Add a short note (for example: checked in by mistake).' using errcode = 'P0001'; end if;
  select * into b from public.booking where booking_ref = upper(trim(p_booking_ref)) for update;
  if not found then raise exception 'Booking not found.' using errcode = 'P0001'; end if;
  if b.checked_in_at is null then return; end if;
  if b.status not in ('Approved', 'In Progress') then
    raise exception 'The check-in of a finished booking cannot be undone.' using errcode = 'P0001';
  end if;
  update public.booking set checked_in_at = null, checked_in_by = null, checked_in_by_name = null where booking_id = b.booking_id;
  insert into public.booking_event (booking_id, action, note, by_user_id, by_name)
  values (b.booking_id, 'Check-in undone', trim(p_note), public.current_app_user_id(), public.staff_display_name());
end $$;
revoke all on function public.staff_undo_check_in(text, text) from public, anon;
grant execute on function public.staff_undo_check_in(text, text) to authenticated;

-- 6. For the admin page: who arrived when (the last 120 days) ---------------------------------------------------
create or replace function public.staff_check_in_times()
returns table (booking_ref text, checked_in_at timestamptz, by_name text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  return query
    select b.booking_ref::text, b.checked_in_at, b.checked_in_by_name
      from public.booking b
     where b.checked_in_at is not null and b.checked_in_at > now() - interval '120 days';
end $$;
revoke all on function public.staff_check_in_times() from public, anon;
grant execute on function public.staff_check_in_times() to authenticated;

-- 7. A customer who has arrived is not a no-show -------------------------------------------------------------------
--    (a) the automatic release skips a checked-in booking while its session time is still running
create or replace function public.release_no_show_bookings() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer := 0; k integer; r record;
begin
  for r in
    select b.booking_id from public.booking b
     where b.status = 'Approved' and b.start_at <= now()
       and (b.checked_in_at is null or b.end_at <= now())
       and public.booking_balance_due(b.booking_id) > 0.005
       and public.booking_release_at(b.booking_id) <= now()
  loop
    begin
      update public.booking
         set status = 'Cancelled',
             cancelled_reason = 'No-show: balance not paid within ' || public.no_show_grace_minutes() || ' minutes of the start time (released automatically). Payments made are non-refundable.'
       where booking_id = r.booking_id and status = 'Approved'
         and (checked_in_at is null or end_at <= now())
         and public.booking_balance_due(r.booking_id) > 0.005;   -- re-checked here: the balance may have been paid, or the customer checked in, a moment ago
      get diagnostics k = row_count;
      if k = 0 then continue; end if;
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

--    (b) staff cannot release a checked-in booking as a no-show
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
  if b.checked_in_at is not null then
    raise exception 'This customer has already checked in, so it is not a no-show. Collect the balance and start the session, or cancel it from Bookings.' using errcode = 'P0001';
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

--    (c) the Sessions tab only shows a release countdown for a booking that has not checked in
create or replace function public.staff_release_times()
returns table (booking_ref text, release_at timestamptz, hold_count smallint, hold_note text)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  return query
    select b.booking_ref::text, public.booking_release_at(b.booking_id), b.hold_count, b.hold_note
      from public.booking b
     where b.status = 'Approved' and b.checked_in_at is null and public.booking_balance_due(b.booking_id) > 0.005;
end $$;
revoke all on function public.staff_release_times() from public, anon;
grant execute on function public.staff_release_times() to authenticated;

--    (d) the customer's own pages stop showing "your slot is held until ..." once they have checked in
create or replace function public.booking_release_time(p_booking_ref text) returns timestamptz
language plpgsql stable security definer set search_path = public as $$
declare b public.booking;
begin
  select * into b from public.booking where booking_ref = upper(trim(p_booking_ref));
  if not found then return null; end if;
  if not public.is_staff() and b.customer_id is distinct from public.current_customer_id() then return null; end if;
  if b.status <> 'Approved' or b.checked_in_at is not null or public.booking_balance_due(b.booking_id) <= 0.005 then return null; end if;
  return public.booking_release_at(b.booking_id);
end $$;
revoke all on function public.booking_release_time(text) from public, anon;
grant execute on function public.booking_release_time(text) to authenticated;

create or replace function public.my_booking_release()
returns table (booking_ref text, release_at timestamptz, late_used boolean, no_show boolean, grace_minutes integer)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  return query
    select b.booking_ref::text,
           case when b.status = 'Approved' and b.checked_in_at is null and public.booking_balance_due(b.booking_id) > 0.005
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
