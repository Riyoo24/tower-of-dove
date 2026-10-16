-- =====================================================================
-- Tower of Dove Music Studio: Supabase schema
-- File 1 of 4: extensions, tables, constraints, helpers, triggers
--
-- Run the files in order in the Supabase SQL Editor:
--   01_schema.sql   -> tables, constraints, triggers
--   02_functions.sql-> RPC functions used by the website, reporting views
--   03_security.sql -> grants, Row Level Security, Storage buckets
--   04_seed.sql     -> studios, categories, equipment
-- (supabase/all_in_one.sql is the same four files joined together.)
--
-- Naming: lowercase snake_case (the doc's "User" is a reserved word in
-- Postgres, so it is app_user here).
-- Business timezone: Asia/Manila. Opening hours 10:00 to 22:00.
-- =====================================================================

create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------
-- Reference numbers
-- ---------------------------------------------------------------------
create sequence if not exists public.booking_ref_seq   start 1000;  -- TOD-1000
create sequence if not exists public.rental_out_seq    start 2000;  -- OUT-2000
create sequence if not exists public.rental_addon_seq  start 1;     -- RA-0001


-- ---------------------------------------------------------------------
-- 1. app_user  (Owner and Staff profiles; passwords live in Supabase Auth)
-- ---------------------------------------------------------------------
create table if not exists public.app_user (
  user_id       bigint generated always as identity primary key,
  auth_user_id  uuid not null unique references auth.users (id) on delete cascade,
  first_name    varchar(100) not null,
  last_name     varchar(100) not null,
  username      varchar(50)  not null,
  number        varchar(20),
  email         varchar(255),                       -- real contact email (optional)
  role          varchar(20)  not null,
  status        varchar(20)  not null default 'Active',
  created_at    timestamptz  not null default now(),
  updated_at    timestamptz  not null default now(),
  constraint app_user_role_chk     check (role in ('Owner', 'Staff')),
  constraint app_user_status_chk   check (status in ('Active', 'Inactive')),
  constraint app_user_username_chk check (username ~ '^[a-z0-9_.]{3,30}$')
);
create unique index if not exists app_user_username_uq on public.app_user (lower(username));


-- ---------------------------------------------------------------------
-- 2. customer  (registered customers and guests)
--    Guests have auth_user_id and username NULL.
-- ---------------------------------------------------------------------
create table if not exists public.customer (
  customer_id   bigint generated always as identity primary key,
  auth_user_id  uuid unique references auth.users (id) on delete set null,
  first_name    varchar(100) not null,
  last_name     varchar(100) not null default '',
  username      varchar(50),
  number        varchar(20),
  email         varchar(255),
  status        varchar(20)  not null default 'Active',
  created_at    timestamptz  not null default now(),
  updated_at    timestamptz  not null default now(),
  constraint customer_status_chk   check (status in ('Active', 'Inactive')),
  constraint customer_username_chk check (username is null or username ~ '^[a-z0-9_.]{3,30}$'),
  constraint customer_number_chk   check (number is null or number ~ '^[0-9+()\s-]{7,20}$'),
  constraint customer_guest_chk    check (auth_user_id is not null or username is null)
);
create unique index if not exists customer_username_uq on public.customer (lower(username)) where username is not null;
create index if not exists customer_number_idx on public.customer (number);


-- ---------------------------------------------------------------------
-- 3. studio
-- ---------------------------------------------------------------------
create table if not exists public.studio (
  studio_id    bigint generated always as identity primary key,
  name         varchar(100) not null,
  image        text,
  description  text,
  capacity     integer      not null default 5,
  hourly_rate  numeric(10,2) not null,
  status       varchar(20)  not null default 'Available',   -- "Occupied" is derived from an In Progress booking
  created_at   timestamptz  not null default now(),
  updated_at   timestamptz  not null default now(),
  constraint studio_capacity_chk check (capacity > 0),
  constraint studio_rate_chk     check (hourly_rate >= 0),
  constraint studio_status_chk   check (status in ('Available', 'Unavailable', 'Maintenance'))
);
create unique index if not exists studio_name_uq on public.studio (lower(name));


-- ---------------------------------------------------------------------
-- 4. equipment_category
-- ---------------------------------------------------------------------
create table if not exists public.equipment_category (
  category_id    bigint generated always as identity primary key,
  category_name  varchar(100) not null unique
);


-- ---------------------------------------------------------------------
-- 5. equipment
--    Added vs the doc: min_hours, is_drum_set, drum_kit, is_vip, updated_at.
--    Rates: add_on_rate is per session; outside_rate is per day.
--    Drum sets are priced per rental (both rates hold the rental price).
--    min_hours is the minimum length of an OUTSIDE rental.
-- ---------------------------------------------------------------------
create table if not exists public.equipment (
  equipment_id    bigint generated always as identity primary key,
  name            varchar(150) not null,
  image           text,
  category_id     bigint not null references public.equipment_category (category_id),
  description     text,
  total_quantity  integer not null default 0,
  add_on_rate     numeric(10,2),
  outside_rate    numeric(10,2),
  allow_addon     boolean not null default true,
  allow_outside   boolean not null default false,
  min_hours       integer not null default 0,
  is_drum_set     boolean not null default false,
  drum_kit        varchar(100),
  is_vip          boolean not null default false,
  status          varchar(20) not null default 'Available',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint equipment_qty_chk      check (total_quantity >= 0),
  constraint equipment_addon_chk    check (add_on_rate  is null or add_on_rate  >= 0),
  constraint equipment_outside_chk  check (outside_rate is null or outside_rate >= 0),
  constraint equipment_min_chk      check (min_hours >= 0),
  constraint equipment_status_chk   check (status in ('Available', 'Unavailable')),
  constraint equipment_addon_rate_required   check (not allow_addon   or add_on_rate  is not null),
  constraint equipment_outside_rate_required check (not allow_outside or outside_rate is not null),
  constraint equipment_drum_chk     check (not is_drum_set or drum_kit is not null)
);
create unique index if not exists equipment_name_uq on public.equipment (lower(name));
create index if not exists equipment_category_idx on public.equipment (category_id);


-- ---------------------------------------------------------------------
-- 6. booking
--    start_at/end_at are the scheduled times; actual_* are what happened.
--    original_* keep the first schedule if a customer reschedules.
--    The exclusion constraint makes double-booking impossible.
-- ---------------------------------------------------------------------
create table if not exists public.booking (
  booking_id              bigint generated always as identity primary key,
  booking_ref             varchar(30) not null unique default ('TOD-' || nextval('public.booking_ref_seq')),
  customer_id             bigint not null references public.customer (customer_id),
  studio_id               bigint not null references public.studio (studio_id),
  start_at                timestamptz not null,
  end_at                  timestamptz not null,
  actual_start_at         timestamptz,
  actual_end_at           timestamptz,
  original_start_at       timestamptz,
  original_end_at         timestamptz,
  reschedule_count        integer not null default 0,
  hourly_rate_at_booking  numeric(10,2) not null,
  status                  varchar(20) not null default 'Pending',
  source                  varchar(10) not null default 'Online',
  approved_by             bigint references public.app_user (user_id) on delete set null,
  created_by              bigint references public.app_user (user_id) on delete set null,   -- staff who recorded an onsite booking
  cancelled_reason        text,
  rejected_reason         text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint booking_time_chk    check (end_at > start_at),
  constraint booking_actual_chk  check (actual_end_at is null or actual_start_at is null or actual_end_at >= actual_start_at),
  constraint booking_rate_chk    check (hourly_rate_at_booking >= 0),
  constraint booking_status_chk  check (status in ('Pending', 'Approved', 'In Progress', 'Completed', 'Rejected', 'Cancelled')),
  constraint booking_source_chk  check (source in ('Online', 'Onsite')),
  constraint booking_no_overlap  exclude using gist (
    studio_id with =,
    tstzrange(start_at, end_at, '[)') with &&
  ) where (status in ('Pending', 'Approved', 'In Progress'))
);
create index if not exists booking_customer_idx on public.booking (customer_id);
create index if not exists booking_studio_time_idx on public.booking (studio_id, start_at);
create index if not exists booking_status_idx on public.booking (status, actual_end_at desc);


-- ---------------------------------------------------------------------
-- 7. rental_order
--    rental_ref: Outside -> OUT-2000..., Add-on -> RA-0001...
--    (customers look add-ons up with their booking reference).
-- ---------------------------------------------------------------------
create table if not exists public.rental_order (
  rental_order_id  bigint generated always as identity primary key,
  rental_ref       varchar(30) not null unique,
  customer_id      bigint not null references public.customer (customer_id),
  rental_type      varchar(20) not null,
  booking_id       bigint references public.booking (booking_id),
  status           varchar(20) not null default 'Pending',
  source           varchar(10) not null default 'Online',
  approved_by      bigint references public.app_user (user_id) on delete set null,
  created_by       bigint references public.app_user (user_id) on delete set null,
  pickup_date      timestamptz,
  return_date      timestamptz,
  contact_number   varchar(20),
  backup_contact   varchar(20),
  id_type          varchar(50),
  id_image_path    text,
  rejected_reason  text,
  issued_at        timestamptz,
  returned_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint rental_type_chk   check (rental_type in ('Add-on', 'Outside')),
  constraint rental_status_chk check (status in ('Pending', 'Approved', 'Rejected', 'Active', 'Returned', 'Cancelled')),
  constraint rental_source_chk check (source in ('Online', 'Onsite')),
  constraint rental_type_booking_chk check (
    (rental_type = 'Add-on'  and booking_id is not null) or
    (rental_type = 'Outside' and booking_id is null)
  ),
  constraint rental_dates_chk check (return_date is null or pickup_date is null or return_date > pickup_date),
  constraint rental_outside_fields_chk check (
    rental_type = 'Add-on' or (pickup_date is not null and return_date is not null and id_type is not null)
  ),
  constraint rental_online_outside_chk check (
    rental_type = 'Add-on' or source = 'Onsite' or (contact_number is not null and id_image_path is not null)
  ),
  constraint rental_rejected_reason_chk check (status <> 'Rejected' or rejected_reason is not null)
);
create index if not exists rental_order_customer_idx on public.rental_order (customer_id);
create index if not exists rental_order_booking_idx  on public.rental_order (booking_id);
create index if not exists rental_order_status_idx   on public.rental_order (status, return_date);


-- ---------------------------------------------------------------------
-- 8. rental_detail  (one equipment line per row)
-- ---------------------------------------------------------------------
create table if not exists public.rental_detail (
  rental_detail_id       bigint generated always as identity primary key,
  rental_order_id        bigint not null references public.rental_order (rental_order_id) on delete cascade,
  equipment_id           bigint not null references public.equipment (equipment_id),
  quantity               integer not null,
  unit_price_at_request  numeric(10,2) not null,
  rental_hours           numeric(6,2),
  returned_at            timestamptz,
  constraint rental_detail_qty_chk   check (quantity > 0),
  constraint rental_detail_price_chk check (unit_price_at_request >= 0),
  constraint rental_detail_hours_chk check (rental_hours is null or rental_hours > 0),
  constraint rental_detail_uq unique (rental_order_id, equipment_id)
);
create index if not exists rental_detail_equipment_idx on public.rental_detail (equipment_id);


-- ---------------------------------------------------------------------
-- 9. payment  (new: the Payments tab verifies or rejects these)
--    Exactly one of booking_id / rental_order_id is set.
-- ---------------------------------------------------------------------
create table if not exists public.payment (
  payment_id       bigint generated always as identity primary key,
  booking_id       bigint references public.booking (booking_id) on delete cascade,
  rental_order_id  bigint references public.rental_order (rental_order_id) on delete cascade,
  method           varchar(10) not null,
  gcash_reference  varchar(40),
  amount           numeric(10,2) not null,
  status           varchar(10) not null default 'Pending',
  verified_by      bigint references public.app_user (user_id) on delete set null,
  verified_at      timestamptz,
  created_at       timestamptz not null default now(),
  constraint payment_target_chk check (num_nonnulls(booking_id, rental_order_id) = 1),
  constraint payment_method_chk check (method in ('GCash', 'Cash')),
  constraint payment_status_chk check (status in ('Pending', 'Verified', 'Rejected')),
  constraint payment_amount_chk check (amount >= 0),
  constraint payment_gcash_chk  check (method <> 'GCash' or gcash_reference is not null)
);
create unique index if not exists payment_booking_uq on public.payment (booking_id) where booking_id is not null and status <> 'Rejected';
create unique index if not exists payment_rental_uq  on public.payment (rental_order_id) where rental_order_id is not null and status <> 'Rejected';
-- one GCash reference can only be used once (unless the earlier payment was rejected)
create unique index if not exists payment_gcash_uq on public.payment (lower(gcash_reference)) where gcash_reference is not null and status <> 'Rejected';


-- ---------------------------------------------------------------------
-- 10. slot_hold  (replaces the 2-minute browser locks)
--     Touched only through hold_slot() / release_hold().
-- ---------------------------------------------------------------------
create table if not exists public.slot_hold (
  hold_id     bigint generated always as identity primary key,
  studio_id   bigint not null references public.studio (studio_id) on delete cascade,
  start_at    timestamptz not null,
  end_at      timestamptz not null,
  token       text not null,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now(),
  constraint slot_hold_time_chk check (end_at > start_at)
);
create index if not exists slot_hold_token_idx on public.slot_hold (token);
create index if not exists slot_hold_studio_idx on public.slot_hold (studio_id, start_at);


-- =====================================================================
-- Helper functions (used by policies, triggers and RPCs)
-- =====================================================================

-- Supabase provides auth.uid(). These wrap it for staff and customers.
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_user where auth_user_id = auth.uid() and status = 'Active');
$$;

create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_user where auth_user_id = auth.uid() and status = 'Active' and role = 'Owner');
$$;

create or replace function public.current_app_user_id() returns bigint
language sql stable security definer set search_path = public as $$
  select user_id from public.app_user where auth_user_id = auth.uid() and status = 'Active';
$$;

create or replace function public.current_customer_id() returns bigint
language sql stable security definer set search_path = public as $$
  select customer_id from public.customer where auth_user_id = auth.uid() and status = 'Active';
$$;

-- digits only, for comparing phone numbers typed in different formats
create or replace function public.digits(p text) returns text
language sql immutable as $$ select regexp_replace(coalesce(p, ''), '\D', '', 'g'); $$;

-- Quantity of an equipment item that is out (Approved or Active, not yet returned)
create or replace function public.equipment_in_use(p_equipment_id bigint, p_exclude_order bigint default null)
returns integer language sql stable security definer set search_path = public as $$
  select coalesce(sum(d.quantity), 0)::int
  from public.rental_detail d
  join public.rental_order o on o.rental_order_id = d.rental_order_id
  where d.equipment_id = p_equipment_id
    and o.status in ('Approved', 'Active')
    and d.returned_at is null
    and (p_exclude_order is null or o.rental_order_id <> p_exclude_order);
$$;

-- Order total: add-ons and drum sets are per rental/session, other outside
-- items are per day (rounded up from the pickup and return times).
create or replace function public.rental_order_total(p_order_id bigint) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(
    d.quantity * d.unit_price_at_request *
    case when o.rental_type = 'Outside' and not e.is_drum_set
         then greatest(1, ceil(coalesce(d.rental_hours, 24) / 24.0))
         else 1 end
  ), 0)::numeric(10,2)
  from public.rental_order o
  join public.rental_detail d on d.rental_order_id = o.rental_order_id
  join public.equipment e on e.equipment_id = d.equipment_id
  where o.rental_order_id = p_order_id;
$$;

create or replace function public.booking_total(p_booking_id bigint) returns numeric
language sql stable security definer set search_path = public as $$
  select round(b.hourly_rate_at_booking * extract(epoch from (b.end_at - b.start_at)) / 3600.0, 2)
  from public.booking b where b.booking_id = p_booking_id;
$$;


-- =====================================================================
-- Triggers
-- =====================================================================

-- updated_at ----------------------------------------------------------
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['app_user', 'customer', 'studio', 'equipment', 'booking', 'rental_order'] loop
    execute format('drop trigger if exists trg_touch on public.%I', t);
    execute format('create trigger trg_touch before update on public.%I for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;


-- Protect columns that only staff may change ---------------------------
create or replace function public.protect_customer_columns() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- auth.uid() is NULL for the dashboard SQL editor and the service_role key
  if auth.uid() is not null and not public.is_staff() then
    if new.status is distinct from old.status
       or new.auth_user_id is distinct from old.auth_user_id then
      raise exception 'Only staff can change status or the linked login.' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_protect on public.customer;
create trigger trg_protect before update on public.customer
  for each row execute function public.protect_customer_columns();

create or replace function public.protect_user_columns() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_owner() then
    if new.role is distinct from old.role
       or new.status is distinct from old.status
       or new.auth_user_id is distinct from old.auth_user_id
       or new.username is distinct from old.username then
      raise exception 'Only the owner can change role, status or username.' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_protect on public.app_user;
create trigger trg_protect before update on public.app_user
  for each row execute function public.protect_user_columns();


-- booking: rate snapshot, history, status rules, approver ---------------
create or replace function public.booking_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.hourly_rate_at_booking is null then
      select hourly_rate into new.hourly_rate_at_booking from public.studio where studio_id = new.studio_id;
    end if;
    new.original_start_at := coalesce(new.original_start_at, new.start_at);
    new.original_end_at   := coalesce(new.original_end_at,   new.end_at);
    return new;
  end if;

  -- UPDATE
  if old.status in ('Completed', 'Rejected', 'Cancelled') and new.status <> old.status then
    raise exception 'A % booking cannot be changed to %.', old.status, new.status;
  end if;

  if new.status is distinct from old.status then
    if new.status in ('Approved', 'Rejected') and new.approved_by is null then
      new.approved_by := public.current_app_user_id();
    end if;
    if new.status = 'In Progress' then
      new.actual_start_at := coalesce(new.actual_start_at, now());
    elsif new.status = 'Completed' then
      new.actual_start_at := coalesce(new.actual_start_at, new.start_at);
      new.actual_end_at   := coalesce(new.actual_end_at, now());
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_booking_write on public.booking;
create trigger trg_booking_write before insert or update on public.booking
  for each row execute function public.booking_before_write();


-- payment: verifying or rejecting moves the booking along ---------------
create or replace function public.payment_stamp_verifier() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status then
    if new.status in ('Verified', 'Rejected') then
      new.verified_by := coalesce(new.verified_by, public.current_app_user_id());
      new.verified_at := coalesce(new.verified_at, now());
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_payment_stamp on public.payment;
create trigger trg_payment_stamp before update on public.payment
  for each row execute function public.payment_stamp_verifier();

create or replace function public.payment_effects() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status is distinct from old.status and new.booking_id is not null then
    if new.status = 'Verified' then
      update public.booking set status = 'Approved'
       where booking_id = new.booking_id and status = 'Pending';
    elsif new.status = 'Rejected' then
      update public.booking set status = 'Rejected', rejected_reason = coalesce(rejected_reason, 'Payment rejected')
       where booking_id = new.booking_id and status = 'Pending';
    end if;
  end if;
  return null;
end $$;
drop trigger if exists trg_payment_effects on public.payment;
create trigger trg_payment_effects after update on public.payment
  for each row execute function public.payment_effects();


-- rental_order: reference numbers, approver, issue/return stamps --------
create or replace function public.rental_order_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.rental_ref is null or new.rental_ref = '' then
      new.rental_ref := case new.rental_type
        when 'Outside' then 'OUT-' || nextval('public.rental_out_seq')
        else 'RA-' || lpad(nextval('public.rental_addon_seq')::text, 4, '0') end;
    end if;
    if new.status = 'Active' then
      new.issued_at := coalesce(new.issued_at, now());
    end if;
    return new;
  end if;

  if old.status in ('Returned', 'Rejected', 'Cancelled') and new.status <> old.status then
    raise exception 'A % rental cannot be changed to %.', old.status, new.status;
  end if;

  if new.status is distinct from old.status then
    if new.status in ('Approved', 'Rejected') and new.approved_by is null then
      new.approved_by := public.current_app_user_id();
    end if;
    if new.status = 'Active' then
      new.issued_at := coalesce(new.issued_at, now());
    elsif new.status = 'Returned' then
      new.returned_at := coalesce(new.returned_at, now());
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_rental_write on public.rental_order;
create trigger trg_rental_write before insert or update on public.rental_order
  for each row execute function public.rental_order_before_write();

-- when the order comes back, every line comes back
create or replace function public.rental_order_returned() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'Returned' and old.status is distinct from 'Returned' then
    update public.rental_detail set returned_at = coalesce(returned_at, new.returned_at, now())
     where rental_order_id = new.rental_order_id;
  end if;
  return null;
end $$;
drop trigger if exists trg_rental_returned on public.rental_order;
create trigger trg_rental_returned after update of status on public.rental_order
  for each row execute function public.rental_order_returned();


-- Stock check: an order cannot be Approved/Active if there isn't enough ----
create or replace function public.assert_order_stock(p_order_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare r record; in_use int;
begin
  for r in
    select d.equipment_id, d.quantity, e.name, e.total_quantity, e.status
    from public.rental_detail d
    join public.equipment e on e.equipment_id = d.equipment_id
    where d.rental_order_id = p_order_id and d.returned_at is null
    order by d.equipment_id
  loop
    -- lock the equipment row so two approvals cannot both take the last item
    perform 1 from public.equipment where equipment_id = r.equipment_id for update;
    in_use := public.equipment_in_use(r.equipment_id, p_order_id);
    if r.status <> 'Available' then
      raise exception '% is not available for rent right now.', r.name using errcode = 'P0001';
    end if;
    if in_use + r.quantity > r.total_quantity then
      raise exception 'Only % of % available, but this order needs %.',
        greatest(r.total_quantity - in_use, 0), r.name, r.quantity using errcode = 'P0001';
    end if;
  end loop;
end $$;

create or replace function public.rental_detail_stock_trg() returns trigger
language plpgsql security definer set search_path = public as $$
declare s text;
begin
  select status into s from public.rental_order where rental_order_id = new.rental_order_id;
  if s in ('Approved', 'Active') then
    perform public.assert_order_stock(new.rental_order_id);
  end if;
  return null;
end $$;
drop trigger if exists trg_detail_stock on public.rental_detail;
create trigger trg_detail_stock after insert or update of quantity, equipment_id on public.rental_detail
  for each row execute function public.rental_detail_stock_trg();

create or replace function public.rental_order_stock_trg() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('Approved', 'Active') and old.status not in ('Approved', 'Active') then
    perform public.assert_order_stock(new.rental_order_id);
  end if;
  return null;
end $$;
drop trigger if exists trg_order_stock on public.rental_order;
create trigger trg_order_stock after update of status on public.rental_order
  for each row execute function public.rental_order_stock_trg();


-- New sign-ups become customers --------------------------------------
-- The website calls supabase.auth.signUp({ email, password, options: { data: {
--   kind: 'customer', full_name: '...', username: '...', number: '09...' } } }).
-- Only kind = 'customer' creates a row, so a sign-up can never create staff.
create or replace function public.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  full_name text := trim(coalesce(m ->> 'full_name', ''));
  fn text; ln text;
begin
  if m ->> 'kind' is distinct from 'customer' then
    return new;
  end if;

  if coalesce(m ->> 'first_name', '') <> '' then
    fn := trim(m ->> 'first_name');
    ln := trim(coalesce(m ->> 'last_name', ''));
  elsif position(' ' in full_name) > 0 then
    fn := regexp_replace(full_name, '\s+\S+$', '');
    ln := substring(full_name from '\S+$');
  else
    fn := nullif(full_name, '');
    ln := '';
  end if;

  insert into public.customer (auth_user_id, first_name, last_name, username, number, email)
  values (
    new.id,
    coalesce(fn, 'Customer'),
    coalesce(ln, ''),
    nullif(lower(trim(m ->> 'username')), ''),
    nullif(trim(m ->> 'number'), ''),
    nullif(trim(coalesce(m ->> 'contact_email', '')), '')
  );
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_auth_user();
