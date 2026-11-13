-- =====================================================================
-- 82_no_show_in_flag.sql  (safe to re-run; run after 78_no_show_release.sql)
-- 1. The flag window in the admin lists a customer's no-shows (last 12 months, people sharing a phone number
--    together), next to late returns and damage fees.
-- 2. Staff can add a note to a no-show and dismiss it (a note is required), exactly like a late return or damage
--    fee. A dismissed no-show stops counting toward the flag and can be counted again. Every note / dismissal is
--    logged with who and when (incident_review / incident_review_log from 64_damage_block_reputation.sql).
-- =====================================================================
alter table public.incident_review drop constraint if exists incident_review_kind_chk;
alter table public.incident_review add constraint incident_review_kind_chk
  check (incident_kind in ('late', 'damage', 'noshow'));

-- the no-show chip / flag count now skips dismissed no-shows
create or replace function public.staff_no_show_counts()
returns table (customer_id bigint, no_shows integer, last_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  return query
  with cust as (
    select c.customer_id as cid, coalesce(public.phone_key(c.number), 'c' || c.customer_id::text) as gk from public.customer c
  ), ev as (
    select cu.gk, e.at from public.booking_event e
      join public.booking b on b.booking_id = e.booking_id
      join cust cu on cu.cid = b.customer_id
     where e.action = 'No-show' and e.at >= now() - interval '12 months'
       and not exists (select 1 from public.incident_review r where r.incident_kind = 'noshow' and r.ref_id = e.event_id and r.dismissed)
  ), g as (
    select ev.gk, count(*)::int as n, max(ev.at) as last_at from ev group by ev.gk
  )
  select cu.cid, g.n, g.last_at from cust cu join g on g.gk = cu.gk;
end $$;

-- note / dismiss: the same function as for late returns and damage fees, now also for 'noshow' (ref_id = booking_event.event_id)
drop function if exists public.staff_review_incident(text, bigint, text, boolean);
create function public.staff_review_incident(p_kind text, p_ref_id bigint, p_note text default null, p_dismiss boolean default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  cid bigint; st text; cur public.incident_review; note_new text; dis_new boolean;
  uid bigint := public.current_app_user_id(); nm text := public.staff_display_name();
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  if p_kind not in ('late', 'damage', 'noshow') then raise exception 'Unknown incident type.' using errcode = 'P0001'; end if;
  if p_note is null and p_dismiss is null then raise exception 'Write a note or choose to dismiss the incident.' using errcode = 'P0001'; end if;

  if p_kind = 'late' then
    select o.customer_id into cid from public.rental_order o
     where o.rental_order_id = p_ref_id and o.rental_type = 'Outside'
       and exists (select 1 from public.rental_detail d where d.rental_order_id = o.rental_order_id and d.returned_at is not null
                      and d.returned_at > public.rental_due_at(o.pickup_date, o.return_date));
  elsif p_kind = 'noshow' then
    select b.customer_id into cid from public.booking_event e join public.booking b on b.booking_id = e.booking_id
     where e.event_id = p_ref_id and e.action = 'No-show';
  else
    select o.customer_id, dc.status into cid, st from public.damage_charge dc
      join public.rental_order o on o.rental_order_id = dc.rental_order_id where dc.damage_charge_id = p_ref_id;
  end if;
  if cid is null then raise exception 'Incident not found.' using errcode = 'P0001'; end if;

  select * into cur from public.incident_review where incident_kind = p_kind and ref_id = p_ref_id for update;
  note_new := case when p_note is null then cur.note else nullif(trim(p_note), '') end;
  dis_new  := coalesce(p_dismiss, coalesce(cur.dismissed, false));

  if dis_new and not coalesce(cur.dismissed, false) then
    if p_kind = 'damage' and st in ('Unpaid', 'Pending') then
      raise exception 'This damage fee is still unpaid, so it cannot be dismissed. Ask the owner to waive it or lift the block.' using errcode = 'P0001';
    end if;
    if note_new is null then raise exception 'Write a note saying why you are dismissing this incident.' using errcode = 'P0001'; end if;
  end if;

  insert into public.incident_review (incident_kind, ref_id, note, dismissed, dismissed_at, updated_by, updated_by_name, updated_at)
  values (p_kind, p_ref_id, note_new, dis_new, case when dis_new then now() end, uid, nm, now())
  on conflict (incident_kind, ref_id) do update
    set note = excluded.note, dismissed = excluded.dismissed,
        dismissed_at = case when excluded.dismissed then coalesce(public.incident_review.dismissed_at, now()) end,
        updated_by = excluded.updated_by, updated_by_name = excluded.updated_by_name, updated_at = now();

  if p_note is not null and note_new is distinct from cur.note then
    insert into public.incident_review_log (incident_kind, ref_id, customer_id, action, note, by_user_id, by_name)
    values (p_kind, p_ref_id, cid, 'Note', note_new, uid, nm);
  end if;
  if dis_new is distinct from coalesce(cur.dismissed, false) then
    insert into public.incident_review_log (incident_kind, ref_id, customer_id, action, note, by_user_id, by_name)
    values (p_kind, p_ref_id, cid, case when dis_new then 'Dismissed' else 'Restored' end, note_new, uid, nm);
  end if;
end $$;

drop function if exists public.staff_no_show_list(bigint);
create function public.staff_no_show_list(p_customer_id bigint)
returns table (event_id bigint, booking_ref text, customer_name text, occurred_at timestamptz, what text, by_name text,
               dismissed boolean, review_note text, reviewed_by text, reviewed_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  return query
  select e.event_id, b.booking_ref::text, trim(c.first_name || ' ' || coalesce(c.last_name, ''))::text, e.at, e.note::text, e.by_name::text,
         coalesce(r.dismissed, false), r.note::text, r.updated_by_name::text, r.updated_at
    from public.booking_event e
    join public.booking b  on b.booking_id  = e.booking_id
    join public.customer c on c.customer_id = b.customer_id
    left join public.incident_review r on r.incident_kind = 'noshow' and r.ref_id = e.event_id
   where e.action = 'No-show' and e.at >= now() - interval '12 months'
     and coalesce(public.phone_key(c.number), 'c' || c.customer_id::text)
       = (select coalesce(public.phone_key(x.number), 'c' || x.customer_id::text)
            from public.customer x where x.customer_id = p_customer_id)
   order by e.at desc;
end $$;
revoke all on function public.staff_no_show_list(bigint) from public, anon;
grant execute on function public.staff_no_show_list(bigint) to authenticated;

revoke all on function public.staff_review_incident(text, bigint, text, boolean) from public, anon;
grant execute on function public.staff_review_incident(text, bigint, text, boolean) to authenticated;
