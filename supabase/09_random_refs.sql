-- =====================================================================
-- 09_random_refs.sql  (safe to re-run)
-- Reference codes become random so they cannot be guessed:
--   bookings  TOD-9F3A21C7     outside rentals  OUT-5B07E1AA     add-on rentals  RA-C41D90E2
-- (8 random characters instead of a counting number.) Codes that already exist keep
-- working and are not changed. Run this once in the Supabase SQL Editor.
-- =====================================================================
create or replace function public.random_ref(p_prefix text) returns text
language plpgsql volatile set search_path = public as $$
declare r text;
begin
  loop
    r := p_prefix || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    exit when not exists (select 1 from public.booking      where booking_ref = r)
          and not exists (select 1 from public.rental_order where rental_ref  = r);
  end loop;
  return r;
end $$;
grant execute on function public.random_ref(text) to anon, authenticated;

-- new bookings get a random code
alter table public.booking alter column booking_ref set default public.random_ref('TOD');

-- new rental orders get a random code (this trigger runs before the one that used to number them)
create or replace function public.rental_random_ref() returns trigger
language plpgsql as $$
begin
  if new.rental_ref is null or new.rental_ref = '' then
    new.rental_ref := public.random_ref(case new.rental_type when 'Outside' then 'OUT' else 'RA' end);
  end if;
  return new;
end $$;
drop trigger if exists aa_rental_random_ref on public.rental_order;
create trigger aa_rental_random_ref before insert on public.rental_order
  for each row execute function public.rental_random_ref();
