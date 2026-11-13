-- =====================================================================
-- 46_equipment_condition_docs.sql  (safe to re-run)
-- Equipment condition documentation for OUTSIDE rentals only.
--   Before issuing: staff upload a "before" photo per rental_detail line.
--   On return:      staff record a condition, optional description, and an
--                   "after" photo (required unless condition = 'No issue').
--   Add-on equipment, booking flows, and automation are unchanged.
--
-- New columns on rental_detail:
--   before_photo_path  text   – private Storage path, uploaded at issue time
--   return_condition   text   – No issue | Scratch | Damaged | Severely damaged | Others
--   return_description text   – optional staff notes
--   after_photo_path   text   – private Storage path, uploaded at return time
--
-- New Storage bucket: rental-photos (private, staff upload, customers view own)
-- New RPC:  staff_set_before_photo(p_rental_detail_id, p_path)
-- New RPC:  staff_return_rental_with_condition(p_rental_ref, p_equipment_id,
--             p_condition, p_description, p_after_photo_path)
-- v_rental_lines: four new columns appended (before_photo_path, return_condition,
--   return_description, after_photo_path)
--
-- Run this once in the Supabase SQL Editor (after 45_addon_balance_on_booking.sql).
-- =====================================================================

-- -----------------------------------------------------------------------
-- 1. New columns on rental_detail
-- -----------------------------------------------------------------------
alter table public.rental_detail
  add column if not exists before_photo_path  text,
  add column if not exists return_condition   text,
  add column if not exists return_description text,
  add column if not exists after_photo_path   text;

alter table public.rental_detail
  drop constraint if exists rental_detail_condition_chk;
alter table public.rental_detail
  add constraint rental_detail_condition_chk
    check (return_condition is null or return_condition in
           ('No issue', 'Scratch', 'Damaged', 'Severely damaged', 'Others'));

-- -----------------------------------------------------------------------
-- 2. Private Storage bucket for equipment inspection photos
-- -----------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'rental-photos', 'rental-photos', false, 10485760,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Storage policies -------------------------------------------------------
drop policy if exists tod_rental_photos_staff_all   on storage.objects;
drop policy if exists tod_rental_photos_customer_own on storage.objects;

-- Staff can read and write all photos in the bucket
create policy tod_rental_photos_staff_all on storage.objects
  for all to authenticated
  using  (bucket_id = 'rental-photos' and public.is_staff())
  with check (bucket_id = 'rental-photos' and public.is_staff());

-- (Superseded by 47_fix_customer_photo_policy.sql, run that too.)
-- Customers can only read photos that belong to their own rentals.
-- Path convention: rental-photos/<rental_detail_id>/<before|after>.<ext>
-- The first path segment is the rental_detail_id; we join to rental_detail →
-- rental_order to verify ownership.
create policy tod_rental_photos_customer_own on storage.objects
  for select to authenticated
  using (
    bucket_id = 'rental-photos'
    and not public.is_staff()
    and exists (
      select 1
        from public.rental_detail d
        join public.rental_order  o on o.rental_order_id = d.rental_order_id
       where o.customer_id = public.current_customer_id()
         and (
           -- name is  "<rental_detail_id>/before.xxx" or "<rental_detail_id>/after.xxx"
           d.before_photo_path = (storage.objects.bucket_id || '/' || storage.objects.name)
           or
           d.after_photo_path  = (storage.objects.bucket_id || '/' || storage.objects.name)
         )
    )
  );

-- -----------------------------------------------------------------------
-- 3. RPC: record the before-photo path on a rental_detail
--    Called by staff right before (or as part of) issuing the equipment.
--    Only outside-rental lines may have inspection photos.
-- -----------------------------------------------------------------------
create or replace function public.staff_set_before_photo(
  p_rental_detail_id bigint,
  p_path             text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  d public.rental_detail;
  o public.rental_order;
begin
  if not public.is_staff() then
    raise exception 'Staff only.' using errcode = '42501';
  end if;

  select * into d from public.rental_detail where rental_detail_id = p_rental_detail_id for update;
  if not found then
    raise exception 'Rental line not found.' using errcode = 'P0001';
  end if;

  select * into o from public.rental_order where rental_order_id = d.rental_order_id;
  if o.rental_type <> 'Outside' then
    raise exception 'Before photos are only required for outside rentals.' using errcode = 'P0001';
  end if;
  if o.status not in ('Approved', 'Active') then
    raise exception 'Cannot set a before photo on a % rental.', o.status using errcode = 'P0001';
  end if;

  if nullif(trim(coalesce(p_path, '')), '') is null then
    raise exception 'A photo path is required.' using errcode = 'P0001';
  end if;

  update public.rental_detail
     set before_photo_path = trim(p_path)
   where rental_detail_id = p_rental_detail_id;
end $$;

revoke all on function public.staff_set_before_photo(bigint, text) from public, anon;
grant  execute on function public.staff_set_before_photo(bigint, text) to authenticated;

-- -----------------------------------------------------------------------
-- 4. RPC: return one or all lines with condition documentation
--    Replaces the old staff_return_rental path for outside rentals.
--    Add-on and old onsite returns still use staff_return_rental (unchanged).
-- -----------------------------------------------------------------------
create or replace function public.staff_return_rental_with_condition(
  p_rental_ref       text,
  p_equipment_id     bigint,       -- null = return all lines of this order
  p_condition        text,
  p_description      text  default null,
  p_after_photo_path text  default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  o          public.rental_order;
  open_lines int;
  cond       text := trim(coalesce(p_condition, ''));
  apath      text := nullif(trim(coalesce(p_after_photo_path, '')), '');
begin
  if not public.is_staff() then
    raise exception 'Staff only.' using errcode = '42501';
  end if;

  -- validate condition
  if cond not in ('No issue', 'Scratch', 'Damaged', 'Severely damaged', 'Others') then
    raise exception 'Choose a condition: No issue, Scratch, Damaged, Severely damaged, or Others.'
      using errcode = 'P0001';
  end if;

  -- after photo is required for every condition except "No issue"
  if cond <> 'No issue' and apath is null then
    raise exception 'An after-photo is required for condition "%".', cond
      using errcode = 'P0001';
  end if;

  -- "No issue" must not store a photo (clear it if one was sent anyway)
  if cond = 'No issue' then
    apath := null;
  end if;

  select * into o
    from public.rental_order
   where rental_ref = upper(trim(p_rental_ref))
   for update;

  if not found then
    raise exception 'Rental not found.' using errcode = 'P0001';
  end if;
  if o.rental_type <> 'Outside' then
    raise exception 'Use this function only for outside rentals.' using errcode = 'P0001';
  end if;
  if o.status <> 'Active' then
    raise exception 'Only active rentals can be returned (this one is %).', o.status
      using errcode = 'P0001';
  end if;

  -- check every targeted line has a before photo
  if exists (
    select 1 from public.rental_detail d
     where d.rental_order_id = o.rental_order_id
       and d.returned_at is null
       and (p_equipment_id is null or d.equipment_id = p_equipment_id)
       and d.before_photo_path is null
  ) then
    raise exception 'A before-photo is missing on one or more lines. Record it at issue time.'
      using errcode = 'P0001';
  end if;

  update public.rental_detail d
     set returned_at         = now(),
         late_fee            = case
                                 when o.return_date is not null and now() > o.return_date
                                 then round(d.quantity * d.unit_price_at_request / 8.0
                                            * ceil(extract(epoch from (now() - o.return_date)) / 3600.0), 2)
                                 else 0
                               end,
         return_condition    = cond,
         return_description  = nullif(trim(coalesce(p_description, '')), ''),
         after_photo_path    = apath
   where d.rental_order_id  = o.rental_order_id
     and d.returned_at is null
     and (p_equipment_id is null or d.equipment_id = p_equipment_id);

  select count(*) into open_lines
    from public.rental_detail
   where rental_order_id = o.rental_order_id
     and returned_at is null;

  if open_lines = 0 then
    update public.rental_order
       set status = 'Returned'
     where rental_order_id = o.rental_order_id;
  end if;
end $$;

revoke all on function public.staff_return_rental_with_condition(text, bigint, text, text, text) from public, anon;
grant  execute on function public.staff_return_rental_with_condition(text, bigint, text, text, text) to authenticated;

-- -----------------------------------------------------------------------
-- 5. Guard: prevent issuing an outside rental line that lacks a before photo.
--    Fires on rental_order status -> Active.  Add-on and onsite (no down_payment
--    guard path) are unaffected because the check is scoped to Outside type only.
-- -----------------------------------------------------------------------
create or replace function public.guard_outside_before_photo() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.rental_type = 'Outside'
     and new.status = 'Active'
     and old.status is distinct from 'Active' then
    -- at least one line must exist; every line must have a before photo
    if exists (
      select 1 from public.rental_detail
       where rental_order_id = new.rental_order_id
         and before_photo_path is null
    ) then
      raise exception
        'Attach a before-photo for every equipment line before issuing this outside rental.'
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_guard_outside_before_photo on public.rental_order;
create trigger trg_guard_outside_before_photo
  before update of status on public.rental_order
  for each row execute function public.guard_outside_before_photo();

-- -----------------------------------------------------------------------
-- 6. v_rental_lines: append the four new inspection columns
--    (all previous columns are preserved verbatim)
-- -----------------------------------------------------------------------
create or replace view public.v_rental_lines with (security_invoker = true) as
select
  o.rental_order_id, o.rental_ref, o.rental_type, o.status, o.source,
  o.customer_id, trim(c.first_name || ' ' || c.last_name) as customer_name, c.number as customer_number,
  bk.booking_ref,
  d.rental_detail_id, d.equipment_id, e.name as equipment_name, d.quantity,
  d.unit_price_at_request, d.rental_hours, d.returned_at as line_returned_at,
  o.pickup_date, o.return_date,
  case when o.rental_type = 'Outside' then public.rental_due_at(o.pickup_date, o.return_date) else bk.end_at end as due_at,
  case
    when o.status = 'Active' and d.returned_at is null
         and now() > case when o.rental_type = 'Outside' then public.rental_due_at(o.pickup_date, o.return_date) else bk.end_at end
    then greatest(1,
      (now() at time zone 'Asia/Manila')::date
      - ((case when o.rental_type = 'Outside' then public.rental_due_at(o.pickup_date, o.return_date) else bk.end_at end) at time zone 'Asia/Manila')::date)
    else 0
  end as days_overdue,
  o.rejected_reason, o.issued_at, o.returned_at, o.created_at,
  d.late_fee, o.down_payment,
  case
    when o.status = 'Active' and d.returned_at is null
         and now() > case when o.rental_type = 'Outside' then public.rental_due_at(o.pickup_date, o.return_date) else bk.end_at end
    then greatest(1, ceil(extract(epoch from (now() - (case when o.rental_type = 'Outside' then public.rental_due_at(o.pickup_date, o.return_date) else bk.end_at end))) / 3600.0))::int
    else 0
  end as hours_overdue,
  pb.balance_paid_amount, pb.balance_paid_at,
  public.rental_balance_due(o.rental_order_id) as balance_due,
  -- NEW: equipment condition documentation (outside rentals only)
  d.before_photo_path,
  d.return_condition,
  d.return_description,
  d.after_photo_path
from public.rental_order o
join public.rental_detail d on d.rental_order_id = o.rental_order_id
join public.equipment e on e.equipment_id = d.equipment_id
join public.customer c on c.customer_id = o.customer_id
left join public.booking bk on bk.booking_id = o.booking_id
left join lateral (
  select p.balance_paid_amount, p.balance_paid_at from public.payment p
   where p.rental_order_id = o.rental_order_id and p.status <> 'Rejected'
   order by p.payment_id desc limit 1
) pb on true;

grant select on public.v_rental_lines to authenticated;

-- -----------------------------------------------------------------------
-- 7. Helper: generate a signed URL for an inspection photo.
--    Used server-side; the frontend calls storage.createSignedUrl directly.
--    Listed here only for documentation / edge-function use.
-- -----------------------------------------------------------------------
-- (No extra SQL needed; signed URLs are generated by the Supabase JS client
--  with the existing Storage key; policies above enforce access.)
