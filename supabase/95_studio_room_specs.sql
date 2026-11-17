-- 95_studio_room_specs.sql
-- Adds a separate "Room specs" (gear list) field to each studio. The existing Description stays a short line.
-- Safe to run more than once.

alter table public.studio add column if not exists room_specs text;

comment on column public.studio.room_specs is 'Gear in the room, one item per line. A line saying "not included" is shown as a note.';