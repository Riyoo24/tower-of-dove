-- =====================================================================
-- 99_extension_cap_fix.sql  (QA H-2; safe to re-run; run after 93)
--
-- Problem: files 91, 92 and 93 re-created customer_extend_pay_later, customer_request_extension and staff_extend_session
-- with a 4-hour cap, undoing file 70 (12 hours). The website offers up to 12 hours, so a customer could pay by GCash for,
-- say, 8 extra hours and the final Submit step then refused: the money was sent and had to be refunded by hand.
--
-- Fix: the same in-place patch as file 70, so it works whichever of those files were run. It only touches a function that
-- still contains the old cap, and keeps its permissions. (Files 91, 92 and 93 in this repo were corrected too, so a fresh
-- install is already right; this file repairs a database where they were already run.)
-- =====================================================================
do $$
declare r record; def text; newdef text;
begin
  for r in
    select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
  loop
    def := pg_get_functiondef(r.oid);
    continue when def not like '%least(4, greatest(0,%' and def not like '%p_extra_hours > 4%';
    newdef := replace(replace(replace(def,
      'least(4, greatest(0,', 'least(12, greatest(0,'),
      'p_extra_hours > 4', 'p_extra_hours > 12'),
      'Choose 1 to 4 extra hours.', 'Choose 1 to 12 extra hours.');
    execute newdef;
  end loop;
end $$;

-- Self-check (optional): no rows expected
-- select proname from pg_proc where pronamespace = 'public'::regnamespace and pg_get_functiondef(oid) like '%p_extra_hours > 4%';

-- end of 99_extension_cap_fix.sql