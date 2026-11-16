-- =====================================================================
-- 94_qa_hardening.sql  (safe to re-run)
-- Fixes from the QA audit (qa-plan-tower-of-dove.md):
--
--   B-01  Guest lookups by reference code now REQUIRE the phone number that
--         was used with the booking / rental. Reference codes alone are
--         guessable, so a stranger can no longer read someone's booking or
--         rental details. (Staff and the signed-in owner are unaffected.)
--
--   B-02  hold_slot is throttled: at most 60 attempts per caller IP in any
--         10 minutes, and at most 10 different people may hold hours of one
--         studio at the same time. A script can no longer pin every slot by
--         minting tokens. (A per-IP Edge Function with a Redis counter in
--         front of Supabase would be the stronger option; this SQL-only
--         version needs no extra infrastructure.)
--
--   B-03  Online bookings by guests and outside-rental contact numbers must
--         be a real 11-digit Philippine mobile number (09 + 9 digits). The
--         lenient 7-20 char column check stays for staff/onsite records.
--
--   B-04  The booking window (28 days), the change/cancel cutoff (24 hours)
--         and the slot-hold length (2 minutes) now live in app_setting and
--         are ENFORCED from there, so the database can never drift from what
--         the website shows (js/shared/availability.js reads them through
--         the new get_public_settings() RPC).
--
-- Run once in the Supabase SQL Editor. No other setup is needed: no new
-- pg_cron jobs, buckets, policies or dashboard screens.
-- =====================================================================

-- ---------------------------------------------------------------------
-- B-04  Rule settings: single source of truth
-- ---------------------------------------------------------------------
insert into public.app_setting (key, value) values
  ('booking_window_days', '28'),
  ('change_cutoff_hours', '24'),
  ('slot_hold_minutes', '2')
on conflict (key) do nothing;

create or replace function public.booking_window_days() returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(trim(value), '')::int, 28)
    from public.app_setting where key = 'booking_window_days';
$$;

create or replace function public.change_cutoff_hours() returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(trim(value), '')::int, 24)
    from public.app_setting where key = 'change_cutoff_hours';
$$;

create or replace function public.slot_hold_minutes() returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(nullif(trim(value), '')::int, 2)
    from public.app_setting where key = 'slot_hold_minutes';
$$;

/* The numbers the customer pages show (calendar, FAQ). Not secret. */
create or replace function public.get_public_settings() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'window_days',  public.booking_window_days(),
    'cutoff_hours', public.change_cutoff_hours(),
    'hold_minutes', public.slot_hold_minutes(),
    'grace_minutes', public.no_show_grace_minutes());
$$;
revoke all on function public.get_public_settings() from public, anon, authenticated;
grant execute on function public.get_public_settings() to anon, authenticated;

-- ---------------------------------------------------------------------
-- B-04  Booking window triggers (33) now read the setting
-- ---------------------------------------------------------------------
create or replace function public.guard_booking_window() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.source = 'Online' and not public.is_staff()
     and (new.start_at at time zone 'Asia/Manila')::date
         > (now() at time zone 'Asia/Manila')::date + public.booking_window_days() then
    raise exception 'Bookings can only be made up to % days ahead. Please choose an earlier date.',
      public.booking_window_days() using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists trg_booking_window on public.booking;
create trigger trg_booking_window before insert or update of start_at on public.booking
  for each row execute function public.guard_booking_window();

create or replace function public.guard_rental_window() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.rental_type = 'Outside' and new.source = 'Online' and not public.is_staff()
     and ((new.pickup_date at time zone 'Asia/Manila')::date
          > (now() at time zone 'Asia/Manila')::date + public.booking_window_days()
       or (new.return_date at time zone 'Asia/Manila')::date
          > (now() at time zone 'Asia/Manila')::date + public.booking_window_days()) then
    raise exception 'Equipment can only be rented up to % days ahead. Please choose an earlier date.',
      public.booking_window_days() using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists trg_rental_window on public.rental_order;
create trigger trg_rental_window before insert or update of pickup_date, return_date on public.rental_order
  for each row execute function public.guard_rental_window();

-- ---------------------------------------------------------------------
-- B-04  Change / cancel cutoff now reads the setting
-- ---------------------------------------------------------------------
create or replace function public.reschedule_booking(p_booking_ref text, p_start_at timestamptz, p_end_at timestamptz, p_token text default null)
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
  if not staff and now() > b.start_at - make_interval(hours => public.change_cutoff_hours()) then
    raise exception 'Changes and cancellations close % hours before your session.',
      public.change_cutoff_hours() using errcode = 'P0001';
  end if;
  if exists (select 1 from public.booking_extension e where e.booking_id = b.booking_id and e.status = 'Pending') then
    raise exception 'This booking has an extension request waiting for payment verification. Please wait until staff verify or reject it.' using errcode = 'P0001';
  end if;
  if p_start_at = b.start_at and p_end_at = b.end_at then
    raise exception 'That is your current time. Pick a different start time.' using errcode = 'P0001';
  end if;
  perform public.validate_slot(p_start_at, p_end_at, staff);

  perform pg_advisory_xact_lock(hashtextextended('studio:' || b.studio_id, 0));
  -- the customer's own hold (same token) does not count as "someone else"
  if public.slot_held_by_other(b.studio_id, p_start_at, p_end_at, p_token) then
    raise exception 'Those hours were just taken by another customer.' using errcode = 'P0001';
  end if;
  begin
    update public.booking
       set start_at = p_start_at, end_at = p_end_at, reschedule_count = reschedule_count + 1
     where booking_id = b.booking_id;
  exception when exclusion_violation then
    raise exception 'That time is no longer available. Please pick another slot.' using errcode = 'P0001';
  end;

  if p_token is not null then
    delete from public.slot_hold where token = p_token;
  end if;
end $$;
revoke all on function public.reschedule_booking(text, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.reschedule_booking(text, timestamptz, timestamptz, text) to authenticated;

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
  if not staff and now() > b.start_at - make_interval(hours => public.change_cutoff_hours()) then
    raise exception 'Changes and cancellations close % hours before your session.',
      public.change_cutoff_hours() using errcode = 'P0001';
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

create or replace function public.cancel_rental(p_rental_ref text, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare o public.rental_order; staff boolean := public.is_staff(); due timestamptz;
begin
  select * into o from public.rental_order where rental_ref = upper(trim(p_rental_ref)) for update;
  if not found then raise exception 'Rental not found.' using errcode = 'P0001'; end if;
  if not staff and o.customer_id is distinct from public.current_customer_id() then
    raise exception 'That is not your rental.' using errcode = '42501';
  end if;
  if o.status not in ('Pending', 'Approved') then
    raise exception 'A % rental cannot be cancelled.', o.status using errcode = 'P0001';
  end if;

  if o.rental_type = 'Outside' then
    due := o.pickup_date;
  else
    select b.start_at into due from public.booking b where b.booking_id = o.booking_id;
  end if;
  if not staff and due is not null and now() > due - make_interval(hours => public.change_cutoff_hours()) then
    raise exception 'Changes and cancellations close % hours before %.',
      public.change_cutoff_hours(),
      case when o.rental_type = 'Outside' then 'pick-up' else 'your session' end using errcode = 'P0001';
  end if;

  update public.rental_order set status = 'Cancelled' where rental_order_id = o.rental_order_id;
  -- an unpaid (still Pending) payment is closed; a verified down payment is NOT refunded
  update public.payment set status = 'Rejected' where rental_order_id = o.rental_order_id and status = 'Pending';
end $$;

-- ---------------------------------------------------------------------
-- B-01  Guest lookups require the phone number (ref alone is guessable)
-- ---------------------------------------------------------------------
create or replace function public.lookup_booking(p_ref text, p_phone text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r record; ad jsonb; ad_total numeric;
begin
  select b.booking_id, b.booking_ref, b.status, b.start_at, b.end_at, s.name as studio_name, s.description as studio_desc,
         public.booking_total(b.booking_id) as total,
         (select p.status from public.payment p where p.booking_id = b.booking_id order by p.payment_id desc limit 1) as payment_status,
         c.number, c.auth_user_id, b.rejected_reason, b.down_payment,
         (select p.balance_paid_amount from public.payment p where p.booking_id = b.booking_id and p.status <> 'Rejected' order by p.payment_id desc limit 1) as balance_paid,
         (select p.payment_option from public.payment p where p.booking_id = b.booking_id order by p.payment_id desc limit 1) as payment_option
    into r
  from public.booking b
  join public.studio s on s.studio_id = b.studio_id
  join public.customer c on c.customer_id = b.customer_id
  where b.booking_ref = upper(regexp_replace(coalesce(p_ref, ''), '\s', '', 'g'));

  if not found then return null; end if;

  -- registered customers' bookings are private: only the owner of the account or staff may read them
  if r.auth_user_id is not null and r.auth_user_id is distinct from auth.uid() and not public.is_staff() then
    return null;
  end if;
  -- B-01: without the matching phone number, nobody but the account owner or staff may read a booking
  -- (a guest booking has no account, so the phone is its only proof of ownership)
  if not public.is_staff() and (r.auth_user_id is null or r.auth_user_id is distinct from auth.uid())
     and (p_phone is null or public.digits(p_phone) <> public.digits(r.number)) then
    return null;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'equipment', e.name, 'quantity', d.quantity,
           'price', d.unit_price_at_request * d.quantity, 'status', o.status) order by e.name), '[]'::jsonb),
         coalesce(sum(d.unit_price_at_request * d.quantity), 0)
    into ad, ad_total
  from public.rental_order o
  join public.rental_detail d on d.rental_order_id = o.rental_order_id
  join public.equipment e on e.equipment_id = d.equipment_id
  where o.booking_id = r.booking_id and o.rental_type = 'Add-on' and o.status not in ('Rejected', 'Cancelled');

  return jsonb_build_object(
    'booking_ref', r.booking_ref, 'status', r.status, 'start_at', r.start_at, 'end_at', r.end_at,
    'studio', r.studio_name, 'studio_description', r.studio_desc,
    'total', r.total,
    'studio_total', r.total, 'addons', ad, 'addons_total', ad_total, 'grand_total', r.total + ad_total,
    'payment_status', r.payment_status, 'rejected_reason', r.rejected_reason,
    'down_payment', r.down_payment,
    -- once staff collected the balance the payment record says 'full'; the customer still sees the original online payment + the balance paid at the studio
    'payment_option', case when coalesce(r.balance_paid, 0) > 0 then 'down' else coalesce(r.payment_option, 'down') end,
    'balance_paid', coalesce(r.balance_paid, 0),
    'addons_paid', public.booking_addon_paid(r.booking_id),
    'balance_due', greatest(0, r.total + ad_total - r.down_payment - public.booking_addon_paid(r.booking_id) - coalesce(r.balance_paid, 0)),
    -- NEW (45): booking paid in full, but equipment added later still has a balance to pay at the studio
    'addon_balance', case when coalesce(r.down_payment, 0) <= 0 then public.booking_balance_due(r.booking_id) else 0 end);
end $$;

create or replace function public.lookup_rental(p_ref text, p_phone text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare ref text := upper(regexp_replace(coalesce(p_ref, ''), '\s', '', 'g')); result jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object(
           'rental_ref', o.rental_ref,
           'rental_type', o.rental_type,
           'equipment', e.name,
           'quantity', d.quantity,
           'return_by', case when o.rental_type = 'Outside' then o.return_date else b.end_at end,
           'status', o.status,
           'rejected_reason', o.rejected_reason
         ) order by o.rental_order_id, e.name), '[]'::jsonb)
    into result
  from public.rental_order o
  join public.rental_detail d on d.rental_order_id = o.rental_order_id
  join public.equipment e on e.equipment_id = d.equipment_id
  join public.customer c on c.customer_id = o.customer_id
  left join public.booking b on b.booking_id = o.booking_id
  where (o.rental_ref = ref or b.booking_ref = ref)
    -- registered customers' rentals are private: only the account owner or staff may read them
    and (c.auth_user_id is null or c.auth_user_id = auth.uid() or public.is_staff())
    -- B-01: without the matching phone number, nobody but the account owner or staff may read a rental
    and (public.is_staff() or c.auth_user_id = auth.uid()
         or (p_phone is not null and public.digits(c.number) = public.digits(p_phone)));

  if jsonb_array_length(result) = 0 then return null; end if;
  return result;
end $$;

-- ---------------------------------------------------------------------
-- B-02  hold_slot: per-IP throttle + per-studio hold cap
-- ---------------------------------------------------------------------
create table if not exists public.slot_hold_attempt (
  ip text not null,
  at timestamptz not null default now()
);
create index if not exists slot_hold_attempt_ip_idx on public.slot_hold_attempt (ip);
create index if not exists slot_hold_attempt_at_idx on public.slot_hold_attempt (at);
revoke all on public.slot_hold_attempt from public, anon, authenticated;

create or replace function public.hold_slot(p_studio_id bigint, p_start_at timestamptz, p_end_at timestamptz, p_token text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_ip text;
begin
  if p_token is null or length(p_token) < 8 or length(p_token) > 80 then
    raise exception 'Missing hold token.' using errcode = 'P0001';
  end if;

  -- B-02: a real customer renews about twice a minute while a form is open; anything much faster
  -- is a script trying to pin slots. Count attempts per caller IP over a 10-minute window.
  begin
    v_ip := split_part(coalesce(current_setting('request.headers', true), '{}')::json ->> 'x-forwarded-for', ',', 1);
  exception when others then v_ip := null;
  end;
  if v_ip is null or v_ip = '' then v_ip := 'direct'; end if;
  insert into public.slot_hold_attempt (ip) values (v_ip);
  delete from public.slot_hold_attempt where at < now() - interval '10 minutes';
  if (select count(*) from public.slot_hold_attempt a where a.ip = v_ip) > 60 then
    raise exception 'Too many booking attempts from this connection. Please wait a few minutes and try again.' using errcode = 'P0001';
  end if;

  perform public.validate_slot(p_start_at, p_end_at, false);
  perform pg_advisory_xact_lock(hashtextextended('studio:' || p_studio_id, 0));

  delete from public.slot_hold where expires_at < now() or token = p_token;

  -- B-02: no more than 10 different people may hold hours of one studio at the same time
  -- (a busy signal, not an error: they can try again a moment later)
  if (select count(distinct token) from public.slot_hold
      where studio_id = p_studio_id and expires_at > now() and token is distinct from p_token) >= 10 then
    raise exception 'This studio is very busy right now. Please try again in a moment.' using errcode = 'P0001';
  end if;

  if exists (select 1 from public.studio where studio_id = p_studio_id and status <> 'Available') then
    return false;
  end if;
  if exists (
    select 1 from public.booking b
    where b.studio_id = p_studio_id and b.status in ('Pending', 'Approved', 'In Progress')
      and tstzrange(b.start_at, b.end_at, '[)') && tstzrange(p_start_at, p_end_at, '[)')
  ) then
    return false;
  end if;
  if public.slot_held_by_other(p_studio_id, p_start_at, p_end_at, p_token) then
    return false;
  end if;

  insert into public.slot_hold (studio_id, start_at, end_at, token, expires_at)
  values (p_studio_id, p_start_at, p_end_at, p_token,
          now() + make_interval(mins => public.slot_hold_minutes()));   -- B-04: the hold length comes from app_setting
  return true;
end $$;

-- ---------------------------------------------------------------------
-- B-03  Real Philippine mobile numbers on the online paths
-- ---------------------------------------------------------------------
create or replace function public.create_booking(
  p_studio_id bigint, p_start_at timestamptz, p_end_at timestamptz,
  p_first_name text, p_last_name text, p_number text,
  p_payment_method text, p_gcash_reference text default null, p_hold_token text default null
) returns table (booking_id bigint, booking_ref text, total_amount numeric, status text)
language plpgsql security definer set search_path = public as $$
declare cid bigint; b public.booking; num text := nullif(trim(coalesce(p_number, '')), '');
begin
  perform public.validate_slot(p_start_at, p_end_at, false);

  if p_payment_method not in ('GCash', 'Cash') then
    raise exception 'Choose GCash or Cash.' using errcode = 'P0001';
  end if;
  if p_payment_method = 'GCash' and length(trim(coalesce(p_gcash_reference, ''))) < 6 then
    raise exception 'Enter your GCash reference number.' using errcode = 'P0001';
  end if;

  -- guests must give a Philippine mobile number so the studio can reach them
  -- (B-03: 11 digits starting with 09; the 7-20 char column check stays for staff/onsite records)
  if public.current_customer_id() is null and (num is null or public.digits(num) !~ '^09[0-9]{9}$') then
    raise exception 'Enter a valid 11-digit Philippine mobile number (e.g. 0917 123 4567).' using errcode = 'P0001';
  end if;

  cid := public.resolve_customer(p_first_name, p_last_name, p_number, false);

  begin
    b := public.insert_booking_with_payment(cid, p_studio_id, p_start_at, p_end_at,
           p_payment_method, p_gcash_reference, 'Online', null, p_hold_token);
  exception when unique_violation then
    raise exception 'That GCash reference was already used.' using errcode = 'P0001';
  end;

  return query select b.booking_id, b.booking_ref::text, public.booking_total(b.booking_id), b.status::text;
end $$;

create or replace function public.request_rental(
  p_type text, p_items jsonb,
  p_booking_ref text default null,
  p_first_name text default null, p_last_name text default null, p_number text default null,
  p_pickup_date timestamptz default null, p_return_date timestamptz default null,
  p_contact_number text default null, p_backup_contact text default null,
  p_id_type text default null, p_id_image_path text default null
) returns table (rental_order_id bigint, rental_ref text, total_amount numeric)
language plpgsql security definer set search_path = public as $$
declare
  o public.rental_order; bk public.booking; cid bigint;
  it jsonb; eq public.equipment; qty int; rate numeric; hrs numeric; min_h int := 0;
  w_s timestamptz; w_e timestamptz; taken int;   -- the hours the equipment is needed
  tok text := nullif(current_setting('app.eq_hold_token', true), '');   -- this browser's equipment hold (file 89)
begin
  if p_type not in ('Add-on', 'Outside') then
    raise exception 'Choose Add-on or Outside.' using errcode = 'P0001';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one item.' using errcode = 'P0001';
  end if;

  if p_type = 'Add-on' then
    select * into bk from public.booking where booking_ref = upper(regexp_replace(coalesce(p_booking_ref, ''), '\s', '', 'g'));
    if not found then raise exception 'Booking reference not found.' using errcode = 'P0001'; end if;
    if bk.status not in ('Pending', 'Approved', 'In Progress') then
      raise exception 'Add-ons need an active booking. This one is %.', bk.status using errcode = 'P0001';
    end if;
    if public.current_customer_id() is not null and bk.customer_id <> public.current_customer_id() then
      raise exception 'That is not your booking.' using errcode = '42501';
    end if;
    cid := bk.customer_id;
    w_s := bk.start_at; w_e := bk.end_at;          -- an add-on is needed for the whole session
  else
    if p_pickup_date is null or p_return_date is null or p_return_date <= p_pickup_date then
      raise exception 'Choose valid pickup and return times.' using errcode = 'P0001';
    end if;
    if p_pickup_date < now() - interval '1 hour' then
      raise exception 'Pickup cannot be in the past.' using errcode = 'P0001';
    end if;
    -- B-03: the renter's contact number must be a real 11-digit Philippine mobile number
    if nullif(trim(coalesce(p_contact_number, '')), '') is null
       or public.digits(p_contact_number) !~ '^09[0-9]{9}$' then
      raise exception 'Enter a valid 11-digit Philippine mobile number (e.g. 0917 123 4567).' using errcode = 'P0001';
    end if;
    if p_backup_contact is not null and p_backup_contact <> '' and p_backup_contact !~ '^[0-9+()\s-]{7,20}$' then
      raise exception 'Enter a valid backup contact number.' using errcode = 'P0001';
    end if;
    if nullif(trim(coalesce(p_id_type, '')), '') is null then
      raise exception 'Choose the type of ID you will show.' using errcode = 'P0001';
    end if;
    if p_id_image_path is null or p_id_image_path !~ '^[A-Za-z0-9/_.-]{5,200}$' or p_id_image_path like '%..%' then
      raise exception 'Attach a photo of your valid ID.' using errcode = 'P0001';
    end if;
    cid := public.resolve_customer(p_first_name, p_last_name, coalesce(p_number, p_contact_number), false);
    w_s := p_pickup_date; w_e := p_return_date;    -- an outside rental is needed from pick-up to return
  end if;

  -- QA fix: lock the requested equipment rows (always in id order, so two requests cannot deadlock) BEFORE counting
  -- what is free. Without this, two customers asking for the last item at the same moment (even for two different
  -- studios) both saw it free and both got a Pending request.
  perform 1 from public.equipment
   where equipment_id in (select (x ->> 'equipment_id')::bigint from jsonb_array_elements(p_items) x)
   order by equipment_id for update;

  insert into public.rental_order (rental_ref, customer_id, rental_type, booking_id, status, source,
                                   pickup_date, return_date, contact_number, backup_contact, id_type, id_image_path)
  values ('', cid, p_type, bk.booking_id, 'Pending', 'Online',
          p_pickup_date, p_return_date, nullif(trim(p_contact_number), ''), nullif(trim(p_backup_contact), ''),
          nullif(trim(p_id_type), ''), p_id_image_path)
  returning * into o;

  for it in select * from jsonb_array_elements(p_items) loop
    qty := (it ->> 'quantity')::int;
    select * into eq from public.equipment where equipment_id = (it ->> 'equipment_id')::bigint;
    if not found then raise exception 'Equipment not found.' using errcode = 'P0001'; end if;
    if qty is null or qty < 1 then raise exception 'Quantity must be at least 1.' using errcode = 'P0001'; end if;
    if eq.status <> 'Available' then raise exception '% is not available for rent.', eq.name using errcode = 'P0001'; end if;
    if qty > eq.total_quantity then raise exception 'We only own % of %.', eq.total_quantity, eq.name using errcode = 'P0001'; end if;
    -- NEW: enough must be free for THOSE hours (other approved / issued add-ons and outside rentals that overlap them count)
    -- file 89: other customers' checkout holds count too (this browser's own hold does not)
    taken := public.equipment_in_use_between(eq.equipment_id, w_s, w_e, null)
           + public.equipment_held_by_checkout(eq.equipment_id, w_s, w_e, tok);
    if taken + qty > eq.total_quantity then
      raise exception 'Only % of % available for those hours (the rest is already reserved by another booking or rental). Choose a smaller quantity, other hours, or another item.',
        greatest(eq.total_quantity - taken, 0), eq.name using errcode = 'P0001';
    end if;

    if p_type = 'Add-on' then
      if not eq.allow_addon then raise exception '% cannot be rented as an add-on.', eq.name using errcode = 'P0001'; end if;
      rate := eq.add_on_rate; hrs := null;
    else
      if not eq.allow_outside then raise exception '% cannot be rented outside the studio.', eq.name using errcode = 'P0001'; end if;
      rate := eq.outside_rate;
      hrs  := round(extract(epoch from (p_return_date - p_pickup_date)) / 3600.0, 2);
      min_h := greatest(min_h, eq.min_hours);
    end if;

    insert into public.rental_detail (rental_order_id, equipment_id, quantity, unit_price_at_request, rental_hours)
    values (o.rental_order_id, eq.equipment_id, qty, rate, hrs);
  end loop;

  if p_type = 'Outside' and extract(epoch from (p_return_date - p_pickup_date)) / 3600.0 < min_h then
    raise exception 'Outside rentals are at least % hours.', min_h using errcode = 'P0001';
  end if;

  -- the order itself holds the items now, so the checkout hold is no longer needed
  if tok is not null then delete from public.equipment_hold where token = tok; end if;

  return query select o.rental_order_id, o.rental_ref::text, public.rental_order_total(o.rental_order_id);
exception when unique_violation then
  raise exception 'Each item can only be listed once per request.' using errcode = 'P0001';
end $$;

-- ---------------------------------------------------------------------
-- Self-check (optional): run these to confirm the migration took effect
-- ---------------------------------------------------------------------
-- select key, value from public.app_setting where key in ('booking_window_days', 'change_cutoff_hours', 'slot_hold_minutes') order by key;
-- select public.get_public_settings();

-- end of 94_qa_hardening.sql