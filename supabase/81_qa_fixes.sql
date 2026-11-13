-- =====================================================================
-- 81_qa_fixes.sql  (safe to re-run)
-- 1. customer.number check: the copy in the old 01_schema.sql had a doubled backslash, which rejected spaces.
-- 2. assert_order_stock() is an internal helper used by triggers (which run as the owner); it does not need to
--    be callable from the API, where it could be used to lock equipment rows.
-- 3. release_no_show_bookings(): if the customer paid the balance at the desk at the very moment the automatic
--    release ran, the booking could still be cancelled. The balance is now re-checked in the same statement
--    that cancels, so a paid booking is never released.
-- =====================================================================
alter table public.customer drop constraint if exists customer_number_chk;
alter table public.customer add constraint customer_number_chk
  check (number is null or number ~ '^[0-9+()\s-]{7,20}$');

revoke all on function public.assert_order_stock(bigint) from public, anon, authenticated;

create or replace function public.release_no_show_bookings() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer := 0; k integer; r record;
begin
  for r in
    select b.booking_id from public.booking b
     where b.status = 'Approved' and b.start_at <= now()
       and public.booking_balance_due(b.booking_id) > 0.005
       and public.booking_release_at(b.booking_id) <= now()
  loop
    begin
      update public.booking
         set status = 'Cancelled',
             cancelled_reason = 'No-show: balance not paid within ' || public.no_show_grace_minutes() || ' minutes of the start time (released automatically). Payments made are non-refundable.'
       where booking_id = r.booking_id and status = 'Approved'
         and public.booking_balance_due(r.booking_id) > 0.005;   -- re-checked here: the balance may have been paid a moment ago
      get diagnostics k = row_count;
      if k = 0 then continue; end if;   -- paid (or changed) in the meantime: do not release
      update public.payment set status = 'Rejected' where booking_id = r.booking_id and status = 'Pending';
      insert into public.booking_event (booking_id, action, note, by_name)
      values (r.booking_id, 'No-show',
              'Balance not paid within ' || public.no_show_grace_minutes() || ' minutes of the start time. Slot and add-ons released automatically. Payments made are non-refundable.',
              'System');
      n := n + 1;
    exception when others then null;   -- leave it for staff, try again on the next run
    end;
  end loop;

  -- catch-up: add-ons still Pending / Approved on a booking that is already Cancelled (older data)
  update public.rental_order ro set status = 'Cancelled'
    from public.booking b
   where b.booking_id = ro.booking_id and b.status = 'Cancelled'
     and ro.rental_type = 'Add-on' and ro.status in ('Pending', 'Approved');
  return n;
end $$;
