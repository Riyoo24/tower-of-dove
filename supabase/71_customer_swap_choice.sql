-- =====================================================================
-- 71_customer_swap_choice.sql - "Let customer choose" a replacement item
-- Run once in the Supabase SQL Editor (after 61_swap_rental_item.sql and 70_no_max_booking_hours.sql). Safe to re-run.
--
-- Why: when a unit is damaged and an upcoming rental can no longer get it, staff could only use "Swap item" (staff pick
-- the replacement alone). Now staff can ALSO offer the customer 1 to 5 equivalent items and let the customer pick one.
-- "Swap item" stays for urgent cases (pick-up in an hour).
--
-- The flow
--   1. staff_create_swap_offer()   staff choose 1-5 items that are free for the rental's hours, an answer deadline and
--                                  whether to swap to the first choice automatically if the customer does not answer.
--   2. While an offer is Open, the offered items are HELD for those hours (equipment_in_use_between counts them), so
--      nobody else can book them while the customer is deciding. Each offered item holds the rental's quantity.
--   3. my_swap_offers()            the customer sees their open offers and picks:
--      customer_choose_swap()      -> the line is swapped at once (no extra charge, no refund), or
--      customer_decline_swap()     -> "None of these suit me": staff are asked to follow up (move the date, etc.).
--   4. expire_swap_offers()        at the deadline: the first choice is swapped in (if the staff allowed it and it is still
--                                  free), otherwise the offer becomes "Expired" and staff follow up. If the original item
--                                  became free again, the offer is simply closed. Runs every minute with pg_cron, and the
--                                  admin page and the customer's My Rental page call it too.
--   5. Staff see: Awaiting customer choice -> Swapped (by the customer / automatically) | Declined | Expired.
--
-- Offer status:  Open | Swapped | Declined | Expired | Cancelled
-- resolved_by:   customer | auto | staff | system
-- =====================================================================

-- 1. tables -----------------------------------------------------------------------------------------------------------
create table if not exists public.rental_swap_offer (
  offer_id          bigint generated always as identity primary key,
  rental_order_id   bigint not null references public.rental_order (rental_order_id) on delete cascade,
  rental_ref        varchar(30) not null,
  rental_detail_id  bigint not null references public.rental_detail (rental_detail_id) on delete cascade,
  old_equipment_id  bigint references public.equipment (equipment_id) on delete set null,
  old_name          text not null,
  quantity          integer not null check (quantity > 0),
  status            text not null default 'Open',
  auto_assign       boolean not null default true,
  deadline_at       timestamptz not null,
  chosen_equipment_id bigint references public.equipment (equipment_id) on delete set null,
  chosen_name       text,
  resolved_by       text,
  note              text,
  created_by        bigint references public.app_user (user_id) on delete set null,
  created_at        timestamptz not null default now(),
  responded_at      timestamptz,
  resolved_at       timestamptz,
  constraint rental_swap_offer_status_chk check (status in ('Open', 'Swapped', 'Declined', 'Expired', 'Cancelled')),
  constraint rental_swap_offer_by_chk check (resolved_by is null or resolved_by in ('customer', 'auto', 'staff', 'system'))
);
create index if not exists rental_swap_offer_order_idx on public.rental_swap_offer (rental_order_id);
create index if not exists rental_swap_offer_open_idx on public.rental_swap_offer (status, deadline_at) where status = 'Open';
create unique index if not exists rental_swap_offer_one_open_per_line on public.rental_swap_offer (rental_detail_id) where status = 'Open';

create table if not exists public.rental_swap_offer_option (
  offer_id     bigint not null references public.rental_swap_offer (offer_id) on delete cascade,
  equipment_id bigint not null references public.equipment (equipment_id) on delete cascade,
  name         text not null,
  sort_order  smallint not null default 1,
  primary key (offer_id, equipment_id)
);
create index if not exists rental_swap_offer_option_eq_idx on public.rental_swap_offer_option (equipment_id);

alter table public.rental_swap_offer enable row level security;
alter table public.rental_swap_offer_option enable row level security;
drop policy if exists rental_swap_offer_select on public.rental_swap_offer;
create policy rental_swap_offer_select on public.rental_swap_offer for select to authenticated using (public.is_staff());
drop policy if exists rental_swap_offer_option_select on public.rental_swap_offer_option;
create policy rental_swap_offer_option_select on public.rental_swap_offer_option for select to authenticated using (public.is_staff());
revoke all on public.rental_swap_offer, public.rental_swap_offer_option from anon;
grant select on public.rental_swap_offer, public.rental_swap_offer_option to authenticated;

-- 2. offered items are HELD while the offer is Open ---------------------------------------------------------------------
--    Same function as file 53, plus: units offered to a customer who is still deciding count as taken (for the hours of
--    that customer's rental), except for the customer's own order. Like waiting (Pending) requests, they hold stock for
--    NEW requests but never block approving or issuing an order (p_include_pending = false skips them).
create or replace function public.equipment_in_use_between(
  p_equipment_id bigint, p_from timestamptz, p_to timestamptz, p_exclude_order bigint default null,
  p_include_pending boolean default true
) returns integer
language sql stable security definer set search_path = public as $$
  select (
    select coalesce(sum(d.quantity), 0)::int
      from public.rental_detail d
      join public.rental_order o on o.rental_order_id = d.rental_order_id
      cross join lateral public.order_window(o.rental_order_id) w
     where d.equipment_id = p_equipment_id
       and (o.status in ('Approved', 'Active')
            or (p_include_pending and o.status = 'Pending'
                and (o.booking_id is null
                     or exists (select 1 from public.booking bk
                                 where bk.booking_id = o.booking_id
                                   and bk.status in ('Pending', 'Approved', 'In Progress')))))
       and d.returned_at is null
       and (p_exclude_order is null or o.rental_order_id <> p_exclude_order)
       and (w.w_start is null or w.w_end is null
            or p_from is null or p_to is null
            or (w.w_start < p_to and p_from < w.w_end))
  ) + (
    case when p_include_pending then (
      select coalesce(sum(f.quantity), 0)::int
        from public.rental_swap_offer f
        join public.rental_swap_offer_option op on op.offer_id = f.offer_id
        cross join lateral public.order_window(f.rental_order_id) w
       where f.status = 'Open'
         and op.equipment_id = p_equipment_id
         and (p_exclude_order is null or f.rental_order_id <> p_exclude_order)
         and (w.w_start is null or w.w_end is null
              or p_from is null or p_to is null
              or (w.w_start < p_to and p_from < w.w_end))
    ) else 0 end
  );
$$;
revoke all on function public.equipment_in_use_between(bigint, timestamptz, timestamptz, bigint, boolean) from public, anon;
grant execute on function public.equipment_in_use_between(bigint, timestamptz, timestamptz, bigint, boolean) to anon, authenticated;

-- 3. the swap itself: one shared routine (file 61's staff_swap_rental_item now calls it) --------------------------------
--    Not callable from the website: only from the functions below (which check who is asking).
drop function if exists public.swap_apply_internal(bigint, bigint, text, bigint);
create function public.swap_apply_internal(
  p_rental_detail_id bigint,
  p_new_equipment_id bigint,
  p_reason           text,
  p_by_user_id       bigint
) returns void
language plpgsql security definer set search_path = public as $$
declare
  ln   record;
  o    public.rental_order;
  oe   public.equipment;
  ne   public.equipment;
  w    record;
  used int;
begin
  select d.rental_detail_id as did, d.rental_order_id as ord_id, d.equipment_id as eid, d.quantity as qty,
         d.returned_at as ret, d.before_photo_path as bpath
    into ln from public.rental_detail d where d.rental_detail_id = p_rental_detail_id;
  if not found then raise exception 'Rental item not found.' using errcode = 'P0001'; end if;

  select * into o from public.rental_order where rental_order_id = ln.ord_id for update;
  if o.status not in ('Pending', 'Approved') then
    raise exception 'Only a rental that has not been issued yet can have an item swapped (this one is %).', o.status using errcode = 'P0001';
  end if;
  if ln.ret is not null or ln.bpath is not null then
    raise exception 'This item was already issued or returned, so it cannot be swapped.' using errcode = 'P0001';
  end if;
  if p_new_equipment_id is null or p_new_equipment_id = ln.eid then
    raise exception 'Choose a different item to swap in.' using errcode = 'P0001';
  end if;

  perform 1 from public.equipment where equipment_id in (ln.eid, p_new_equipment_id) order by equipment_id for update;
  select * into oe from public.equipment where equipment_id = ln.eid;
  select * into ne from public.equipment where equipment_id = p_new_equipment_id;
  if not found then raise exception 'Equipment not found.' using errcode = 'P0001'; end if;

  if ne.status <> 'Available' then raise exception '% is not available for rent.', ne.name using errcode = 'P0001'; end if;
  if o.rental_type = 'Add-on' and not ne.allow_addon then
    raise exception '% cannot be rented as an add-on.', ne.name using errcode = 'P0001';
  end if;
  if o.rental_type = 'Outside' and not ne.allow_outside then
    raise exception '% cannot be rented outside the studio.', ne.name using errcode = 'P0001';
  end if;
  if exists (select 1 from public.rental_detail x where x.rental_order_id = o.rental_order_id and x.equipment_id = ne.equipment_id) then
    raise exception '% is already on this rental. Choose another item.', ne.name using errcode = 'P0001';
  end if;

  -- enough must be free for THE HOURS of this rental (this order's own held offer is not counted against it)
  select * into w from public.order_window(o.rental_order_id);
  used := public.equipment_in_use_between(ne.equipment_id, w.w_start, w.w_end, o.rental_order_id, true);
  if used + ln.qty > ne.total_quantity then
    raise exception 'Only % of % are free for the hours of this rental, but it needs %.',
      greatest(ne.total_quantity - used, 0), ne.name, ln.qty using errcode = 'P0001';
  end if;

  update public.rental_detail set equipment_id = ne.equipment_id where rental_detail_id = ln.did;

  insert into public.rental_item_swap
    (rental_order_id, rental_ref, rental_detail_id, old_equipment_id, new_equipment_id, old_name, new_name, quantity, reason, by_user_id)
  values (o.rental_order_id, o.rental_ref, ln.did, oe.equipment_id, ne.equipment_id, oe.name, ne.name, ln.qty, p_reason, p_by_user_id);
end $$;
revoke all on function public.swap_apply_internal(bigint, bigint, text, bigint) from public, anon, authenticated;

-- file 61's staff swap, now a thin wrapper: same checks and messages, and it closes any open offer for that line ------------
drop function if exists public.staff_swap_rental_item(bigint, bigint, text);
create function public.staff_swap_rental_item(
  p_rental_detail_id bigint,
  p_new_equipment_id bigint,
  p_reason           text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  why text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  if why is null then raise exception 'Enter a reason for the swap.' using errcode = 'P0001'; end if;

  perform public.swap_apply_internal(p_rental_detail_id, p_new_equipment_id, why, public.current_app_user_id());

  -- the staff swapped it directly, so a replacement offer still waiting for the customer is closed (and its held items released)
  update public.rental_swap_offer
     set status = 'Cancelled', resolved_by = 'staff', resolved_at = now(),
         note = 'Staff swapped the item directly.'
   where rental_detail_id = p_rental_detail_id and status = 'Open';
end $$;
revoke all on function public.staff_swap_rental_item(bigint, bigint, text) from public, anon;
grant execute on function public.staff_swap_rental_item(bigint, bigint, text) to authenticated;

-- 4. staff: offer the customer a choice -------------------------------------------------------------------------------------
drop function if exists public.staff_create_swap_offer(bigint, bigint[], timestamptz, boolean);
create function public.staff_create_swap_offer(
  p_rental_detail_id bigint,
  p_equipment_ids    bigint[],
  p_deadline_at      timestamptz,
  p_auto_assign      boolean default true
) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  ln    record;
  o     public.rental_order;
  oe    public.equipment;
  ne    public.equipment;
  w     record;
  used  int;
  ids   bigint[];
  i     int;
  n_id  bigint;
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;

  -- 1 to 5 different items, in the order staff listed them (the first is the one used if the customer does not answer)
  select coalesce(array_agg(x.id order by x.ord), array[]::bigint[]) into ids
    from (select id, min(ord) as ord from unnest(coalesce(p_equipment_ids, array[]::bigint[])) with ordinality as t(id, ord)
           where id is not null group by id) x;
  if coalesce(array_length(ids, 1), 0) < 1 then raise exception 'Choose at least one item to offer.' using errcode = 'P0001'; end if;
  if array_length(ids, 1) > 5 then raise exception 'Offer at most 5 items.' using errcode = 'P0001'; end if;

  select d.rental_detail_id as did, d.rental_order_id as ord_id, d.equipment_id as eid, d.quantity as qty,
         d.returned_at as ret, d.before_photo_path as bpath
    into ln from public.rental_detail d where d.rental_detail_id = p_rental_detail_id;
  if not found then raise exception 'Rental item not found.' using errcode = 'P0001'; end if;

  select * into o from public.rental_order where rental_order_id = ln.ord_id for update;
  if o.status not in ('Pending', 'Approved') then
    raise exception 'Only a rental that has not been issued yet can be offered a replacement (this one is %).', o.status using errcode = 'P0001';
  end if;
  if ln.ret is not null or ln.bpath is not null then
    raise exception 'This item was already issued or returned, so it cannot be replaced.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.rental_swap_offer f where f.rental_detail_id = ln.did and f.status = 'Open') then
    raise exception 'This item already has a replacement offer waiting for the customer. Cancel it first to make a new one.' using errcode = 'P0001';
  end if;

  select * into w from public.order_window(o.rental_order_id);
  if p_deadline_at is null or p_deadline_at < now() + interval '5 minutes' then
    raise exception 'The customer needs at least 5 minutes to answer. Choose a later deadline, or use Swap item.' using errcode = 'P0001';
  end if;
  if w.w_start is not null and p_deadline_at > w.w_start - interval '15 minutes' then
    raise exception 'The deadline must be at least 15 minutes before the rental starts. Choose an earlier deadline, or use Swap item.' using errcode = 'P0001';
  end if;

  select * into oe from public.equipment where equipment_id = ln.eid;

  -- lock the offered items in id order, then check each one
  perform 1 from public.equipment where equipment_id = any(ids) order by equipment_id for update;
  for i in 1 .. array_length(ids, 1) loop
    select * into ne from public.equipment where equipment_id = ids[i];
    if not found then raise exception 'Equipment not found.' using errcode = 'P0001'; end if;
    if ne.equipment_id = ln.eid then raise exception 'Do not offer the same item that is being replaced.' using errcode = 'P0001'; end if;
    if ne.status <> 'Available' then raise exception '% is not available for rent.', ne.name using errcode = 'P0001'; end if;
    if o.rental_type = 'Add-on' and not ne.allow_addon then
      raise exception '% cannot be rented as an add-on.', ne.name using errcode = 'P0001';
    end if;
    if o.rental_type = 'Outside' and not ne.allow_outside then
      raise exception '% cannot be rented outside the studio.', ne.name using errcode = 'P0001';
    end if;
    if exists (select 1 from public.rental_detail x where x.rental_order_id = o.rental_order_id and x.equipment_id = ne.equipment_id) then
      raise exception '% is already on this rental. Offer another item.', ne.name using errcode = 'P0001';
    end if;
    used := public.equipment_in_use_between(ne.equipment_id, w.w_start, w.w_end, o.rental_order_id, true);
    if used + ln.qty > ne.total_quantity then
      raise exception 'Only % of % are free for the hours of this rental (others may be held for another customer), but it needs %.',
        greatest(ne.total_quantity - used, 0), ne.name, ln.qty using errcode = 'P0001';
    end if;
  end loop;

  insert into public.rental_swap_offer
    (rental_order_id, rental_ref, rental_detail_id, old_equipment_id, old_name, quantity, auto_assign, deadline_at, created_by)
  values (o.rental_order_id, o.rental_ref, ln.did, oe.equipment_id, oe.name, ln.qty, coalesce(p_auto_assign, true), p_deadline_at,
          public.current_app_user_id())
  returning offer_id into n_id;

  insert into public.rental_swap_offer_option (offer_id, equipment_id, name, sort_order)
  select n_id, e.equipment_id, e.name::text, a.ord::smallint
    from unnest(ids) with ordinality as a(id, ord)
    join public.equipment e on e.equipment_id = a.id;

  return n_id;
end $$;
revoke all on function public.staff_create_swap_offer(bigint, bigint[], timestamptz, boolean) from public, anon;
grant execute on function public.staff_create_swap_offer(bigint, bigint[], timestamptz, boolean) to authenticated;

drop function if exists public.staff_cancel_swap_offer(bigint, text);
create function public.staff_cancel_swap_offer(p_offer_id bigint, p_note text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare f public.rental_swap_offer;
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  select * into f from public.rental_swap_offer where offer_id = p_offer_id for update;
  if not found then raise exception 'Offer not found.' using errcode = 'P0001'; end if;
  if f.status <> 'Open' then raise exception 'This offer is already closed (%).', f.status using errcode = 'P0001'; end if;
  update public.rental_swap_offer
     set status = 'Cancelled', resolved_by = 'staff', resolved_at = now(),
         note = coalesce(nullif(trim(coalesce(p_note, '')), ''), 'Cancelled by staff.')
   where offer_id = p_offer_id;
end $$;
revoke all on function public.staff_cancel_swap_offer(bigint, text) from public, anon;
grant execute on function public.staff_cancel_swap_offer(bigint, text) to authenticated;

-- 5. customer: see the open offers, choose, or decline ----------------------------------------------------------------------
drop function if exists public.expire_swap_offers();
create function public.expire_swap_offers() returns integer
language plpgsql security definer set search_path = public as $$
declare
  f     public.rental_swap_offer;
  o     public.rental_order;
  oe    public.equipment;
  w     record;
  opt   record;
  done  boolean;
  n     integer := 0;
begin
  for f in
    select * from public.rental_swap_offer
     where status = 'Open' and deadline_at <= now()
     order by deadline_at
       for update skip locked
  loop
    begin
      select * into o from public.rental_order where rental_order_id = f.rental_order_id;

      -- the rental was cancelled, rejected, issued ... : nothing left to swap
      if not found or o.status not in ('Pending', 'Approved') then
        update public.rental_swap_offer set status = 'Cancelled', resolved_by = 'system', resolved_at = now(),
               note = 'The rental is no longer waiting to be issued.' where offer_id = f.offer_id;
        n := n + 1;
        continue;
      end if;

      -- the original item is free for this rental again (repaired / found): no replacement needed
      select * into oe from public.equipment where equipment_id = f.old_equipment_id;
      select * into w from public.order_window(f.rental_order_id);
      if found and oe.status = 'Available'
         and oe.total_quantity - public.equipment_in_use_between(oe.equipment_id, w.w_start, w.w_end, f.rental_order_id, true) >= f.quantity then
        update public.rental_swap_offer set status = 'Cancelled', resolved_by = 'system', resolved_at = now(),
               note = 'The original item is available again, so no replacement was needed.' where offer_id = f.offer_id;
        n := n + 1;
        continue;
      end if;

      done := false;
      if f.auto_assign then
        for opt in select equipment_id, name from public.rental_swap_offer_option where offer_id = f.offer_id order by sort_order loop
          begin
            perform public.swap_apply_internal(f.rental_detail_id, opt.equipment_id,
              'The customer did not answer by the deadline, so the first choice was used.', null);
            update public.rental_swap_offer set status = 'Swapped', resolved_by = 'auto', resolved_at = now(),
                   chosen_equipment_id = opt.equipment_id, chosen_name = opt.name where offer_id = f.offer_id;
            done := true;
            exit;
          exception when others then
            null;   -- this one cannot be used any more: try the next choice
          end;
        end loop;
      end if;

      if not done then
        update public.rental_swap_offer set status = 'Expired', resolved_by = 'system', resolved_at = now(),
               note = case when f.auto_assign then 'No answer, and none of the offered items could be assigned automatically.'
                           else 'No answer from the customer.' end
         where offer_id = f.offer_id;
      end if;
      n := n + 1;
    exception when others then
      null;   -- never let one bad offer stop the others
    end;
  end loop;
  return n;
end $$;
revoke all on function public.expire_swap_offers() from public, anon;
grant execute on function public.expire_swap_offers() to authenticated;

drop function if exists public.my_swap_offers();
create function public.my_swap_offers()
returns table (
  offer_id        bigint,
  rental_ref      text,
  rental_type     text,
  booking_ref     text,
  old_name        text,
  quantity        integer,
  deadline_at     timestamptz,
  auto_assign     boolean,
  w_start         timestamptz,
  w_end           timestamptz,
  option_id       bigint,
  option_name     text,
  option_category text,
  option_image    text,
  option_position integer
)
language plpgsql security definer set search_path = public as $$
declare cid bigint := public.current_customer_id();
begin
  if cid is null then return; end if;
  perform public.expire_swap_offers();   -- offers past their deadline are settled first

  return query
  select f.offer_id, f.rental_ref::text, o.rental_type::text, bk.booking_ref::text, f.old_name, f.quantity, f.deadline_at, f.auto_assign,
         w.w_start, w.w_end,
         e.equipment_id, e.name::text, c.category_name::text, e.image::text, op.sort_order::int
    from public.rental_swap_offer f
    join public.rental_order o on o.rental_order_id = f.rental_order_id
    left join public.booking bk on bk.booking_id = o.booking_id
    cross join lateral public.order_window(o.rental_order_id) w
    join public.rental_swap_offer_option op on op.offer_id = f.offer_id
    join public.equipment e on e.equipment_id = op.equipment_id and e.status = 'Available'
    left join public.equipment_category c on c.category_id = e.category_id
   where o.customer_id = cid
     and f.status = 'Open'
     and f.deadline_at > now()
     and o.status in ('Pending', 'Approved')
   order by f.deadline_at, f.offer_id, op.sort_order;
end $$;
revoke all on function public.my_swap_offers() from public, anon;
grant execute on function public.my_swap_offers() to authenticated;

drop function if exists public.customer_choose_swap(bigint, bigint);
create function public.customer_choose_swap(p_offer_id bigint, p_equipment_id bigint)
returns text
language plpgsql security definer set search_path = public as $$
declare
  cid bigint := public.current_customer_id();
  f   public.rental_swap_offer;
  op  public.rental_swap_offer_option;
begin
  if cid is null then raise exception 'Please sign in first.' using errcode = '42501'; end if;

  select f2.* into f
    from public.rental_swap_offer f2
    join public.rental_order o on o.rental_order_id = f2.rental_order_id
   where f2.offer_id = p_offer_id and o.customer_id = cid
     for update of f2;
  if not found then raise exception 'This offer could not be found.' using errcode = 'P0001'; end if;
  if f.status <> 'Open' then raise exception 'This offer is no longer open. Please check My rental or contact the studio.' using errcode = 'P0001'; end if;
  if f.deadline_at <= now() then raise exception 'The time to choose has passed. The studio will contact you.' using errcode = 'P0001'; end if;

  select * into op from public.rental_swap_offer_option where offer_id = f.offer_id and equipment_id = p_equipment_id;
  if not found then raise exception 'That item is not one of your choices.' using errcode = 'P0001'; end if;

  perform public.swap_apply_internal(f.rental_detail_id, op.equipment_id, 'The customer chose this replacement.', null);

  update public.rental_swap_offer
     set status = 'Swapped', resolved_by = 'customer', responded_at = now(), resolved_at = now(),
         chosen_equipment_id = op.equipment_id, chosen_name = op.name
   where offer_id = f.offer_id;
  return op.name;
end $$;
revoke all on function public.customer_choose_swap(bigint, bigint) from public, anon;
grant execute on function public.customer_choose_swap(bigint, bigint) to authenticated;

drop function if exists public.customer_decline_swap(bigint, text);
create function public.customer_decline_swap(p_offer_id bigint, p_note text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  cid bigint := public.current_customer_id();
  f   public.rental_swap_offer;
begin
  if cid is null then raise exception 'Please sign in first.' using errcode = '42501'; end if;
  select f2.* into f
    from public.rental_swap_offer f2
    join public.rental_order o on o.rental_order_id = f2.rental_order_id
   where f2.offer_id = p_offer_id and o.customer_id = cid
     for update of f2;
  if not found then raise exception 'This offer could not be found.' using errcode = 'P0001'; end if;
  if f.status <> 'Open' then raise exception 'This offer is no longer open.' using errcode = 'P0001'; end if;
  update public.rental_swap_offer
     set status = 'Declined', resolved_by = 'customer', responded_at = now(), resolved_at = now(),
         note = nullif(left(trim(coalesce(p_note, '')), 300), '')
   where offer_id = f.offer_id;
end $$;
revoke all on function public.customer_decline_swap(bigint, text) from public, anon;
grant execute on function public.customer_decline_swap(bigint, text) to authenticated;

-- 6. settle expired offers by itself (every minute) ----------------------------------------------------------------------------
do $$
begin
  create extension if not exists pg_cron with schema pg_catalog;
  perform cron.unschedule(jobid) from cron.job where jobname = 'tod-expire-swap-offers';
  perform cron.schedule('tod-expire-swap-offers', '* * * * *', 'select public.expire_swap_offers()');
exception when others then
  raise notice 'pg_cron is not available: expired offers are still settled when the admin page or the customer''s My rental page loads.';
end $$;

-- end of 71_customer_swap_choice.sql
