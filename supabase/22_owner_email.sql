-- =====================================================================
-- 22_owner_email.sql  (one-time fix for an EXISTING database; safe to re-run)
-- Changes the owner's login from owner@towerofdove.app to towerofdovemusic@gmail.com.
--   * updates the login email in Supabase Auth (the password stays the same)
--   * updates the owner's row in app_user (username and email)
-- Afterwards the owner logs in with towerofdovemusic@gmail.com and the same password, and
-- "Forgot password?" works because it is a real inbox.
-- Fresh installs do not need this file: create the owner with the new email (see 04_seed.sql).
-- Run once in the Supabase SQL Editor.
-- =====================================================================

do $$
declare
  new_email constant text := 'towerofdovemusic@gmail.com';
  owners integer; uid uuid;
begin
  select count(*) into owners from public.app_user where role = 'Owner';
  if owners = 0 then raise exception 'No Owner account was found in app_user.'; end if;
  if owners > 1 then raise exception 'More than one Owner exists. Tell the developer before running this.'; end if;

  select auth_user_id into uid from public.app_user where role = 'Owner';

  if exists (select 1 from auth.users where lower(email) = new_email and id <> uid) then
    raise exception '% is already used by another account. Delete or rename that account first (Authentication > Users).', new_email;
  end if;

  update auth.users
     set email = new_email,
         email_confirmed_at = coalesce(email_confirmed_at, now()),
         updated_at = now()
   where id = uid;

  update auth.identities
     set identity_data = jsonb_set(identity_data, '{email}', to_jsonb(new_email)),
         updated_at = now()
   where user_id = uid and provider = 'email';

  update public.app_user
     set username = new_email, email = new_email
   where auth_user_id = uid;
end $$;
