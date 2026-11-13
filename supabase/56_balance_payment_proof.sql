-- =====================================================================
-- 56_balance_payment_proof.sql  (safe to re-run)
-- Collect balance & start (bookings) / Collect balance & issue (rentals):
--   * Cash   : staff enter the amount tendered; the window shows the change. The database refuses a tendered
--              amount that is lower than the balance.
--   * GCash  : the 13-digit reference number is mandatory and is saved on the payment (payment.balance_paid_reference).
-- staff_collect_balance() from 45 is NOT changed. The new staff_collect_balance_proof() checks the proof and then
-- calls it in the same transaction, so everything is still saved together or not at all.
-- Run once in the Supabase SQL Editor (after 55_extend_without_addons.sql).
-- =====================================================================

alter table public.payment add column if not exists balance_paid_reference varchar(13);

drop function if exists public.staff_collect_balance_proof(text, text, text, numeric, boolean, text, numeric);
create function public.staff_collect_balance_proof(
  p_kind text, p_ref text, p_method text default 'Cash', p_expected numeric default null,
  p_start boolean default true, p_reference text default null, p_tendered numeric default null
) returns table (kind text, ref text, collected numeric, new_status text)
language plpgsql security definer set search_path = public as $$
declare
  m    text := case lower(coalesce(trim(p_method), 'cash')) when 'gcash' then 'GCash' when 'cash' then 'Cash' else null end;
  gref text := regexp_replace(coalesce(p_reference, ''), '\D', '', 'g');
  res  record;
begin
  if not public.is_staff() then raise exception 'Staff only.' using errcode = '42501'; end if;
  if m is null then raise exception 'Choose how the balance was paid: Cash or GCash.' using errcode = 'P0001'; end if;

  if m = 'GCash' and length(gref) <> 13 then
    raise exception 'Enter the 13-digit GCash reference number.' using errcode = 'P0001';
  end if;
  if m = 'Cash' and p_expected is not null and (p_tendered is null or p_tendered + 0.005 < p_expected) then
    raise exception 'The cash received is less than the balance of PHP %.', to_char(p_expected, 'FM999,999,990.00') using errcode = 'P0001';
  end if;

  select * into res from public.staff_collect_balance(p_kind, p_ref, m, p_expected, p_start);

  -- now() is the start of this transaction: it marks exactly the payment rows the call above just settled
  if m = 'GCash' then
    update public.payment
       set balance_paid_reference = gref
     where balance_paid_at = now() and balance_paid_method = 'GCash'
       and balance_paid_by is not distinct from public.current_app_user_id();
  end if;

  return query select res.kind::text, res.ref::text, res.collected::numeric, res.new_status::text;
end $$;
revoke all on function public.staff_collect_balance_proof(text, text, text, numeric, boolean, text, numeric) from public, anon;
grant execute on function public.staff_collect_balance_proof(text, text, text, numeric, boolean, text, numeric) to authenticated;

-- end of 56_balance_payment_proof.sql
