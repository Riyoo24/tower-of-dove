-- =====================================================================
-- 34_receipt_emails.sql  (safe to re-run)
-- Confirmation receipt emails for bookings and rentals.
--   * Guest (not logged in): the booking form now asks for an email address (required, format-checked here too).
--   * Logged-in customer: no email is typed. The database reads the email of the signed-in account itself
--     (auth.users), so the browser cannot choose a different recipient.
-- The address is stored on the booking / rental (receipt_email). The Edge Function `send-receipt` reads it from
-- the database, sends the email ONCE (receipt_sent_at) and never accepts an address from the browser.
-- Run once in the Supabase SQL Editor (after 33_booking_window.sql).
-- =====================================================================

-- 1. Columns ----------------------------------------------------------------------------------------
alter table public.booking      add column if not exists receipt_email   varchar(254);
alter table public.booking      add column if not exists receipt_sent_at timestamptz;
alter table public.rental_order add column if not exists receipt_email   varchar(254);
alter table public.rental_order add column if not exists receipt_sent_at timestamptz;

-- 2. Helper: the email of the signed-in customer account (null for guests) --------------------------
create or replace function public.current_account_email() returns text
language sql stable security definer set search_path = public, auth as $$
  select lower(nullif(trim(u.email), ''))
    from auth.users u
   where u.id = auth.uid()
     and public.current_customer_id() is not null;
$$;
grant execute on function public.current_account_email() to anon, authenticated;

-- 2b. Customers cannot edit the receipt address or the "sent" mark by calling the API directly --------
--     (otherwise they could point a receipt at someone else's inbox). The database functions above and the
--     Edge Function run as a different role, so they are not affected.
create or replace function public.protect_receipt_columns() returns trigger
language plpgsql as $$
begin
  if current_user in ('anon', 'authenticated') then
    new.receipt_email   := old.receipt_email;
    new.receipt_sent_at := old.receipt_sent_at;
  end if;
  return new;
end $$;
drop trigger if exists trg_protect_receipt_booking on public.booking;
create trigger trg_protect_receipt_booking before update on public.booking
  for each row execute function public.protect_receipt_columns();
drop trigger if exists trg_protect_receipt_rental on public.rental_order;
create trigger trg_protect_receipt_rental before update on public.rental_order
  for each row execute function public.protect_receipt_columns();

-- 3. Book a studio (+ add-ons): now takes the guest's email ------------------------------------------
drop function if exists public.create_booking_with_addons(bigint, timestamptz, timestamptz, text, text, text, text, text, text, jsonb, text);
drop function if exists public.create_booking_with_addons(bigint, timestamptz, timestamptz, text, text, text, text, text, text, jsonb, text, text);
create function public.create_booking_with_addons(
  p_studio_id bigint, p_start_at timestamptz, p_end_at timestamptz,
  p_first_name text, p_last_name text, p_number text,
  p_payment_method text, p_gcash_reference text default null, p_hold_token text default null,
  p_items jsonb default '[]'::jsonb,
  p_pay_option text default 'down',
  p_email text default null
) returns table (
  booking_ref text, status text, studio_total numeric, addons_total numeric, total_amount numeric, rental_ref text,
  down_payment numeric, balance_due numeric, pay_option text
)
language plpgsql security definer set search_path = public as $$
declare
  bk record;
  studio numeric := 0;
  addons numeric := 0;
  rref   text;
  dp     numeric;
  opt    text := lower(coalesce(nullif(trim(p_pay_option), ''), 'down'));
  acct   text := public.current_account_email();            -- signed-in customer's own email (null = guest)
  mail   text := lower(nullif(trim(coalesce(p_email, '')), ''));
begin
  if opt not in ('down', 'full') then
    raise exception 'Choose 50%% down payment or full payment.' using errcode = 'P0001';
  end if;

  -- Logged-in customers: always the account email (whatever the browser sent is ignored).
  -- Guests: the email is required and must look like an email address.
  if acct is not null then
    mail := acct;
  elsif mail is null or length(mail) > 254 or mail !~ '^[^\s@]+@[^\s@]+\.[^\s@]{2,}$' then
    raise exception 'Enter a valid email address, like name@example.com, so we can send your receipt.' using errcode = 'P0001';
  end if;

  select * into bk from public.create_booking(
    p_studio_id, p_start_at, p_end_at, p_first_name, p_last_name, p_number,
    p_payment_method, p_gcash_reference, p_hold_token);
  studio := bk.total_amount;

  if p_items is not null and jsonb_typeof(p_items) = 'array' and jsonb_array_length(p_items) > 0 then
    select o.rental_ref, o.total_amount into rref, addons
      from public.request_rental('Add-on', p_items, bk.booking_ref) o;
  end if;

  dp := public.pay_option_amount(studio + coalesce(addons, 0), opt);
  update public.booking set down_payment = dp, receipt_email = mail where booking_id = bk.booking_id;
  update public.payment pay set amount = dp, payment_option = opt
   where pay.booking_id = bk.booking_id and pay.status <> 'Rejected';

  return query select bk.booking_ref::text, bk.status::text, studio, coalesce(addons, 0),
                      studio + coalesce(addons, 0), rref, dp, (studio + coalesce(addons, 0)) - dp, opt;
end $$;
revoke all on function public.create_booking_with_addons(bigint, timestamptz, timestamptz, text, text, text, text, text, text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.create_booking_with_addons(bigint, timestamptz, timestamptz, text, text, text, text, text, text, jsonb, text, text) to anon, authenticated;

-- 4. Outside rental (members only): receipt goes to the account email --------------------------------
create or replace function public.request_outside_rental(
  p_items jsonb, p_first_name text, p_last_name text, p_number text,
  p_pickup_date timestamptz, p_return_date timestamptz,
  p_contact_number text, p_backup_contact text, p_id_type text, p_id_image_path text,
  p_gcash_reference text,
  p_pay_option text default 'down'
) returns table (rental_ref text, total_amount numeric, down_payment numeric, pay_option text)
language plpgsql security definer set search_path = public as $$
declare
  r record; total numeric; dp numeric;
  gref text := regexp_replace(coalesce(p_gcash_reference, ''), '\s', '', 'g');
  opt  text := lower(coalesce(nullif(trim(p_pay_option), ''), 'down'));
begin
  if public.current_customer_id() is null then
    raise exception 'Please log in or register to rent equipment outside the studio.' using errcode = 'P0001';
  end if;
  if opt not in ('down', 'full') then
    raise exception 'Choose 50%% down payment or full payment.' using errcode = 'P0001';
  end if;
  if gref !~ '^[0-9]{13}$' then
    raise exception 'Enter the 13-digit GCash reference number of your payment.' using errcode = 'P0001';
  end if;

  perform set_config('app.outside_ok', '1', true);
  select o.rental_order_id, o.rental_ref, o.total_amount into r
    from public.request_rental('Outside', p_items, null, p_first_name, p_last_name, p_number,
                               p_pickup_date, p_return_date, p_contact_number, p_backup_contact,
                               p_id_type, p_id_image_path) o;
  perform set_config('app.outside_ok', '', true);

  total := r.total_amount;
  dp := public.pay_option_amount(total, opt);
  update public.rental_order set down_payment = dp, receipt_email = public.current_account_email()
   where rental_order_id = r.rental_order_id;
  insert into public.payment (rental_order_id, method, gcash_reference, amount, status, payment_option)
  values (r.rental_order_id, 'GCash', gref, dp, 'Pending', opt);

  return query select r.rental_ref::text, total, dp, opt;
exception when unique_violation then
  raise exception 'That GCash reference number was already used.' using errcode = 'P0001';
end $$;
revoke all on function public.request_outside_rental(jsonb, text, text, text, timestamptz, timestamptz, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.request_outside_rental(jsonb, text, text, text, timestamptz, timestamptz, text, text, text, text, text, text) to authenticated;

-- 5. Add-on rental added to a booking later: member -> account email; guest -> the booking's email ----
create or replace function public.request_addon_rental(
  p_booking_ref text, p_items jsonb, p_pay_option text default 'down', p_gcash_reference text default null
) returns table (rental_ref text, total_amount numeric, down_payment numeric, pay_option text)
language plpgsql security definer set search_path = public as $$
declare
  r record; total numeric; dp numeric; mail text;
  gref text := regexp_replace(coalesce(p_gcash_reference, ''), '\s', '', 'g');
  opt  text := lower(coalesce(nullif(trim(p_pay_option), ''), 'down'));
begin
  if opt not in ('down', 'full') then
    raise exception 'Choose 50%% down payment or full payment.' using errcode = 'P0001';
  end if;
  if gref !~ '^[0-9]{13}$' then
    raise exception 'Enter the 13-digit GCash reference number of your payment.' using errcode = 'P0001';
  end if;

  select o.rental_order_id, o.rental_ref, o.total_amount into r
    from public.request_rental('Add-on', p_items, p_booking_ref) o;

  select coalesce(public.current_account_email(), b.receipt_email) into mail
    from public.rental_order ro join public.booking b on b.booking_id = ro.booking_id
   where ro.rental_order_id = r.rental_order_id;

  total := r.total_amount;
  dp := public.pay_option_amount(total, opt);
  update public.rental_order set down_payment = dp, receipt_email = mail where rental_order_id = r.rental_order_id;
  insert into public.payment (rental_order_id, method, gcash_reference, amount, status, payment_option)
  values (r.rental_order_id, 'GCash', gref, dp, 'Pending', opt);

  return query select r.rental_ref::text, total, dp, opt;
exception when unique_violation then
  raise exception 'That GCash reference number was already used.' using errcode = 'P0001';
end $$;
revoke all on function public.request_addon_rental(text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.request_addon_rental(text, jsonb, text, text) to anon, authenticated;

-- end of 34_receipt_emails.sql
