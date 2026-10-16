-- =====================================================================
-- Tower of Dove Music Studio: Supabase schema
-- File 4 of 4: starting data (safe to re-run)
-- =====================================================================

insert into public.studio (name, description, capacity, hourly_rate, status) values
  ('Studio A', 'Drum and full band room',  8, 350, 'Available'),
  ('Studio B', 'Vocal and acoustic booth', 3, 250, 'Available'),
  ('Studio C', 'Mid-size band room',       6, 300, 'Available'),
  ('Studio D', 'Production room',          4, 280, 'Maintenance')
on conflict (lower(name)) do nothing;

insert into public.equipment_category (category_name) values
  ('Guitars'), ('Amplifiers'), ('Drums'), ('Keyboards'), ('Effects'), ('Accessories'), ('Other')
on conflict (category_name) do nothing;

-- rates: add-on = per session, outside = per day, drum sets = per rental.
-- min_hours = minimum OUTSIDE rental length.
insert into public.equipment
  (name, category_id, total_quantity, add_on_rate, outside_rate, allow_addon, allow_outside, min_hours, is_drum_set, drum_kit, is_vip)
select v.name, c.category_id, v.qty, v.addon, v.outside, v.allow_addon, v.allow_outside, v.min_hours, v.drum, v.kit, v.vip
from (select row_number() over () as ord, x.* from (values
  ('Electric guitar',     'Guitars',    4,  100, 250,  true, true,  8,  false, null,                                  false),
  ('Guitar amplifier',    'Amplifiers', 4,  150, 350,  true, true,  8,  false, null,                                  false),
  ('Set A Drum Set',      'Drums',      1, 2700, 2700, true, true,  8,  true,  'RDX drum set',                        false),
  ('Set B Drum Set',      'Drums',      1, 3000, 3000, true, true,  8,  true,  'RDX drum set',                        true),
  ('Set C Drum Set',      'Drums',      1, 2500, 2500, true, true,  8,  true,  'Steely drum set (high-end model)',    false),
  ('Set D Drum Set',      'Drums',      1, 2800, 2800, true, true,  8,  true,  'Steely drum set (high-end model)',    true),
  ('Drum kit add-ons',    'Drums',      2,  120, null, true, false, 0,  false, null,                                  false),
  ('Keyboard',            'Keyboards',  1,  200, 500,  true, true,  8,  false, null,                                  false),
  ('Multi-effects pedal', 'Effects',    3,   80, 150,  true, true,  8,  false, null,                                  false)
) as x(name, cat, qty, addon, outside, allow_addon, allow_outside, min_hours, drum, kit, vip)) as v
join public.equipment_category c on c.category_name = v.cat
order by v.ord
on conflict (lower(name)) do nothing;


-- =====================================================================
-- CREATING THE FIRST OWNER (run once, after the four files)
--
-- 1. Supabase dashboard -> Authentication -> Users -> Add user.
--    Email: owner@towerofdove.app   (the website turns the username "owner"
--    into username@towerofdove.app when signing in)
--    Password: choose one. Tick "Auto Confirm User".
-- 2. Authentication -> Providers -> Email: turn OFF "Confirm email"
--    (the fake @towerofdove.app addresses cannot receive mail).
-- 3. Run this, replacing the email if you used another one:
--
-- insert into public.app_user (auth_user_id, first_name, last_name, username, role)
-- select id, 'Studio', 'Owner', 'owner', 'Owner'
-- from auth.users where email = 'owner@towerofdove.app';
--
-- Staff accounts: create the Auth user from a server-side function (an Edge
-- Function using the service_role key and auth.admin.createUser), then insert
-- the matching app_user row with role = 'Staff'. Do not do this from the
-- browser: it would need the service_role key.
-- =====================================================================
