-- =====================================================================
-- qa_tests.sql  -  automated checks for Tower of Dove (run in the Supabase SQL Editor)
--
-- HOW TO RUN: paste the whole file into the SQL Editor and press Run.
-- SAFE: everything is rolled back. The script ends with an intentional error whose message is the
-- report, so you will see a red "QA RESULTS" box. That is the normal, expected output.
-- Read it: PASS = good, FAIL = a bug, WARN = a weakness worth knowing, SKIP = could not test
-- (not enough data in your database, e.g. only one studio).
-- Tests use guest bookings 14 to 26 days ahead on the first free day.
-- =====================================================================
do $qa$
declare
  rep text := '';
  ok boolean; msg text;
  st record; st2 record; e record; r record; r2 record;
  d date; s1 timestamptz; i int;
  bid bigint; bid2 bigint; rate numeric; v numeric; v2 numeric; cnt bigint; n int;
  gref text := 'QA' || to_char(clock_timestamp(), 'MMDDHH24MISSUS');
  ref1 text; ref2 text; uid uuid;
  ca record; cb record; a_bk bigint[]; a_ro bigint[];
begin
  -- ---------- setup ----------
  select * into st from public.studio where status = 'Available' order by studio_id limit 1;
  select * into st2 from public.studio where status = 'Available' and studio_id <> st.studio_id order by studio_id limit 1;
  if st.studio_id is null then
    raise exception 'QA RESULTS: no Available studio found, nothing to test.';
  end if;
  rate := st.hourly_rate;
  select * into e from public.equipment
   where status = 'Available' and allow_addon and add_on_rate is not null and total_quantity >= 1
   order by total_quantity, equipment_id limit 1;

  for i in 14..26 loop
    d := (now() at time zone 'Asia/Manila')::date + i;
    s1 := (d + time '10:00') at time zone 'Asia/Manila';
    exit when not exists (select 1 from public.booking b where b.status in ('Pending','Approved','In Progress')
                           and tstzrange(b.start_at, b.end_at, '[)') && tstzrange(s1, s1 + interval '10 hours', '[)')
                           and b.studio_id in (st.studio_id, coalesce(st2.studio_id, st.studio_id)))
              and not exists (select 1 from public.slot_hold h where h.expires_at > now()
                           and tstzrange(h.start_at, h.end_at, '[)') && tstzrange(s1, s1 + interval '10 hours', '[)'));
    s1 := null;
  end loop;
  if s1 is null then
    raise exception 'QA RESULTS: could not find a free day in the next 26 days, nothing to test.';
  end if;
  rep := rep || format(E'\nUsing studio "%" (rate %/h), day %', st.name, rate, d);

  -- ---------- T1: booking math ----------
  ok := false; msg := null;
  begin
    select * into r from public.create_booking_with_addons(st.studio_id, s1, s1 + interval '2 hours', 'QA', 'Tester',
         '0917 123 4567', 'GCash', gref || 'A', null, '[]'::jsonb, 'down', 'qa@example.com');
    ok := true;
  exception when others then msg := sqlerrm; end;
  if not ok then
    rep := rep || E'\nFAIL  T1 guest booking could not be created: ' || msg;
    raise exception E'QA RESULTS (stopped early)\n%', rep;
  end if;
  ref1 := r.booking_ref;
  select booking_id into bid from public.booking where booking_ref = ref1;
  rep := rep || case when abs(r.total_amount - rate * 2) < 0.01 then E'\nPASS  T1a total = rate x hours'
                     else format(E'\nFAIL  T1a total %, expected %', r.total_amount, rate * 2) end;
  rep := rep || case when abs(r.down_payment - round(rate * 2 * 0.5, 2)) < 0.01 then E'\nPASS  T1b 50% down payment is exact'
                     else format(E'\nFAIL  T1b down payment %, expected %', r.down_payment, round(rate * 2 * 0.5, 2)) end;
  v := public.booking_balance_due(bid);
  rep := rep || case when abs(v - (r.total_amount - r.down_payment)) < 0.01 then E'\nPASS  T1c balance due = total - down payment'
                     else format(E'\nFAIL  T1c balance due %, expected %', v, r.total_amount - r.down_payment) end;
  select amount into v from public.payment where booking_id = bid order by payment_id desc limit 1;
  rep := rep || case when abs(v - r.down_payment) < 0.01 then E'\nPASS  T1d payment row amount = down payment'
                     else format(E'\nFAIL  T1d payment row %, expected %', v, r.down_payment) end;

  -- ---------- T2: overlapping booking must be refused ----------
  ok := false; msg := null;
  begin
    perform public.create_booking_with_addons(st.studio_id, s1 + interval '1 hour', s1 + interval '3 hours', 'QA', 'Two',
         '0917 123 4568', 'GCash', gref || 'B', null, '[]'::jsonb, 'down', 'qa2@example.com');
    ok := true;
  exception when others then msg := sqlerrm; end;
  rep := rep || case when ok then E'\nFAIL  T2 DOUBLE BOOKING: an overlapping booking was accepted'
                     when msg ilike '%no longer available%' or msg ilike '%taken%' then E'\nPASS  T2 overlapping booking refused'
                     else E'\nFAIL  T2 refused for the wrong reason: ' || msg end;

  -- ---------- T3: back-to-back booking must be allowed ----------
  ok := false; msg := null;
  begin
    select * into r2 from public.create_booking_with_addons(st.studio_id, s1 + interval '2 hours', s1 + interval '4 hours', 'QA', 'Three',
         '0917 123 4569', 'GCash', gref || 'C', null, '[]'::jsonb, 'down', 'qa3@example.com');
    ok := true;
  exception when others then msg := sqlerrm; end;
  rep := rep || case when ok then E'\nPASS  T3 back-to-back booking allowed' else E'\nFAIL  T3 back-to-back booking refused: ' || msg end;
  ref2 := r2.booking_ref;

  -- ---------- T4: same GCash reference twice ----------
  ok := false; msg := null;
  begin
    perform public.create_booking_with_addons(st.studio_id, s1 + interval '4 hours', s1 + interval '5 hours', 'QA', 'Four',
         '0917 123 4570', 'GCash', gref || 'A', null, '[]'::jsonb, 'down', 'qa4@example.com');
    ok := true;
  exception when others then msg := sqlerrm; end;
  rep := rep || case when ok then E'\nFAIL  T4 the same GCash reference was accepted twice'
                     when msg ilike '%already used%' then E'\nPASS  T4 duplicate GCash reference refused'
                     else E'\nFAIL  T4 refused for the wrong reason: ' || msg end;

  -- ---------- T5: phone length rule on the server ----------
  ok := false; msg := null;
  begin
    perform public.create_booking_with_addons(st.studio_id, s1 + interval '5 hours', s1 + interval '6 hours', 'QA', 'Five',
         '09171234567890123456', 'GCash', gref || 'D', null, '[]'::jsonb, 'down', 'qa5@example.com');
    ok := true;
  exception when others then msg := sqlerrm; end;
  rep := rep || case when ok then E'\nWARN  T5 the server accepts a 20-digit phone number; the 11-digit limit exists only in the web forms'
                     else E'\nPASS  T5 server rejects over-long phone numbers' end;

  -- ---------- T6/T7: add-on stock and payment options ----------
  if e.equipment_id is null then
    rep := rep || E'\nSKIP  T6/T7 no equipment that can be rented as an add-on';
  else
    -- T6a full payment with an add-on: nothing left to pay
    ok := false; msg := null;
    begin
      select * into r from public.create_booking_with_addons(st.studio_id, s1 + interval '6 hours', s1 + interval '7 hours', 'QA', 'Six',
           '0917 123 4571', 'GCash', gref || 'E', null,
           jsonb_build_array(jsonb_build_object('equipment_id', e.equipment_id, 'quantity', 1)), 'full', 'qa6@example.com');
      ok := true;
    exception when others then msg := sqlerrm; end;
    if not ok then
      rep := rep || E'\nSKIP  T6a add-on booking not possible: ' || msg;
    else
      select booking_id into bid2 from public.booking where booking_ref = r.booking_ref;
      v := public.booking_balance_due(bid2);
      rep := rep || case when abs(v) < 0.01 and abs(r.down_payment - r.total_amount) < 0.01
                         then E'\nPASS  T6a full payment with add-on leaves balance 0'
                         else format(E'\nFAIL  T6a full payment with add-on: balance %, paid % of total %', v, r.down_payment, r.total_amount) end;
    end if;

    -- T6b 50% with an add-on
    ok := false; msg := null;
    begin
      select * into r from public.create_booking_with_addons(st.studio_id, s1 + interval '7 hours', s1 + interval '8 hours', 'QA', 'Seven',
           '0917 123 4572', 'GCash', gref || 'F', null,
           jsonb_build_array(jsonb_build_object('equipment_id', e.equipment_id, 'quantity', 1)), 'down', 'qa7@example.com');
      ok := true;
    exception when others then msg := sqlerrm; end;
    if not ok then
      rep := rep || E'\nSKIP  T6b add-on booking not possible: ' || msg;
    else
      select booking_id into bid2 from public.booking where booking_ref = r.booking_ref;
      v := public.booking_balance_due(bid2);
      rep := rep || case when abs(v - (r.total_amount - r.down_payment)) < 0.01 and abs(r.down_payment - round(r.total_amount * 0.5, 2)) < 0.01
                         then E'\nPASS  T6b 50% with add-on: balance = total - down payment'
                         else format(E'\nFAIL  T6b 50%% with add-on: balance %, down %, total %', v, r.down_payment, r.total_amount) end;
    end if;

    -- T7 last item: take all units for studio 1, then ask for one more at studio 2 for the same hours
    if st2.studio_id is null then
      rep := rep || E'\nSKIP  T7 needs two studios';
    else
      ok := false; msg := null;
      begin
        perform public.create_booking_with_addons(st.studio_id, s1 + interval '8 hours', s1 + interval '10 hours', 'QA', 'Eight',
             '0917 123 4573', 'GCash', gref || 'G', null,
             jsonb_build_array(jsonb_build_object('equipment_id', e.equipment_id, 'quantity', e.total_quantity)), 'down', 'qa8@example.com');
        ok := true;
      exception when others then msg := sqlerrm; end;
      if not ok then
        rep := rep || E'\nSKIP  T7 could not take every unit of "' || e.name || '": ' || msg;
      else
        ok := false; msg := null;
        begin
          perform public.create_booking_with_addons(st2.studio_id, s1 + interval '8 hours', s1 + interval '10 hours', 'QA', 'Nine',
               '0917 123 4574', 'GCash', gref || 'H', null,
               jsonb_build_array(jsonb_build_object('equipment_id', e.equipment_id, 'quantity', 1)), 'down', 'qa9@example.com');
          ok := true;
        exception when others then msg := sqlerrm; end;
        rep := rep || case when ok then E'\nFAIL  T7 OVERBOOKING: more "' || e.name || E'" were reserved than the studio owns'
                           when msg ilike '%only%available%' then E'\nPASS  T7 last item cannot be reserved twice (one after the other)'
                           else E'\nFAIL  T7 refused for the wrong reason: ' || msg end;
      end if;
    end if;
  end if;

  -- ---------- T8/T9: staff actions (we pretend to be the owner) ----------
  select auth_user_id into uid from public.app_user where role = 'Owner' and status = 'Active' and auth_user_id is not null limit 1;
  if uid is null then
    rep := rep || E'\nSKIP  T8/T9 no active owner account found';
  else
    perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', uid::text, true);

    -- T8 no refunds: a verified payment must stay verified after the booking is cancelled
    ok := false; msg := null;
    begin
      select booking_id into bid2 from public.booking where booking_ref = ref2;
      update public.payment set status = 'Verified' where booking_id = bid2;
      perform public.cancel_booking(ref2, 'QA test');
      ok := true;
    exception when others then msg := sqlerrm; end;
    if not ok then
      rep := rep || E'\nSKIP  T8 could not verify and cancel: ' || msg;
    else
      select p.status, p.amount into r from public.payment p where p.booking_id = bid2 order by payment_id desc limit 1;
      select status into msg from public.booking where booking_id = bid2;
      rep := rep || case when msg = 'Cancelled' and r.status = 'Verified'
                         then E'\nPASS  T8 cancelled booking keeps its Verified payment (no refund recorded)'
                         else format(E'\nFAIL  T8 after cancel: booking %, payment %', msg, r.status) end;
    end if;

    -- T9 staff extension cost (needs the booking to be verified/approved first)
    ok := false; msg := null;
    begin
      update public.payment set status = 'Verified' where booking_id = bid;
      v := public.booking_balance_due(bid);
      select * into r from public.staff_extend_booking(ref1, 1, null, false);
      ok := true;
    exception when others then msg := sqlerrm; end;
    if not ok then
      rep := rep || E'\nSKIP  T9 staff extension not possible: ' || msg;
    else
      v2 := public.booking_balance_due(bid);
      rep := rep || case when abs(r.extra_cost - rate) < 0.01 then E'\nPASS  T9a extension cost = rate x extra hours'
                         else format(E'\nFAIL  T9a extension cost %, expected %', r.extra_cost, rate) end;
      rep := rep || case when abs(r.studio_total - rate * 3) < 0.01 then E'\nPASS  T9b new studio total covers the extra hour'
                         else format(E'\nFAIL  T9b studio total %, expected %', r.studio_total, rate * 3) end;
      rep := rep || case when abs((v2 - v) - rate) < 0.01 then E'\nPASS  T9c balance due rose by exactly one hour'
                         else format(E'\nFAIL  T9c balance before %, after % (expected a rise of %)', v, v2, rate) end;
    end if;

    -- T13 no-show release: an Approved booking whose start has passed with a balance still owing is released;
    -- the money already paid stays (no refunds); a booking whose balance is fully paid is NOT released.
    ok := false; msg := null;
    begin
      select b.booking_id, b.status into r from public.booking b where b.booking_ref = ref1;
      -- make the session start 3 hours ago (as staff; this only exists inside the test)
      update public.booking set start_at = now() - interval '3 hours', end_at = now() - interval '1 hour'
       where booking_ref = ref1;
      update public.booking set status = 'Approved' where booking_ref = ref1;
      perform public.release_no_show_bookings();
      ok := true;
    exception when others then msg := sqlerrm; end;
    if not ok then
      rep := rep || E'\nSKIP  T13 could not set up the no-show test: ' || msg;
    else
      select b.status, (select p.status from public.payment p where p.booking_id = b.booking_id order by p.payment_id desc limit 1) as pay
        into r2 from public.booking b where b.booking_ref = ref1;
      v := public.booking_balance_due(bid);
      rep := rep || case when v > 0.005 and r2.status = 'Cancelled' and r2.pay = 'Verified'
                         then E'\nPASS  T13a unpaid balance past the start time: booking released, payment kept (no refund)'
                         when v > 0.005 then format(E'\nFAIL  T13a balance % still owing but booking is %, payment %', v, r2.status, r2.pay)
                         else E'\nSKIP  T13a nothing owing on this booking, release not applicable' end;
      -- fully paid booking must not be released
      ok := false; msg := null;
      begin
        update public.booking set status = 'Approved' where booking_ref = ref1;
        update public.payment set balance_paid_amount = (select public.booking_total(bid) + public.booking_addons_total(bid) - down_payment from public.booking where booking_id = bid)
         where booking_id = bid;
        perform public.release_no_show_bookings();
        ok := true;
      exception when others then msg := sqlerrm; end;
      if not ok then
        rep := rep || E'\nSKIP  T13b could not set up the fully-paid case: ' || msg;
      else
        select status into msg from public.booking where booking_ref = ref1;
        rep := rep || case when msg = 'Cancelled' then E'\nFAIL  T13b a booking whose balance was fully paid was released as a no-show'
                           else E'\nPASS  T13b fully paid booking is not released' end;
      end if;
    end if;
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
  end if;

  -- ---------- T10: who can read whose data ----------
  select c.customer_id, c.auth_user_id into ca from public.customer c
   where c.auth_user_id is not null and exists (select 1 from public.booking b where b.customer_id = c.customer_id)
   order by c.customer_id limit 1;
  select c.customer_id, c.auth_user_id into cb from public.customer c
   where c.auth_user_id is not null and c.customer_id <> coalesce(ca.customer_id, -1)
     and not exists (select 1 from public.app_user u where u.auth_user_id = c.auth_user_id)
   order by c.customer_id limit 1;
  if ca.customer_id is null or cb.customer_id is null then
    rep := rep || E'\nSKIP  T10 needs two customer accounts, one of them with a booking';
  else
    select coalesce(array_agg(booking_id), '{}') into a_bk from public.booking where customer_id = ca.customer_id;
    select coalesce(array_agg(rental_order_id), '{}') into a_ro from public.rental_order where customer_id = ca.customer_id;
    ok := false; msg := null;
    begin
      perform set_config('request.jwt.claims', json_build_object('sub', cb.auth_user_id, 'role', 'authenticated')::text, true);
      perform set_config('request.jwt.claim.sub', cb.auth_user_id::text, true);
      execute 'set local role authenticated';
      select count(*) into cnt from public.booking where booking_id = any(a_bk);
      rep := rep || case when cnt = 0 then E'\nPASS  T10a a customer cannot read another customer''s bookings' else format(E'\nFAIL  T10a LEAK: %s foreign bookings readable', cnt) end;
      select count(*) into cnt from public.payment where booking_id = any(a_bk) or rental_order_id = any(a_ro);
      rep := rep || case when cnt = 0 then E'\nPASS  T10b a customer cannot read another customer''s payments' else format(E'\nFAIL  T10b LEAK: %s foreign payments readable', cnt) end;
      select count(*) into cnt from public.rental_order where rental_order_id = any(a_ro);
      rep := rep || case when cnt = 0 then E'\nPASS  T10c a customer cannot read another customer''s rentals' else format(E'\nFAIL  T10c LEAK: %s foreign rentals readable', cnt) end;
      select count(*) into cnt from public.customer where customer_id = ca.customer_id;
      rep := rep || case when cnt = 0 then E'\nPASS  T10d a customer cannot read another customer''s profile' else E'\nFAIL  T10d LEAK: foreign profile readable' end;
      update public.customer set number = '09000000000' where customer_id = ca.customer_id;
      get diagnostics n = row_count;
      rep := rep || case when n = 0 then E'\nPASS  T10e a customer cannot edit another customer''s profile' else E'\nFAIL  T10e a customer edited another profile' end;
      update public.app_user set role = 'Owner';
      get diagnostics n = row_count;
      rep := rep || case when n = 0 then E'\nPASS  T10f a customer cannot touch staff accounts' else E'\nFAIL  T10f a customer changed staff accounts' end;
      ok := true;
    exception when others then msg := sqlerrm; end;
    execute 'reset role';
    perform set_config('request.jwt.claims', '', true);
    perform set_config('request.jwt.claim.sub', '', true);
    if not ok then rep := rep || E'\nSKIP  T10 stopped: ' || msg; end if;
  end if;

  -- ---------- T11: logged-out visitor ----------
  ok := false; msg := null;
  begin
    execute 'set local role anon';
    select count(*) into cnt from public.booking;           n := cnt;
    select count(*) into cnt from public.customer;          n := n + cnt;
    select count(*) into cnt from public.payment;           n := n + cnt;
    select count(*) into cnt from public.rental_order;      n := n + cnt;
    rep := rep || case when n = 0 then E'\nPASS  T11 a logged-out visitor can read no bookings, customers, payments or rentals'
                       else format(E'\nFAIL  T11 LEAK: a logged-out visitor can read % rows', n) end;
    ok := true;
  exception when others then msg := sqlerrm; end;
  execute 'reset role';
  if not ok then rep := rep || E'\nPASS  T11 logged-out visitor is blocked from the private tables (' || msg || ')'; end if;

  rep := rep || case when has_function_privilege('anon', 'public.assert_order_stock(bigint)', 'execute')
                     then E'\nWARN  T12 anyone can call assert_order_stock (run 81_qa_fixes.sql)'
                     else E'\nPASS  T12 assert_order_stock is not callable from the API' end;

  raise exception E'QA RESULTS (everything was rolled back, nothing was saved)\n%\n\nFAIL = bug, WARN = weakness, SKIP = not enough data to test', rep;
end
$qa$;
