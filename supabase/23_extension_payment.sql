-- =====================================================================
-- 23_extension_payment.sql  (safe to re-run)
-- Customers pay for a session extension the same way they pay for a booking:
--
--   1. My bookings > Extend: the customer picks the extra hours and pays a 50% DOWN PAYMENT by GCash
--      (reference number). The database sets the amount; the browser cannot change it.
--   2. The request is saved as Pending and the extra hours are RESERVED (nobody else can book them)
--      until staff decide. Staff and the owner see it in the Payments tab (kind "Extension").
--   3. Staff VERIFY the down payment  -> the booking's end time moves, so the studio total goes up by the
--      extension cost, and the extension down payment is added to the booking's down payment
--      (balance at the studio = total - down payment, as before).
--      Staff REJECT it (with a reason) -> nothing changes and the hours are released.
--   4. The extra hours are only added to the booking when the payment is verified.
--
--   * Only one pending extension per booking. Reschedule is blocked while one is pending; cancelling the
--     booking closes it.
--   * Customers can no longer call staff_extend_booking directly (it is staff only again).
--   * Staff's own Extend button (extension paid at the studio) is unchanged.
--   * Revenue report: the extension down payment counts when verified, the rest with the booking balance.
-- Run once in the Supabase SQL Editor (after 21_fix_rental_total_8h.sql).
-- =====================================================================

-- 1. Extension requests -----------------------------------------------------------------------
create table if not exists public.booking_extension (
  extension_id     bigint generated always as identity primary key,
  booking_id       bigint not null references public.booking (booking_id) on delete cascade,
  customer_id      bigint not null references public.customer (customer_id),
  extra_hours      integer not null,
  hourly_rate      numeric(10,2) not null,
  extra_cost       numeric(10,2) not null,
  down_payment     numeric(10,2) not null,
  old_end_at       timestamptz not null,
  new_end_at       timestamptz not null,
  status           varchar(10) not null default 'Pending',
  rejected_reason  text,
  hold_token       text,
  approved_by      bigint references public.app_user (user_id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint booking_extension_hours_chk  check (extra_hours between 1 and 4),
  constraint booking_extension_amount_chk check (extra_cost >= 0 and down_payment >= 0),
  constraint booking_extension_time_chk   check (new_end_at > old_end_at),
  constraint booking_extension_status_chk check (status in ('Pending', 'Approved', 'Rejected'))
);
create unique index if not exists booking_extension_one_pending on public.booking_extension (booking_id) where status = 'Pending';
create index if not exists booking_extension_booking_idx on public.booking_extension (booking_id);

drop trigger if exists trg_touch on public.booking_extension;
create trigger trg_touch before update on public.booking_extension
  for each row execute function public.touch_updated_at();

-- 2. A payment can now belong to an extension ---------------------------------------------------
alter table public.payment add column if not exists extension_id bigint references public.booking_extension (extension_id) on delete cascade;
alter table public.payment drop constraint if exists payment_target_chk;
alter table public.payment add constraint payment_target_chk check (num_nonnulls(booking_id, rental_order_id, extension_id) = 1);
create unique index if not exists payment_extension_uq on public.payment (extension_id) where extension_id is not null and status <> 'Rejected';

-- 3. Privileges and Row Level Security -----------------------------------------------------------
alter table public.booking_extension enable row level security;
revoke all on public.booking_extension from anon, authenticated;
grant select on public.booking_extension to authenticated;

drop policy if exists booking_extension_select on public.booking_extension;
create policy booking_extension_select on public.booking_extension for select to authenticated
  using (public.is_staff() or customer_id = public.current_customer_id());

-- customers can read the payment of their own extension (staff already read everything)
drop policy if exists payment_extension_select on public.payment;
create policy payment_extension_select on public.payment for select to authenticated
  using (exists (select 1 from public.booking_extension x
                  where x.extension_id = payment.extension_id and x.customer_id = public.current_customer_id()));

-- 4. View for My bookings and the staff dashboard (no hold token) --------------------------------
create or replace view public.v_booking_extension with (security_invoker = true) as
select
  x.extension_id, x.booking_id, b.booking_ref, x.customer_id,
  x.extra_hours, x.hourly_rate, x.extra_cost, x.down_payment, (x.extra_cost - x.down_payment) as balance_due,
  x.old_end_at, x.new_end_at, x.status, x.rejected_reason, x.created_at, x.updated_at,
  p.payment_id, p.status as payment_status, p.method as payment_method, p.gcash_reference
from public.booking_extension x
join public.booking b on b.booking_id = x.booking_id
left join lateral (
  select * from public.payment p where p.extension_id = x.extension_id order by p.payment_id desc limit 1
) p on true;
grant select on public.v_booking_extension to authenticated;

-- 5. Staff: a session extension request is checked before anything else ---------------------------
create or replace function public.staff_extension_info(p_booking_ref text, p_token text default null)
returns table (
  min_hours integer, max_hours integer, message text,
  current_end_at timestamptz, hourly_rate numeric, next_start timestamptz, booking_status text
)
language plpgsql stable security definer set search_path = public as $$
declare
  b public.booking; st public.studio;
  closing timestamptz; nxt timestamptz; held timestamptz; held_staff boolean := false;
  free_until timestamptz; lo integer := 1; hi integer; msg text;
begin

  select * into b from public.booking bk where bk.booking_ref = upper(trim(p_booking_ref));
  if not found then raise exception 'Booking not found.' using errcode = 'P0001'; end if;
  if not public.is_staff() and b.customer_id is distinct from public.current_customer_id() then
    raise exception 'That is not your booking.' using errcode = '42501';
  end if;
  select * into st from public.studio where studio_id = b.studio_id;

  -- NEW: only one extension request at a time (it must be verified or rejected first)
  if exists (select 1 from public.booking_extension e where e.booking_id = b.booking_id and e.status = 'Pending') then
    return query select 1, 0, 'Cannot extend: an extension request for this booking is waiting for its down payment to be verified.'::text,
                        b.end_at, b.hourly_rate_at_booking, null::timestamptz, b.status::text;
    return;
  end if;

  if b.status not in ('Approved', 'In Progress') then
    return query select 1, 0, 'Cannot extend: only Confirmed or Active bookings can be extended.'::text,
                        b.end_at, b.hourly_rate_at_booking, null::timestamptz, b.status::text;
    return;
  end if;
  if st.status <> 'Available' then
    return query select 1, 0, ('Cannot extend: ' || st.name || ' is ' || lower(st.status) || '.')::text,
                        b.end_at, b.hourly_rate_at_booking, null::timestamptz, b.status::text;
    return;
  end if;

  -- 10:00 PM closing on the day the session ends (Manila time)
  closing := (date_trunc('day', b.end_at at time zone 'Asia/Manila') + interval '22 hours') at time zone 'Asia/Manila';

  select min(o.start_at) into nxt from public.booking o
   where o.studio_id = b.studio_id and o.booking_id <> b.booking_id
     and o.status in ('Pending', 'Approved', 'In Progress') and o.end_at > b.end_at;

  -- the earliest hold by somebody else (a customer filling in the form, or another staff member extending)
  select h.start_at, h.held_by_staff into held, held_staff from public.slot_hold h
   where h.studio_id = b.studio_id and h.expires_at > now()
     and h.token is distinct from p_token and h.end_at > b.end_at
   order by h.start_at limit 1;

  free_until := least(closing, coalesce(nxt, 'infinity'::timestamptz), coalesce(held, 'infinity'::timestamptz));
  hi := least(4, greatest(0, floor(extract(epoch from (free_until - b.end_at)) / 3600.0)::integer));

  -- a session already running past its end time must be extended far enough to cover the time used
  if b.status = 'In Progress' and now() >= b.end_at then
    lo := floor(extract(epoch from (now() - b.end_at)) / 3600.0)::integer + 1;
  end if;

  if hi < lo then
    if nxt is not null and nxt <= b.end_at + make_interval(hours => lo) then
      msg := 'Cannot extend: studio is booked for the next time slot.';
    elsif held is not null and held <= b.end_at + make_interval(hours => lo) then
      msg := case when held_staff
               then 'Cannot extend: this time is Held by Staff. Another staff member is extending this session right now. Try again in a few minutes.'
               else 'Cannot extend: someone is booking the next time slot right now. Try again in a couple of minutes.' end;
    elsif closing <= b.end_at + make_interval(hours => lo) then
      msg := 'Cannot extend: the studio closes at 10:00 PM.';
    else
      msg := 'Cannot extend: that time is not free.';
    end if;
  elsif hi < 4 then
    if nxt is not null and nxt = free_until then
      msg := 'The studio is booked from ' || to_char(nxt at time zone 'Asia/Manila', 'FMHH12:MI AM') || ', so it can be extended by up to ' || hi || ' hour' || case when hi > 1 then 's' else '' end || '.';
    elsif held is not null and held = free_until then
      msg := case when held_staff
               then 'Held by Staff: another staff member is holding the time from '
               else 'Someone is holding the time from ' end
             || to_char(held at time zone 'Asia/Manila', 'FMHH12:MI AM') || case when held_staff then '' else ' in the booking form' end
             || ', so the limit is ' || hi || ' hour' || case when hi > 1 then 's' else '' end || ' for now.';
    else
      msg := 'The studio closes at 10:00 PM, so it can be extended by up to ' || hi || ' hour' || case when hi > 1 then 's' else '' end || '.';
    end if;
  end if;

  return query select lo, hi, msg, b.end_at, b.hourly_rate_at_booking, nxt, b.status::text;
end $$;

-- 6. staff_extend_booking is staff only again (customers use customer_request_extension) ------------
create or replace function public.staff_extend_booking(p_booking_ref text, p_extra_hours integer, p_token text default null)
returns table (booking_ref text, new_end_at timestamptz, extra_cost numeric, studio_total numeric, payment_method text, payment_status text)
language plpgsql security definer set search_path = public as $$
declare
  b public.booking; info record; cost numeric; pay public.payment;
begin
  -- NEW: customers no longer extend directly; they pay a 50% down payment through customer_request_extension()
  if not public.is_staff() then raise exception 'Staff only. Customers request an extension with a down payment.' using errcode = '42501'; end if;
  if p_extra_hours is null or p_extra_hours < 1 or p_extra_hours > 4 then
    raise exception 'Choose 1 to 4 extra hours.' using errcode = 'P0001';
  end if;

  select * into b from public.booking bk where bk.booking_ref = upper(trim(p_booking_ref)) for update;
  if not found then raise exception 'Booking not found.' using errcode = 'P0001'; end if;

  -- same lock the booking functions use, so nobody can book the free hour while we extend
  perform pg_advisory_xact_lock(hashtextextended('studio:' || b.studio_id, 0));

  -- holds by other people block the extension; this staff member's own hold does not
  select * into info from public.staff_extension_info(b.booking_ref, p_token);
  if info.max_hours < info.min_hours then
    raise exception '%', info.message using errcode = 'P0001';
  end if;
  if p_extra_hours > info.max_hours then
    raise exception '%', coalesce(info.message, 'Cannot extend: that time is not free.') using errcode = 'P0001';
  end if;
  if p_extra_hours < info.min_hours then
    raise exception 'The session is already past its end time. Extend by at least % hour(s).', info.min_hours using errcode = 'P0001';
  end if;

  cost := round(b.hourly_rate_at_booking * p_extra_hours, 2);

  begin
    update public.booking set end_at = end_at + make_interval(hours => p_extra_hours) where booking_id = b.booking_id;
  exception when exclusion_violation then
    raise exception 'Cannot extend: studio is booked for the next time slot.' using errcode = 'P0001';
  end;

  if p_token is not null then
    delete from public.slot_hold where token = p_token;     -- the hold did its job
  end if;

  select * into pay from public.payment p
   where p.booking_id = b.booking_id and p.status in ('Pending', 'Verified')
   order by p.payment_id desc limit 1;
  -- With a down payment the extra cost is NOT added to the payment: the customer already paid 50% of the
  -- original total, and the extra hours are part of the balance paid at the studio (total - down payment).
  -- Older bookings without a down payment keep the previous behaviour (cost added to the payment amount).
  if found and coalesce(b.down_payment, 0) = 0 then
    update public.payment set amount = amount + cost where payment_id = pay.payment_id;
  end if;

  return query
    select b.booking_ref::text, x.end_at, cost, public.booking_total(b.booking_id), pay.method::text, pay.status::text
      from public.booking x where x.booking_id = b.booking_id;
end $$;

-- 7. Customer: request an extension with a 50% down payment ---------------------------------------
create or replace function public.customer_request_extension(
  p_booking_ref text, p_extra_hours integer, p_token text, p_gcash_reference text
) returns table (extension_id bigint, booking_ref text, new_end_at timestamptz, extra_cost numeric, down_payment numeric, balance_due numeric)
language plpgsql security definer set search_path = public as $$
declare
  cid bigint := public.current_customer_id();
  b public.booking; info record; x public.booking_extension;
  cost numeric; dp numeric; tok text;
  gref text := regexp_replace(coalesce(p_gcash_reference, ''), '\s', '', 'g');
begin
  if cid is null then raise exception 'Please log in to extend your booking.' using errcode = 'P0001'; end if;
  if p_extra_hours is null or p_extra_hours < 1 or p_extra_hours > 4 then
    raise exception 'Choose 1 to 4 extra hours.' using errcode = 'P0001';
  end if;
  if gref !~ '^[0-9]{13}$' then
    raise exception 'Enter the 13-digit GCash reference number of your down payment.' using errcode = 'P0001';
  end if;

  select * into b from public.booking bk where bk.booking_ref = upper(trim(p_booking_ref)) for update;
  if not found or b.customer_id is distinct from cid then
    raise exception 'That is not your booking.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('studio:' || b.studio_id, 0));

  if exists (select 1 from public.booking_extension e where e.booking_id = b.booking_id and e.status = 'Pending') then
    raise exception 'You already have an extension request waiting for staff to verify its down payment.' using errcode = 'P0001';
  end if;

  -- the customer's own open Extend window (p_token) does not block the hours
  select * into info from public.staff_extension_info(b.booking_ref, p_token);
  if info.max_hours < info.min_hours then raise exception '%', info.message using errcode = 'P0001'; end if;
  if p_extra_hours > info.max_hours then
    raise exception '%', coalesce(info.message, 'Cannot extend: that time is not free.') using errcode = 'P0001';
  end if;
  if p_extra_hours < info.min_hours then
    raise exception 'The session is already past its end time. Extend by at least % hour(s).', info.min_hours using errcode = 'P0001';
  end if;

  cost := round(b.hourly_rate_at_booking * p_extra_hours, 2);
  dp   := round(cost * 0.5, 2);
  tok  := 'e' || replace(gen_random_uuid()::text, '-', '');

  insert into public.booking_extension (booking_id, customer_id, extra_hours, hourly_rate, extra_cost, down_payment,
                                        old_end_at, new_end_at, hold_token)
  values (b.booking_id, cid, p_extra_hours, b.hourly_rate_at_booking, cost, dp,
          b.end_at, b.end_at + make_interval(hours => p_extra_hours), tok)
  returning * into x;

  insert into public.payment (extension_id, method, gcash_reference, amount, status)
  values (x.extension_id, 'GCash', gref, dp, 'Pending');

  -- reserve the extra hours until staff decide (an ordinary hold: nobody else can book or extend them)
  delete from public.slot_hold where expires_at < now() or token = p_token;
  insert into public.slot_hold (studio_id, start_at, end_at, token, expires_at, held_by_staff)
  values (b.studio_id, x.old_end_at, x.new_end_at, tok, x.new_end_at, false);

  return query select x.extension_id, b.booking_ref::text, x.new_end_at, cost, dp, cost - dp;
exception when unique_violation then
  raise exception 'That GCash reference number was already used.' using errcode = 'P0001';
end $$;

-- 8. Apply an approved extension to the booking (called by the payment trigger) -----------------------
create or replace function public.apply_booking_extension(p_extension_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare x public.booking_extension; b public.booking; paid numeric := 0;
begin
  select * into x from public.booking_extension where extension_id = p_extension_id for update;
  if not found or x.status <> 'Pending' then return; end if;

  select * into b from public.booking where booking_id = x.booking_id for update;
  perform pg_advisory_xact_lock(hashtextextended('studio:' || b.studio_id, 0));

  if b.status not in ('Approved', 'In Progress') then
    raise exception 'This booking is % now, so the extension cannot be applied. Reject the extension payment instead.', b.status using errcode = 'P0001';
  end if;
  if b.end_at is distinct from x.old_end_at then
    raise exception 'The booking time changed after this request was made. Reject the extension payment and ask the customer to request it again.' using errcode = 'P0001';
  end if;

  -- an older booking paid in full has no down payment: what it already paid counts as paid
  if coalesce(b.down_payment, 0) = 0 then
    select coalesce(sum(p.amount), 0) into paid from public.payment p where p.booking_id = b.booking_id and p.status = 'Verified';
  end if;

  begin
    update public.booking
       set end_at = x.new_end_at,
           down_payment = case when down_payment > 0 then down_payment else paid end + x.down_payment
     where booking_id = b.booking_id;
  exception when exclusion_violation then
    raise exception 'Cannot verify: the extra time is no longer free (another booking took it). Reject the extension payment with the reason "Time slot is no longer available".' using errcode = 'P0001';
  end;

  delete from public.slot_hold where token = x.hold_token;
  update public.booking_extension set status = 'Approved', approved_by = public.current_app_user_id() where extension_id = x.extension_id;
end $$;

-- 9. Verifying / rejecting the extension payment (same Payments tab as bookings) -----------------------
create or replace function public.payment_effects() returns trigger
language plpgsql security definer set search_path = public as $$
declare o record;
begin
  -- NEW: extension payments
  if new.status is distinct from old.status and new.extension_id is not null then
    if new.status = 'Verified' then
      perform public.apply_booking_extension(new.extension_id);
    elsif new.status = 'Rejected' then
      update public.booking_extension
         set status = 'Rejected', rejected_reason = coalesce(rejected_reason, 'Payment rejected')
       where extension_id = new.extension_id and status = 'Pending';
      delete from public.slot_hold where token in (select hold_token from public.booking_extension where extension_id = new.extension_id);
    end if;
    return null;
  end if;

  if new.status is distinct from old.status and new.booking_id is not null then
    if new.status = 'Verified' then
      update public.booking set status = 'Approved'
       where booking_id = new.booking_id and status = 'Pending';

      for o in select ro.rental_order_id from public.rental_order ro
                where ro.booking_id = new.booking_id and ro.rental_type = 'Add-on' and ro.status = 'Pending' loop
        begin
          update public.rental_order set status = 'Approved' where rental_order_id = o.rental_order_id;
        exception when others then
          null;   -- for example not enough stock right now: leave it Pending
        end;
      end loop;

    elsif new.status = 'Rejected' then
      update public.booking set status = 'Rejected', rejected_reason = coalesce(rejected_reason, 'Payment rejected')
       where booking_id = new.booking_id and status = 'Pending';

      for o in select ro.rental_order_id from public.rental_order ro
                where ro.booking_id = new.booking_id and ro.rental_type = 'Add-on' and ro.status = 'Pending' loop
        begin
          update public.rental_order set status = 'Rejected', rejected_reason = 'Booking payment was rejected'
           where rental_order_id = o.rental_order_id;
        exception when others then
          null;
        end;
      end loop;
    end if;
  end if;
  return null;
end $$;

-- 10. Staff reject an extension with a reason the customer sees ------------------------------------------
create or replace function public.staff_reject_extension(p_extension_id bigint, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare x public.booking_extension; why text := trim(coalesce(p_reason, ''));
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  if length(why) < 3 then raise exception 'Enter the reason for rejecting this extension.' using errcode = 'P0001'; end if;
  if length(why) > 300 then raise exception 'Keep the reason under 300 characters.' using errcode = 'P0001'; end if;

  select * into x from public.booking_extension where extension_id = p_extension_id for update;
  if not found then raise exception 'Extension request not found.' using errcode = 'P0001'; end if;
  if x.status <> 'Pending' then
    raise exception 'Only a Pending extension can be rejected (this one is %).', x.status using errcode = 'P0001';
  end if;

  update public.booking_extension set rejected_reason = why where extension_id = x.extension_id;
  update public.payment set status = 'Rejected' where extension_id = x.extension_id and status = 'Pending';   -- trigger closes the request
end $$;

-- 11. Reschedule is blocked and cancel closes a pending request -------------------------------------------
create or replace function public.reschedule_booking(p_booking_ref text, p_start_at timestamptz, p_end_at timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare b public.booking; staff boolean := public.is_staff();
begin
  select * into b from public.booking where booking_ref = upper(trim(p_booking_ref)) for update;
  if not found then raise exception 'Booking not found.' using errcode = 'P0001'; end if;
  if not staff and b.customer_id is distinct from public.current_customer_id() then
    raise exception 'That is not your booking.' using errcode = '42501';
  end if;
  if b.status not in ('Pending', 'Approved') then
    raise exception 'A % booking cannot be rescheduled.', b.status using errcode = 'P0001';
  end if;
  if not staff and now() > b.start_at - interval '24 hours' then
    raise exception 'Changes and cancellations close 24 hours before your session.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.booking_extension e where e.booking_id = b.booking_id and e.status = 'Pending') then
    raise exception 'This booking has an extension request waiting for payment verification. Please wait until staff verify or reject it.' using errcode = 'P0001';
  end if;
  perform public.validate_slot(p_start_at, p_end_at, staff);

  perform pg_advisory_xact_lock(hashtextextended('studio:' || b.studio_id, 0));
  if public.slot_held_by_other(b.studio_id, p_start_at, p_end_at, null) then
    raise exception 'Those hours were just taken by another customer.' using errcode = 'P0001';
  end if;
  begin
    update public.booking
       set start_at = p_start_at, end_at = p_end_at, reschedule_count = reschedule_count + 1
     where booking_id = b.booking_id;
  exception when exclusion_violation then
    raise exception 'That time is no longer available. Please pick another slot.' using errcode = 'P0001';
  end;
end $$;

create or replace function public.cancel_booking(p_booking_ref text, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare b public.booking; staff boolean := public.is_staff();
begin
  select * into b from public.booking where booking_ref = upper(trim(p_booking_ref)) for update;
  if not found then raise exception 'Booking not found.' using errcode = 'P0001'; end if;
  if not staff and b.customer_id is distinct from public.current_customer_id() then
    raise exception 'That is not your booking.' using errcode = '42501';
  end if;
  if b.status not in ('Pending', 'Approved') then
    raise exception 'A % booking cannot be cancelled.', b.status using errcode = 'P0001';
  end if;
  if not staff and now() > b.start_at - interval '24 hours' then
    raise exception 'Changes and cancellations close 24 hours before your session.' using errcode = 'P0001';
  end if;

  update public.booking set status = 'Cancelled', cancelled_reason = nullif(trim(p_reason), '')
   where booking_id = b.booking_id;
  update public.payment set status = 'Rejected' where booking_id = b.booking_id and status = 'Pending';
  -- NEW: an extension request still waiting for verification is closed too (its unverified payment is rejected)
  update public.booking_extension set rejected_reason = 'The booking was cancelled'
   where booking_id = b.booking_id and status = 'Pending';
  update public.payment set status = 'Rejected'
   where status = 'Pending' and extension_id in (select e.extension_id from public.booking_extension e where e.booking_id = b.booking_id);
end $$;

-- 12. Payments tab, Customers tab ------------------------------------------------------------------------
create or replace view public.v_payment_queue with (security_invoker = true) as
select
  p.payment_id, p.status, p.method, p.gcash_reference, p.amount, p.created_at, p.verified_at,
  coalesce(b.booking_ref, o.rental_ref, xb.booking_ref) as reference,
  case when p.booking_id is not null then 'Booking'
       when p.extension_id is not null then 'Extension'
       else 'Rental' end as kind,
  trim(c.first_name || ' ' || c.last_name) as customer_name,
  p.extension_id
from public.payment p
left join public.booking b on b.booking_id = p.booking_id
left join public.rental_order o on o.rental_order_id = p.rental_order_id
left join public.booking_extension x on x.extension_id = p.extension_id
left join public.booking xb on xb.booking_id = x.booking_id
join public.customer c on c.customer_id = coalesce(b.customer_id, o.customer_id, xb.customer_id);
grant select on public.v_payment_queue to authenticated;

create or replace view public.v_customer_spending with (security_invoker = true) as
select
  c.customer_id, trim(c.first_name || ' ' || c.last_name) as customer_name, c.number, c.status,
  case when c.auth_user_id is null then 'Guest' else 'Registered' end as account_type,
  (select count(*) from public.booking b where b.customer_id = c.customer_id and b.status <> 'Cancelled') as bookings,
  (select count(*) from public.rental_order o where o.customer_id = c.customer_id and o.status not in ('Rejected', 'Cancelled')) as rentals,
  coalesce((select sum(p.amount) from public.payment p
            left join public.booking b on b.booking_id = p.booking_id
            left join public.rental_order o on o.rental_order_id = p.rental_order_id
            left join public.booking_extension x on x.extension_id = p.extension_id
            where p.status = 'Verified' and coalesce(b.customer_id, o.customer_id, x.customer_id) = c.customer_id), 0) as total_spent
from public.customer c;
grant select on public.v_customer_spending to authenticated;

-- 13. Revenue report: also counts verified extension down payments -------------------------------------------
drop view if exists public.v_revenue_daily;
create view public.v_revenue_daily with (security_invoker = true) as
select day, kind, studio_name, sum(amount) as amount, count(*) as payments
from (
  -- studio part of a booking payment (the down payment, or the full payment of older/walk-in bookings)
  select (coalesce(p.verified_at, p.created_at) at time zone 'Asia/Manila')::date as day,
         'Studio'::text as kind, s.name::varchar(100) as studio_name,
         least(p.amount, public.booking_total(b.booking_id)) as amount
    from public.payment p
    join public.booking b on b.booking_id = p.booking_id
    join public.studio  s on s.studio_id  = b.studio_id
   where p.status = 'Verified'
  union all
  -- add-on equipment paid together with the booking
  select (coalesce(p.verified_at, p.created_at) at time zone 'Asia/Manila')::date,
         'Equipment'::text, null::varchar(100),
         p.amount - public.booking_total(b.booking_id)
    from public.payment p
    join public.booking b on b.booking_id = p.booking_id
   where p.status = 'Verified' and p.amount > public.booking_total(b.booking_id)
  union all
  -- the studio balance of a booking with a down payment, collected when the session starts
  select (b.actual_start_at at time zone 'Asia/Manila')::date,
         'Studio'::text, s.name::varchar(100),
         public.booking_total(b.booking_id) - least(b.down_payment, public.booking_total(b.booking_id))
    from public.booking b
    join public.studio s on s.studio_id = b.studio_id
   where b.down_payment > 0 and b.status in ('In Progress', 'Completed') and b.actual_start_at is not null
     and exists (select 1 from public.payment p where p.booking_id = b.booking_id and p.status = 'Verified')
     and public.booking_total(b.booking_id) - least(b.down_payment, public.booking_total(b.booking_id)) > 0
  union all
  -- the add-on equipment balance of a booking with a down payment, collected when the session starts
  select (b.actual_start_at at time zone 'Asia/Manila')::date,
         'Equipment'::text, null::varchar(100),
         public.booking_addons_total(b.booking_id) - greatest(b.down_payment - public.booking_total(b.booking_id), 0)
    from public.booking b
   where b.down_payment > 0 and b.status in ('In Progress', 'Completed') and b.actual_start_at is not null
     and exists (select 1 from public.payment p where p.booking_id = b.booking_id and p.status = 'Verified')
     and public.booking_addons_total(b.booking_id) - greatest(b.down_payment - public.booking_total(b.booking_id), 0) > 0
  union all
  -- NEW: down payments of verified session extensions (the extra cost itself is in the booking total)
  select (coalesce(p.verified_at, p.created_at) at time zone 'Asia/Manila')::date,
         'Studio'::text, s.name::varchar(100), p.amount
    from public.payment p
    join public.booking_extension x on x.extension_id = p.extension_id
    join public.booking b on b.booking_id = x.booking_id
    join public.studio  s on s.studio_id  = b.studio_id
   where p.status = 'Verified'
  union all
  -- rental payments (outside rental down payments, onsite rentals)
  select (coalesce(p.verified_at, p.created_at) at time zone 'Asia/Manila')::date,
         'Equipment'::text, null::varchar(100), p.amount
    from public.payment p
   where p.status = 'Verified' and p.rental_order_id is not null
  union all
  -- the other 50% of an online outside rental, collected when the equipment is issued
  select (o.issued_at at time zone 'Asia/Manila')::date,
         'Equipment'::text, null::varchar(100),
         public.rental_order_total(o.rental_order_id) - o.down_payment
    from public.rental_order o
   where o.down_payment > 0 and o.status in ('Active', 'Returned') and o.issued_at is not null
  union all
  -- late fees collected when the equipment is returned
  select (d.returned_at at time zone 'Asia/Manila')::date,
         'Equipment'::text, null::varchar(100), d.late_fee
    from public.rental_detail d
   where d.late_fee > 0
) x
group by day, kind, studio_name;

grant select on public.v_revenue_daily to authenticated;


-- 14. Function privileges ----------------------------------------------------------------------------------
revoke all on function public.staff_extension_info(text, text) from public, anon, authenticated;
revoke all on function public.staff_extend_booking(text, integer, text) from public, anon, authenticated;
revoke all on function public.customer_request_extension(text, integer, text, text) from public, anon, authenticated;
revoke all on function public.apply_booking_extension(bigint) from public, anon, authenticated;
revoke all on function public.staff_reject_extension(bigint, text) from public, anon, authenticated;
revoke all on function public.reschedule_booking(text, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.cancel_booking(text, text) from public, anon, authenticated;
grant execute on function public.staff_extension_info(text, text) to authenticated;
grant execute on function public.staff_extend_booking(text, integer, text) to authenticated;
grant execute on function public.customer_request_extension(text, integer, text, text) to authenticated;
grant execute on function public.staff_reject_extension(bigint, text) to authenticated;
grant execute on function public.reschedule_booking(text, timestamptz, timestamptz) to authenticated;
grant execute on function public.cancel_booking(text, text) to authenticated;
