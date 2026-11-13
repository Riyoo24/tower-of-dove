-- =====================================================================
-- 57_handover_proof.sql  (safe to re-run)
-- Outside rentals: a HANDOVER PROOF photo, separate from the per-item "before" photo (46).
--   before photo   : the state of each item before the rental (one per item, unchanged)
--   handover proof : a photo showing the equipment being handed over to the customer (one per rental)
-- Staff must attach both before the rental can be issued. The customer sees the handover proof in
-- My rentals -> Details (the before photos stay available there too).
--
-- New column  rental_order.handover_photo_path   (private Storage path in bucket rental-photos)
-- New RPC     staff_set_handover_photo(p_rental_ref, p_path)
-- Changed     guard_outside_before_photo() also requires the handover proof
-- Changed     customer_owns_rental_photo() also lets the customer open their own handover proof
-- Changed     v_rental_lines: one column appended (handover_photo_path)
-- Run once in the Supabase SQL Editor (after 56_balance_payment_proof.sql; 46 and 47 must have been run).
-- =====================================================================

alter table public.rental_order add column if not exists handover_photo_path text;

-- ---- staff record the handover proof ---------------------------------
create or replace function public.staff_set_handover_photo(p_rental_ref text, p_path text)
returns void language plpgsql security definer set search_path = public as $$
declare o public.rental_order;
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  select * into o from public.rental_order where rental_ref = upper(trim(p_rental_ref)) for update;
  if not found then raise exception 'Rental not found.' using errcode = 'P0001'; end if;
  if o.rental_type <> 'Outside' then
    raise exception 'Handover proof is only required for outside rentals.' using errcode = 'P0001';
  end if;
  if o.status not in ('Approved', 'Active') then
    raise exception 'Cannot set a handover proof on a % rental.', o.status using errcode = 'P0001';
  end if;
  if nullif(trim(coalesce(p_path, '')), '') is null then
    raise exception 'A photo path is required.' using errcode = 'P0001';
  end if;
  update public.rental_order set handover_photo_path = trim(p_path) where rental_order_id = o.rental_order_id;
end $$;
revoke all on function public.staff_set_handover_photo(text, text) from public, anon;
grant execute on function public.staff_set_handover_photo(text, text) to authenticated;

-- ---- the rental cannot become Active without both kinds of photo -------
create or replace function public.guard_outside_before_photo() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.rental_type = 'Outside' and new.status = 'Active' and old.status is distinct from 'Active' then
    if exists (select 1 from public.rental_detail where rental_order_id = new.rental_order_id and before_photo_path is null) then
      raise exception 'Attach a before-photo for every equipment line before issuing this outside rental.' using errcode = 'P0001';
    end if;
    if nullif(trim(coalesce(new.handover_photo_path, '')), '') is null then
      raise exception 'Attach the handover proof photo before issuing this outside rental.' using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;

-- ---- customers may open their own handover proof ----------------------
create or replace function public.customer_owns_rental_photo(p_name text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
      from public.rental_detail d
      join public.rental_order  o on o.rental_order_id = d.rental_order_id
     where o.customer_id = public.current_customer_id()
       and p_name in (
            d.before_photo_path, d.after_photo_path, o.handover_photo_path,
            'rental-photos/' || d.before_photo_path, 'rental-photos/' || d.after_photo_path,
            'rental-photos/' || o.handover_photo_path
       )
  );
$$;
revoke all on function public.customer_owns_rental_photo(text) from public;
grant execute on function public.customer_owns_rental_photo(text) to authenticated;

-- ---- v_rental_lines (46 version + handover_photo_path at the end) -------
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
  d.after_photo_path,
  -- NEW (57): proof that the equipment was handed to the customer (one photo per rental)
  o.handover_photo_path
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

-- end of 57_handover_proof.sql
