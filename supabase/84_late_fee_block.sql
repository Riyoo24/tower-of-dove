-- =====================================================================
-- 84_late_fee_block.sql  (safe to re-run; run after 83_late_fee_collection.sql and 64_damage_block_reputation.sql)
-- A late fee that is left unpaid at the return ("Not now") now works like an unpaid damage fee:
--   * LOCK: the customer (and anyone with the same phone number) cannot book or rent again until it is paid. Pending (the customer
--     sent GCash, staff have not checked it) still blocks, exactly like a damage fee. The owner's Waive / Defer / Lift block
--     work for it too (Waive sets the late fee to 0 and logs the amount).
--   * RED FLAG: an unpaid late fee always makes the customer's flag red, whatever its age (an unpaid damage fee does the same).
--     The late return itself still counts as before (1-2 late returns = yellow, 3+ = red).
--   * Only the functions below are replaced; they are copies of the ones in file 64 with the late fee added.
--     The messages now say "unpaid fee" instead of "unpaid damage fee", because it can be either.
-- =====================================================================

-- 1. which open fees block a customer
drop function if exists public.damage_block_fees(bigint, text);
create function public.damage_block_fees(p_customer_id bigint, p_phone text default null)
returns table (f_order_id bigint, f_ref text, f_owner_id bigint, f_unpaid numeric, f_pending numeric, f_first_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare k1 text; k2 text := public.phone_key(p_phone);
begin
  select public.phone_key(c.number) into k1 from public.customer c where c.customer_id = p_customer_id;

  -- an active "lift" for this customer or anyone with the same phone number
  if exists (
    select 1 from public.damage_block_override v
      join public.customer c on c.customer_id = v.customer_id
     where v.kind = 'lift' and v.revoked_at is null and (v.until_at is null or v.until_at > now())
       and (c.customer_id = p_customer_id
            or (k1 is not null and public.phone_key(c.number) = k1)
            or (k2 is not null and public.phone_key(c.number) = k2))
  ) then
    return;
  end if;

  return query
  with open_fees as (
    select dc.rental_order_id as oid, dc.amount as amt, dc.status::text as st, dc.created_at as ts
      from public.damage_charge dc
     where dc.status in ('Unpaid', 'Pending') and dc.amount > 0
    union all
    -- NEW: a late fee that was left unpaid at the return (83_late_fee_collection.sql), Pending = the customer sent GCash
    select d.rental_order_id, d.late_fee, case when d.late_fee_pending_reference is not null then 'Pending' else 'Unpaid' end, d.returned_at
      from public.rental_detail d
     where d.late_fee_deferred and d.late_fee_paid_at is null and d.late_fee > 0 and d.returned_at is not null
  )
  select o.rental_order_id, o.rental_ref::text, o.customer_id,
         coalesce(sum(f.amt) filter (where f.st = 'Unpaid'), 0),
         coalesce(sum(f.amt) filter (where f.st = 'Pending'), 0),
         min(f.ts)
    from open_fees f
    join public.rental_order o on o.rental_order_id = f.oid
    join public.customer c on c.customer_id = o.customer_id
   where (c.customer_id = p_customer_id
          or (k1 is not null and public.phone_key(c.number) = k1)
          or (k2 is not null and public.phone_key(c.number) = k2))
     and not exists (select 1 from public.damage_block_override v
                      where v.kind = 'defer' and v.rental_order_id = o.rental_order_id
                        and v.revoked_at is null and v.until_at > now())
   group by o.rental_order_id, o.rental_ref, o.customer_id
   order by min(f.ts);
end $$;
revoke all on function public.damage_block_fees(bigint, text) from public, anon, authenticated;

-- 2. the text shown when a booking / rental is refused
drop function if exists public.damage_block_message(bigint, text);
create function public.damage_block_message(p_customer_id bigint, p_phone text default null)
returns text
language plpgsql stable security definer set search_path = public as $$
declare
  me     bigint := public.current_customer_id();
  staff  boolean := public.is_staff();
  rows_n int; own_n int;
  unpaid numeric := 0; pend numeric := 0; refs_u text; refs_p text; n_u int; n_p int;
begin
  select count(*) into rows_n from public.damage_block_fees(p_customer_id, p_phone);
  if rows_n = 0 then return null; end if;

  select count(*) into own_n from public.damage_block_fees(p_customer_id, p_phone) f where me is not null and f.f_owner_id = me;

  if not staff and own_n = 0 then
    return 'This phone number has an unpaid fee from an earlier rental. Please log in to your account or visit the studio to settle it before booking or renting again.';
  end if;

  select coalesce(sum(f.f_unpaid), 0), coalesce(sum(f.f_pending), 0),
         string_agg(f.f_ref, ', ' order by f.f_first_at) filter (where f.f_unpaid > 0),
         string_agg(f.f_ref, ', ' order by f.f_first_at) filter (where f.f_pending > 0 and f.f_unpaid = 0),
         count(*) filter (where f.f_unpaid > 0),
         count(*) filter (where f.f_pending > 0 and f.f_unpaid = 0)
    into unpaid, pend, refs_u, refs_p, n_u, n_p
    from public.damage_block_fees(p_customer_id, p_phone) f
   where staff or f.f_owner_id = me;

  if unpaid > 0 then
    if staff then
      return 'This customer has ' || case when n_u = 1 then 'an unpaid fee' else 'unpaid fees' end
        || ' of ' || public.damage_peso_text(unpaid) || ' for ' || case when n_u = 1 then 'rental ' else 'rentals ' end || refs_u
        || '. Collect it first (Rentals, Actions) or ask the owner to lift the block.';
    end if;
    return 'You have ' || case when n_u = 1 then 'an unpaid fee' else 'unpaid fees' end
      || ' of ' || public.damage_peso_text(unpaid) || ' for ' || case when n_u = 1 then 'rental ' else 'rentals ' end || refs_u
      || '. Please pay ' || case when n_u = 1 then 'it' else 'them' end || ' before booking or renting again.';
  end if;

  if staff then
    return 'This customer sent a GCash payment of ' || public.damage_peso_text(pend) || ' for the fee on '
      || case when n_p = 1 then 'rental ' else 'rentals ' end || refs_p
      || '. Check it first (Payments) or ask the owner to lift the block.';
  end if;
  return 'Your fee payment of ' || public.damage_peso_text(pend) || ' for '
    || case when n_p = 1 then 'rental ' else 'rentals ' end || refs_p
    || ' is waiting for staff to check it. You can book or rent again once it is confirmed.';
end $$;
revoke all on function public.damage_block_message(bigint, text) from public, anon, authenticated;

-- 3. the flag
drop function if exists public.staff_customer_reputation();
create function public.staff_customer_reputation()
returns table (
  customer_id bigint, late_count integer, damage_unpaid integer, damage_paid integer, unpaid_amount numeric,
  flag text, summary text, blocked boolean, block_amount numeric, block_fees jsonb, lifted boolean, lift_until timestamptz
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  return query
  with cust as (
    select c.customer_id as cid, coalesce(public.phone_key(c.number), 'c' || c.customer_id::text) as gk from public.customer c
  ),
  late as (
    select o.customer_id as cid, o.rental_order_id as ref_id, max(d.returned_at) as occ
      from public.rental_order o
      join public.rental_detail d on d.rental_order_id = o.rental_order_id
     where o.rental_type = 'Outside' and d.returned_at is not null
       and d.returned_at > public.rental_due_at(o.pickup_date, o.return_date)
     group by o.customer_id, o.rental_order_id
  ),
  dmg as (
    select o.customer_id as cid, dc.damage_charge_id as ref_id, dc.created_at as occ, dc.status
      from public.damage_charge dc
      join public.rental_order o on o.rental_order_id = dc.rental_order_id
     where dc.status in ('Unpaid', 'Pending', 'Paid') and dc.amount > 0
  ),
  inc as (
    select cu.gk, 'late'::text as kind, l.ref_id, l.occ, null::text as status, coalesce(r.dismissed, false) as dis
      from late l join cust cu on cu.cid = l.cid
      left join public.incident_review r on r.incident_kind = 'late' and r.ref_id = l.ref_id
    union all
    select cu.gk, 'damage'::text, m.ref_id, m.occ, m.status::text, coalesce(r.dismissed, false)
      from dmg m join cust cu on cu.cid = m.cid
      left join public.incident_review r on r.incident_kind = 'damage' and r.ref_id = m.ref_id
  ),
  agg as (
    select i.gk,
           (count(*) filter (where i.kind = 'late' and not i.dis and i.occ >= now() - interval '12 months'))::int as late_n,
           (count(*) filter (where i.kind = 'damage' and i.status in ('Unpaid', 'Pending')))::int as unpaid_n,
           (count(*) filter (where i.kind = 'damage' and i.status = 'Paid' and not i.dis and i.occ >= now() - interval '12 months'))::int as paid_n
      from inc i group by i.gk
  ),
  fee as (
    select cu.gk, o.rental_order_id as oid, o.rental_ref::text as ref, dc.amount, dc.status::text, dc.created_at,
           (select max(v.until_at) from public.damage_block_override v
             where v.kind = 'defer' and v.rental_order_id = dc.rental_order_id and v.revoked_at is null and v.until_at > now()) as deferred_until
      from public.damage_charge dc
      join public.rental_order o on o.rental_order_id = dc.rental_order_id
      join cust cu on cu.cid = o.customer_id
     where dc.status in ('Unpaid', 'Pending') and dc.amount > 0
    union all
    select cu.gk, o.rental_order_id, o.rental_ref::text, d.late_fee,
           case when d.late_fee_pending_reference is not null then 'Pending' else 'Unpaid' end, d.returned_at,
           (select max(v.until_at) from public.damage_block_override v
             where v.kind = 'defer' and v.rental_order_id = d.rental_order_id and v.revoked_at is null and v.until_at > now())
      from public.rental_detail d
      join public.rental_order o on o.rental_order_id = d.rental_order_id
      join cust cu on cu.cid = o.customer_id
     where d.late_fee_deferred and d.late_fee_paid_at is null and d.late_fee > 0 and d.returned_at is not null
  ),
  lfo as (   -- rentals whose late fee is still unpaid (or being checked): always a red flag, like an unpaid damage fee
    select cu.gk, count(distinct d.rental_order_id)::int as n
      from public.rental_detail d
      join public.rental_order o on o.rental_order_id = d.rental_order_id
      join cust cu on cu.cid = o.customer_id
     where d.late_fee_deferred and d.late_fee_paid_at is null and d.late_fee > 0 and d.returned_at is not null
     group by cu.gk
  ),
  feeagg as (
    select f.gk, f.oid, f.ref,
           coalesce(sum(f.amount) filter (where f.status = 'Unpaid'), 0) as unpaid,
           coalesce(sum(f.amount) filter (where f.status = 'Pending'), 0) as pending,
           min(f.created_at) as first_at, max(f.deferred_until) as deferred_until
      from fee f group by f.gk, f.oid, f.ref
  ),
  blk as (
    select g.gk,
           sum(g.unpaid + g.pending) as total_amt,
           coalesce(sum(g.unpaid + g.pending) filter (where g.deferred_until is null), 0) as live_amt,
           count(*) filter (where g.deferred_until is null) as live_n,
           jsonb_agg(jsonb_build_object('ref', g.ref, 'unpaid', g.unpaid, 'pending', g.pending, 'deferred_until', g.deferred_until) order by g.first_at) as fees
      from feeagg g group by g.gk
  ),
  lift as (
    select cu.gk, bool_or(v.until_at is null) as forever, max(v.until_at) as until_at
      from public.damage_block_override v
      join cust cu on cu.cid = v.customer_id
     where v.kind = 'lift' and v.revoked_at is null and (v.until_at is null or v.until_at > now())
     group by cu.gk
  )
  select cu.cid,
         coalesce(a.late_n, 0), coalesce(a.unpaid_n, 0), coalesce(a.paid_n, 0),
         coalesce(b.total_amt, 0),
         case when coalesce(a.unpaid_n, 0) > 0 or coalesce(lf.n, 0) > 0 or coalesce(a.late_n, 0) >= 3 then 'red'
              when coalesce(a.late_n, 0) >= 1 or coalesce(a.paid_n, 0) >= 1 then 'yellow'
              else 'none' end,
         case when coalesce(a.late_n, 0) = 0 and coalesce(a.unpaid_n, 0) + coalesce(a.paid_n, 0) = 0 and coalesce(lf.n, 0) = 0
              then 'No late returns or damage fees in the last 12 months'
              else concat_ws(', ',
                case when coalesce(a.late_n, 0) > 0 then a.late_n || ' late return' || case when a.late_n = 1 then '' else 's' end end,
                case when coalesce(a.unpaid_n, 0) + coalesce(a.paid_n, 0) > 0 then
                  (a.unpaid_n + a.paid_n) || ' damage fee' || case when a.unpaid_n + a.paid_n = 1 then '' else 's' end || ' ('
                  || case when a.unpaid_n > 0 and a.paid_n > 0 then a.unpaid_n || ' unpaid, ' || a.paid_n || ' paid'
                          when a.unpaid_n > 0 then case when a.unpaid_n = 1 then 'unpaid' else a.unpaid_n || ' unpaid' end
                          else case when a.paid_n = 1 then 'paid' else a.paid_n || ' paid' end end
                  || ')' end,
                case when coalesce(lf.n, 0) > 0 then lf.n || ' unpaid late fee' || case when lf.n = 1 then '' else 's' end end)
         end,
         (coalesce(b.live_n, 0) > 0 and l.gk is null),
         case when coalesce(b.live_n, 0) > 0 and l.gk is null then b.live_amt else 0 end,
         coalesce(b.fees, '[]'::jsonb),
         (l.gk is not null),
         case when l.forever then null else l.until_at end
    from cust cu
    left join agg a on a.gk = cu.gk
    left join lfo lf on lf.gk = cu.gk
    left join blk b on b.gk = cu.gk
    left join lift l on l.gk = cu.gk
   where a.gk is not null or b.gk is not null;
end $$;
revoke all on function public.staff_customer_reputation() from public, anon;
grant execute on function public.staff_customer_reputation() to authenticated;

-- 4. the incidents behind a flag
drop function if exists public.staff_customer_incidents(bigint);
create function public.staff_customer_incidents(p_customer_id bigint)
returns table (
  incident_kind text, ref_id bigint, rental_ref text, customer_id bigint, customer_name text, occurred_at timestamptz,
  detail text, status text, amount numeric, counts boolean, dismissed boolean, note text,
  reviewed_by text, reviewed_at timestamptz, history jsonb
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare k text;
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  select coalesce(public.phone_key(c.number), 'c' || c.customer_id::text) into k from public.customer c where c.customer_id = p_customer_id;
  if k is null then return; end if;

  return query
  with grp as (
    select c.customer_id as cid, trim(c.first_name || ' ' || c.last_name) as nm from public.customer c
     where coalesce(public.phone_key(c.number), 'c' || c.customer_id::text) = k
  ),
  late as (
    select o.rental_order_id, o.rental_ref::text as ref, g.cid, g.nm,
           max(d.returned_at) as occ,
           bool_or(d.late_fee_deferred and d.late_fee_paid_at is null and d.late_fee > 0) as lf_open,
           ceil(extract(epoch from (max(d.returned_at) - public.rental_due_at(o.pickup_date, o.return_date))) / 3600.0)::int as hrs
      from public.rental_order o
      join public.rental_detail d on d.rental_order_id = o.rental_order_id
      join grp g on g.cid = o.customer_id
     where o.rental_type = 'Outside' and d.returned_at is not null
       and d.returned_at > public.rental_due_at(o.pickup_date, o.return_date)
     group by o.rental_order_id, o.rental_ref, g.cid, g.nm, o.pickup_date, o.return_date
  ),
  rows_all as (
    select 'late'::text as kind, l.rental_order_id as rid, l.ref, l.cid, l.nm, l.occ,
           'Returned ' || l.hrs || case when l.hrs = 1 then ' hour late' else ' hours late' end
           || case when l.lf_open then ', late fee unpaid' else '' end as detail,
           null::text as status, null::numeric as amount
      from late l
    union all
    select 'damage'::text, dc.damage_charge_id, o.rental_ref::text, g.cid, g.nm, dc.created_at,
           e.name || ' (' || dc.condition || ')' || coalesce(': ' || nullif(trim(dc.reason), ''), ''),
           dc.status::text, dc.amount
      from public.damage_charge dc
      join public.rental_order o on o.rental_order_id = dc.rental_order_id
      join public.rental_detail d on d.rental_detail_id = dc.rental_detail_id
      join public.equipment e on e.equipment_id = d.equipment_id
      join grp g on g.cid = o.customer_id
  )
  select x.kind, x.rid, x.ref, x.cid, x.nm, x.occ, x.detail, x.status, x.amount,
         case when x.kind = 'late' then (not coalesce(r.dismissed, false)) and x.occ >= now() - interval '12 months'
              when x.status in ('Unpaid', 'Pending') then true
              when x.status = 'Paid' then (not coalesce(r.dismissed, false)) and x.occ >= now() - interval '12 months'
              else false end,
         coalesce(r.dismissed, false), r.note, r.updated_by_name, r.updated_at,
         coalesce((select jsonb_agg(jsonb_build_object('action', l.action, 'note', l.note, 'by', l.by_name, 'at', l.created_at) order by l.log_id)
                     from public.incident_review_log l where l.incident_kind = x.kind and l.ref_id = x.rid), '[]'::jsonb)
    from rows_all x
    left join public.incident_review r on r.incident_kind = x.kind and r.ref_id = x.rid
   order by x.occ desc;
end $$;
revoke all on function public.staff_customer_incidents(bigint) from public, anon;
grant execute on function public.staff_customer_incidents(bigint) to authenticated;

-- 5. owner: waive the open fees of a rental (damage fee and late fee)
drop function if exists public.owner_waive_damage_fee(text, text);
create function public.owner_waive_damage_fee(p_rental_ref text, p_reason text)
returns numeric
language plpgsql security definer set search_path = public as $$
declare
  o public.rental_order; r record; total numeric := 0; late_amt numeric := 0; why text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if not public.is_owner() then raise exception 'Only the owner can waive a damage fee.' using errcode = '42501'; end if;
  if why is null then raise exception 'Write the reason for waiving this damage fee.' using errcode = 'P0001'; end if;
  select * into o from public.rental_order where rental_ref = upper(trim(p_rental_ref)) for update;
  if not found then raise exception 'Rental not found.' using errcode = 'P0001'; end if;
  if exists (select 1 from public.damage_charge where rental_order_id = o.rental_order_id and status = 'Pending')
     or exists (select 1 from public.rental_detail where rental_order_id = o.rental_order_id and late_fee_deferred and late_fee_paid_at is null and late_fee_pending_reference is not null) then
    raise exception 'The customer sent a GCash payment for this rental. Verify or reject it first.' using errcode = 'P0001';
  end if;
  for r in select * from public.damage_charge where rental_order_id = o.rental_order_id and status = 'Unpaid' and amount > 0 for update loop
    update public.damage_charge set amount = 0, status = 'Waived', updated_at = now() where damage_charge_id = r.damage_charge_id;
    perform public.damage_log(r.damage_charge_id, 'Waived', r.amount, 0, 'Unpaid', 'Waived', 'Owner waived: ' || why);
    total := total + r.amount;
  end loop;
  -- NEW: a late fee left unpaid at the return is waived too (its amount goes to 0; the amount is kept in the override log)
  select coalesce(sum(late_fee), 0) into late_amt from public.rental_detail
   where rental_order_id = o.rental_order_id and late_fee_deferred and late_fee_paid_at is null and late_fee > 0 and returned_at is not null;
  if late_amt > 0 then
    update public.rental_detail set late_fee = 0, late_fee_deferred = false
     where rental_order_id = o.rental_order_id and late_fee_deferred and late_fee_paid_at is null and late_fee > 0 and returned_at is not null;
    total := total + late_amt;
    perform public.late_fee_log_add(o.rental_order_id, 'Waived', late_amt, 'Unpaid', 'Waived', 'Owner waived: ' || why);
  end if;
  if total <= 0 then raise exception 'There is no unpaid fee on this rental.' using errcode = 'P0001'; end if;
  insert into public.damage_block_override (kind, customer_id, rental_order_id, rental_ref, amount, reason, by_user_id, by_name)
  values ('waive', o.customer_id, o.rental_order_id, o.rental_ref, total, why, public.current_app_user_id(), public.staff_display_name());
  return total;
end $$;
revoke all on function public.owner_waive_damage_fee(text, text) from public, anon;
grant execute on function public.owner_waive_damage_fee(text, text) to authenticated;

-- end of 84_late_fee_block.sql
