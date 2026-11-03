-- =====================================================================
-- 38_gcash_screenshots.sql
-- "Attach GCash Screenshot" on every GCash payment form (studio booking, extension,
-- add-on rental, outside rental).
--
-- The picture goes to a PRIVATE storage bucket "gcash-screenshots" at
--   <13-digit GCash reference>/<timestamp>-<random>.<ext>
-- Anyone filling in a payment form (guests too) may upload; only staff can open the files
-- (Verify drawer in the dashboard). No table or function changes are needed.
-- Safe to re-run.
-- =====================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('gcash-screenshots', 'gcash-screenshots', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists tod_gcash_shot_upload     on storage.objects;
drop policy if exists tod_gcash_shot_staff_read on storage.objects;

-- customers and guests: upload only, and only into a folder named after a 13-digit reference
create policy tod_gcash_shot_upload on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'gcash-screenshots' and name ~ '^[0-9]{13}/[^/]+$');

-- staff (owner and staff accounts): list and open
create policy tod_gcash_shot_staff_read on storage.objects for select to authenticated
  using (bucket_id = 'gcash-screenshots' and public.is_staff());
