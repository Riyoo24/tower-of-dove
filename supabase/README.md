# Supabase setup

1. Create a Supabase project.
2. SQL Editor: run `01_schema.sql`, `02_functions.sql`, `03_security.sql`, `04_seed.sql` in order
   (or paste `all_in_one.sql`, which already includes every numbered file up to `13_...`).
   Existing projects: just run the newest numbered file(s) you have not run yet (latest: `13_overdue_hours_addon_return.sql`). Every file is safe to re-run.
3. Authentication > Providers > Email: turn **off** "Confirm email".
   Sign-in uses a username, so the site turns `juan` into `juan@towerofdove.app` for Supabase Auth.
4. Create the owner: follow the comment block at the bottom of `04_seed.sql`.

## What the website calls

| Screen / action | Call |
|---|---|
| Register | `auth.signUp({ email: username + '@towerofdove.app', password, options: { data: { kind: 'customer', full_name, username, number } } })` (a trigger creates the customer row) |
| Log in | `auth.signInWithPassword({ email: username + '@towerofdove.app', password })`, then read `app_user` to see if it is staff |
| Studios, equipment | `from('studio')`, `from('v_equipment_stock')` (readable without login) |
| Calendar occupied times | `rpc('get_busy_slots', { p_studio_id, p_from, p_to, p_token })` |
| Hold a slot (2 min) / release | `rpc('hold_slot', ...)`, `rpc('release_hold', { p_token })` |
| Book a studio (guest or customer) | `rpc('create_booking', ...)` |
| My bookings | `from('v_booking_summary')` (customers see only their own) |
| Reschedule / cancel | `rpc('reschedule_booking')`, `rpc('cancel_booking')` (24h rule enforced) |
| Guest lookup | `rpc('lookup_booking', { p_ref })`, `rpc('lookup_rental', { p_ref })` |
| Request a rental | `rpc('request_rental', ...)`; upload the ID photo to the `rental-ids` bucket first |
| Onsite booking / rental | `rpc('staff_create_onsite_booking')`, `rpc('staff_create_onsite_rental')` |
| Verify / reject payment | `update payment set status = 'Verified' | 'Rejected'` (booking updates itself) |
| Approve / reject / issue rental | `update rental_order set status = ...` (reject needs `rejected_reason`; stock is checked) |
| Return equipment | `rpc('staff_return_rental', { p_rental_ref, p_equipment_id })` |
| Dashboard, Bookings, Rentals, Payments, Customers, Reports | `v_dashboard_counts`, `v_booking_summary`, `v_rental_lines`, `v_payment_queue`, `v_customer_spending`, `v_revenue_daily` |

## Rules the database enforces

- No double booking: an exclusion constraint on studio + time range (Pending, Approved and In Progress bookings count).
- Opening hours 10:00 to 22:00 Manila, whole hours, 1 to 4 hours.
- Changes and cancellations close 24 hours before the session (customers; staff may override).
- Equipment cannot be approved or issued beyond the stock owned.
- Customers can only see their own bookings, rentals and payments. Guests can only use the RPCs.
- Staff cannot edit studios, equipment or staff accounts. Only the owner can.

## Before launch

- Guest lookup currently needs only the reference code (matches the site). References like `TOD-1042` are
  guessable, so pass `p_phone` too once the lookup form asks for it. The result never includes names.
- `hold_slot` is open to anyone, so add a rate limit (Edge Function or Supabase rate limits) if abuse is a concern.
- Reference numbers can skip values when a booking attempt fails (the sequence still advances).
- Creating staff accounts needs the `service_role` key, so it lives in an Edge Function, never in the browser.
  The function is `functions/create-staff/index.ts`. Deploy it once (below) and **Settings > Add staff** works.

## Deploy the create-staff function

**Dashboard (no tools needed):**
1. Supabase > **Edge Functions** > **Deploy a new function** > **Via Editor**.
2. Name it exactly `create-staff`.
3. Replace the sample code with the contents of `functions/create-staff/index.ts`.
4. Leave **Verify JWT** on, then click **Deploy**.

**Or with the CLI:** `supabase functions deploy create-staff --project-ref xwdpduwgswyxqhbrvpay`

Supabase gives the function `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` itself, so there are no secrets to set.
Only an active Owner can call it. It creates staff accounts, resets staff passwords and removes customer accounts.
**If you deployed it earlier, open the function in the dashboard, paste the new code over the old and press Deploy again** (the customer removal needs it).
