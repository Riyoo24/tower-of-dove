# Supabase Backend

Everything the Tower of Dove website needs on the server side: the PostgreSQL schema and business rules, Row Level Security, Storage buckets, scheduled jobs, and two Edge Functions.

> The frontend only ever uses the public **anon** key. All rules (no double booking, stock limits, payment maths, booking window, no-show release) are enforced here in the database, so they hold no matter which client calls it.

For a deeper reference (every table, view, trigger and policy) see [`../docs/supabase_setup_summary.md`](../docs/supabase_setup_summary.md).

---

## Contents

1. [What is in this folder](#what-is-in-this-folder)
2. [Quick start (fresh install)](#quick-start-fresh-install)
3. [Migration reference](#migration-reference)
4. [Authentication setup](#authentication-setup)
5. [Edge Functions](#edge-functions)
6. [Scheduled jobs (pg_cron)](#scheduled-jobs-pg_cron)
7. [Storage buckets](#storage-buckets)
8. [What the website calls](#what-the-website-calls)
9. [Rules the database enforces](#rules-the-database-enforces)
10. [Testing](#testing)
11. [Updating an existing database](#updating-an-existing-database)
12. [Security checklist](#security-checklist)

---

## What is in this folder

```text
supabase/
├── 01_schema.sql              Tables, constraints, indexes, helpers, triggers
├── 02_functions.sql           RPC functions and views the website calls
├── 03_security.sql            Privileges, Row Level Security, Storage buckets and policies
├── 04_seed.sql                Starting data (studios, categories, equipment) + owner setup notes
├── 05_… → 94_…                Incremental feature migrations (see the reference below)
├── all_in_one.sql             Combined script of the early files (not a full replacement, see below)
├── functions/
│   ├── create-staff/index.ts  Edge Function: staff accounts and customer removal (Owner only)
│   └── send-receipt/index.ts  Edge Function: receipts and notification emails
└── tests/
    └── qa_tests.sql           Database QA suite (everything is rolled back)
```

Notes on the file set:

- There is intentionally **no `74_*.sql`**.
- `29_optional_backfill_first_name_usernames.sql` is **optional**.
- `48_performance_indexes.sql` is **optional** (speeds up "newest N" reads).
- `94_qa_hardening .sql` currently has a **space before `.sql`** in its filename. Rename it to `94_qa_hardening.sql` to keep the numbering tidy.
- Every migration is **safe to re-run**.

---

## Quick start (fresh install)

**Prerequisites:** a [Supabase](https://supabase.com) project, access to its **SQL Editor**, and (for emails) an SMTP account such as Gmail with an App Password.

1. **Create a Supabase project.**
2. **Run the core files** in the SQL Editor, in order:
   `01_schema.sql` → `02_functions.sql` → `03_security.sql` → `04_seed.sql`
3. **Run every numbered migration `05` → `94` in numeric order.**
   Skip the optional ones if you do not need them. Use the numbered files rather than `all_in_one.sql` for a fresh install; `all_in_one.sql` does not cover every migration.
4. **Configure authentication** (email confirmation, SMTP, redirect URLs). See [Authentication setup](#authentication-setup).
5. **Create the first Owner account.** Follow the comment block at the bottom of `04_seed.sql`:
   1. In **Authentication → Users → Add user**, create the owner's email and password and tick **Auto Confirm User**.
   2. Run the `insert into public.app_user …` statement from that comment block with the same email.
6. **Deploy the Edge Functions** and add their secrets. See [Edge Functions](#edge-functions).
7. **Finish `79_no_show_emails.sql`.** It needs a secret and one config row (details in [Scheduled jobs](#scheduled-jobs-pg_cron)).
8. **Point the frontend at your project** by editing `js/config/supabaseClient.js` with your project URL and anon key.
9. *(Optional)* Paste `tests/qa_tests.sql` into the SQL Editor and run it to confirm the rules work.

> Run the SQL **before** uploading a new version of the site files. Several migrations add functions the new pages call.

---

## Migration reference

Every file is **safe to re-run**. Each one lists what it does and what it must come after. Unless stated otherwise, run it once in the **Supabase SQL Editor**, and no Edge Function change is needed.

> **Reading tip:** later files often change or replace behavior added by earlier ones. Where a rule was changed later, the entry says so (for example, the 4-hour limit of file 15 is lifted by file 70).

### Core schema (run first, in this order)

#### `01_schema.sql`
Creates the extensions (including `btree_gist`), all core tables (`app_user`, `customer`, `studio`, `equipment_category`, `equipment`, `booking`, `rental_order`, `rental_detail`, `payment`, `slot_hold`, `app_setting`), their constraints, indexes, helper functions, triggers and reference-number sequences. The **no-overlap exclusion constraint** on studio + time range is what makes double booking impossible. Business timezone is Asia/Manila, opening hours 10:00 to 22:00.

#### `02_functions.sql`
The RPC functions the website calls (booking, rescheduling, cancelling, guest lookups, slot holds, rental requests, staff actions) and the reporting views (`v_booking_summary`, `v_rental_lines`, `v_payment_queue`, `v_dashboard_counts`, `v_revenue_daily`, ...). All are `SECURITY DEFINER` and validate their own input, so the tables themselves stay locked down.

#### `03_security.sql`
Table privileges, **Row Level Security** policies, and the first Storage buckets (`studio-images`, `equipment-images`, `rental-ids`) with their policies. Defines the access model: guests can read the catalogue and call guest RPCs; customers see only their own data; staff run operations; the Owner also manages studios, equipment and staff.

#### `04_seed.sql`
Starting data: Studios A to D, the equipment categories, and sample equipment (add-on price is per session, outside price is per day, `min_hours` is the minimum outside rental). The **bottom comment block explains how to create the first Owner account**.

### Add-ons, outside rentals and extensions (05 to 25)

#### `05_booking_addons.sql`
Book a studio **and** add equipment in one transaction, paying one combined amount (studio total + add-on total). If anything fails (for example an item is unavailable), nothing is saved. Staff verify a single payment.

#### `06_lookup_addons.sql`
The guest "find my booking" lookup now also returns the booking's add-on equipment and a grand total.

#### `07_auto_approve_addons.sql`
Verifying a booking payment automatically approves its add-on equipment (no second trip to Rentals). Rejecting the payment rejects the pending add-on too. If an item is out of stock, the add-on stays Pending for staff to review.

#### `08_outside_rental.sql`
Outside (take-home) rentals: logged-in customers only, priced per hour (the item price covers 8 hours, each extra hour adds price / 8), 50% GCash down payment with the request and the balance at pick-up, late returns charged price / 8 per hour. Customers can cancel under the same 24-hour rule as bookings. Online outside rentals can only be created through `request_outside_rental()`.

#### `09_random_refs.sql`
Reference codes become random so they cannot be guessed: bookings `TOD-9F3A21C7`, outside rentals `OUT-5B07E1AA`, add-on rentals `RA-C41D90E2`. Existing codes keep working.

#### `10_guest_lookup_privacy.sql`
The reference-code lookup works for **guest** bookings only. A booking made with an account can only be read by that account or by staff, and the lookup answers "not found" so it never confirms that a code exists.

#### `11_cash_autostart_addons.sql`
Online bookings cannot be paid in cash. Confirmed bookings start by themselves at their start time. Add-ons added later follow rules (a guest cannot attach equipment to a registered customer's booking; the payment amount follows the add-ons while still Pending). Optionally schedules a `pg_cron` job (superseded by file 49).

#### `12_rental_base_hours_autostatus.sql`
Outside rentals get an **8-hour base**: returns under 8 hours keep the base price, each extra hour adds price / 8, and late fees or "Overdue" only begin after the full 8-hour window. Onsite rentals take a start date and time and are saved as Approved. Add-ons go In Use when their booking starts; outside rentals go In Use at pick-up time (later changed by 65). Staff can disable and re-enable customer accounts.

#### `13_overdue_hours_addon_return.sql`
Adds `hours_overdue` to `v_rental_lines` (the Rentals page shows "3 hours overdue"). When a studio booking becomes Completed, its Approved / In Use add-ons are marked Returned automatically so stock comes back. Includes a one-time clean-up of add-ons on bookings that were already Completed. *After 12.*

#### `14_email_login_names_id_view.sql`
Customers and staff log in with a **real email address** (the `username` column accepts an email up to 254 characters). New sign-ups copy the email into the customer's email column. Names can no longer contain digits. Customers can open the valid ID they uploaded with their own outside rental. Old accounts are not touched. *After 13.*

#### `15_extend_booking.sql`
Staff can extend a Confirmed or Active booking. `staff_extension_info()` tells how many extra hours are free; `staff_extend_booking()` moves the end time and adds the cost to the bill and payment. The database refuses overlaps with the next booking, other people's holds, an unavailable studio, and anything past 10:00 PM. (The original 1 to 4 extra hours limit was lifted by file 70.) *After 14.*

#### `16_extension_slot_hold.sql`
While staff have the Extend window open, the extra hours are held ("Held by Staff") and renewed every minute, so two people can never extend the same slot at once. Replaces the two functions from file 15 with hold-aware versions. (The hold length became 2 minutes in file 37.) *After 15.*

#### `17_customer_extend.sql`
The extension functions accept either staff or the customer who owns the booking, so customers can extend their own Confirmed or Active booking from My bookings. (Customer extensions later require a verified payment, see 23.) *After 16.*

#### `18_booking_reject_reason.sql`
Rejecting a booking needs a reason, and the customer sees it. Adds `staff_reject_booking(ref, reason)`, a `rejected_reason` column on `v_booking_summary`, and the same field in `lookup_booking`. *After 17.*

#### `19_remove_drum_vip_capacity.sql`
Removes `is_drum_set`, `drum_kit` and `is_vip` from equipment and `capacity` from studios. All drum categories are consolidated into one `Drums` category, with model details moved into the item's name and description.

#### `20_booking_down_payment.sql`
Online studio bookings need a **50% GCash down payment**, set by the server (the browser cannot change it). The other 50% is paid at the studio. The down payment is non-refundable on cancellation. Later add-ons and extensions are paid at the studio as part of the balance. Walk-in bookings are unchanged (paid in full). The revenue report counts the down payment when verified and the balance when the session starts. *After 18.*

#### `21_fix_rental_total_8h.sql`
Restores 8-hour billing for outside rentals (price covers 8 hours, +price / 8 per extra hour, rounded up). File 19 had replaced it with per-day billing, which made the server total differ from what the site showed. *After 20.*

#### `22_owner_email.sql`
**One-time fix for an existing database only.** Changes the owner login from `owner@towerofdove.app` to `towerofdovemusic@gmail.com` in Supabase Auth and `app_user` (the password stays the same). Fresh installs do not need it; create the owner with the new email instead.

#### `23_extension_payment.sql`
Customers pay for extensions like bookings: pick extra hours and pay a **50% down payment by GCash**. The request is saved as Pending and the extra hours are **reserved** until staff decide. Verifying moves the booking's end time and adds to its down payment; rejecting (with a reason) releases the hours. One pending extension per booking; reschedule is blocked while one is pending. Customers can no longer call `staff_extend_booking` directly. *After 21.*

#### `24_onsite_gcash_optional.sql`
The GCash reference becomes optional for staff-recorded onsite bookings and rentals (online payments still require it). Later made required again by file 69.

#### `25_reschedule_slot_hold.sql`
Rescheduling **holds the new hours for 2 minutes** while the customer chooses, like booking does. Adds `hold_reschedule_slot()`; `reschedule_booking()` now takes the hold token, refuses the same start time, and frees the hold afterwards. *After 24.*

### Accounts, payment options and emails (26 to 45)

#### `26_profile_management.sql`
When someone confirms a new login email (Supabase sends the link), copies it into their profile row. A different contact email chosen by staff is left alone. Name and password changes need nothing here.

#### `27_allow_username_change.sql`
Relaxes the `protect_user_columns` trigger so any logged-in user can change their **own username**. Role, status and `auth_user_id` stay owner-only. Needed by the account page.

#### `28_default_username_first_name.sql`
New accounts default to their **first name** as username (`maria`, `maria2`, ...). Letters and numbers only, lowercase, at least 3 characters. Login still uses the email. Existing usernames are not changed. Redeploy `create-staff` afterwards.

#### `29_optional_backfill_first_name_usernames.sql`
**Optional.** Renames existing accounts whose username is still their email to their first name. Accounts already changed by the person and the owner account are skipped. *After 28.*

#### `30_claim_guest_bookings.sql`
After a guest registers or logs in, `claim_guest_bookings()` moves their guest bookings onto the account. A booking moves only when its code exists **and** the phone number matches. Add-ons, extension requests and payments follow.

#### `31_payment_options.sql`
Customers choose **50% down payment** or **100% full payment** for studio bookings, outside rentals, later add-on rentals and extensions. The server calculates the amount; the choice is stored in `payment.payment_option`. Walk-in records are unchanged. *After 30.*

#### `32_balance_collection.sql`
Staff must **collect the remaining balance** before a session starts or equipment is issued. Adds `booking_balance_due()`, `rental_balance_due()`, and `staff_collect_balance()` (one transaction that records the balance, turns the payment into a full payment and moves the booking to In Progress / the rental to Active). A guard trigger blocks starting anything with a balance, and `start_due_sessions()` no longer auto-starts those. Views gain `balance_due` columns. *After 31.*

#### `33_booking_window.sql`
The database refuses online bookings and pick-ups more than **28 days** ahead. Staff and onsite records are not limited. Existing bookings are untouched. (Now driven by `app_setting` since 94.)

#### `34_receipt_emails.sql`
Receipt emails. Guests type an email in the booking form (required, validated here too); signed-in customers use their account email, read by the database. Stored as `receipt_email` and `receipt_sent_at` so the Edge Function sends once and never accepts an address from the browser. **Also deploy `functions/send-receipt`.** *After 33.*

#### `35_verified_emails.sql`
"Your payment is verified" emails. Adds `payment.verified_email_sent_at` so each verification sends exactly one email. **Redeploy `send-receipt`.** *After 34.*

#### `36_onsite_slot_hold.sql`
The onsite booking form **holds the chosen hours for 2 minutes** ("Held by Staff", renewed every minute, released on inactivity). Adds `staff_hold_onsite` and replaces `staff_create_onsite_booking` with a version accepting the hold token. **Run it before uploading new site files**, or the onsite form cannot record bookings. *After 16 and 24.*

#### `37_hold_two_minutes.sql`
Makes the Extend hold last 2 minutes like every other hold (replaces `staff_hold_extension`). *After 36.*

#### `38_gcash_screenshots.sql`
Creates the private `gcash-screenshots` bucket (images only, 5 MB) for the required **Attach GCash Screenshot** field. Files go in `<13-digit reference>/`. Anyone filling a payment form can upload; only staff can open them (Verify drawer). No table changes.

#### `39_addon_auto_issue_return.sql`
Add-on equipment follows its studio session, even when added later: session starts means the add-on is issued; session completed means it is returned. One function, `sync_addon_orders`, does this and also runs every 30 seconds to catch missed items. Pending add-ons of ended bookings are cancelled. *After 38.*

#### `40_addon_balance_collection.sql`
A later add-on paid at 50% stays a down payment until staff collect the rest ("Collect balance & issue" in Rentals), and is not issued before that, even in a running session. Starting the session collects it together with the booking balance. *After 39.*

#### `41_auto_complete_sessions.sql`
A session that reaches its end time is **marked Completed automatically** (inside `start_due_sessions()`), which also returns its add-ons and frees the studio. A session with an extension still awaiting verification is not completed yet. *After 40.*

#### `42_onsite_receipt_email.sql`
Onsite bookings and rentals can email a receipt through an optional "Email for the receipt" box. Adds `staff_set_receipt_email()`. Needs files 34 and 35 and the `send-receipt` function. *After 41.*

#### `43_onsite_outside_down_payment.sql`
An onsite **outside rental for a later day** can take a 50% down payment. It shows "Balance PHP x" and is not issued until "Collect balance & issue". Today's rentals stay full payment. *After 42.*

#### `44_onsite_booking_down_payment.sql`
An onsite **studio booking for a later day** can take a 50% down payment; its Start button reads "Collect balance & start". Today's bookings stay full payment. *After 43.*

#### `45_addon_balance_on_booking.sql`
A booking now shows the **balance of its add-on equipment**, even when the booking itself was paid in full. `booking_balance_due()` counts add-ons with their own down payment, starting the session collects it, `staff_collect_balance()` only collects add-ons whose payment staff verified, and `lookup_booking()` returns `addon_balance`. *After 44.*

### Condition logging, stock and damage fees (46 to 77)

#### `46_equipment_condition_docs.sql`
Equipment condition documentation for **outside rentals**: a "before" photo per item when issuing; a return condition (No issue, Scratch, Damaged, Severely damaged, Others), optional notes and an "after" photo on return. Adds columns to `rental_detail`, the private `rental-photos` bucket, `staff_set_before_photo()` and `staff_return_rental_with_condition()`, and four columns on `v_rental_lines`. *After 45.*

#### `47_fix_customer_photo_policy.sql`
Fixes customers being unable to open their own before / after photos (the policy compared the wrong path form). Adds the helper `customer_owns_rental_photo()`.

#### `48_performance_indexes.sql`
**Optional.** Indexes for the newest-first, capped reads the site uses (newest bookings, payments, rentals, extensions). Changes nothing else.

#### `49_cron_auto_complete.sql`
Schedules `start_due_sessions()` with **`pg_cron` every 30 seconds** (falls back to every minute) so sessions start and complete even when no admin page is open. Requires file 41. The admin page still calls it too (harmless, idempotent). Job: `tod-start-sessions`.

#### `50_addon_full_payment_when_started.sql`
Equipment added to a session that has already started had to be paid in full. (Relaxed by file 90, which adds "pay after the session".)

#### `51_stock_by_time.sql`
Equipment stock is checked **for the hours it is needed** (studio add-ons and outside rentals). Two orders only compete when their hours overlap. The check also runs when the customer submits, so "not enough" shows before paying. Adds `equipment_available_between(from, to)`. Orders that are Approved or Active hold stock. *After 50.*

#### `52_stock_on_booking_time_change.sql`
Re-checks add-on equipment whenever a booking is **extended or rescheduled**, so new hours cannot double-book an item. The Extend window shows the problem before the customer pays, and the same check runs when staff verify an extension. *After 51.*

#### `53_pending_orders_hold_stock.sql`
A **Pending** add-on or outside-rental request now holds its equipment (no time limit) until staff verify, reject or cancel it, so a customer who paid cannot lose items because staff were slow. Stale holds from Rejected / Cancelled / Completed bookings are ignored. *After 52.*

#### `54_reschedule_stock_slots.sql`
The Reschedule window **greys out start times** where the booking's add-on equipment is not free. Adds `reschedule_blocked_slots(ref, date)`, using the same check as the save, so what is greyed out is exactly what would be refused. *After 53.*

#### `55_extend_without_addons.sql`
A session can still be **extended when its add-on equipment is not free** for the extra hours, after a confirmation ("Extend without the add-on?"). Only the booking is extended; the add-on keeps its original hours (`rental_order.addon_cut_hours`). For customer requests the choice is saved in `booking_extension.without_addons` and applied on verification.

#### `56_balance_payment_proof.sql`
Collecting a balance now requires proof: **Cash** (amount tendered, change shown, database refuses less than the balance) or **GCash** (13-digit reference saved in `payment.balance_paid_reference`). Adds `staff_collect_balance_proof()`, which checks the proof and calls the existing function in the same transaction. *After 55.*

#### `57_handover_proof.sql`
Outside rentals need a **handover proof photo** (one per rental) in addition to per-item before photos. Adds `rental_order.handover_photo_path`, `staff_set_handover_photo()`, and extends the issue guard, the customer photo policy and `v_rental_lines`. Customers see it in My rental > Details. *After 56 (needs 46 and 47).*

#### `58_damage_charges.sql`
**Damage fees** for outside rentals. A fee is money owed, kept in its own tables (`damage_charge`, `damage_charge_log`) and view (`v_damage_charge`), separate from the payment table. Status flows Unpaid, Pending (GCash sent, awaiting staff check), Paid; Waived means 0. Every change is logged with who, when and why. Returns never depend on payment: staff can collect now (Cash / GCash) or the customer pays later. Reports count a fee only once Paid.

#### `59_remove_damaged_stock.sql`
In the return window, staff can tick **Remove from stock** for a damaged item and choose how many. Confirming lowers Total stock in the same transaction and logs a "Stock removed" line. *After 58.*

#### `60_out_of_service_stock.sql`
Equipment gets **Owned** and **Out of service** quantities (Rentable = owned - out of service; `total_quantity` is kept equal to rentable by a trigger so existing checks keep working). The return window offers per damaged item: Back in stock, Out of service, or Remove permanently. A return is **never cancelled** because of this; the app lists upcoming rentals and bookings that no longer have enough (checked by date). Replaces the function from 59. *After 59.*

#### `61_swap_rental_item.sql`
Staff can **swap an item** on a not-yet-issued rental for an equivalent one at no extra charge (the customer keeps the agreed price; nothing is refunded). Adds the `rental_item_swap` log, `staff_swap_options()`, `staff_swap_rental_item()`, and an updated `equipment_stock_conflicts()` that returns the line id and booking time. *After 60.*

#### `62_stock_preview.sql`
`equipment_stock_preview()` shows which upcoming rentals would be short **before** a return is confirmed, when staff tick "Remove from stock", so they can swap right there. Read-only. *After 61.*

#### `63_out_of_stock_status.sql`
Equipment with 0 rentable units shows **Out of Stock** instead of "In Use". "In Use" is kept for items with units rented out and none left. *After 62.*

#### `64_damage_block_reputation.sql`
Two features. **(1)** A customer with an **unpaid damage fee** (Unpaid, or Pending until staff check the GCash payment) cannot create a new booking or rental, online or onsite. Enforced by `BEFORE INSERT` triggers on `booking` and `rental_order`, matched by account **and** phone number (last 10 digits) so guests are covered. A phone-only match gets a generic message with no amount. Only the Owner can waive, defer or lift a block, with a required, logged reason. **(2)** Staff-only **reputation flags** (late returns and damage fees of the last 12 months) with notes and dismissals, in tables customers cannot read (`incident_review`, `incident_review_log`). *After 63.*

#### `65_outside_no_auto_issue.sql`
An outside rental is **never issued automatically**, even when fully paid and past pick-up time. Staff issue it from the admin page after attaching the before photos and handover proof. Sessions, extensions and add-ons behave as before.

#### `66_balance_receipt_email.sql`
A **"fully paid" receipt email** is sent when staff collect a booking or rental balance (once per collection, staff only, via `send-receipt` kind `balance`). **Redeploy `send-receipt`.** *After 65.*

#### `67_balance_cash_tendered.sql`
The fully paid email also shows **Cash received and Change**; the tendered amount is saved in `payment.balance_tendered`. **Redeploy `send-receipt`.** *After 66.*

#### `68_damage_paid_email.sql`
The same fully paid receipt is emailed when a **damage fee gets paid** (staff collect it, accept the customer's GCash payment, or collect it at the return). Sent once, within 30 minutes of payment. Saves cash received in `damage_charge.paid_tendered` and replaces `staff_collect_damage()` and `staff_return_rental_with_damage()`. **Redeploy `send-receipt`.** *After 67.*

#### `69_onsite_gcash_required.sql`
Onsite bookings and rentals paid by **GCash require the 13-digit reference** (same rule as online). Cash is unchanged. *After 68.*

#### `70_no_max_booking_hours.sql`
Removes the **4-hour maximum** of a booking and of an extension. A booking can be 1 hour up to the whole day; the only limits are the schedule and the 10:00 PM close. It patches function text, so **if you ever re-run an older file such as 55, run 70 again afterwards.**

#### `71_customer_swap_choice.sql`
**"Let customer choose"**: staff offer 1 to 5 equivalent items (free for the rental's hours), set an answer deadline, and decide whether to swap in the first choice automatically if the customer does not answer. While an offer is Open the offered items are **held**. The customer picks one (swapped at once, no extra charge) or declines. At the deadline the first choice is swapped in, or the offer closes or is marked Expired. Adds the offer tables, `staff_create_swap_offer`, `my_swap_offers`, `customer_choose_swap`, `customer_decline_swap`, `expire_swap_offers`, and the `pg_cron` job `tod-expire-swap-offers` (every minute). `staff_swap_rental_item` now shares one routine, `swap_apply_internal`. *After 61 and 70.*

#### `72_customer_swap_followup.sql`
When a customer declines (or does not answer and nothing can be assigned), My rental shows **"Studio will contact you"** instead of "Approved", until staff swap the item or the rental is issued, returned, rejected or cancelled. *After 71.*

#### `73_approve_after_swap.sql`
**One Verify only.** If a rental's payment is verified but the item is out of stock, the order stays Pending until a replacement is in; then it is **approved automatically**, with no second Verify. The approver recorded is the staff member who verified the payment. *After 72.*

> There is intentionally **no `74_*.sql`**.

#### `75_onsite_cash_tendered.sql`
Onsite bookings and rentals paid in cash save the **cash tendered**, so the receipt email can show Cash received and Change. Adds `payment.cash_tendered` and a fourth argument to `staff_set_receipt_email()`. **Redeploy `send-receipt`.** *After 73.*

#### `76_replacement_emails.sql`
Automatic emails when a rental item becomes unavailable: the **"choose your replacement" email** (lists options, prices, deadline, default item) and the **"your item was replaced" email**. Each is sent once (`customer_emailed_at`). **Redeploy `send-receipt`.** *After 75.*

#### `77_equipment_sort_order.sql`
Adds `equipment.sort_order` so the Owner can **drag equipment rows** in Admin > Equipment to set the order customers see (Rent page, "Browse equipment" window, home page). New items go to the end. Until run, the drag handles are hidden.

### No-shows, late fees, check-in and hardening (78 to 94)

#### `78_no_show_release.sql`
**No-show release.** A confirmed booking with an unpaid balance is held for a grace period after its start (default 15 minutes, `app_setting` key `no_show_grace_minutes`). If the balance is not paid and the session not started, it is **cancelled automatically** ("No-show: ...") and the slot is freed; its Pending and Approved add-ons are cancelled too. Payments already made are not refunded. Staff can hold longer (staff once, owner up to 3 times) or release at once; customers get one extra 15 minutes with "Running late". Runs from the existing 30-second `pg_cron` job. *After 77.*

#### `79_no_show_emails.sql`
Three emails for the no-show release: the verified email now shows **"Pay the balance by <time>"** and the terms; a **reminder** about 2 hours before the start (only if a balance is due); and a **forfeiture** notice when released. Needs setup: add the `CRON_SECRET` Edge Function secret, run the `insert into public.email_job_config ...` statement from the bottom of the file with your project URL, anon key and that secret, and redeploy `send-receipt`. Adds the `pg_cron` job `tod-no-show-emails` (every 5 minutes, through `pg_net`). Until the config row exists the job does nothing. *After 78.*

#### `80_lock_equipment_on_request.sql`
Fixes a **last-item race**: two customers requesting the last unit at the same moment (even for different studios) could both pass the stock check. Adds a lock inside `request_rental()`.

#### `81_qa_fixes.sql`
QA fixes: re-creates the `customer.number` check (the old copy rejected spaces), stops the internal helper `assert_order_stock` from being callable from the API, and makes the no-show release **re-check the balance** so a booking paid at the desk at that very moment is never released.

#### `82_no_show_in_flag.sql`
No-shows appear **inside the reputation flag** (last 12 months, people sharing a phone number together). Staff can Add note and Dismiss a no-show (note required) and later Count again; everything is logged. One counted no-show is yellow, two or more red (display only, never blocks anyone). *After 78 and 64.*

#### `83_late_fee_collection.sql`
The **late fee is collected at the return**, together with any damage fee, in one payment (Cash with change, or GCash with reference). The fee is price / 8 per hour per item, a started hour counts as a full hour, counted from the end of the 8-hour window. Adds `staff_return_rental_with_fees()` (return, late fee and damage fee in one transaction) and stores how the late fee was paid on the rental line. *After 82 and 68.*

#### `84_late_fee_block.sql`
A late fee left unpaid at the return ("Not now") now works like an unpaid damage fee: it **blocks new bookings and rentals** (including the same phone number) and forces a red flag. The Owner's Waive / Defer / Lift tools work for it too. *After 83 and 64.*

#### `85_collect_balance_on_complete.sql`
**Mark completed collects the balance of an extended session.** For an In Progress booking with a balance, the window asks for Cash (tendered, change) or GCash (reference), records the balance as fully paid, completes the booking and emails the fully paid receipt. `staff_collect_balance()` accepts an In Progress booking when `p_start = false`. *After 84.*

#### `86_block_autocomplete_with_balance.sql`
A session that **still owes a balance is never completed by itself**. It stays In Progress ("Over time", with the amount due) until staff press **Collect balance & complete**. Sessions with nothing owed complete exactly as before. No trigger is used on purpose, so one error cannot roll back the whole batch. *After 85.*

#### `87_booking_check_in.sql`
**Check-in:** staff record when the customer arrived (`booking.checked_in_at / checked_in_by / checked_in_by_name`), for down-payment and fully paid bookings alike. It does not start the session. A checked-in customer is **not a no-show** (the countdown, Hold and Release stop). Adds `staff_check_in`, `staff_undo_check_in` (Owner only, note required) and `staff_check_in_times`. Walk-ins starting within 15 minutes are checked in automatically. Every action is logged in the booking's History. *After 86.*

#### `88_late_fee_preview.sql`
The Return window asks the **database** how much late fee will be charged (`staff_late_fee_preview`), instead of calculating in the browser, so the window and the actual charge can never disagree. Read-only. *After 87 (needs 83).*

#### `89_equipment_checkout_hold.sql`
**Checkout hold:** while a customer has the rental checkout window open, the items in their cart are held for 2 minutes (new `equipment_hold` table, `hold_equipment()`, `release_equipment_hold()`), so two customers cannot both reserve the last unit. `equipment_available_between()` subtracts other customers' holds; the request RPCs take an optional `p_hold_token`. Holds never block staff. **Run it, or the checkout window will not open.** *After 88.*

#### `90_addon_balance_in_session.sql`
Equipment added to a **running (Active) session** can be paid **after the session**. The customer gets a "Pay after my session" option (`request_addon_rental_later()`); staff get "After the session (added to the balance)" in Onsite > Rental. The equipment is marked In Use right away and its price becomes part of the booking balance, collected with **Collect balance & complete**. `staff_create_onsite_rental()` gains a last argument `p_pay_later`. Stored as `rental_order.balance_deferred = true` plus a PHP 0.00 Verified payment row. *After 89.*

#### `91_extension_pay_later.sql`
A customer can **extend now and pay after the session**. `customer_extend_pay_later()` extends at once (same studio, closing-time and add-on checks) and adds the cost to the balance. A booking that was paid in full is switched to the down-payment model so the extra hours show as a balance. *After 90.*

#### `92_extension_active_no_down.sql`
Extending an **Active** session offers only **Pay after my session** or **Full payment**; the 50% down payment is refused by the database too. Before the session starts, 50% / 100% / pay later work as before. *After 91.*

#### `93_staff_extend_session_payment.sql`
Staff extending a **running session** get the same two choices: **Full payment (paid now)**, Cash with change or GCash with reference and screenshot, or **After the session** (added to the balance). Adds `staff_extend_session()`. Confirmed (not started) bookings still use `staff_extend_booking` from 55. *After 91.*

#### `94_qa_hardening.sql`
Fixes from the QA audit. **(B-01)** Guest lookups by reference code now **require the phone number**. **(B-02)** `hold_slot` is throttled (60 attempts per IP per 10 minutes, and at most 10 different people holding one studio at once). **(B-03)** Online guest bookings and outside-rental contact numbers must be a real 11-digit Philippine mobile number (`09` + 9 digits). **(B-04)** The booking window (28 days), change / cancel cutoff (24 hours) and slot-hold length (2 minutes) now live in `app_setting` and are enforced from there; the website reads them through `get_public_settings()`. No new jobs, buckets or policies. *Rename the file to remove the space before `.sql`.*

### Other files

#### `all_in_one.sql`
The four core files plus a selection of later migrations (05 to 18, 20, 21, 23 to 28, 30, 38 to 45, 65 to 67). A convenience for early setups only; it is **not** a full replacement. For a complete, current database, run the numbered files.

#### `tests/qa_tests.sql`
The database QA suite. See [Testing](#testing).

**Dependency tips**

- Files 83 to 93 build on each other. Run them in order.
- If you re-run an older file that redefines extension functions (for example 55), run 70 again afterwards.
- Redeploy `send-receipt` after 35, 66, 67, 68, 75, 76 and 79 (the `functions/send-receipt/index.ts` in this repo already includes all of them).

---

## Authentication setup

Customers and staff log in with their **real email address**. Email confirmation is on, so these settings matter.

1. **Authentication → Providers → Email:** turn on **Confirm email**.
2. **Authentication → URL Configuration:**
   - **Site URL:** the address where the site is hosted (for example `https://tower-of-dove.vercel.app/`).
   - **Redirect URLs:** add the same address followed by `**` (and `http://localhost:8000/**` for local work). Without this, confirmation and reset links will not return to the site. The site must be opened over `http(s)`, not by double-clicking a file.
3. **Custom SMTP sender:** Supabase's built-in sender only emails project team members and allows very few emails per hour. Under **Authentication → Emails → SMTP Settings**, enable custom SMTP using a service such as Resend, Brevo, or Gmail with an App Password (`smtp.gmail.com`, port `465`). Raise **Authentication → Rate Limits → Emails sent per hour** if you expect many sign-ups.
4. *(Optional)* Edit the **Confirm signup**, **Reset password** and **Change email address** templates. Keep the `{{ .ConfirmationURL }}` link in each.
5. **Secure email change** (Providers → Email): turn it on so a changed email must be confirmed from both inboxes.

**Behaviour to know about:**

- **Forgot password** sends a reset link that returns to `pages/login.html?reset=1`.
- **Profile changes:** email changes go through `auth.updateUser` and are confirmed by link (trigger from `26_profile_management.sql` then syncs the profile row). Passwords are changed through the emailed reset link, so the old password keeps working until then.
- **Usernames** default to the first name (`maria`, then `maria2` if taken). Login always uses the email. Accounts created before the email-login change may still use a fake `@towerofdove.app` address. Change that email under **Authentication → Users** before expecting emails to arrive.
- **Guest checkout:** a guest can continue without an account or register during checkout. Guest bookings from the same device are claimed by the account after login (booking code and phone must match).

---

## Edge Functions

Both functions run on Supabase's servers and keep **Verify JWT on**. Supabase provides `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` to them automatically.

| Function | Purpose |
|---|---|
| `create-staff` | **Owner only.** Creates staff accounts, resets staff passwords, removes customer accounts. Uses the `service_role` key server-side so it never reaches the browser. |
| `send-receipt` | Sends booking and rental receipts, "payment verified" emails, "fully paid" balance / damage / late-fee receipts, replacement-item notices, and no-show reminder and forfeiture emails. |

### Deploy

**Dashboard:** Edge Functions → **Deploy a new function** → **Via Editor**, name it exactly (`create-staff` or `send-receipt`), paste the file's contents, keep **Verify JWT** on, then **Deploy**.

**CLI:**

```bash
supabase functions deploy create-staff --project-ref <your-project-ref>
supabase functions deploy send-receipt --project-ref <your-project-ref>
```

> After pulling a new version of the code, **redeploy** the functions. Several migrations (for example 35, 66, 68, 76, 79) change what `send-receipt` handles.

### Secrets for `send-receipt`

Add under **Edge Functions → Secrets**:

| Secret | Required | Notes |
|---|---|---|
| `SMTP_HOST` | Yes | For Gmail: `smtp.gmail.com` |
| `SMTP_PORT` | Yes | For Gmail: `465` |
| `SMTP_USER` | Yes | Your sending address |
| `SMTP_PASS` | Yes | For Gmail: an App Password |
| `CRON_SECRET` | For no-show emails | Any long random text; must match the value in `email_job_config` |
| `RECEIPT_FROM_EMAIL` | No | Defaults to `SMTP_USER` |
| `STUDIO_NAME` | No | Defaults to "Tower of Dove Music Studio" |
| `STUDIO_CONTACT_EMAIL` | No | Shown in emails |

### Email safety rules built into `send-receipt`

- The recipient is **never taken from the request**. It is the address saved with the booking or rental, or the signed-in account's email.
- Each receipt is sent **once** and only within 30 minutes of being created.
- Everything shown in an email is read from the database, not from the browser.
- Staff-only email kinds (verified, balance, damage, late fee, replacement) require an active staff login.
- Bookings created before `34_receipt_emails.sql` have no saved email, so no receipt is sent for them.

---

## Scheduled jobs (pg_cron)

| Job | Schedule | What it does | Set up by |
|---|---|---|---|
| `tod-start-sessions` | Every 30 seconds | `start_due_sessions()`: starts paid sessions at their start time, completes sessions at their end time (skipping any that still owe a balance), and runs the no-show release | `49_cron_auto_complete.sql` |
| `tod-expire-swap-offers` | Every minute | `expire_swap_offers()`: settles replacement offers at their deadline | `71_customer_swap_choice.sql` |
| `tod-no-show-emails` | Every 5 minutes | `send_no_show_emails()`: calls `send-receipt` (through `pg_net`) for reminders and forfeiture notices | `79_no_show_emails.sql` |

If `pg_cron` is unavailable on your plan, the admin dashboard also runs the session check about every 30 seconds while it is open, and the customer pages settle expired swap offers when they load.

### Finishing `79_no_show_emails.sql`

1. Run `79_no_show_emails.sql`.
2. Add the `CRON_SECRET` Edge Function secret (your own long random text).
3. Run the `insert into public.email_job_config …` statement from the bottom of that file, using your project URL, anon key and the same secret.
4. Deploy the current `send-receipt` function.

Until step 3 is done the email job does nothing.

---

## Storage buckets

| Bucket | Visibility | Used for | Created in |
|---|---|---|---|
| `studio-images` | Public | Studio photos | `03_security.sql` |
| `equipment-images` | Public | Equipment photos | `03_security.sql` |
| `rental-ids` | Private | Customer ID uploads for rentals | `03_security.sql` |
| `rental-photos` | Private | Before / after / handover / return inspection photos (staff upload; customers can view their own) | `46_equipment_condition_docs.sql` |
| `gcash-screenshots` | Private | GCash payment screenshots, stored under `<13-digit reference>/` (anyone can upload, only staff can view) | `38_gcash_screenshots.sql` |

Images are limited to JPEG / PNG / WebP (PDF also allowed for IDs) and 5 MB (10 MB for rental photos).

---

## What the website calls

| Screen / action | Call |
|---|---|
| Register | `auth.signUp({ email, password, options: { data: { kind: 'customer', first_name, last_name, username, number } } })`; a trigger creates the `customer` row |
| Log in | `auth.signInWithPassword({ email, password })`, then read `app_user` to see if the user is staff |
| Studios, equipment | `from('studio')`, `from('v_equipment_stock')` (readable without login) |
| Public settings (booking window, cutoff, hold length) | `rpc('get_public_settings')` |
| Calendar occupied times | `rpc('get_busy_slots', { p_studio_id, p_from, p_to, p_token })` |
| Hold / release a slot (2 min) | `rpc('hold_slot', …)`, `rpc('release_hold', { p_token })` |
| Hold rental equipment at checkout (2 min) | `rpc('hold_equipment', { p_items, p_start_at, p_end_at, p_token })`; request RPCs take `p_hold_token` |
| Book a studio (guest or customer) | `rpc('create_booking', …)` |
| My bookings | `from('v_booking_summary')` (customers see only their own) |
| Extend a session | `rpc('customer_request_extension', …)` (GCash) or `rpc('customer_extend_pay_later', …)`; staff verify in Payments or `rpc('staff_reject_extension', …)` |
| Reschedule / cancel | `rpc('hold_reschedule_slot', …)`, `rpc('reschedule_booking', …)`, `rpc('cancel_booking', …)` (24-hour rule) |
| Guest lookup | `rpc('lookup_booking', …)`, `rpc('lookup_rental', …)` (reference code **and** phone number) |
| Request a rental | `rpc('request_rental' / 'request_addon_rental' / 'request_outside_rental', …)`; upload the ID photo to `rental-ids` first |
| Onsite booking / rental | `rpc('staff_create_onsite_booking', …)`, `rpc('staff_create_onsite_rental', …)` |
| Verify / reject payment | `update payment set status = 'Verified' \| 'Rejected'` (the booking updates itself) |
| Collect balance | `rpc('staff_collect_balance', …)` |
| Check in a customer | `rpc('staff_check_in', …)`, `rpc('staff_undo_check_in', …)` (Owner, note required) |
| Approve / reject / issue rental | `update rental_order set status = …` (rejecting needs a reason; stock is checked) |
| Return equipment | `rpc('staff_return_rental_with_fees', …)` (condition, late fee, damage fee in one step) |
| Damage fees | `rpc('staff_collect_damage' / 'staff_reject_damage_payment' / 'staff_update_damage_charge', …)`; customers use `rpc('customer_pay_damage', …)`; read `v_damage_charge` |
| Replacement items | `rpc('staff_swap_rental_item', …)`, `rpc('staff_create_swap_offer', …)`, `rpc('customer_choose_swap', …)` |
| Dashboard and reports | `v_dashboard_counts`, `v_booking_summary`, `v_rental_lines`, `v_payment_queue`, `v_customer_spending`, `v_revenue_daily` |

---

## Rules the database enforces

- **No double booking:** an exclusion constraint on studio + time range (Pending, Approved and In Progress bookings count).
- **Opening hours:** 10:00 to 22:00 Asia/Manila, whole hours. There is no maximum booking length (removed in `70`).
- **Booking window:** online bookings and outside rentals cannot start more than **28 days** ahead. Staff and onsite records are not limited.
- **Change / cancel cutoff:** customers can change or cancel up to **24 hours** before the session. Staff may override.
- **Slot hold length:** **2 minutes**.
- **Rule settings:** the three values above live in `app_setting` (`booking_window_days`, `change_cutoff_hours`, `slot_hold_minutes`) and the website reads them through `get_public_settings()`, so the site and the database cannot disagree (`94`).
- **Phone numbers:** online guest bookings and outside-rental contact numbers must be a real 11-digit Philippine mobile number (`09` + 9 digits). Staff and onsite records use a lenient check.
- **Stock:** equipment cannot be approved, issued or requested beyond the units free for the hours needed; Pending requests and checkout holds count.
- **Payments:** 50% down payment or 100% full payment; any balance must be collected (cash with change, or GCash reference) before a session starts, gear is issued, or an extended session completes.
- **No-shows:** a confirmed booking with an unpaid balance is released after the grace period (`app_setting` key `no_show_grace_minutes`, default 15 minutes). A checked-in customer is never a no-show. Payments already made are not refunded.
- **Unpaid fees:** an unpaid damage or late fee blocks new bookings and rentals (matched by account and phone number). Only the Owner can waive, defer or lift a block, with a logged reason.
- **Data access:** customers see only their own bookings, rentals and payments. Guests can only use specific RPCs. GCash screenshots and inspection photos are staff-readable.
- **Roles:** staff cannot edit studios, equipment or staff accounts. Only the Owner can.

---

## Testing

`tests/qa_tests.sql` checks double-booking, 50% / full payment maths, cancelling after payment (no refund), staff extension cost, the no-show release, and who can read whose data.

1. Paste the whole file into the **SQL Editor** and run it.
2. Everything is rolled back, so no data is changed.
3. The result appears as a **"QA RESULTS"** error box. That is expected: the error is how the results are reported.

Re-run it after applying new migrations.

---

## Updating an existing database

1. Find the newest numbered file you have already applied.
2. Run each later file in numeric order. They are safe to re-run, so running one twice does no harm.
3. Redeploy the Edge Functions if the release notes (or the migration's header comment) say so.
4. Re-run `tests/qa_tests.sql`.

Each migration's header comment explains what it changes, which file it must follow, and whether an Edge Function needs redeploying.

---

## Security checklist

- **Never** put the `service_role` key in frontend code. Only the Edge Functions use it.
- The anon key in `js/config/supabaseClient.js` is public by design; Row Level Security and the RPC checks protect the data.
- Guest lookups require the **reference code and the phone number** used for the booking (`94`).
- `hold_slot` is throttled per caller IP and per studio (`94`). For heavier abuse protection, add a per-IP Edge Function with an external counter in front of Supabase.
- Reference numbers are random but can skip values when a booking attempt fails.
- Keep SMTP credentials and `CRON_SECRET` in Edge Function **Secrets**, never in the repo.
- Make sure Redirect URLs contain only domains you control.