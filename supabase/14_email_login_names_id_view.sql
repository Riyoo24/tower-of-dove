-- =====================================================================
-- 14_email_login_names_id_view.sql  (safe to re-run)
--  1. Customers and staff now log in with a real EMAIL ADDRESS. The "username" column keeps
--     holding the login, but it is now an email (up to 254 characters). The old
--     letters/numbers-only username rule is replaced by an email-format rule.
--     Old accounts (for example "owner" or "juan") are NOT touched and keep working: they sign in
--     with their old login written as an email, like owner@towerofdove.app.
--  2. New sign-ups copy the email into the customer's email column too.
--  3. First and last names can no longer contain digits (customer and staff).
--  4. A customer can open the valid ID they uploaded with their own outside rental
--     (staff could always open it; customers could not).
-- Run this once in the Supabase SQL Editor (after 13_overdue_hours_addon_return.sql).
-- =====================================================================

-- 1. username column holds an email ---------------------------------------------------------------
alter table public.app_user alter column username type varchar(254);
alter table public.customer alter column username type varchar(254);

alter table public.app_user  drop constraint if exists app_user_username_chk;
alter table public.customer  drop constraint if exists customer_username_chk;

-- NOT VALID = only new and changed rows are checked, so old accounts keep working.
alter table public.app_user add constraint app_user_username_chk
  check (username ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$') not valid;
alter table public.customer add constraint customer_username_chk
  check (username is null or username ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$') not valid;

-- 2. sign-up trigger: login email is also the customer's contact email ----------------------------
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
    nullif(lower(trim(coalesce(m ->> 'username', new.email))), ''),
    nullif(trim(m ->> 'number'), ''),
    coalesce(nullif(trim(coalesce(m ->> 'contact_email', '')), ''), lower(new.email))
  );
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- 3. names: no digits -----------------------------------------------------------------------------
alter table public.customer drop constraint if exists customer_name_letters_chk;
alter table public.customer add constraint customer_name_letters_chk
  check (first_name !~ '[[:digit:]]' and last_name !~ '[[:digit:]]') not valid;

alter table public.app_user drop constraint if exists app_user_name_letters_chk;
alter table public.app_user add constraint app_user_name_letters_chk
  check (first_name !~ '[[:digit:]]' and last_name !~ '[[:digit:]]') not valid;

-- 4. customers can open their own valid ID --------------------------------------------------------
drop policy if exists tod_ids_owner_read on storage.objects;
create policy tod_ids_owner_read on storage.objects for select to authenticated
  using (
    bucket_id = 'rental-ids'
    and exists (
      select 1 from public.rental_order o
      where o.id_image_path = storage.objects.name
        and o.customer_id = public.current_customer_id()
    )
  );
