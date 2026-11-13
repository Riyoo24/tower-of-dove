-- =====================================================================
-- 88_late_fee_preview.sql  (safe to re-run; run after 87_booking_check_in.sql, needs 83_late_fee_collection.sql)
-- The Return window (Rentals > Process return) now asks the DATABASE how much late fee will be charged, instead of working
-- it out in the browser from the page's data. The database is what charges the fee when the return is saved
-- (staff_return_rental_with_fees, file 83), so the window and the charge can no longer disagree: if the fee is owed, the
-- window shows it (with Cash / GCash / Not now), and if it is not, nothing is shown and nothing is charged.
-- Same formula as file 83: price / 8 per hour, per item, a started hour counts as a full hour, counted from the end of the
-- 8-hour window (rental_due_at). Read-only: it changes nothing.
-- =====================================================================
create or replace function public.staff_late_fee_preview(p_rental_ref text, p_equipment_id bigint default null)
returns table (hours integer, fee numeric, due_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare o public.rental_order; due timestamptz; h integer := 0; f numeric := 0;
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  select * into o from public.rental_order where rental_ref = upper(trim(p_rental_ref));
  if not found or o.rental_type <> 'Outside' then
    return query select 0, 0::numeric, null::timestamptz;
    return;
  end if;
  due := public.rental_due_at(o.pickup_date, o.return_date);
  if due is not null and now() > due then
    h := ceil(extract(epoch from (now() - due)) / 3600.0)::int;
    select coalesce(sum(round(d.quantity * d.unit_price_at_request / 8.0 * h, 2)), 0) into f
      from public.rental_detail d
     where d.rental_order_id = o.rental_order_id and d.returned_at is null
       and (p_equipment_id is null or d.equipment_id = p_equipment_id);
  end if;
  return query select h, f, due;
end $$;
revoke all on function public.staff_late_fee_preview(text, bigint) from public, anon;
grant execute on function public.staff_late_fee_preview(text, bigint) to authenticated;
