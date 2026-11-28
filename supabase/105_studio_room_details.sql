-- =====================================================================
-- 105_studio_room_details.sql  (safe to re-run)
-- Everything a customer sees about a room is now editable in Admin > Studio Management.
--   * public.studio gets: capacity, room_size_sqm, location, about, sort_order.
--     sort_order is backfilled from studio_id; a new studio goes to the end.
--     room_specs (file 95) stays and is the "Included gear" list, one item per line.
--   * public.studio_photo: the room gallery. The lowest sort_order is the main photo.
--     studio.image is kept equal to the main photo by a trigger, so the older booking pages keep working.
--   * RLS: anyone reads the photos of Available and Maintenance studios (Unavailable ones stay hidden, staff see all);
--     only the Owner inserts, updates or deletes. Photos use the existing public studio-images bucket and its policies.
--   * Audit log (file 98): adding or removing a photo is recorded, if file 98 has been run. Studio edits are already audited.
-- Run this once in the Supabase SQL Editor (after 98_audit_log.sql; it also works before it).
-- =====================================================================

-- ---- 1. studio: new columns --------------------------------------------------------------------------------------
alter table public.studio add column if not exists capacity      integer;
alter table public.studio add column if not exists room_size_sqm numeric(6,1);
alter table public.studio add column if not exists location      text;
alter table public.studio add column if not exists about         text;
alter table public.studio add column if not exists sort_order    integer;

comment on column public.studio.capacity      is 'How many players the room fits. Empty = not shown to customers.';
comment on column public.studio.room_size_sqm is 'Room size in square metres. Empty = not shown to customers.';
comment on column public.studio.location      is 'Where the room is, e.g. 2nd floor. Empty = not shown to customers.';
comment on column public.studio.about         is 'Longer "About this room" text. Empty = the block is hidden.';
comment on column public.studio.sort_order    is 'Order customers see the rooms in (lowest first). Set with the arrows in Admin > Studio Management.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'studio_capacity_chk') then
    alter table public.studio add constraint studio_capacity_chk check (capacity is null or capacity > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'studio_size_chk') then
    alter table public.studio add constraint studio_size_chk check (room_size_sqm is null or room_size_sqm > 0);
  end if;
end $$;

-- existing rooms keep today's order (studio_id); only rows without an order are touched
update public.studio s
   set sort_order = x.rn
  from (select studio_id, row_number() over (order by studio_id) as rn from public.studio) x
 where s.studio_id = x.studio_id and s.sort_order is null;

-- a new studio goes to the end of the list unless an order is given
create or replace function public.studio_default_sort() returns trigger
language plpgsql as $$
begin
  if new.sort_order is null then
    select coalesce(max(sort_order), 0) + 1 into new.sort_order from public.studio;
  end if;
  return new;
end $$;

drop trigger if exists trg_studio_default_sort on public.studio;
create trigger trg_studio_default_sort before insert on public.studio
  for each row execute function public.studio_default_sort();

create index if not exists studio_sort_idx on public.studio (sort_order, studio_id);

-- ---- 2. studio_photo ---------------------------------------------------------------------------------------------
create table if not exists public.studio_photo (
  photo_id    bigint generated always as identity primary key,
  studio_id   bigint not null references public.studio (studio_id) on delete cascade,
  url         text   not null,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists studio_photo_studio_idx on public.studio_photo (studio_id, sort_order, photo_id);

-- rooms that already have a photo keep it: it becomes their main photo (only when they have no gallery yet)
insert into public.studio_photo (studio_id, url, sort_order)
select s.studio_id, s.image, 0
  from public.studio s
 where s.image is not null and btrim(s.image) <> ''
   and not exists (select 1 from public.studio_photo p where p.studio_id = s.studio_id);

-- studio.image always equals the main photo (lowest sort_order). With no photos it is empty.
create or replace function public.studio_photo_sync_image() returns trigger
language plpgsql security definer set search_path = public as $$
declare sid bigint := case when tg_op = 'DELETE' then old.studio_id else new.studio_id end;
begin
  update public.studio s
     set image = (select p.url from public.studio_photo p where p.studio_id = sid order by p.sort_order, p.photo_id limit 1)
   where s.studio_id = sid
     and s.image is distinct from (select p.url from public.studio_photo p where p.studio_id = sid order by p.sort_order, p.photo_id limit 1);
  -- a photo moved to another room: refresh the room it left too
  if tg_op = 'UPDATE' and old.studio_id <> new.studio_id then
    update public.studio s
       set image = (select p.url from public.studio_photo p where p.studio_id = old.studio_id order by p.sort_order, p.photo_id limit 1)
     where s.studio_id = old.studio_id;
  end if;
  return null;
end $$;

drop trigger if exists trg_studio_photo_sync on public.studio_photo;
create trigger trg_studio_photo_sync after insert or update or delete on public.studio_photo
  for each row execute function public.studio_photo_sync_image();

-- ---- 3. Row Level Security ---------------------------------------------------------------------------------------
grant select on public.studio_photo to anon, authenticated;
grant insert, update, delete on public.studio_photo to authenticated;

alter table public.studio_photo enable row level security;

drop policy if exists studio_photo_read       on public.studio_photo;
drop policy if exists studio_photo_staff_read on public.studio_photo;
drop policy if exists studio_photo_write      on public.studio_photo;

-- customers: photos of rooms they can see on the home page (Available, or Maintenance shown with its badge)
create policy studio_photo_read on public.studio_photo for select to anon, authenticated
  using (exists (select 1 from public.studio s where s.studio_id = studio_photo.studio_id and s.status in ('Available', 'Maintenance')));
-- staff: every room, including Unavailable ones
create policy studio_photo_staff_read on public.studio_photo for select to authenticated
  using (public.is_staff());
-- owner only: add, reorder, remove
create policy studio_photo_write on public.studio_photo for all to authenticated
  using (public.is_owner()) with check (public.is_owner());

-- ---- 4. Audit log: photo added / removed (needs 98_audit_log.sql; skipped when it has not been run) ----------------
create or replace function public.audit_trg_studio_photo() returns trigger
language plpgsql security definer set search_path = public as $$
declare sid bigint := case when tg_op = 'DELETE' then old.studio_id else new.studio_id end; nm text;
begin
  if auth.uid() is null or not public.is_staff() then return null; end if;
  select name into nm from public.studio where studio_id = sid;
  if nm is null then return null;   -- the room itself was deleted: that is audited as studio.deleted
  end if;
  if tg_op = 'INSERT' then
    perform public.audit_write('studio.photo_added', 'Settings', 'Added a photo to ' || nm,
      'studio', null, null, nm, null, jsonb_build_object('url', new.url));
  else
    perform public.audit_write('studio.photo_removed', 'Settings', 'Removed a photo from ' || nm,
      'studio', null, null, nm, jsonb_build_object('url', old.url), null);
  end if;
  return null;
exception when others then
  raise warning 'audit_log: trigger % failed: %', tg_name, sqlerrm;
  return null;
end $$;

do $$
begin
  if to_regprocedure('public.audit_write(text,text,text,text,text,text,text,jsonb,jsonb)') is null then
    raise notice 'Photo changes are not audited yet (98_audit_log.sql has not been run). Run this file again after it.';
    return;
  end if;
  drop trigger if exists trg_audit_studio_photo on public.studio_photo;
  create trigger trg_audit_studio_photo after insert or delete on public.studio_photo
    for each row execute function public.audit_trg_studio_photo();
end $$;

-- end of 105_studio_room_details.sql