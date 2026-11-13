-- =====================================================================
-- 47_fix_customer_photo_policy.sql
-- Fixes: customers could not open their before / after rental photos.
-- The app saves the path as "<rental_detail_id>/before.jpg" (no bucket name), but the
-- policy in 46 compared it with "rental-photos/<rental_detail_id>/before.jpg", so it never matched.
-- This version matches the stored path exactly (and also the old form) and uses a
-- security-definer helper so it does not depend on the customer's rights on other tables.
-- Safe to re-run. Run once in the Supabase SQL Editor.
-- =====================================================================

create or replace function public.customer_owns_rental_photo(p_name text)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
      from public.rental_detail d
      join public.rental_order  o on o.rental_order_id = d.rental_order_id
     where o.customer_id = public.current_customer_id()
       and p_name in (
            d.before_photo_path, d.after_photo_path,
            'rental-photos/' || d.before_photo_path, 'rental-photos/' || d.after_photo_path
       )
  );
$$;

revoke all on function public.customer_owns_rental_photo(text) from public;
grant execute on function public.customer_owns_rental_photo(text) to authenticated;

drop policy if exists tod_rental_photos_customer_own on storage.objects;

create policy tod_rental_photos_customer_own on storage.objects
  for select to authenticated
  using (
    bucket_id = 'rental-photos'
    and not public.is_staff()
    and public.customer_owns_rental_photo(storage.objects.name)
  );

-- end of 47_fix_customer_photo_policy.sql
