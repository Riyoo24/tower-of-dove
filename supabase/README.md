# Supabase setup

1. Create a Supabase project.
2. SQL Editor: run `01_schema.sql`, `02_functions.sql`, `03_security.sql`, `04_seed.sql` in order
   (or paste `all_in_one.sql`, which already includes every numbered file up to `18_...` plus `20_booking_down_payment.sql`, `21_fix_rental_total_8h.sql` and `23_extension_payment.sql` and `24_onsite_gcash_optional.sql` and `25_reschedule_slot_hold.sql`).
   Existing projects: just run the newest numbered file(s) you have not run yet (latest: `89_equipment_checkout_hold.sql` holds the items in a rental checkout window for 2 minutes (studio add-on and outside rental), like the studio booking hold, so two customers cannot both reserve the last unit; run it, or the checkout window will not open; before it `70_no_max_booking_hours.sql` removes the 4-hour limit of a studio booking and of an extension (run it, or bookings over 4 hours are refused by the database); before it `69_onsite_gcash_required.sql` makes the 13-digit GCash reference required for onsite bookings and rentals paid by GCash; before it `68_damage_paid_email.sql` emails the customer the same fully paid receipt when a damage fee gets paid (staff collect it, accept the customer's GCash payment, or collect it at the return; send-once, staff only; it also saves the cash received so the email shows Cash received and Change; deploy the `send-receipt` Edge Function again); before it `67_balance_cash_tendered.sql` saves the cash tendered when a balance is collected so the fully paid email shows Cash received and Change; before it `66_balance_receipt_email.sql` emails the customer a fully paid receipt when staff collect the remaining balance of a booking or rental (send-once, staff only; deploy the `send-receipt` Edge Function again); before it `65_outside_no_auto_issue.sql` stops the database from ever issuing an outside rental by itself at its pick-up time, even when fully paid; staff issue it on the admin page with the before photos and handover proof; before it `64_damage_block_reputation.sql` blocks a customer with an unpaid damage fee (Unpaid, or Pending until staff check the GCash payment) from creating a new studio booking or rental, online or onsite, matched by account and by phone number so guests are covered; the block is a database trigger on `booking` and `rental_order`, the customer pages show the message with a Pay now button, and only the owner can waive or defer a fee or lift the block, with a required reason that is logged; it also adds staff-only customer reputation flags (late returns and damage fees of the last 12 months) with notes and dismissals, in tables that customers cannot read; before it `63_out_of_stock_status.sql` shows Out of Stock in Equipment when no unit is rentable; before it `62_stock_preview.sql` shows, inside the return window, which upcoming rentals would be short if the damaged units are taken out, each with a Swap item button; before it `61_swap_rental_item.sql` lets staff swap an item on a rental that has not been issued yet for an equivalent one at no extra charge (the customer keeps the agreed price, nothing is refunded), from the rental's Actions menu or from the shortage warning in Equipment, logs it in the rental's History and adds the line id and booking time to the shortage list; before it `60_out_of_service_stock.sql` adds Owned and Out of service quantities to Equipment (Rentable = owned - out of service), lets the return window mark a damaged item Out of service or Remove it permanently, never cancels the return, and lists the upcoming rentals / bookings that no longer have enough (checked by date); it replaces the function from 59; before it `59_remove_damaged_stock.sql` lets staff take a damaged item out of stock (Total stock goes down) when they record its return, and logs it in the Damage fee history; before it `58_damage_charges.sql` adds damage fees for outside rentals (its own `damage_charge` table with an audit log, kept apart from the payment table; the customer can pay now with GCash or pay later; reports count a fee only once it is Paid); before it `57_handover_proof.sql` adds the handover proof photo; before it `56_balance_payment_proof.sql` makes staff enter the cash tendered (change is shown) or the 13-digit GCash reference when collecting a balance; before it `55_extend_without_addons.sql` lets a session be extended, after a confirmation, when its add-on equipment is not free for the extra hours (only the booking is extended; the add-on keeps its original hours); before it `54_reschedule_stock_slots.sql` greys out reschedule times where the add-on equipment is not free; before it `53_pending_orders_hold_stock.sql` makes a Pending add-on / outside-rental request hold its equipment until staff verify or reject it; before it `52_stock_on_booking_time_change.sql` re-checks the add-on equipment of a studio session whenever its hours are extended or rescheduled, so the new hours can no longer double-book an item; before it `51_stock_by_time.sql` checks equipment stock for the hours it is needed (studio add-ons and outside rentals), when the customer submits the request and when staff approve it; before it `50_addon_full_payment_when_started.sql` makes equipment added to a session that has already started full payment only (100%); before it `49_cron_auto_complete.sql` schedules the session start / end check inside Supabase (pg_cron) so a studio session completes at its end time even when no admin / staff page is open; before it `45_addon_balance_on_booking.sql` shows the balance of a later add-on (paid 50%) on its booking, also when the booking was paid in full, and collects it when the session starts; before it `44_onsite_booking_down_payment.sql` lets an onsite studio booking for a later day take a 50% down payment; before it `43_onsite_outside_down_payment.sql` lets an onsite outside rental for a later day take a 50% down payment; before it `42_onsite_receipt_email.sql` lets onsite bookings and rentals email a receipt; before it `41_auto_complete_sessions.sql` completes a studio session by itself at its end time; before it `40_addon_balance_collection.sql` keeps a later add-on paid 50% as a down payment until staff collect the rest at the studio (it is not issued before that); before it `39_addon_auto_issue_return.sql` issues add-on equipment when its studio session starts and returns it when the session is completed, also for add-ons added later; before it `38_gcash_screenshots.sql` adds the private `gcash-screenshots` storage bucket for the required "Attach GCash Screenshot" field; before it `31_payment_options.sql` lets customers pay 50% (down payment) or 100% (full payment) for bookings, outside rentals, add-on rentals and extensions; before it `25_reschedule_slot_hold.sql` holds the new hours while a customer reschedules; `24_onsite_gcash_optional.sql` makes the GCash reference optional for onsite bookings and rentals; `20_booking_down_payment.sql` adds the 50% studio down payment; `23_extension_payment.sql` makes customers pay a 50% down payment, verified by staff, to extend a session). Every file is safe to re-run.
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
| Hold rental equipment at checkout (2 min) | `rpc('hold_equipment', { p_items, p_start_at, p_end_at, p_token })`; freed by `release_hold`; `request_addon_rental` / `request_outside_rental` take `p_hold_token` |
| Book a studio (guest or customer) | `rpc('create_booking', ...)` |
| My bookings | `from('v_booking_summary')` (customers see only their own) |
| Extend a session (customer, 50% GCash down payment) | `rpc('customer_request_extension', { p_booking_ref, p_extra_hours, p_token, p_gcash_reference })`; staff verify in Payments (`update payment set status = 'Verified'`) or `rpc('staff_reject_extension', { p_extension_id, p_reason })`; read with `from('v_booking_extension')` |
| Reschedule / cancel | `rpc('hold_reschedule_slot')` while picking, then `rpc('reschedule_booking', { ..., p_token })`, `rpc('cancel_booking')` (24h rule enforced) |
| Guest lookup | `rpc('lookup_booking', { p_ref })`, `rpc('lookup_rental', { p_ref })` |
| Request a rental | `rpc('request_rental', ...)`; upload the ID photo to the `rental-ids` bucket first |
| Onsite booking / rental | `rpc('staff_create_onsite_booking')`, `rpc('staff_create_onsite_rental')` |
| Verify / reject payment | `update payment set status = 'Verified' | 'Rejected'` (booking updates itself) |
| Approve / reject / issue rental | `update rental_order set status = ...` (reject needs `rejected_reason`; stock is checked) |
| Return equipment | `rpc('staff_return_rental', { p_rental_ref, p_equipment_id })` (outside rentals: `rpc('staff_return_rental_with_damage', ...)` records the condition and an optional damage fee) |
| Damage fee | `rpc('staff_collect_damage')`, `rpc('staff_reject_damage_payment')`, `rpc('staff_update_damage_charge')` (staff); `rpc('customer_pay_damage')` (customer, GCash); read with `v_damage_charge` |
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

## Let the customer choose a replacement item (71_customer_swap_choice.sql)
Run once in the SQL Editor (after 61_swap_rental_item.sql and 70_no_max_booking_hours.sql; safe to re-run). No Edge Function or other setting changes.
When a unit is damaged and an upcoming rental can no longer get it, staff now have two ways to fix it, next to each other in the shortage pop-up, the Equipment tab warning and the Rentals > Actions menu:
- **Swap item** (unchanged): staff pick the replacement at once. Use it when pick-up is soon.
- **Let customer choose** (new): staff tick 1 to 5 equivalent items that are free for the rental's hours, set how long the customer has to answer (1 hour to 2 days, always ending at least 30 minutes before the rental starts) and decide whether the first choice is swapped in automatically if the customer does not answer.
While the offer is open the offered items are **held** for those hours (`equipment_in_use_between` counts them), so nobody else can rent them. The customer sees a notice, a status chip and a pop-up in My rental / My bookings, and picks one (swapped at once, no extra charge, no refund) or presses "None of these suit me" (optional message). At the deadline the database either swaps in the first choice (if allowed and still free), closes the offer if the original item became free again, or marks it **Expired** and flags the rental "Replacement: follow up" for staff.
Offer status: Open, Swapped (by the customer or automatically), Declined, Expired, Cancelled. Staff can cancel an open offer, and a direct "Swap item" on the same line closes it. Every step is in the rental's History.
Expired offers are settled every minute by pg_cron (`tod-expire-swap-offers`; if pg_cron is not available the admin page and the customer's My rental page settle them when they load).
`staff_swap_rental_item` now calls the same shared routine (`swap_apply_internal`), with the same checks and messages as before.

## Studio will contact you (72_customer_swap_followup.sql)
Run after 71. When a customer answers "None of these suit me" (or does not answer in time and nothing can be assigned), their My rental status shows "Studio will contact you" instead of "Approved", until staff swap the item or the rental is issued, returned, rejected or cancelled.


## One Verify only: approve after the item is replaced (73_approve_after_swap.sql)
When a rental's payment is verified but its item is out of stock, the order stays Pending and staff must **Let customer choose** or **Swap item** (the same pop-up as after a damaged return). Once the replacement is in (staff swap, customer choice, or the deadline's automatic first choice), the order is approved by itself, so there is no second Verify. Run once in the Supabase SQL Editor, after 72_customer_swap_followup.sql.

## Drag equipment into the order customers see (77_equipment_sort_order.sql)
Run once in the Supabase SQL Editor (safe to re-run). Adds `equipment.sort_order`. In Admin > Equipment the owner drags a row by its handle to set the order of the equipment on the Rent page, the booking "Browse equipment" window and the home page. New equipment is added at the end. The category / Low stock / Newest added filters in the admin never change what customers see. Until the file is run the site keeps its old order and the drag handles are hidden.

## No-show release (78_no_show_release.sql)
Run once in the Supabase SQL Editor (safe to re-run), after 77_equipment_sort_order.sql. A confirmed booking that still owes a balance is held for a grace period after its start time (default 15 minutes, `app_setting` `no_show_grace_minutes`). If the balance is not paid and the session not started by then, it is cancelled automatically ("No-show: ...") and the slot is freed; its Pending and Approved add-on orders are cancelled too. Payments already made are not refunded. Staff can hold a booking longer (staff once, owner up to 3 times) or release it at once; every action appears in the booking's History. Customers get one extra 15 minutes with "Running late", see the release time on their booking, and can "Book again" after a no-show. Called every 30 seconds by the existing pg_cron job (file 49), so no new job is needed.

## No-show emails (79_no_show_emails.sql + send-receipt Edge Function)
Three emails for the no-show release, sent to the booking's saved receipt email (guests get them too; only the "I'm running late" button and "Slot held until" on the site need a login):
* **Confirmation**: the existing "Your booking is verified" email now shows "Pay the balance by <time>" and the no-show terms when a balance is left. The booking request receipt also carries the terms line.
* **Reminder** about 2 hours before the start, only if a balance is still due and the booking was confirmed more than 2 hours before the start. Sent once.
* **Forfeiture** when a booking is released as a no-show (automatically or by staff): the slot was released, the payment is kept. Sent once, within 6 hours of the release.

Setup, once, after 78: 1) run `79_no_show_emails.sql`; 2) Edge Functions > Secrets: add `CRON_SECRET` (your own long random text); 3) run the `insert into public.email_job_config ...` statement from the bottom of that file with your project URL, anon key and the same secret; 4) deploy the new `functions/send-receipt/index.ts` (Verify JWT stays on). A pg_cron job (`tod-no-show-emails`, every 5 minutes) then calls the function through pg_net. Until step 3 is done the job does nothing.

## QA fixes and tests (80_lock_equipment_on_request.sql, 81_qa_fixes.sql, tests/qa_tests.sql)
Run `80_lock_equipment_on_request.sql` and `81_qa_fixes.sql` once in the SQL Editor (safe to re-run).
* **80**: two customers asking for the last item at the same moment (even for two different studios) can no longer both get a Pending request.
* **81**: re-creates the phone check on `customer.number` (the copy in the old `01_schema.sql` rejected spaces), stops the internal helper `assert_order_stock` from being callable from the API, and makes the no-show release re-check the balance so a booking paid at the desk at that very moment is never released.
* **tests/qa_tests.sql**: paste into the SQL Editor and Run. It tests double-booking, the 50% / full payment maths, cancelling after payment (no refund), staff extension cost, the no-show release, and who can read whose data. Everything is rolled back; the result appears as a "QA RESULTS" error box.
Note: `70_no_max_booking_hours.sql` raises the extension limit to 12 hours by patching function text. If you ever re-run an older file such as `55_extend_without_addons.sql`, run 70 again afterwards.

## No-shows inside the flag window (82_no_show_in_flag.sql)
Run once in the SQL Editor (safe to re-run), after 78 and 64. Clicking a flag in the admin lists the customer's no-shows of the last 12 months (booking, date, what happened, who released it). Staff can **Add note** and **Dismiss** a no-show (a note is required) and later press **Count again**, exactly like a late return or damage fee; every note and dismissal is logged with who and when. A dismissed no-show stops counting. A customer who only has no-shows gets the flag too (1 counted no-show = yellow, 2 or more = red; display only, it never blocks anyone). The separate "No-show x1" chip was removed; the flag replaces it everywhere (bookings, customers, Studio sessions). Dismissing does not reopen the booking or change what the customer sees on it. Until the file is run the window shows no No-shows section.

## Late fee collected at the return (83_late_fee_collection.sql)
Run once in the SQL Editor (safe to re-run), after 82 and 68. When staff press **Actions > Process return** on an overdue outside rental, the Return window works out the late fee by itself (price / 8 per hour, per item, a started hour counts as a full hour, counted from the end of the 8-hour window, the same moment the list says Overdue) and adds the damage fee the staff enter. One payment covers both: **Cash** (the amount tendered must cover the total, the change is shown) or **GCash** (13-digit reference). A late fee is always collected at the return (there is no "Not now"); a damage fee alone can still be left unpaid. How the late fee was paid (method, reference, cash tendered, when, by whom) is saved on the rental line and shown in the rental's details. The Rentals list shows the late fee so far next to Overdue. Return, late fee and damage fee are saved in one step (`staff_return_rental_with_fees`); if an hour ticks over while the window is open, nothing is saved and staff are asked to open it again. Until the file is run, a return with no late fee works as before and a return with a late fee asks to run it.

## Mark completed collects the balance of an extended session (85_collect_balance_on_complete.sql)
Run once in the SQL Editor (safe to re-run), after 84. When staff **Extend** an Active session, the extra hours are added to the bill and the booking shows **Balance ₱...** in the Payment column. **Mark completed** on such a session now opens the same window as **Collect balance & start**: the amount to collect, **Cash** (amount tendered, change to return, quick-cash chips) or **GCash** (13-digit reference number). Confirming records the balance as fully paid, marks the booking **Completed**, and emails the customer the fully paid receipt. A session with nothing left to pay keeps the normal "Mark this session as completed?" question. The file lets `staff_collect_balance` accept an In Progress booking when it is called with `p_start = false` (starting a session still needs a Confirmed booking) and clears `payment.balance_email_sent_at` so a second collection is emailed again. Until the file is run, the window shows a message asking to run it and the booking is not completed. No Edge Function change.

## A session that owes a balance is never completed by itself (86_block_autocomplete_with_balance.sql)
Run once in the SQL Editor (safe to re-run), after 85. Until now `start_due_sessions()` (every 30 seconds, pg_cron file 49) completed every In Progress session at its end time, so an extended session whose extra hours were not paid was completed with its balance never collected. The auto-complete step now skips a booking whose balance due is above zero: it stays In Progress, shows **Over time by N min** with **Balance due** on the Studio Sessions card (the sidebar badge and the "Session is over time" pop-up stay on, with the amount), and its button reads **Collect balance & complete** (Studio Sessions, Bookings Actions menu, Verify window). Pressing it opens the file 85 window; once the balance is saved the session is completed. Sessions with nothing owed still complete at their end time exactly as before. No trigger is used on purpose: one that raises an error would roll back the whole batch and stop other sessions from completing. Add-on equipment of such a session is returned when the session is completed, so until then it can show as Overdue in Rentals.


## 87_booking_check_in.sql  (check-in: when the customer arrived)
Run once in the SQL Editor (safe to re-run), after 86. Adds `booking.checked_in_at / checked_in_by / checked_in_by_name`, the RPCs `staff_check_in`, `staff_undo_check_in` (owner only, note required) and `staff_check_in_times`, a guard so only staff can change the check-in, and an automatic check-in for onsite walk-ins. A checked-in customer is not a no-show: `release_no_show_bookings`, `staff_release_booking`, `staff_release_times`, `booking_release_time` and `my_booking_release` skip a checked-in booking. Check-in is a record only; fully paid bookings still start by themselves at their start time. Every check-in and undo is written to `booking_event` (the booking's History).
