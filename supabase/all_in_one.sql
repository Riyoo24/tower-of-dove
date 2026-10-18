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
-- =====================================================================
-- Tower of Dove Music Studio: Supabase schema
-- File 2 of 4: RPC functions (what the website calls) and views
--
-- Call from supabase-js with  supabase.rpc('function_name', { p_... })
-- All of these are SECURITY DEFINER and validate their own input, so the
-- tables themselves stay locked down (see 03_security.sql).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Internal helpers (not exposed to the website)
-- ---------------------------------------------------------------------

-- Opening hours 10:00 to 22:00 Manila, whole hours, 1 to 4 hours, same day.
create or replace function public.validate_slot(p_start timestamptz, p_end timestamptz, p_allow_current_hour boolean default false)
returns void language plpgsql stable set search_path = public as $$
declare
  s timestamp := p_start at time zone 'Asia/Manila';
  e timestamp := p_end   at time zone 'Asia/Manila';
  hrs numeric := extract(epoch from (p_end - p_start)) / 3600.0;
begin
  if p_start is null or p_end is null or p_end <= p_start then
    raise exception 'Choose a valid start and end time.' using errcode = 'P0001';
  end if;
  if extract(minute from s) <> 0 or extract(second from s) <> 0
     or extract(minute from e) <> 0 or extract(second from e) <> 0 then
    raise exception 'Bookings start and end on the hour.' using errcode = 'P0001';
  end if;
  if hrs < 1 or hrs > 4 or hrs <> floor(hrs) then
    raise exception 'Bookings are 1 to 4 whole hours.' using errcode = 'P0001';
  end if;
  if s::date <> e::date or extract(hour from s) < 10 or e::time > '22:00' then
    raise exception 'The studio is open 10:00 AM to 10:00 PM, and a booking must finish the same day.' using errcode = 'P0001';
  end if;
  if p_allow_current_hour then
    if p_start < date_trunc('hour', now()) then
      raise exception 'That time has already passed.' using errcode = 'P0001';
    end if;
  elsif p_start <= now() then
    raise exception 'Choose a time in the future.' using errcode = 'P0001';
  end if;
end $$;

-- Find or create the customer a booking/rental belongs to.
--   * signed-in customer  -> their own row
--   * guest or onsite     -> match on name + phone, or create a guest row
create or replace function public.resolve_customer(p_first text, p_last text, p_number text, p_force_guest boolean default false)
returns bigint language plpgsql security definer set search_path = public as $$
declare cid bigint; fn text := trim(coalesce(p_first, '')); ln text := trim(coalesce(p_last, '')); num text := nullif(trim(coalesce(p_number, '')), '');
begin
  if not p_force_guest then
    cid := public.current_customer_id();
    if cid is not null then
      -- keep the profile phone up to date if it was empty
      if num is not null then
        update public.customer set number = num where customer_id = cid and number is null;
      end if;
      return cid;
    end if;
  end if;

  if fn = '' then
    raise exception 'Enter the customer name.' using errcode = 'P0001';
  end if;
  if num is not null and num !~ '^[0-9+()\s-]{7,20}$' then
    raise exception 'Enter a valid phone number.' using errcode = 'P0001';
  end if;

  select customer_id into cid
  from public.customer
  where auth_user_id is null
    and lower(first_name) = lower(fn) and lower(last_name) = lower(ln)
    and (num is null or public.digits(number) = public.digits(num))
  order by customer_id limit 1;

  if cid is null then
    insert into public.customer (first_name, last_name, number) values (fn, ln, num) returning customer_id into cid;
  end if;
  return cid;
end $$;

-- Is any other person holding part of this slot right now?
create or replace function public.slot_held_by_other(p_studio_id bigint, p_start timestamptz, p_end timestamptz, p_token text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.slot_hold h
    where h.studio_id = p_studio_id
      and h.expires_at > now()
      and h.token is distinct from p_token
      and tstzrange(h.start_at, h.end_at, '[)') && tstzrange(p_start, p_end, '[)')
  );
$$;

-- Insert a booking + its payment. Used by the customer and staff RPCs.
create or replace function public.insert_booking_with_payment(
  p_customer_id bigint, p_studio_id bigint, p_start timestamptz, p_end timestamptz,
  p_method text, p_gcash text, p_source text, p_staff_id bigint, p_token text
) returns public.booking
language plpgsql security definer set search_path = public as $$
declare b public.booking; st public.studio; amount numeric;
begin
  perform pg_advisory_xact_lock(hashtextextended('studio:' || p_studio_id, 0));

  select * into st from public.studio where studio_id = p_studio_id;
  if not found then raise exception 'Studio not found.' using errcode = 'P0001'; end if;
  if p_source = 'Online' and st.status <> 'Available' then
    raise exception '% is not taking bookings right now.', st.name using errcode = 'P0001';
  end if;

  if public.slot_held_by_other(p_studio_id, p_start, p_end, p_token) then
    raise exception 'Those hours were just taken by another customer.' using errcode = 'P0001';
  end if;

  begin
    insert into public.booking (customer_id, studio_id, start_at, end_at, hourly_rate_at_booking,
                                status, source, approved_by, created_by)
    values (p_customer_id, p_studio_id, p_start, p_end, st.hourly_rate,
            case when p_source = 'Onsite' then 'Approved' else 'Pending' end,
            p_source,
            case when p_source = 'Onsite' then p_staff_id end,
            case when p_source = 'Onsite' then p_staff_id end)
    returning * into b;
  exception when exclusion_violation then
    raise exception 'That time is no longer available. Please pick another slot.' using errcode = 'P0001';
  end;

  amount := public.booking_total(b.booking_id);
  insert into public.payment (booking_id, method, gcash_reference, amount, status, verified_by, verified_at)
  values (b.booking_id, p_method, nullif(trim(p_gcash), ''), amount,
          case when p_source = 'Onsite' then 'Verified' else 'Pending' end,
          case when p_source = 'Onsite' then p_staff_id end,
          case when p_source = 'Onsite' then now() end);

  if p_token is not null then
    delete from public.slot_hold where token = p_token;
  end if;
  return b;
end $$;


-- ---------------------------------------------------------------------
-- Availability and slot holds (public: guests need them too)
-- ---------------------------------------------------------------------

-- Occupied ranges for a studio, for the calendar. No customer data returned.
create or replace function public.get_busy_slots(p_studio_id bigint, p_from timestamptz, p_to timestamptz, p_token text default null)
returns table (start_at timestamptz, end_at timestamptz, kind text)
language sql stable security definer set search_path = public as $$
  select b.start_at, b.end_at, 'booked'::text
  from public.booking b
  where b.studio_id = p_studio_id
    and b.status in ('Pending', 'Approved', 'In Progress')
    and b.start_at < p_to and b.end_at > p_from
  union all
  select h.start_at, h.end_at, 'held'::text
  from public.slot_hold h
  where h.studio_id = p_studio_id
    and h.expires_at > now()
    and h.token is distinct from p_token
    and h.start_at < p_to and h.end_at > p_from
  order by 1;
$$;

-- Hold a slot for 2 minutes while someone fills in the booking form.
-- One token (browser session) holds one slot at a time; holding again moves it.
create or replace function public.hold_slot(p_studio_id bigint, p_start_at timestamptz, p_end_at timestamptz, p_token text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if p_token is null or length(p_token) < 8 or length(p_token) > 80 then
    raise exception 'Missing hold token.' using errcode = 'P0001';
  end if;
  perform public.validate_slot(p_start_at, p_end_at, false);
  perform pg_advisory_xact_lock(hashtextextended('studio:' || p_studio_id, 0));

  delete from public.slot_hold where expires_at < now() or token = p_token;

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
  values (p_studio_id, p_start_at, p_end_at, p_token, now() + interval '2 minutes');
  return true;
end $$;

create or replace function public.release_hold(p_token text) returns void
language sql security definer set search_path = public as $$
  delete from public.slot_hold where token = p_token;
$$;


-- ---------------------------------------------------------------------
-- Customer bookings
-- ---------------------------------------------------------------------

-- Works for guests (no login) and signed-in customers.
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

  -- guests must give a phone number so the studio can reach them
  if public.current_customer_id() is null and (num is null or num !~ '^[0-9+()\s-]{7,20}$') then
    raise exception 'Enter a valid phone number.' using errcode = 'P0001';
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

-- Customers (and staff) may change or cancel until 24 hours before the session.
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
end $$;


-- ---------------------------------------------------------------------
-- Guest lookups by reference code (no login)
-- The website currently asks for the reference only. Pass p_phone as well
-- if you want to require the phone number (recommended before launch,
-- because TOD-#### references are sequential and guessable).
-- ---------------------------------------------------------------------
create or replace function public.lookup_booking(p_ref text, p_phone text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r record;
begin
  select b.booking_ref, b.status, b.start_at, b.end_at, s.name as studio_name, s.description as studio_desc,
         public.booking_total(b.booking_id) as total,
         (select p.status from public.payment p where p.booking_id = b.booking_id order by p.payment_id desc limit 1) as payment_status,
         c.number
    into r
  from public.booking b
  join public.studio s on s.studio_id = b.studio_id
  join public.customer c on c.customer_id = b.customer_id
  where b.booking_ref = upper(regexp_replace(coalesce(p_ref, ''), '\s', '', 'g'));

  if not found then return null; end if;
  if p_phone is not null and public.digits(p_phone) <> public.digits(r.number) then return null; end if;

  return jsonb_build_object(
    'booking_ref', r.booking_ref, 'status', r.status, 'start_at', r.start_at, 'end_at', r.end_at,
    'studio', r.studio_name, 'studio_description', r.studio_desc,
    'total', r.total, 'payment_status', r.payment_status);
end $$;

-- OUT-/RA- references return that order; a booking reference returns the
-- add-on rentals attached to that booking.
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
    and (p_phone is null or public.digits(c.number) = public.digits(p_phone));

  if jsonb_array_length(result) = 0 then return null; end if;
  return result;
end $$;


-- ---------------------------------------------------------------------
-- Customer rental requests
-- p_items example: [{"equipment_id": 1, "quantity": 2}]
-- Add-on:  p_booking_ref is required; the order belongs to that booking's customer.
-- Outside: needs pickup, return, phone, ID type and an uploaded ID image path.
-- ---------------------------------------------------------------------
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
  else
    if p_pickup_date is null or p_return_date is null or p_return_date <= p_pickup_date then
      raise exception 'Choose valid pickup and return times.' using errcode = 'P0001';
    end if;
    if p_pickup_date < now() - interval '1 hour' then
      raise exception 'Pickup cannot be in the past.' using errcode = 'P0001';
    end if;
    if nullif(trim(coalesce(p_contact_number, '')), '') is null
       or p_contact_number !~ '^[0-9+()\s-]{7,20}$' then
      raise exception 'Enter a valid contact number.' using errcode = 'P0001';
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
  end if;

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

  return query select o.rental_order_id, o.rental_ref::text, public.rental_order_total(o.rental_order_id);
exception when unique_violation then
  raise exception 'Each item can only be listed once per request.' using errcode = 'P0001';
end $$;


-- ---------------------------------------------------------------------
-- Staff: onsite booking and onsite rental (Onsite pages)
-- ---------------------------------------------------------------------
create or replace function public.staff_create_onsite_booking(
  p_studio_id bigint, p_start_at timestamptz, p_end_at timestamptz,
  p_first_name text, p_last_name text, p_number text,
  p_payment_method text, p_gcash_reference text default null
) returns table (booking_id bigint, booking_ref text, total_amount numeric)
language plpgsql security definer set search_path = public as $$
declare b public.booking; cid bigint;
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  perform public.validate_slot(p_start_at, p_end_at, true);
  if p_payment_method not in ('GCash', 'Cash') then
    raise exception 'Choose GCash or Cash.' using errcode = 'P0001';
  end if;
  if p_payment_method = 'GCash' and length(trim(coalesce(p_gcash_reference, ''))) < 6 then
    raise exception 'Enter the GCash reference.' using errcode = 'P0001';
  end if;

  cid := public.resolve_customer(p_first_name, p_last_name, p_number, true);
  b := public.insert_booking_with_payment(cid, p_studio_id, p_start_at, p_end_at,
         p_payment_method, p_gcash_reference, 'Onsite', public.current_app_user_id(), null);
  return query select b.booking_id, b.booking_ref::text, public.booking_total(b.booking_id);
end $$;

-- Items are issued immediately (status Active) and stock updates.
create or replace function public.staff_create_onsite_rental(
  p_type text, p_items jsonb,
  p_booking_ref text default null,
  p_first_name text default null, p_last_name text default null, p_number text default null,
  p_return_date timestamptz default null, p_id_type text default null, p_id_checked boolean default false,
  p_payment_method text default 'Cash', p_gcash_reference text default null
) returns table (rental_order_id bigint, rental_ref text, total_amount numeric)
language plpgsql security definer set search_path = public as $$
declare
  o public.rental_order; bk public.booking; cid bigint; staff_id bigint := public.current_app_user_id();
  it jsonb; eq public.equipment; qty int; rate numeric; hrs numeric; pick timestamptz := now(); total numeric;
begin
  if staff_id is null then raise exception 'Staff only.' using errcode = '42501'; end if;
  if p_type not in ('Add-on', 'Outside') then raise exception 'Choose Add-on or Outside.' using errcode = 'P0001'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one item.' using errcode = 'P0001';
  end if;
  if p_payment_method not in ('GCash', 'Cash') then raise exception 'Choose GCash or Cash.' using errcode = 'P0001'; end if;
  if p_payment_method = 'GCash' and length(trim(coalesce(p_gcash_reference, ''))) < 6 then
    raise exception 'Enter the GCash reference.' using errcode = 'P0001';
  end if;

  if p_type = 'Add-on' then
    select * into bk from public.booking where booking_ref = upper(regexp_replace(coalesce(p_booking_ref, ''), '\s', '', 'g'));
    if not found then raise exception 'Choose a confirmed booking.' using errcode = 'P0001'; end if;
    if bk.status not in ('Approved', 'In Progress') then
      raise exception 'Add-ons need a confirmed or active booking. This one is %.', bk.status using errcode = 'P0001';
    end if;
    cid := bk.customer_id;
  else
    if p_return_date is null or p_return_date <= pick then raise exception 'Choose a return date in the future.' using errcode = 'P0001'; end if;
    if nullif(trim(coalesce(p_id_type, '')), '') is null then raise exception 'Choose the ID type.' using errcode = 'P0001'; end if;
    if not coalesce(p_id_checked, false) then raise exception 'Confirm that you checked a valid ID in person.' using errcode = 'P0001'; end if;
    cid := public.resolve_customer(p_first_name, p_last_name, p_number, true);
  end if;

  insert into public.rental_order (rental_ref, customer_id, rental_type, booking_id, status, source,
                                   approved_by, created_by, pickup_date, return_date, contact_number, id_type)
  values ('', cid, p_type, bk.booking_id, 'Active', 'Onsite', staff_id, staff_id,
          case when p_type = 'Outside' then pick end, p_return_date, nullif(trim(p_number), ''), nullif(trim(p_id_type), ''))
  returning * into o;

  for it in select * from jsonb_array_elements(p_items) loop
    qty := (it ->> 'quantity')::int;
    select * into eq from public.equipment where equipment_id = (it ->> 'equipment_id')::bigint;
    if not found then raise exception 'Equipment not found.' using errcode = 'P0001'; end if;
    if qty is null or qty < 1 then raise exception 'Quantity must be at least 1.' using errcode = 'P0001'; end if;

    if p_type = 'Add-on' then
      if not eq.allow_addon then raise exception '% cannot be rented as an add-on.', eq.name using errcode = 'P0001'; end if;
      rate := eq.add_on_rate; hrs := null;
    else
      if not eq.allow_outside then raise exception '% cannot be rented outside the studio.', eq.name using errcode = 'P0001'; end if;
      rate := eq.outside_rate; hrs := round(extract(epoch from (p_return_date - pick)) / 3600.0, 2);
    end if;

    -- the stock trigger runs here and rejects the row if there isn't enough
    insert into public.rental_detail (rental_order_id, equipment_id, quantity, unit_price_at_request, rental_hours)
    values (o.rental_order_id, eq.equipment_id, qty, rate, hrs);
  end loop;

  total := public.rental_order_total(o.rental_order_id);
  insert into public.payment (rental_order_id, method, gcash_reference, amount, status, verified_by, verified_at)
  values (o.rental_order_id, p_payment_method, nullif(trim(p_gcash_reference), ''), total, 'Verified', staff_id, now());

  return query select o.rental_order_id, o.rental_ref::text, total;
exception when unique_violation then
  raise exception 'Each item can only be listed once, or that GCash reference was already used.' using errcode = 'P0001';
end $$;

-- Mark one line (or the whole order) as returned. When every line is back,
-- the order becomes Returned.
create or replace function public.staff_return_rental(p_rental_ref text, p_equipment_id bigint default null)
returns void language plpgsql security definer set search_path = public as $$
declare o public.rental_order; open_lines int;
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  select * into o from public.rental_order where rental_ref = upper(trim(p_rental_ref)) for update;
  if not found then raise exception 'Rental not found.' using errcode = 'P0001'; end if;
  if o.status <> 'Active' then raise exception 'Only active rentals can be returned (this one is %).', o.status using errcode = 'P0001'; end if;

  update public.rental_detail set returned_at = now()
   where rental_order_id = o.rental_order_id and returned_at is null
     and (p_equipment_id is null or equipment_id = p_equipment_id);

  select count(*) into open_lines from public.rental_detail where rental_order_id = o.rental_order_id and returned_at is null;
  if open_lines = 0 then
    update public.rental_order set status = 'Returned' where rental_order_id = o.rental_order_id;
  end if;
end $$;


-- =====================================================================
-- Views for the owner/staff dashboard and reports
-- security_invoker = the caller's Row Level Security applies, so customers
-- only ever see their own rows and anonymous users see nothing.
-- =====================================================================

-- Bookings tab / Payments tab
create or replace view public.v_booking_summary with (security_invoker = true) as
select
  b.booking_id, b.booking_ref, b.status, b.source,
  b.studio_id, s.name as studio_name,
  b.customer_id, trim(c.first_name || ' ' || c.last_name) as customer_name, c.number as customer_number,
  (c.auth_user_id is null) as is_guest,
  b.start_at, b.end_at,
  extract(epoch from (b.end_at - b.start_at)) / 3600.0 as hours,
  b.actual_start_at, b.actual_end_at,
  b.hourly_rate_at_booking,
  round(b.hourly_rate_at_booking * extract(epoch from (b.end_at - b.start_at)) / 3600.0, 2) as total_amount,
  p.payment_id, p.method as payment_method, p.gcash_reference, p.status as payment_status,
  b.approved_by, b.created_at
from public.booking b
join public.studio s   on s.studio_id = b.studio_id
join public.customer c on c.customer_id = b.customer_id
left join lateral (
  select * from public.payment p where p.booking_id = b.booking_id order by p.payment_id desc limit 1
) p on true;

-- Equipment tab and the customer rent page: total, in use, available, status
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
  e.is_drum_set, e.drum_kit, e.is_vip
from public.equipment e
join public.equipment_category c on c.category_id = e.category_id;

-- Rentals tab: one row per equipment line, with due date and days overdue (Manila dates)
create or replace view public.v_rental_lines with (security_invoker = true) as
select
  o.rental_order_id, o.rental_ref, o.rental_type, o.status, o.source,
  o.customer_id, trim(c.first_name || ' ' || c.last_name) as customer_name, c.number as customer_number,
  bk.booking_ref,
  d.rental_detail_id, d.equipment_id, e.name as equipment_name, d.quantity,
  d.unit_price_at_request, d.rental_hours, d.returned_at as line_returned_at,
  o.pickup_date, o.return_date,
  case when o.rental_type = 'Outside' then o.return_date else bk.end_at end as due_at,
  case
    when o.status = 'Active' and d.returned_at is null
         and now() > case when o.rental_type = 'Outside' then o.return_date else bk.end_at end
    then greatest(1,
      (now() at time zone 'Asia/Manila')::date
      - ((case when o.rental_type = 'Outside' then o.return_date else bk.end_at end) at time zone 'Asia/Manila')::date)
    else 0
  end as days_overdue,
  o.rejected_reason, o.issued_at, o.returned_at, o.created_at
from public.rental_order o
join public.rental_detail d on d.rental_order_id = o.rental_order_id
join public.equipment e on e.equipment_id = d.equipment_id
join public.customer c on c.customer_id = o.customer_id
left join public.booking bk on bk.booking_id = o.booking_id;

-- Payments tab (bookings and rentals together)
create or replace view public.v_payment_queue with (security_invoker = true) as
select
  p.payment_id, p.status, p.method, p.gcash_reference, p.amount, p.created_at, p.verified_at,
  coalesce(b.booking_ref, o.rental_ref) as reference,
  case when p.booking_id is not null then 'Booking' else 'Rental' end as kind,
  trim(c.first_name || ' ' || c.last_name) as customer_name
from public.payment p
left join public.booking b on b.booking_id = p.booking_id
left join public.rental_order o on o.rental_order_id = p.rental_order_id
join public.customer c on c.customer_id = coalesce(b.customer_id, o.customer_id);

-- Customers tab: registered vs guest, counts and money spent (verified payments only)
create or replace view public.v_customer_spending with (security_invoker = true) as
select
  c.customer_id, trim(c.first_name || ' ' || c.last_name) as customer_name, c.number, c.status,
  case when c.auth_user_id is null then 'Guest' else 'Registered' end as account_type,
  (select count(*) from public.booking b where b.customer_id = c.customer_id and b.status <> 'Cancelled') as bookings,
  (select count(*) from public.rental_order o where o.customer_id = c.customer_id and o.status not in ('Rejected', 'Cancelled')) as rentals,
  coalesce((select sum(p.amount) from public.payment p
            left join public.booking b on b.booking_id = p.booking_id
            left join public.rental_order o on o.rental_order_id = p.rental_order_id
            where p.status = 'Verified' and coalesce(b.customer_id, o.customer_id) = c.customer_id), 0) as total_spent
from public.customer c;

-- Reports: verified money per day (Manila), split into studio and equipment
create or replace view public.v_revenue_daily with (security_invoker = true) as
select
  (coalesce(p.verified_at, p.created_at) at time zone 'Asia/Manila')::date as day,
  case when p.booking_id is not null then 'Studio' else 'Equipment' end as kind,
  s.name as studio_name,
  sum(p.amount) as amount,
  count(*) as payments
from public.payment p
left join public.booking b on b.booking_id = p.booking_id
left join public.studio s on s.studio_id = b.studio_id
where p.status = 'Verified'
group by 1, 2, 3;

-- Overview tab: the headline numbers in one row (Manila "today")
create or replace view public.v_dashboard_counts with (security_invoker = true) as
select
  (select count(*) from public.booking) as total_bookings,
  (select count(*) from public.booking where (start_at at time zone 'Asia/Manila')::date = (now() at time zone 'Asia/Manila')::date
                                         and status not in ('Cancelled', 'Rejected')) as todays_bookings,
  (select count(*) from public.booking where status = 'Approved') as confirmed_bookings,
  (select count(*) from public.booking where status = 'Pending') as pending_bookings,
  (select count(*) from public.payment where status = 'Pending') as pending_payments,
  (select count(*) from public.rental_order where status = 'Pending') as rental_requests,
  (select count(*) from public.booking where status = 'In Progress') as active_sessions,
  (select count(distinct rental_order_id) from public.v_rental_lines where days_overdue > 0) as overdue_rentals;
-- =====================================================================
-- Tower of Dove Music Studio: Supabase schema
-- File 3 of 4: privileges, Row Level Security, Storage
--
-- Model
--   anon (not signed in)  : can read studios, equipment, categories, and
--                           call the guest RPCs (bookings, lookups, holds).
--   authenticated customer: can read their own bookings/rentals/payments
--                           and use the RPCs (reschedule, cancel, rent).
--   staff                 : everything operational (bookings, payments,
--                           rentals, customers).
--   owner                 : staff + studios, equipment, categories, staff
--                           accounts, deletes.
-- Staff accounts are created from a server-side function (see README notes
-- at the bottom of 04_seed.sql), never from the browser.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Table privileges (RLS below decides which rows)
-- ---------------------------------------------------------------------
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

grant usage on schema public to anon, authenticated;

-- public catalogue
grant select on public.studio, public.equipment, public.equipment_category to anon, authenticated;

-- signed-in users
grant select, insert, update, delete on
  public.app_user, public.customer, public.studio, public.equipment, public.equipment_category,
  public.booking, public.rental_order, public.rental_detail, public.payment
  to authenticated;
grant select on
  public.v_booking_summary, public.v_equipment_stock, public.v_rental_lines,
  public.v_payment_queue, public.v_customer_spending, public.v_revenue_daily, public.v_dashboard_counts
  to authenticated;
grant select on public.v_equipment_stock to anon;     -- customer rent page shows "available"
-- staff inserting rows directly need the reference-number sequences
grant usage on sequence public.booking_ref_seq, public.rental_out_seq, public.rental_addon_seq to authenticated;

-- functions the website may call
grant execute on function
  public.is_staff(), public.is_owner(), public.current_app_user_id(), public.current_customer_id(),
  public.digits(text)
  to anon, authenticated;

grant execute on function
  public.get_busy_slots(bigint, timestamptz, timestamptz, text),
  public.hold_slot(bigint, timestamptz, timestamptz, text),
  public.release_hold(text),
  public.create_booking(bigint, timestamptz, timestamptz, text, text, text, text, text, text),
  public.lookup_booking(text, text),
  public.lookup_rental(text, text),
  public.request_rental(text, jsonb, text, text, text, text, timestamptz, timestamptz, text, text, text, text)
  to anon, authenticated;

grant execute on function
  public.reschedule_booking(text, timestamptz, timestamptz),
  public.cancel_booking(text, text),
  public.staff_create_onsite_booking(bigint, timestamptz, timestamptz, text, text, text, text, text),
  public.staff_create_onsite_rental(text, jsonb, text, text, text, text, timestamptz, text, boolean, text, text),
  public.staff_return_rental(text, bigint),
  public.equipment_in_use(bigint, bigint),
  public.rental_order_total(bigint),
  public.booking_total(bigint)
  to authenticated;
-- (reschedule/cancel check ownership or staff inside the function)
-- the public equipment list (v_equipment_stock) calls this, so guests need it too
grant execute on function public.equipment_in_use(bigint, bigint) to anon;

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
alter table public.app_user           enable row level security;
alter table public.customer           enable row level security;
alter table public.studio             enable row level security;
alter table public.equipment_category enable row level security;
alter table public.equipment          enable row level security;
alter table public.booking            enable row level security;
alter table public.rental_order       enable row level security;
alter table public.rental_detail      enable row level security;
alter table public.payment            enable row level security;
alter table public.slot_hold          enable row level security;   -- no policies: only the RPCs touch it

-- helper to re-run this file safely
do $$
declare r record;
begin
  for r in select policyname, tablename from pg_policies where schemaname = 'public' loop
    execute format('drop policy %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- app_user -------------------------------------------------------------
create policy app_user_select on public.app_user for select to authenticated
  using (public.is_staff() or auth_user_id = (select auth.uid()));
create policy app_user_update_self on public.app_user for update to authenticated
  using (auth_user_id = (select auth.uid()) or public.is_owner())
  with check (auth_user_id = (select auth.uid()) or public.is_owner());   -- trigger blocks role/status edits by non-owners
create policy app_user_owner_insert on public.app_user for insert to authenticated with check (public.is_owner());
create policy app_user_owner_delete on public.app_user for delete to authenticated using (public.is_owner());

-- customer -------------------------------------------------------------
create policy customer_select on public.customer for select to authenticated
  using (public.is_staff() or auth_user_id = (select auth.uid()));
create policy customer_update on public.customer for update to authenticated
  using (public.is_staff() or auth_user_id = (select auth.uid()))
  with check (public.is_staff() or auth_user_id = (select auth.uid()));
create policy customer_staff_insert on public.customer for insert to authenticated with check (public.is_staff());
create policy customer_owner_delete on public.customer for delete to authenticated using (public.is_owner());

-- catalogue: everyone reads, only the owner writes -------------------------
create policy studio_read   on public.studio for select to anon, authenticated using (true);
create policy studio_write  on public.studio for all    to authenticated using (public.is_owner()) with check (public.is_owner());

create policy category_read  on public.equipment_category for select to anon, authenticated using (true);
create policy category_write on public.equipment_category for all    to authenticated using (public.is_owner()) with check (public.is_owner());

create policy equipment_read  on public.equipment for select to anon, authenticated using (true);
create policy equipment_write on public.equipment for all    to authenticated using (public.is_owner()) with check (public.is_owner());

-- booking --------------------------------------------------------------
create policy booking_select on public.booking for select to authenticated
  using (public.is_staff() or customer_id = public.current_customer_id());
create policy booking_staff_insert on public.booking for insert to authenticated with check (public.is_staff());
create policy booking_staff_update on public.booking for update to authenticated using (public.is_staff()) with check (public.is_staff());
create policy booking_owner_delete on public.booking for delete to authenticated using (public.is_owner());

-- rental_order / rental_detail -----------------------------------------------
create policy rental_order_select on public.rental_order for select to authenticated
  using (public.is_staff() or customer_id = public.current_customer_id());
create policy rental_order_staff_insert on public.rental_order for insert to authenticated with check (public.is_staff());
create policy rental_order_staff_update on public.rental_order for update to authenticated using (public.is_staff()) with check (public.is_staff());
create policy rental_order_owner_delete on public.rental_order for delete to authenticated using (public.is_owner());

create policy rental_detail_select on public.rental_detail for select to authenticated
  using (public.is_staff() or exists (
    select 1 from public.rental_order o
    where o.rental_order_id = rental_detail.rental_order_id and o.customer_id = public.current_customer_id()));
create policy rental_detail_staff_write on public.rental_detail for all to authenticated
  using (public.is_staff()) with check (public.is_staff());

-- payment ----------------------------------------------------------------
create policy payment_select on public.payment for select to authenticated
  using (
    public.is_staff()
    or exists (select 1 from public.booking b where b.booking_id = payment.booking_id and b.customer_id = public.current_customer_id())
    or exists (select 1 from public.rental_order o where o.rental_order_id = payment.rental_order_id and o.customer_id = public.current_customer_id())
  );
create policy payment_staff_insert on public.payment for insert to authenticated with check (public.is_staff());
create policy payment_staff_update on public.payment for update to authenticated using (public.is_staff()) with check (public.is_staff());
create policy payment_owner_delete on public.payment for delete to authenticated using (public.is_owner());


-- ---------------------------------------------------------------------
-- Storage buckets
--   studio-images, equipment-images : public to view, owner uploads
--   rental-ids                      : PRIVATE. Customers upload a photo of
--                                     their ID, only staff can view it.
-- Upload path for IDs: "<random-uuid>/<filename>"; pass that string as
-- p_id_image_path when calling request_rental.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('studio-images',    'studio-images',    true,  5242880, array['image/jpeg', 'image/png', 'image/webp']),
  ('equipment-images', 'equipment-images', true,  5242880, array['image/jpeg', 'image/png', 'image/webp']),
  ('rental-ids',       'rental-ids',       false, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'application/pdf'])
on conflict (id) do update
  set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists tod_public_images_read   on storage.objects;
drop policy if exists tod_owner_images_write   on storage.objects;
drop policy if exists tod_ids_upload           on storage.objects;
drop policy if exists tod_ids_staff_read       on storage.objects;

create policy tod_public_images_read on storage.objects for select to anon, authenticated
  using (bucket_id in ('studio-images', 'equipment-images'));

create policy tod_owner_images_write on storage.objects for all to authenticated
  using (bucket_id in ('studio-images', 'equipment-images') and public.is_owner())
  with check (bucket_id in ('studio-images', 'equipment-images') and public.is_owner());

create policy tod_ids_upload on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'rental-ids');

create policy tod_ids_staff_read on storage.objects for select to authenticated
  using (bucket_id = 'rental-ids' and public.is_staff());
-- =====================================================================
-- Tower of Dove Music Studio: Supabase schema
-- File 4 of 4: starting data (safe to re-run)
-- =====================================================================

insert into public.studio (name, description, capacity, hourly_rate, status) values
  ('Studio A', 'Drum and full band room',  8, 350, 'Available'),
  ('Studio B', 'Vocal and acoustic booth', 3, 250, 'Available'),
  ('Studio C', 'Mid-size band room',       6, 300, 'Available'),
  ('Studio D', 'Production room',          4, 280, 'Maintenance')
on conflict (lower(name)) do nothing;

insert into public.equipment_category (category_name) values
  ('Guitars'), ('Amplifiers'), ('Drums'), ('Keyboards'), ('Effects'), ('Accessories'), ('Other')
on conflict (category_name) do nothing;

-- rates: add-on = per session, outside = per day, drum sets = per rental.
-- min_hours = minimum OUTSIDE rental length.
insert into public.equipment
  (name, category_id, total_quantity, add_on_rate, outside_rate, allow_addon, allow_outside, min_hours, is_drum_set, drum_kit, is_vip)
select v.name, c.category_id, v.qty, v.addon, v.outside, v.allow_addon, v.allow_outside, v.min_hours, v.drum, v.kit, v.vip
from (select row_number() over () as ord, x.* from (values
  ('Electric guitar',     'Guitars',    4,  100, 250,  true, true,  8,  false, null,                                  false),
  ('Guitar amplifier',    'Amplifiers', 4,  150, 350,  true, true,  8,  false, null,                                  false),
  ('Set A Drum Set',      'Drums',      1, 2700, 2700, true, true,  8,  true,  'RDX drum set',                        false),
  ('Set B Drum Set',      'Drums',      1, 3000, 3000, true, true,  8,  true,  'RDX drum set',                        true),
  ('Set C Drum Set',      'Drums',      1, 2500, 2500, true, true,  8,  true,  'Steely drum set (high-end model)',    false),
  ('Set D Drum Set',      'Drums',      1, 2800, 2800, true, true,  8,  true,  'Steely drum set (high-end model)',    true),
  ('Drum kit add-ons',    'Drums',      2,  120, null, true, false, 0,  false, null,                                  false),
  ('Keyboard',            'Keyboards',  1,  200, 500,  true, true,  8,  false, null,                                  false),
  ('Multi-effects pedal', 'Effects',    3,   80, 150,  true, true,  8,  false, null,                                  false)
) as x(name, cat, qty, addon, outside, allow_addon, allow_outside, min_hours, drum, kit, vip)) as v
join public.equipment_category c on c.category_name = v.cat
order by v.ord
on conflict (lower(name)) do nothing;


-- =====================================================================
-- CREATING THE FIRST OWNER (run once, after the four files)
--
-- 1. Supabase dashboard -> Authentication -> Users -> Add user.
--    Email: owner@towerofdove.app   (the website turns the username "owner"
--    into username@towerofdove.app when signing in)
--    Password: choose one. Tick "Auto Confirm User".
-- 2. Authentication -> Providers -> Email: turn OFF "Confirm email"
--    (the fake @towerofdove.app addresses cannot receive mail).
-- 3. Run this, replacing the email if you used another one:
--
-- insert into public.app_user (auth_user_id, first_name, last_name, username, role)
-- select id, 'Studio', 'Owner', 'owner', 'Owner'
-- from auth.users where email = 'owner@towerofdove.app';
--
-- Staff accounts: create the Auth user from a server-side function (an Edge
-- Function using the service_role key and auth.admin.createUser), then insert
-- the matching app_user row with role = 'Staff'. Do not do this from the
-- browser: it would need the service_role key.
-- =====================================================================
-- =====================================================================
-- 05_booking_addons.sql  (safe to re-run)
-- Lets a customer book a studio AND add equipment in one step, and pay one
-- combined amount. Run this once in the Supabase SQL Editor.
-- =====================================================================

-- 1. Book a studio plus optional add-on equipment in one transaction.
--    If anything fails (for example an add-on item is not available), nothing is saved.
--    The payment amount becomes studio total + add-on total, so staff verify one payment.
create or replace function public.create_booking_with_addons(
  p_studio_id bigint, p_start_at timestamptz, p_end_at timestamptz,
  p_first_name text, p_last_name text, p_number text,
  p_payment_method text, p_gcash_reference text default null, p_hold_token text default null,
  p_items jsonb default '[]'::jsonb
) returns table (
  booking_ref text, status text, studio_total numeric, addons_total numeric, total_amount numeric, rental_ref text
)
language plpgsql security definer set search_path = public as $$
declare
  bk record;
  studio numeric := 0;
  addons numeric := 0;
  rref   text;
begin
  select * into bk from public.create_booking(
    p_studio_id, p_start_at, p_end_at, p_first_name, p_last_name, p_number,
    p_payment_method, p_gcash_reference, p_hold_token);
  studio := bk.total_amount;

  if p_items is not null and jsonb_typeof(p_items) = 'array' and jsonb_array_length(p_items) > 0 then
    select o.rental_ref, o.total_amount into rref, addons
      from public.request_rental('Add-on', p_items, bk.booking_ref) o;

    update public.payment pay
       set amount = studio + coalesce(addons, 0)
     where pay.booking_id = bk.booking_id and pay.status <> 'Rejected';
  end if;

  return query select bk.booking_ref::text, bk.status::text, studio, coalesce(addons, 0), studio + coalesce(addons, 0), rref;
end $$;

revoke all on function public.create_booking_with_addons(bigint, timestamptz, timestamptz, text, text, text, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.create_booking_with_addons(bigint, timestamptz, timestamptz, text, text, text, text, text, text, jsonb) to anon, authenticated;


-- 2. Revenue report: split a booking payment into its studio part and its add-on equipment part,
--    so "Studio revenue" and "Equipment revenue" stay correct.
-- (dropped and recreated because the column types are fixed once a view exists)
drop view if exists public.v_revenue_daily;
create view public.v_revenue_daily with (security_invoker = true) as
select day, kind, studio_name, sum(amount) as amount, count(*) as payments
from (
  -- studio part of a booking payment
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
  -- rentals paid on their own (outside rentals, onsite rentals)
  select (coalesce(p.verified_at, p.created_at) at time zone 'Asia/Manila')::date,
         'Equipment'::text, null::varchar(100), p.amount
    from public.payment p
   where p.status = 'Verified' and p.rental_order_id is not null
) x
group by day, kind, studio_name;

grant select on public.v_revenue_daily to authenticated;
-- =====================================================================
-- 06_lookup_addons.sql  (safe to re-run)
-- The guest "find my booking" lookup now also returns the add-on equipment
-- on the booking and a grand total (studio + add-ons).
-- Run this once in the Supabase SQL Editor.
-- =====================================================================
create or replace function public.lookup_booking(p_ref text, p_phone text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r record; ad jsonb; ad_total numeric;
begin
  select b.booking_id, b.booking_ref, b.status, b.start_at, b.end_at, s.name as studio_name, s.description as studio_desc,
         public.booking_total(b.booking_id) as total,
         (select p.status from public.payment p where p.booking_id = b.booking_id order by p.payment_id desc limit 1) as payment_status,
         c.number
    into r
  from public.booking b
  join public.studio s on s.studio_id = b.studio_id
  join public.customer c on c.customer_id = b.customer_id
  where b.booking_ref = upper(regexp_replace(coalesce(p_ref, ''), '\s', '', 'g'));

  if not found then return null; end if;
  if p_phone is not null and public.digits(p_phone) <> public.digits(r.number) then return null; end if;

  -- add-on equipment on this booking (rejected or cancelled requests are not counted)
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
    'total', r.total,                         -- studio only (kept for older pages)
    'studio_total', r.total, 'addons', ad, 'addons_total', ad_total, 'grand_total', r.total + ad_total,
    'payment_status', r.payment_status);
end $$;
-- =====================================================================
-- 07_auto_approve_addons.sql  (safe to re-run)
-- When staff VERIFY a booking payment, the add-on equipment requested with that
-- booking is approved automatically (no second trip to the Rentals tab).
-- If the payment is REJECTED, the pending add-on request is rejected too.
-- If an item is out of stock, that add-on stays Pending for staff to review.
-- Run this once in the Supabase SQL Editor.
-- =====================================================================
create or replace function public.payment_effects() returns trigger
language plpgsql security definer set search_path = public as $$
declare o record;
begin
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

-- One-time catch-up: add-ons on bookings that were already verified but are still Pending
do $$
declare o record;
begin
  for o in
    select ro.rental_order_id
      from public.rental_order ro
      join public.booking b on b.booking_id = ro.booking_id
     where ro.rental_type = 'Add-on' and ro.status = 'Pending'
       and b.status in ('Approved', 'In Progress')
       and exists (select 1 from public.payment p where p.booking_id = b.booking_id and p.status = 'Verified')
  loop
    begin
      update public.rental_order set status = 'Approved' where rental_order_id = o.rental_order_id;
    exception when others then
      null;
    end;
  end loop;
end $$;
-- =====================================================================
-- 08_outside_rental.sql  (safe to re-run)
-- Outside (take-home) rentals:
--   * logged-in customers only (guests are blocked)
--   * priced per hour: the item price covers 8 hours, every extra hour adds price / 8
--   * 50% down payment (GCash) is paid with the request; the balance is paid at pick-up
--   * late returns add the same hourly charge (price / 8) for every hour late
-- Customers can cancel their own rentals (same 24-hour rule as bookings).
-- Run this once in the Supabase SQL Editor.
-- =====================================================================

-- 1. New columns -------------------------------------------------------
alter table public.rental_detail add column if not exists late_fee     numeric(10,2) not null default 0;
alter table public.rental_order  add column if not exists down_payment numeric(10,2) not null default 0;

-- 2. Pricing: min 8 hours, then price / 8 for every extra hour (rounded up to whole hours)
create or replace function public.rental_order_total(p_order_id bigint) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(sum(
    d.quantity * d.unit_price_at_request *
    case when o.rental_type = 'Outside'
         then greatest(8, ceil(coalesce(d.rental_hours, 8)))::numeric / 8
         else 1 end
  ), 0)::numeric(10,2)
  from public.rental_order o
  join public.rental_detail d on d.rental_order_id = o.rental_order_id
  where o.rental_order_id = p_order_id;
$$;

-- 3. Guests cannot create online outside rentals, and nobody can skip the down payment:
--    an online outside rental can only be created by request_outside_rental() below.
create or replace function public.rental_outside_guard() returns trigger
language plpgsql as $$
begin
  if new.rental_type = 'Outside' and new.source = 'Online'
     and coalesce(current_setting('app.outside_ok', true), '') <> '1' then
    raise exception 'Outside rentals need an account and a down payment. Please log in and use the Rent equipment page.' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists trg_rental_outside_guard on public.rental_order;
create trigger trg_rental_outside_guard before insert on public.rental_order
  for each row execute function public.rental_outside_guard();

-- 4. Request an outside rental with the 50% down payment ------------------
create or replace function public.request_outside_rental(
  p_items jsonb, p_first_name text, p_last_name text, p_number text,
  p_pickup_date timestamptz, p_return_date timestamptz,
  p_contact_number text, p_backup_contact text, p_id_type text, p_id_image_path text,
  p_gcash_reference text
) returns table (rental_ref text, total_amount numeric, down_payment numeric)
language plpgsql security definer set search_path = public as $$
declare
  r record; total numeric; dp numeric;
  gref text := regexp_replace(coalesce(p_gcash_reference, ''), '\s', '', 'g');
begin
  if public.current_customer_id() is null then
    raise exception 'Please log in or register to rent equipment outside the studio.' using errcode = 'P0001';
  end if;
  if gref !~ '^[0-9]{13}$' then
    raise exception 'Enter the 13-digit GCash reference number of your down payment.' using errcode = 'P0001';
  end if;

  perform set_config('app.outside_ok', '1', true);
  select o.rental_order_id, o.rental_ref, o.total_amount into r
    from public.request_rental('Outside', p_items, null, p_first_name, p_last_name, p_number,
                               p_pickup_date, p_return_date, p_contact_number, p_backup_contact,
                               p_id_type, p_id_image_path) o;
  perform set_config('app.outside_ok', '', true);

  total := r.total_amount;
  dp := round(total * 0.5, 2);
  update public.rental_order set down_payment = dp where rental_order_id = r.rental_order_id;
  insert into public.payment (rental_order_id, method, gcash_reference, amount, status)
  values (r.rental_order_id, 'GCash', gref, dp, 'Pending');

  return query select r.rental_ref::text, total, dp;
exception when unique_violation then
  raise exception 'That GCash reference number was already used.' using errcode = 'P0001';
end $$;

-- 5. Cancel a rental (customer: own rentals, until 24 hours before pick-up / the session)
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
  if not staff and due is not null and now() > due - interval '24 hours' then
    raise exception 'Changes and cancellations close 24 hours before %.',
      case when o.rental_type = 'Outside' then 'pick-up' else 'your session' end using errcode = 'P0001';
  end if;

  update public.rental_order set status = 'Cancelled' where rental_order_id = o.rental_order_id;
  -- an unpaid (still Pending) payment is closed; a verified down payment is NOT refunded
  update public.payment set status = 'Rejected' where rental_order_id = o.rental_order_id and status = 'Pending';
end $$;

-- 6. Returning equipment: late fee = quantity x price / 8 x each hour late (rounded up) -----
create or replace function public.staff_return_rental(p_rental_ref text, p_equipment_id bigint default null)
returns void language plpgsql security definer set search_path = public as $$
declare o public.rental_order; open_lines int;
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  select * into o from public.rental_order where rental_ref = upper(trim(p_rental_ref)) for update;
  if not found then raise exception 'Rental not found.' using errcode = 'P0001'; end if;
  if o.status <> 'Active' then raise exception 'Only active rentals can be returned (this one is %).', o.status using errcode = 'P0001'; end if;

  update public.rental_detail d
     set returned_at = now(),
         late_fee = case when o.rental_type = 'Outside' and o.return_date is not null and now() > o.return_date
                         then round(d.quantity * d.unit_price_at_request / 8.0
                                    * ceil(extract(epoch from (now() - o.return_date)) / 3600.0), 2)
                         else 0 end
   where d.rental_order_id = o.rental_order_id and d.returned_at is null
     and (p_equipment_id is null or d.equipment_id = p_equipment_id);

  select count(*) into open_lines from public.rental_detail where rental_order_id = o.rental_order_id and returned_at is null;
  if open_lines = 0 then
    update public.rental_order set status = 'Returned' where rental_order_id = o.rental_order_id;
  end if;
end $$;

-- 7. Dashboard view: two extra columns at the end (late fee and down payment) ----------------
create or replace view public.v_rental_lines with (security_invoker = true) as
select
  o.rental_order_id, o.rental_ref, o.rental_type, o.status, o.source,
  o.customer_id, trim(c.first_name || ' ' || c.last_name) as customer_name, c.number as customer_number,
  bk.booking_ref,
  d.rental_detail_id, d.equipment_id, e.name as equipment_name, d.quantity,
  d.unit_price_at_request, d.rental_hours, d.returned_at as line_returned_at,
  o.pickup_date, o.return_date,
  case when o.rental_type = 'Outside' then o.return_date else bk.end_at end as due_at,
  case
    when o.status = 'Active' and d.returned_at is null
         and now() > case when o.rental_type = 'Outside' then o.return_date else bk.end_at end
    then greatest(1,
      (now() at time zone 'Asia/Manila')::date
      - ((case when o.rental_type = 'Outside' then o.return_date else bk.end_at end) at time zone 'Asia/Manila')::date)
    else 0
  end as days_overdue,
  o.rejected_reason, o.issued_at, o.returned_at, o.created_at,
  d.late_fee, o.down_payment
from public.rental_order o
join public.rental_detail d on d.rental_order_id = o.rental_order_id
join public.equipment e on e.equipment_id = d.equipment_id
join public.customer c on c.customer_id = o.customer_id
left join public.booking bk on bk.booking_id = o.booking_id;

-- 8. Revenue report: also count the balance paid at pick-up and late fees -------------------
drop view if exists public.v_revenue_daily;
create view public.v_revenue_daily with (security_invoker = true) as
select day, kind, studio_name, sum(amount) as amount, count(*) as payments
from (
  -- studio part of a booking payment
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

-- 9. Permissions ------------------------------------------------------------------------------
grant select on public.v_revenue_daily to authenticated;
revoke all on function public.request_outside_rental(jsonb, text, text, text, timestamptz, timestamptz, text, text, text, text, text) from public, anon;
grant execute on function public.request_outside_rental(jsonb, text, text, text, timestamptz, timestamptz, text, text, text, text, text) to authenticated;
revoke all on function public.cancel_rental(text, text) from public, anon;
grant execute on function public.cancel_rental(text, text) to authenticated;
-- =====================================================================
-- 09_random_refs.sql  (safe to re-run)
-- Reference codes become random so they cannot be guessed:
--   bookings  TOD-9F3A21C7     outside rentals  OUT-5B07E1AA     add-on rentals  RA-C41D90E2
-- (8 random characters instead of a counting number.) Codes that already exist keep
-- working and are not changed. Run this once in the Supabase SQL Editor.
-- =====================================================================
create or replace function public.random_ref(p_prefix text) returns text
language plpgsql volatile set search_path = public as $$
declare r text;
begin
  loop
    r := p_prefix || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    exit when not exists (select 1 from public.booking      where booking_ref = r)
          and not exists (select 1 from public.rental_order where rental_ref  = r);
  end loop;
  return r;
end $$;
grant execute on function public.random_ref(text) to anon, authenticated;

-- new bookings get a random code
alter table public.booking alter column booking_ref set default public.random_ref('TOD');

-- new rental orders get a random code (this trigger runs before the one that used to number them)
create or replace function public.rental_random_ref() returns trigger
language plpgsql as $$
begin
  if new.rental_ref is null or new.rental_ref = '' then
    new.rental_ref := public.random_ref(case new.rental_type when 'Outside' then 'OUT' else 'RA' end);
  end if;
  return new;
end $$;
drop trigger if exists aa_rental_random_ref on public.rental_order;
create trigger aa_rental_random_ref before insert on public.rental_order
  for each row execute function public.rental_random_ref();
