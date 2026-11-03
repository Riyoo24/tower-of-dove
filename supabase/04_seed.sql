-- =====================================================================
-- Tower of Dove Music Studio: Supabase schema
-- File 4 of 4: starting data (safe to re-run)
-- =====================================================================

insert into public.studio (name, description, hourly_rate, status) values
  ('Studio A', 'Drum and full band room',  350, 'Available'),
  ('Studio B', 'Vocal and acoustic booth', 250, 'Available'),
  ('Studio C', 'Mid-size band room',       300, 'Available'),
  ('Studio D', 'Production room',          280, 'Maintenance')
on conflict (lower(name)) do nothing;

insert into public.equipment_category (category_name) values
  ('Guitars'), ('Amplifiers'), ('Drums'), ('Keyboards'), ('Effects'), ('Accessories'), ('Other')
on conflict (category_name) do nothing;

-- rates: add-on = per session, outside = per day.
-- min_hours = minimum OUTSIDE rental length.
-- Drum model and configuration details go in name and description.
insert into public.equipment
  (name, category_id, description, total_quantity, add_on_rate, outside_rate, allow_addon, allow_outside, min_hours)
select v.name, c.category_id, v.desc, v.qty, v.addon, v.outside, v.allow_addon, v.allow_outside, v.min_hours
from (select row_number() over () as ord, x.* from (values
  ('Electric guitar',     'Guitars',    null,                                           4,  100,  250,  true, true,  8),
  ('Guitar amplifier',    'Amplifiers', null,                                           4,  150,  350,  true, true,  8),
  ('Set A Drum Set',      'Drums',      'RDX drum set. 1 crash, 1 ride, hi-hat.',       1, 2700, 2700, true, true,  8),
  ('Set B Drum Set',      'Drums',      'RDX drum set. 2 crash, 1 ride, hi-hat, splash.', 1, 3000, 3000, true, true, 8),
  ('Set C Drum Set',      'Drums',      'Steely drum set (high-end model). 1 crash, 1 ride, hi-hat.', 1, 2500, 2500, true, true, 8),
  ('Set D Drum Set',      'Drums',      'Steely drum set (high-end model). 2 crash, 1 ride, hi-hat, splash.', 1, 2800, 2800, true, true, 8),
  ('Drum kit add-ons',    'Drums',      null,                                           2,  120, null, true, false, 0),
  ('Keyboard',            'Keyboards',  null,                                           1,  200,  500, true, true,  8),
  ('Multi-effects pedal', 'Effects',    null,                                           3,   80,  150, true, true,  8)
) as x(name, cat, desc, qty, addon, outside, allow_addon, allow_outside, min_hours)) as v
join public.equipment_category c on c.category_name = v.cat
order by v.ord
on conflict (lower(name)) do nothing;


-- =====================================================================
-- CREATING THE FIRST OWNER (run once, after the four files)
--
-- 1. Supabase dashboard -> Authentication -> Users -> Add user.
--    Email: towerofdovemusic@gmail.com   (the owner's real email; it is the login on the website)
--    Password: choose one. Tick "Auto Confirm User".
-- 2. Authentication -> Providers -> Email: turn ON "Confirm email" (see supabase/README.md > Email verification setup)
--    ("Auto Confirm User" above keeps the owner able to log in; customers must confirm by email.)
-- 3. Run this, replacing the email if you used another one:
--
-- insert into public.app_user (auth_user_id, first_name, last_name, username, email, role)
-- select id, 'Studio', 'Owner', 'towerofdovemusic@gmail.com', 'towerofdovemusic@gmail.com', 'Owner'
-- from auth.users where email = 'towerofdovemusic@gmail.com';
--
-- Staff accounts: create the Auth user from a server-side function (an Edge
-- Function using the service_role key and auth.admin.createUser), then insert
-- the matching app_user row with role = 'Staff'. Do not do this from the
-- browser: it would need the service_role key.
-- =====================================================================
