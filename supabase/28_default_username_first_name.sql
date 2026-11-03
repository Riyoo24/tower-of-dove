-- =====================================================================
-- 28_default_username_first_name.sql  (safe to re-run)
-- New accounts now get their FIRST NAME as the default username (shown in the sidebar and
-- editable in Account settings) instead of their email address.
--   * letters/numbers only, lower case, "Mary Ann" -> maryann
--   * if the name is already taken, a number is added: maria, maria2, maria3 ...
--   * names shorter than 3 characters get "user" added (Al -> aluser), the minimum length is 3
-- Login still uses the email address. Existing usernames are NOT changed by this file.
-- Run once in the Supabase SQL Editor.
-- =====================================================================

-- 1. helper that builds a free username --------------------------------------------------------
create or replace function public.make_username(p_first text, p_table text default 'customer')
returns text
language plpgsql security definer set search_path = public as $$
declare
  base text := lower(regexp_replace(coalesce(p_first, ''), '[^A-Za-z0-9]', '', 'g'));
  cand text;
  n    integer := 1;
  used boolean;
begin
  if base = '' then base := 'user'; end if;
  if length(base) < 3 then base := base || 'user'; end if;
  base := left(base, 24);                     -- leaves room for a number, 30 characters max
  cand := base;
  loop
    if p_table = 'app_user' then
      select exists (select 1 from public.app_user where lower(username) = cand) into used;
    else
      select exists (select 1 from public.customer where lower(username) = cand) into used;
    end if;
    exit when not used;
    n := n + 1;
    cand := base || n::text;
  end loop;
  return cand;
end $$;

-- only the database itself and the create-staff Edge Function (service_role) may call it
revoke all on function public.make_username(text, text) from public, anon, authenticated;
grant execute on function public.make_username(text, text) to service_role;

-- 2. sign-up trigger: username = first name instead of the email ---------------------------------
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
    public.make_username(coalesce(fn, 'Customer'), 'customer'),
    nullif(trim(m ->> 'number'), ''),
    coalesce(nullif(trim(coalesce(m ->> 'contact_email', '')), ''), lower(new.email))
  );
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_auth_user();
