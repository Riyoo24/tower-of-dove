-- =====================================================================
-- 27_allow_username_change.sql  (safe to re-run)
-- Relaxes the protect_user_columns trigger on app_user so that a
-- logged-in user can update their OWN username (was previously
-- restricted to the owner only).  All other protections stay in place:
--   • role, status, auth_user_id  → still owner-only
--   • username uniqueness         → enforced by the unique index
--   • username format             → enforced by the check constraint
--     (3-30 username characters; existing email usernames remain supported)
-- The customer table already allowed username self-updates (only
-- status and auth_user_id were protected there).
-- Run once in the Supabase SQL Editor.
-- =====================================================================

create or replace function public.protect_user_columns() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- auth.uid() is NULL for the dashboard SQL editor and the service_role key
  if auth.uid() is not null and not public.is_owner() then
    if new.role      is distinct from old.role
       or new.status      is distinct from old.status
       or new.auth_user_id is distinct from old.auth_user_id then
      raise exception 'Only the owner can change role, status or the linked login.' using errcode = '42501';
    end if;
    -- A user may only change their own username, not someone else's
    if new.username is distinct from old.username
       and old.auth_user_id is distinct from auth.uid() then
      raise exception 'Only the owner can change another user''s username.' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

-- The trigger already exists; recreating the function above is enough.
-- Re-create the trigger anyway so this script is fully self-contained.
drop trigger if exists trg_protect on public.app_user;
create trigger trg_protect before update on public.app_user
  for each row execute function public.protect_user_columns();

-- Keep existing email usernames valid for registration and existing accounts.
alter table public.app_user drop constraint if exists app_user_username_chk;
alter table public.customer drop constraint if exists customer_username_chk;
alter table public.app_user add constraint app_user_username_chk
  check (username ~ '^[a-z0-9_.]{3,30}$'
    or username ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$') not valid;
alter table public.customer add constraint customer_username_chk
  check (username is null or username ~ '^[a-z0-9_.]{3,30}$'
    or username ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]{2,}$') not valid;

-- Also replace the email-sync function on installations that already ran migration 26.
-- =====================================================================
-- 26_profile_management.sql  (safe to re-run)
-- Profile management: when a person confirms a new login email (Supabase Auth sends the link),
-- copy the new address into their profile row so the dashboard and booking records stay correct.
--   * usernames remain independent of the login email
--   * customer.email     = new email, but only if it still equalled the old login email
--                          (a different contact email chosen by staff is left alone)
--   * app_user (owner/staff): same contact email rule
-- Name and password changes need nothing here: the app updates its own row (RLS policies
-- customer_update / app_user_update_self) and calls auth.updateUser.
-- Run once in the Supabase SQL Editor.
-- =====================================================================

create or replace function public.sync_profile_email() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.email is distinct from old.email and new.email is not null then
    update public.customer
       set email = case when lower(coalesce(email, '')) = lower(coalesce(old.email, '')) then lower(new.email) else email end
     where auth_user_id = new.id;

    update public.app_user
       set email = case when lower(coalesce(email, '')) = lower(coalesce(old.email, '')) then lower(new.email) else email end
     where auth_user_id = new.id;
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed after update of email on auth.users
  for each row execute function public.sync_profile_email();
