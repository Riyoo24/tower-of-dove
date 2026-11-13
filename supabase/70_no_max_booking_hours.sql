-- =====================================================================
-- 70_no_max_booking_hours.sql
-- Removes the 4-hour maximum of a studio booking (and of an extension).
-- A booking may now be 1 hour up to the whole day (10:00 AM to 10:00 PM).
-- The only limit is the schedule: the website offers hours up to the start of
-- the next booked / held hour (get_busy_slots), and the database still refuses
-- any overlap (exclusion constraint / slot checks) and anything past 10:00 PM.
-- Safe to re-run.
-- =====================================================================

create or replace function public.validate_slot(p_start timestamptz, p_end timestamptz, p_allow_current_hour boolean default false)
returns void language plpgsql stable set search_path = public as $$
declare
  s timestamp := p_start at time zone 'Asia/Manila';
  e timestamp := p_end   at time zone 'Asia/Manila';
  hrs numeric := extract(epoch from (p_end - p_start)) / 3600.0;
begin
  if p_start is null or p_end is null or p_end <= p_start then
    raise exception 'Choose a valid start and end time.' using errcode = 'P0001';
  end if;
  if extract(minute from s) <> 0 or extract(second from s) <> 0
     or extract(minute from e) <> 0 or extract(second from e) <> 0 then
    raise exception 'Bookings start and end on the hour.' using errcode = 'P0001';
  end if;
  if hrs < 1 or hrs <> floor(hrs) then
    raise exception 'Bookings are whole hours, at least 1 hour.' using errcode = 'P0001';
  end if;
  if s::date <> e::date or extract(hour from s) < 10 or e::time > '22:00' then
    raise exception 'The studio is open 10:00 AM to 10:00 PM, and a booking must finish the same day.' using errcode = 'P0001';
  end if;
  if p_allow_current_hour then
    if p_start < date_trunc('hour', now()) then
      raise exception 'That time has already passed.' using errcode = 'P0001';
    end if;
  elsif p_start <= now() then
    raise exception 'Choose a time in the future.' using errcode = 'P0001';
  end if;
end $$;

-- Extensions: the same cap of 4 extra hours is lifted. Every version of the extension functions
-- (staff_extension_info, request / hold / customer extend ...) is patched in place, so this works
-- whichever numbered files were run. 12 is the length of the whole opening day, so it can never bind;
-- the real limit stays "until the next occupied hour or 10:00 PM".
do $$
declare r record; def text; newdef text;
begin
  for r in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
  loop
    def := pg_get_functiondef(r.oid);
    continue when def not like '%least(4, greatest(0,%' and def not like '%p_extra_hours > 4%';
    newdef := replace(replace(replace(def,
      'least(4, greatest(0,', 'least(12, greatest(0,'),
      'p_extra_hours > 4', 'p_extra_hours > 12'),
      'Choose 1 to 4 extra hours.', 'Choose at least 1 extra hour.');
    execute newdef;
  end loop;
end $$;

do $$
begin
  if exists (select 1 from pg_constraint where conname = 'booking_extension_hours_chk') then
    alter table public.booking_extension drop constraint booking_extension_hours_chk;
  end if;
  alter table public.booking_extension add constraint booking_extension_hours_chk check (extra_hours between 1 and 12);
exception when undefined_table then null;
end $$;
