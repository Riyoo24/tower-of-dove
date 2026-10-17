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
