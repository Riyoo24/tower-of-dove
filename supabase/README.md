# Supabase setup

1. Create a Supabase project.
2. SQL Editor: run `01_schema.sql`, `02_functions.sql`, `03_security.sql`, `04_seed.sql` in order
   (or paste `all_in_one.sql`, which already includes every numbered file up to `18_...` plus `20_booking_down_payment.sql`, `21_fix_rental_total_8h.sql` and `23_extension_payment.sql` and `24_onsite_gcash_optional.sql` and `25_reschedule_slot_hold.sql`).
   Existing projects: just run the newest numbered file(s) you have not run yet (latest: `45_addon_balance_on_booking.sql` shows the balance of a later add-on (paid 50%) on its booking, also when the booking was paid in full, and collects it when the session starts; before it `44_onsite_booking_down_payment.sql` lets an onsite studio booking for a later day take a 50% down payment; before it `43_onsite_outside_down_payment.sql` lets an onsite outside rental for a later day take a 50% down payment; before it `42_onsite_receipt_email.sql` lets onsite bookings and rentals email a receipt; before it `41_auto_complete_sessions.sql` completes a studio session by itself at its end time; before it `40_addon_balance_collection.sql` keeps a later add-on paid 50% as a down payment until staff collect the rest at the studio (it is not issued before that); before it `39_addon_auto_issue_return.sql` issues add-on equipment when its studio session starts and returns it when the session is completed, also for add-ons added later; before it `38_gcash_screenshots.sql` adds the private `gcash-screenshots` storage bucket for the required "Attach GCash Screenshot" field; before it `31_payment_options.sql` lets customers pay 50% (down payment) or 100% (full payment) for bookings, outside rentals, add-on rentals and extensions; before it `25_reschedule_slot_hold.sql` holds the new hours while a customer reschedules; `24_onsite_gcash_optional.sql` makes the GCash reference optional for onsite bookings and rentals; `20_booking_down_payment.sql` adds the 50% studio down payment; `23_extension_payment.sql` makes customers pay a 50% down payment, verified by staff, to extend a session). Every file is safe to re-run.
3. Email verification is ON: customers must open the link in a confirmation email before they can log in.
   Follow **Email verification setup** below (turn on "Confirm email", set the URLs, add an SMTP sender).
   Customers and staff sign in with their real email address (stored as the Supabase Auth email).
   Accounts made before file 14 keep their old login written as an email (for example `owner@towerofdove.app`). The owner login is now `towerofdovemusic@gmail.com`: for an existing database run `22_owner_email.sql` once.
4. Create the owner: follow the comment block at the bottom of `04_seed.sql`.

## What the website calls

| Screen / action | Call |
|---|---|
| Register | `auth.signUp({ email, password, options: { data: { kind: 'customer', first_name, last_name, username: email, number } } })` (a trigger creates the customer row) |
| Log in | `auth.signInWithPassword({ email, password })`, then read `app_user` to see if it is staff |
| Studios, equipment | `from('studio')`, `from('v_equipment_stock')` (readable without login) |
| Calendar occupied times | `rpc('get_busy_slots', { p_studio_id, p_from, p_to, p_token })` |
| Hold a slot (2 min) / release | `rpc('hold_slot', ...)`, `rpc('release_hold', { p_token })` |
| Book a studio (guest or customer) | `rpc('create_booking', ...)` |
| My bookings | `from('v_booking_summary')` (customers see only their own) |
| Extend a session (customer, 50% GCash down payment) | `rpc('customer_request_extension', { p_booking_ref, p_extra_hours, p_token, p_gcash_reference })`; staff verify in Payments (`update payment set status = 'Verified'`) or `rpc('staff_reject_extension', { p_extension_id, p_reason })`; read with `from('v_booking_extension')` |
| Reschedule / cancel | `rpc('hold_reschedule_slot')` while picking, then `rpc('reschedule_booking', { ..., p_token })`, `rpc('cancel_booking')` (24h rule enforced) |
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
**Staff are now created with an email address, so if you deployed it earlier, open the function in the dashboard, paste the new code over the old and press Deploy again** (the customer removal needs it).

## Email verification setup

1. **Authentication > Providers > Email**: turn **on** "Confirm email" and save.
2. **Authentication > URL Configuration**: set **Site URL** to the address where the site is hosted
   (for example `https://yourname.github.io/tower-of-dove-main/`). Under **Redirect URLs** add the same address followed by `**`
   (for example `https://yourname.github.io/tower-of-dove-main/**`). Without this the confirmation link does not return to the site.
   The site must be opened over `http(s)` (not by double-clicking `index.html`) for the link to work.
3. **Your own email sender (SMTP)**: Supabase's built-in sender only mails project team members and allows just a few emails per hour,
   so real customers will not get it. In **Authentication > Emails > SMTP Settings** (older dashboards: Project Settings > Authentication) turn on **Enable custom SMTP**
   and enter the details from an email service (for example Resend, Brevo, or Gmail with an App Password: host `smtp.gmail.com`, port `465`).
   Then raise **Authentication > Rate Limits > Emails sent per hour** if you expect many sign-ups.
4. Optional: **Authentication > Emails > Confirm signup** lets you edit the message. Keep the `{{ .ConfirmationURL }}` link in it.
5. Test: register with a real inbox, open the link, then log in. Accounts created before this change stay confirmed.

## Forgot password

Works with the same setup as email verification (SMTP sender + Redirect URLs `.../**`). The login page's **Forgot password?** sends a reset link
to the account's email; the link returns to `pages/login.html?reset=1`, where the person chooses a new password.
Old accounts that still use a fake `@towerofdove.app` login cannot receive the email: change their email under **Authentication > Users** first.
Optional: edit the message in **Authentication > Emails > Reset password** (keep `{{ .ConfirmationURL }}`).

## Changing email or password from the profile page

The profile page (customers: `pages/account.html`, owner/staff: the sidebar name in `pages/admin.html`) never changes a login directly:

- **Email**: `auth.updateUser({ email })` makes Supabase email a confirmation link. The login email only changes after the link is opened;
  trigger `supabase/26_profile_management.sql` then copies the new address into the profile row. Turn on **Authentication > Providers > Email > Secure email change**
  so the link must be opened from both the old and the new inbox. Optional: edit **Authentication > Emails > Change email address** (keep `{{ .ConfirmationURL }}`).
- **Password**: the button calls `auth.resetPasswordForEmail`; the new password is typed on `pages/login.html?reset=1` after the emailed link is opened.
  Your current password keeps working until then.
- **Redirect URLs** must include `.../pages/account.html`, `.../pages/admin.html` and `.../pages/login.html` (the `.../**` entry from the steps above covers all three).
- **Name**: the Account name card saves first and last name and displays the stored values immediately.
- **Username**: the Account name card saves username, first name and last name together. The username is read from the signed-in account row in `customer` or `app_user` and displayed in the sidebar; it is never substituted with the login email. Sidebars query the database on page load and update immediately after saving, including in other open tabs. Login still uses email.
- Existing installations must run `supabase/27_allow_username_change.sql`. It allows users to update their own username, accepts usernames alongside legacy email values, and prevents email changes from overwriting usernames. New installations using `all_in_one.sql` include these changes.
- **Default username**: new customer and staff accounts start with their first name as the username (`maria`, then `maria2` if taken), not their email. Existing installations run `supabase/28_default_username_first_name.sql`, then redeploy the `create-staff` Edge Function. `supabase/29_optional_backfill_first_name_usernames.sql` is optional and renames existing accounts that still use their email as username.

- **Guest or register at checkout**: a customer who is not logged in chooses **Continue as Guest** or **Register an account to save your data** in the booking form. Register saves the selection in the browser (24 hours), opens a Create your account pop-up (same fields as the register page), and restores the booking form after the first login. Guest bookings made on the same device are moved onto the account after login by `supabase/30_claim_guest_bookings.sql` (a booking moves only when its code and phone number match). Existing installations run that file once; new installations using `all_in_one.sql` already have it. No new settings are needed, but email confirmation must already be set up (see above), and the Redirect URLs entry `.../**` covers the return trip.

## Balance collection (32_balance_collection.sql)
Run `32_balance_collection.sql` once after `31_payment_options.sql` (not included in `all_in_one.sql`). It adds the columns and functions that let staff confirm the remaining balance of a 50% down payment before a session starts or equipment is issued, and stops sessions / outside rentals with a balance from starting by themselves. No other Supabase settings change; the `create-staff` Edge Function is untouched.

## Booking window (33_booking_window.sql)
Run once after 32. Online bookings and outside rentals cannot start more than 28 days ahead; staff and onsite records are not limited.

## Receipt emails (34_receipt_emails.sql + send-receipt Edge Function)
Guests type an email address in the booking form (required, checked in the browser and again in the database). Logged-in customers see no email field: the database reads the email of the signed-in account. After a booking, outside rental or add-on rental the site calls the `send-receipt` Edge Function, which emails the receipt (one template for guests and members) to the address saved with the booking / rental, once.
1. Run `34_receipt_emails.sql` once in the SQL Editor (after 33).
2. Deploy `functions/send-receipt/index.ts` as an Edge Function named `send-receipt` (leave **Verify JWT** on; guests use the public anon key, which passes).
3. Edge Functions > Secrets: add `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` (your own email account; Gmail: `smtp.gmail.com`, `465`, your address, an App Password). Optional: `RECEIPT_FROM_EMAIL`, `STUDIO_NAME`, `STUDIO_CONTACT_EMAIL`.
Bookings made before this update have no saved email, so no receipt is sent for them.

## "Your payment is verified" emails (35_verified_emails.sql)
When staff verify a payment (Bookings, Rentals or Payments tab, including session extensions), the website asks the `send-receipt` Edge Function (`kind: "verified"`) to email the customer. Only an active staff login can trigger it, the address comes from the database (the saved receipt email, then the customer's email / account email for older records) and each payment sends once (`payment.verified_email_sent_at`).
1. Run `35_verified_emails.sql` once in the SQL Editor (after 34).
2. Re-deploy the `send-receipt` Edge Function with the new `functions/send-receipt/index.ts`. The SMTP secrets stay the same.

## Onsite booking slot hold (36_onsite_slot_hold.sql)
Run once in the SQL Editor (after 35; not included in `all_in_one.sql`). While staff fill in the Onsite booking form, the chosen hours are held ("Held by Staff") for 2 minutes, renewed every minute, with a "Closes in m:ss if idle" countdown (2 minutes of inactivity releases the hold). It adds `staff_hold_onsite` and replaces `staff_create_onsite_booking` with a version that accepts the hold token. No other Supabase settings change. Run the file BEFORE uploading the new site files, otherwise the onsite form cannot record bookings.

## Hold length (37_hold_two_minutes.sql)
Run once after 36. Every slot hold now expires after 2 minutes (the Extend windows and the Onsite form renew it every minute while open), matching the 2-minute idle countdown. It only replaces `staff_hold_extension`.

## GCash screenshot (file 38)
Every GCash payment form has a required **Attach GCash Screenshot** field under the QR code. The reference number is
read from the picture in the browser (Tesseract.js, loaded from the jsDelivr CDN, nothing to configure) and the customer can correct it.
Run `38_gcash_screenshots.sql` once: it creates the private bucket `gcash-screenshots` (images only, 5 MB) and two policies
(anyone can upload into `<13-digit reference>/`, only staff can view). Staff see the screenshot in the Verify drawer.
