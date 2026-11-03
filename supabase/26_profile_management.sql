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
