-- =====================================================================
-- 29_optional_backfill_first_name_usernames.sql  (OPTIONAL, safe to re-run)
-- Changes EXISTING accounts whose username is still their email address to their first name
-- (maria, maria2, ...). Accounts whose username was already changed by the person are left alone.
-- The owner account is skipped. Skip this file if you want existing usernames to stay as they are.
-- Run after 28_default_username_first_name.sql.
-- =====================================================================

do $$
declare r record;
begin
  -- customers (oldest first, so the earliest "maria" keeps the plain name)
  for r in
    select customer_id, first_name from public.customer
     where auth_user_id is not null and username like '%@%'
     order by customer_id
  loop
    update public.customer set username = public.make_username(r.first_name, 'customer')
     where customer_id = r.customer_id;
  end loop;

  -- staff (not the owner)
  for r in
    select user_id, first_name from public.app_user
     where role = 'Staff' and username like '%@%'
     order by user_id
  loop
    update public.app_user set username = public.make_username(r.first_name, 'app_user')
     where user_id = r.user_id;
  end loop;
end $$;
