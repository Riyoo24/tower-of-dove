# Tower of Dove — Supabase Setup Summary

This document describes the complete Supabase backend for the Tower of Dove Music Studio booking and rental system. It covers the database schema, functions, security policies, storage, Edge Functions, authentication, migration history, and deployment instructions for both fresh installations and existing databases.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Database Tables and Relationships](#2-database-tables-and-relationships)
3. [SQL Functions and RPCs](#3-sql-functions-and-rpcs)
4. [Database Views](#4-database-views)
5. [Triggers](#5-triggers)
6. [Row Level Security (RLS) Policies](#6-row-level-security-rls-policies)
7. [Storage Buckets](#7-storage-buckets)
8. [Edge Functions](#8-edge-functions)
9. [Authentication Configuration](#9-authentication-configuration)
10. [Migration History](#10-migration-history)
11. [Setup Order — Fresh Installation](#11-setup-order--fresh-installation)
12. [Migrating an Existing Database](#12-migrating-an-existing-database)
13. [Deployment Instructions](#13-deployment-instructions)

---

## 1. Project Overview

Tower of Dove is a studio management web app with:

- **Customer-facing pages** — landing page, studio booking, equipment rental (add-on and outside).
- **Staff/Owner dashboard** — bookings, rentals, payments, equipment management, studio management, customer management, reporting.

The backend runs entirely on **Supabase** (PostgreSQL + Auth + Storage + Edge Functions). Business timezone: `Asia/Manila`. Studio hours: 10:00–22:00.

**User kinds:**

| Kind | Table | Auth |
|------|-------|------|
| Owner | `app_user` (role = `Owner`) | Supabase Auth email/password |
| Staff | `app_user` (role = `Staff`) | Supabase Auth email/password, created via Edge Function |
| Registered customer | `customer` | Supabase Auth email/password, self-registered |
| Guest customer | `customer` (no `auth_user_id`) | No login; looked up by booking/rental ref + phone number |

---

## 2. Database Tables and Relationships

### Schema overview

```
app_user ──────────────────────────────────────────────── (approves/creates)
    │                                                           │
customer ──── booking ──── rental_order ──── rental_detail ────┘
                │               │
              payment         payment
```

All tables live in the `public` schema. The `extensions` schema holds `btree_gist` (required for the booking overlap exclusion constraint).

---

### `app_user` — Staff and Owner accounts

| Column | Type | Notes |
|--------|------|-------|
| `user_id` | `bigint` PK | Auto-generated |
| `auth_user_id` | `uuid` | FK → `auth.users.id`, unique |
| `first_name` | `varchar(100)` | |
| `last_name` | `varchar(100)` | |
| `username` | `varchar(50)` | Lowercase alphanumeric + `_.`, 3–30 chars; unique (case-insensitive) |
| `number` | `varchar(20)` | Optional phone |
| `email` | `varchar(255)` | Optional real contact email |
| `role` | `varchar(20)` | `Owner` or `Staff` |
| `status` | `varchar(20)` | `Active` or `Inactive` |
| `created_at` / `updated_at` | `timestamptz` | Auto-set/updated |

---

### `customer` — Registered and guest customers

| Column | Type | Notes |
|--------|------|-------|
| `customer_id` | `bigint` PK | |
| `auth_user_id` | `uuid` | FK → `auth.users.id`; NULL for guests |
| `first_name` | `varchar(100)` | |
| `last_name` | `varchar(100)` | Default `''` |
| `username` | `varchar(50)` | NULL for guests |
| `number` | `varchar(20)` | Optional; digits/spaces/`+()-` only |
| `email` | `varchar(255)` | Optional real contact email |
| `status` | `varchar(20)` | `Active` or `Inactive` |

Guests (`auth_user_id IS NULL`) cannot have a username (enforced by `customer_guest_chk`).

---

### `studio` — Recording studios

| Column | Type | Notes |
|--------|------|-------|
| `studio_id` | `bigint` PK | |
| `name` | `varchar(100)` | Unique (case-insensitive) |
| `image` | `text` | URL (Storage or external) |
| `description` | `text` | |
| `hourly_rate` | `numeric(10,2)` | ≥ 0 |
| `status` | `varchar(20)` | `Available`, `Unavailable`, or `Maintenance` |

> **Note:** `capacity` was removed in migration 19. Studios do not track headcount.

---

### `equipment_category` — Equipment groupings

| Column | Type | Notes |
|--------|------|-------|
| `category_id` | `bigint` PK | |
| `category_name` | `varchar(100)` | Unique |

Default categories: `Guitars`, `Amplifiers`, `Drums`, `Keyboards`, `Effects`, `Accessories`, `Other`.

All drum equipment (drum sets, add-on packs) belongs to the single `Drums` category. Model names and cymbal configurations are stored in the equipment's `name` and `description` fields.

---

### `equipment` — Rentable items

| Column | Type | Notes |
|--------|------|-------|
| `equipment_id` | `bigint` PK | |
| `name` | `varchar(150)` | Unique (case-insensitive) |
| `image` | `text` | URL |
| `category_id` | `bigint` | FK → `equipment_category` |
| `description` | `text` | Model, configuration, notes. Use for drum kit details. |
| `total_quantity` | `integer` | ≥ 0 |
| `add_on_rate` | `numeric(10,2)` | Per session; required when `allow_addon = true` |
| `outside_rate` | `numeric(10,2)` | Per day (base 8 h); required when `allow_outside = true` |
| `allow_addon` | `boolean` | Can be rented as a booking add-on |
| `allow_outside` | `boolean` | Can be rented as a standalone outside rental |
| `min_hours` | `integer` | Minimum outside rental length (hours) |
| `status` | `varchar(20)` | `Available` or `Unavailable` |

> **Note:** `is_drum_set`, `drum_kit`, and `is_vip` were removed in migration 19. Use `name` and `description` to record drum models and configurations (e.g. `"RDX drum set. 1 crash, 1 ride, hi-hat."`).

**Pricing rules:**
- Add-on rate: flat fee per booking session.
- Outside rate: per 8-hour block. Each extra hour beyond 8 adds one-eighth of the daily rate. Late returns are charged at the same one-eighth per hour.

---

### `booking` — Studio session bookings

| Column | Type | Notes |
|--------|------|-------|
| `booking_id` | `bigint` PK | |
| `booking_ref` | `varchar(30)` | Auto: `TOD-1000`, `TOD-1001`, … |
| `customer_id` | `bigint` | FK → `customer` |
| `studio_id` | `bigint` | FK → `studio` |
| `start_at` / `end_at` | `timestamptz` | Scheduled times |
| `actual_start_at` / `actual_end_at` | `timestamptz` | Actual times (set on In Progress / Completed) |
| `original_start_at` / `original_end_at` | `timestamptz` | Preserved on reschedule |
| `reschedule_count` | `integer` | |
| `hourly_rate_at_booking` | `numeric(10,2)` | Rate snapshot from `studio.hourly_rate` |
| `status` | `varchar(20)` | `Pending`, `Approved`, `In Progress`, `Completed`, `Rejected`, `Cancelled` |
| `source` | `varchar(10)` | `Online` or `Onsite` |
| `approved_by` | `bigint` | FK → `app_user` |
| `created_by` | `bigint` | FK → `app_user` (for onsite bookings) |
| `cancelled_reason` / `rejected_reason` | `text` | |

**Double-booking prevention:** A GiST exclusion constraint on `(studio_id, tstzrange(start_at, end_at, '[)'))` prevents overlapping bookings with status `Pending`, `Approved`, or `In Progress`.

**Status flow:**
```
Pending → Approved → In Progress → Completed
        ↘ Rejected
Pending/Approved → Cancelled
```

---

### `rental_order` — Equipment rental orders

| Column | Type | Notes |
|--------|------|-------|
| `rental_order_id` | `bigint` PK | |
| `rental_ref` | `varchar(30)` | Auto: `RA-0001` (add-on), `OUT-2000` (outside) |
| `customer_id` | `bigint` | FK → `customer` |
| `rental_type` | `varchar(20)` | `Add-on` (tied to a booking) or `Outside` (standalone) |
| `booking_id` | `bigint` | FK → `booking`; required for `Add-on`, NULL for `Outside` |
| `status` | `varchar(20)` | `Pending`, `Approved`, `Rejected`, `Active`, `Returned`, `Cancelled` |
| `source` | `varchar(10)` | `Online` or `Onsite` |
| `pickup_date` / `return_date` | `timestamptz` | Required for Outside rentals |
| `contact_number` / `backup_contact` | `varchar(20)` | |
| `id_type` / `id_image_path` | `text` | Required for online outside rentals |
| `issued_at` / `returned_at` | `timestamptz` | Set when status → Active / Returned |
| `approved_by` / `created_by` | `bigint` | FK → `app_user` |

---

### `rental_detail` — Line items per rental order

| Column | Type | Notes |
|--------|------|-------|
| `rental_detail_id` | `bigint` PK | |
| `rental_order_id` | `bigint` | FK → `rental_order` (cascade delete) |
| `equipment_id` | `bigint` | FK → `equipment` |
| `quantity` | `integer` | > 0 |
| `unit_price_at_request` | `numeric(10,2)` | Rate snapshot |
| `rental_hours` | `numeric(6,2)` | Actual hours out (for outside pricing) |
| `returned_at` | `timestamptz` | NULL until this line is returned |

Unique on `(rental_order_id, equipment_id)`.

---

### `payment` — GCash or Cash payment records

| Column | Type | Notes |
|--------|------|-------|
| `payment_id` | `bigint` PK | |
| `booking_id` | `bigint` | FK → `booking` (exclusive-or with `rental_order_id`) |
| `rental_order_id` | `bigint` | FK → `rental_order` |
| `method` | `varchar(10)` | `GCash` or `Cash` |
| `gcash_reference` | `varchar(40)` | Required when method = `GCash`; unique among non-rejected payments |
| `amount` | `numeric(10,2)` | ≥ 0 |
| `status` | `varchar(10)` | `Pending`, `Verified`, `Rejected` |
| `verified_by` / `verified_at` | FK / timestamptz | Auto-set on verification |

Exactly one of `booking_id` / `rental_order_id` must be non-null. Verifying a pending booking payment automatically moves the booking to `Approved`.

---

### `slot_hold` — Temporary slot locks during checkout

| Column | Type | Notes |
|--------|------|-------|
| `hold_id` | `bigint` PK | |
| `studio_id` | `bigint` | FK → `studio` |
| `start_at` / `end_at` | `timestamptz` | Held range |
| `token` | `text` | Browser session token |
| `expires_at` | `timestamptz` | Holds expire automatically |

Managed only through `hold_slot()` and `release_hold()` RPCs.

---

### Sequences

| Sequence | Range | Used for |
|----------|-------|---------|
| `booking_ref_seq` | starts 1000 | `TOD-1000`, `TOD-1001`, … |
| `rental_out_seq` | starts 2000 | `OUT-2000`, `OUT-2001`, … |
| `rental_addon_seq` | starts 1 | `RA-0001`, `RA-0002`, … |

---

## 3. SQL Functions and RPCs

All functions use `security definer` and `set search_path = public` to run with controlled privileges.

### Helper functions (internal)

| Function | Returns | Purpose |
|----------|---------|---------|
| `is_staff()` | `boolean` | True if the caller has an active `app_user` row |
| `is_owner()` | `boolean` | True if the caller is an active Owner |
| `current_app_user_id()` | `bigint` | `user_id` for the logged-in staff member |
| `current_customer_id()` | `bigint` | `customer_id` for the logged-in customer |
| `digits(text)` | `text` | Strip non-digits (for phone number comparison) |
| `equipment_in_use(equipment_id, exclude_order?)` | `integer` | Quantity of an item currently out (Approved + Active, not returned) |
| `rental_order_total(order_id)` | `numeric` | Order total: add-ons × unit price; outside items × unit price × days |
| `booking_total(booking_id)` | `numeric` | `hourly_rate_at_booking × session_hours` |

> **`rental_order_total` note:** Outside items are priced per day (rounded up from `rental_hours`, defaulting to 24 h). There is no longer a special drum-set pricing path — all equipment is priced the same way.

### Customer-facing RPCs

| Function | Purpose |
|----------|---------|
| `validate_slot(start, end, allow_current_hour?)` | Checks opening hours, minimum 1 h, not in the past |
| `resolve_customer(first, last, number, force_guest?)` | Finds or creates a guest customer by name + phone |
| `slot_held_by_other(studio_id, start, end, token)` | True if another session holds this slot |
| `get_busy_slots(studio_id, from, to, token?)` | Returns booked + held ranges for the calendar |
| `hold_slot(studio_id, start, end, token)` | Creates/refreshes a 10-minute slot hold |
| `release_hold(token)` | Removes all holds for a browser token |
| `insert_booking_with_payment(…)` | Atomically creates a booking + payment (online flow) |
| `create_booking(…)` | Staff: creates a booking (cash or GCash) |
| `reschedule_booking(ref, start, end)` | Customer: reschedule a Pending/Approved booking |
| `cancel_booking(ref, reason?)` | Customer: cancel own booking |
| `lookup_booking(ref, phone?)` | Guest/customer booking status lookup |
| `lookup_rental(ref, phone?)` | Guest/customer rental status lookup |
| `request_rental(…)` | Customer/guest: submit an outside rental request |
| `assert_order_stock(order_id)` | Internal: raise exception if stock is insufficient |
| `staff_create_onsite_booking(…)` | Staff: create an onsite booking with optional payment |
| `staff_create_onsite_rental(…)` | Staff: create an onsite rental order |
| `staff_return_rental(ref, equipment_id?)` | Staff: mark a rental (or one item) as returned |

---

## 4. Database Views

All views use `security_invoker = true`, so RLS applies to the calling user.

| View | Purpose |
|------|---------|
| `v_booking_summary` | Bookings joined with customer name, studio name, approver name, computed total |
| `v_equipment_stock` | Equipment joined with category, in-use count, available count, stock status label |
| `v_rental_lines` | Rental orders joined with detail lines and equipment names |
| `v_payment_queue` | Pending payments with linked booking/rental details |
| `v_customer_spending` | Per-customer total spend (bookings + rentals) |
| `v_revenue_daily` | Daily revenue breakdown by source |
| `v_dashboard_counts` | Snapshot counts for the dashboard widgets |

### `v_equipment_stock` columns

```
equipment_id, name, image, description, category_name,
total_quantity, in_use, available, stock_status,
add_on_rate, outside_rate, allow_addon, allow_outside, min_hours
```

`stock_status` values: `Available`, `Low` (only 1 left of 2+), `In Use` (none available), `Unavailable` (status = Unavailable).

---

## 5. Triggers

| Trigger | Table | Timing | Purpose |
|---------|-------|--------|---------|
| `trg_touch` | all major tables | BEFORE UPDATE | Sets `updated_at = now()` |
| `trg_protect` | `customer` | BEFORE UPDATE | Prevents customers from changing their own `status` or `auth_user_id` |
| `trg_protect` | `app_user` | BEFORE UPDATE | Prevents non-owners from changing `role`, `status`, `auth_user_id`, `username` |
| `trg_booking_write` | `booking` | BEFORE INSERT/UPDATE | Snapshots hourly rate, sets `original_*` times, validates status transitions, sets `actual_start_at` / `actual_end_at`, auto-sets `approved_by` |
| `trg_payment_stamp` | `payment` | BEFORE UPDATE | Sets `verified_by` / `verified_at` on verification |
| `trg_payment_effects` | `payment` | AFTER UPDATE | Approves (or rejects) the linked booking when the payment is verified (or rejected) |
| `trg_rental_write` | `rental_order` | BEFORE INSERT/UPDATE | Generates `rental_ref`, sets `issued_at` / `returned_at`, validates transitions, auto-sets `approved_by` |
| `trg_rental_returned` | `rental_order` | AFTER UPDATE | Sets `returned_at` on all unreturned `rental_detail` rows when order status → Returned |
| `trg_detail_stock` | `rental_detail` | AFTER INSERT/UPDATE | Checks stock when a line is added/changed on an active order |
| `trg_order_stock` | `rental_order` | AFTER UPDATE | Checks stock when an order is moved to Approved or Active |
| `on_auth_user_created` | `auth.users` | AFTER INSERT | Creates a `customer` row for new sign-ups with `kind = 'customer'` in metadata |

---

## 6. Row Level Security (RLS) Policies

RLS is enabled on all tables. The service role key (used by Edge Functions and the Supabase dashboard) bypasses RLS.

### `app_user`

| Policy | Operation | Who |
|--------|-----------|-----|
| `app_user_select` | SELECT | Any authenticated user (staff see all; customers see only themselves) |
| `app_user_update_self` | UPDATE | Own row only (trigger blocks role/status/username changes by non-owners) |
| `app_user_owner_insert` | INSERT | Owner only |
| `app_user_owner_delete` | DELETE | Owner only |

### `customer`

| Policy | Operation | Who |
|--------|-----------|-----|
| `customer_select` | SELECT | Staff (all) or own row |
| `customer_update` | UPDATE | Staff or own row |
| `customer_staff_insert` | INSERT | Staff only |
| `customer_owner_delete` | DELETE | Owner only |

### `studio` / `equipment_category` / `equipment`

| Policy | Operation | Who |
|--------|-----------|-----|
| `*_read` | SELECT | Anyone (anon + authenticated) |
| `*_write` | ALL (insert/update/delete) | Owner only |

### `booking`

| Policy | Operation | Who |
|--------|-----------|-----|
| `booking_select` | SELECT | Staff (all) or own bookings |
| `booking_staff_insert` | INSERT | Staff only |
| `booking_staff_update` | UPDATE | Staff only |
| `booking_owner_delete` | DELETE | Owner only |

### `rental_order` / `rental_detail`

Similar to bookings: staff insert/update, owner delete, customers see own rows.

### `payment`

| Policy | Operation | Who |
|--------|-----------|-----|
| `payment_select` | SELECT | Staff (all) or own payment |
| `payment_customer_insert` | INSERT | Customers (own bookings/rentals) or staff |
| `payment_staff_update` | UPDATE | Staff only |
| `payment_owner_delete` | DELETE | Owner only |

---

## 7. Storage Buckets

| Bucket | Public | Size limit | Allowed types | Purpose |
|--------|--------|-----------|---------------|---------|
| `studio-images` | ✅ Yes | 5 MB | JPEG, PNG, WebP | Studio photos shown to all visitors |
| `equipment-images` | ✅ Yes | 5 MB | JPEG, PNG, WebP | Equipment photos shown to all visitors |
| `rental-ids` | ❌ Private | 5 MB | JPEG, PNG, WebP, PDF | Customer ID photos for outside rentals |

### Storage policies

| Policy | Bucket(s) | Operation | Who |
|--------|-----------|-----------|-----|
| `tod_public_images_read` | studio-images, equipment-images | SELECT | Anyone |
| `tod_owner_images_write` | studio-images, equipment-images | ALL | Owner only |
| `tod_ids_upload` | rental-ids | INSERT | Anyone (anon + authenticated) |
| `tod_ids_staff_read` | rental-ids | SELECT | Staff only |

**ID upload path:** `<random-uuid>/<filename>`. Pass the resulting path as `p_id_image_path` in `request_rental(…)`.

---

## 8. Edge Functions

### `create-staff`

**Location:** `supabase/functions/create-staff/index.ts`

**Purpose:** Lets the owner manage staff accounts from the dashboard without exposing the `service_role` key to the browser.

**Endpoint:** `POST /functions/v1/create-staff`

**Authentication:** Caller must be authenticated as an active Owner (verified server-side).

**Actions:**

| `action` | Required fields | What it does |
|----------|----------------|--------------|
| `create` | `first_name`, `last_name`, `email`, `password`, `number?` | Creates a Supabase Auth user + `app_user` row with `role = Staff` |
| `reset_password` | `user_id`, `password` | Resets a staff member's password |
| `delete_customer` | `customer_id` | Deletes a customer's Auth account (and cascade-nulls the `customer` row) |

The function uses `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` from Supabase's built-in environment — no manual secrets needed.

**Deploy:**
```bash
supabase functions deploy create-staff
```

---

## 9. Authentication Configuration

Tower of Dove uses **Supabase Auth with email/password** for all user types.

### Sign-up flow (customers)

Customers self-register via the website. The sign-up call includes metadata:

```js
supabase.auth.signUp({
  email: 'login@example.com',   // used only for login; not shown publicly
  password: '…',
  options: {
    data: {
      kind: 'customer',
      first_name: '…',
      last_name: '…',
      username: '…',          // the public handle
      number: '09…',
      contact_email: '…'      // optional real contact email
    }
  }
})
```

The `on_auth_user_created` trigger fires and inserts a `customer` row. Only `kind = 'customer'` in metadata creates a customer row — signing up cannot create staff.

### Staff sign-up

Staff are created server-side via the `create-staff` Edge Function (owner-only). The function:
1. Calls `auth.admin.createUser` with the service role key.
2. Inserts the `app_user` row with `role = Staff`.

### Email verification

Enable **email confirmation** in Supabase dashboard → Authentication → Providers → Email. Customers must verify their email before logging in. The first owner account should be created with "Auto Confirm User" checked, then email confirmation turned on for all subsequent sign-ups.

### Password recovery

Use Supabase's built-in **"Send password reset"** flow (dashboard or `auth.resetPasswordForEmail`). For staff, the owner can also use the `reset_password` action in the `create-staff` Edge Function.

### JWT and session

The website uses the **Supabase JS client** (`supabase-js`). The anon key is safe to include in the frontend — RLS enforces access control server-side. Never expose the `service_role` key in the browser.

---

## 10. Migration History

Each file is idempotent (`create or replace`, `if not exists`, `on conflict do nothing`).

| File | What it adds or changes |
|------|------------------------|
| `01_schema.sql` | Core tables, constraints, sequences, helper functions, triggers |
| `02_functions.sql` | RPC functions, reporting views |
| `03_security.sql` | Grants, RLS policies, storage buckets |
| `04_seed.sql` | Initial studios, equipment categories, equipment |
| `05_booking_addons.sql` | Equipment add-on columns for booking flow |
| `06_lookup_addons.sql` | Guest lookup RPC enhancements |
| `07_auto_approve_addons.sql` | Auto-approval for add-on rentals on booking approval |
| `08_outside_rental.sql` | Outside rental RPC and flow |
| `09_random_refs.sql` | Randomised reference numbers (replaces sequential) |
| `10_guest_lookup_privacy.sql` | Privacy: phone-number verification for guest lookups |
| `11_cash_autostart_addons.sql` | Cash bookings auto-start add-on rentals |
| `12_rental_base_hours_autostatus.sql` | `rental_hours` defaults, auto-status from base hours |
| `13_overdue_hours_addon_return.sql` | Overdue hour tracking for add-on returns |
| `14_email_login_names_id_view.sql` | View joining login email to customer/staff names |
| `15_extend_booking.sql` | Booking extension RPC |
| `16_extension_slot_hold.sql` | Slot hold support for booking extensions |
| `17_customer_extend.sql` | Customer-facing booking extension |
| `18_booking_reject_reason.sql` | `rejected_reason` column on `booking` |
| `21_fix_rental_total_8h.sql` | Restores 8-hour billing in `rental_order_total` (undoes the per-24-hour version from migration 19) |
| `20_booking_down_payment.sql` | **50% down payment for online studio bookings:** `booking.down_payment` column; the booking payment is the down payment (the balance is paid at the studio); extensions and later add-ons join the balance; `v_booking_summary` and `lookup_booking` return the down payment; `v_revenue_daily` counts the balance when the session starts. Older and walk-in bookings are unchanged (`down_payment = 0`) |
| `19_remove_drum_vip_capacity.sql` | **Schema simplification:** removes `is_drum_set`, `drum_kit`, `is_vip` from `equipment`; removes `capacity` from `studio`; consolidates drum categories into `Drums`; migrates drum model info to `description`; updates `rental_order_total` |

---

## 11. Setup Order — Fresh Installation

Run the following in the **Supabase SQL Editor** in this exact order:

```
01_schema.sql
02_functions.sql
03_security.sql
04_seed.sql
05_booking_addons.sql
06_lookup_addons.sql
07_auto_approve_addons.sql
08_outside_rental.sql
09_random_refs.sql
10_guest_lookup_privacy.sql
11_cash_autostart_addons.sql
12_rental_base_hours_autostatus.sql
13_overdue_hours_addon_return.sql
14_email_login_names_id_view.sql
15_extend_booking.sql
16_extension_slot_hold.sql
17_customer_extend.sql
18_booking_reject_reason.sql
20_booking_down_payment.sql
21_fix_rental_total_8h.sql
```

> **Note:** `19_remove_drum_vip_capacity.sql` applies only to existing databases. For fresh installations, `01_schema.sql` and `04_seed.sql` already include the updated schema — do not run migration 19 on a fresh install.

Alternatively, run `all_in_one.sql` which contains all of the above joined in order (except migration 19).

### After the SQL files — create the first Owner

1. Supabase dashboard → **Authentication → Users → Add user**.
   - Email: `towerofdovemusic@gmail.com` (the owner's login).
   - Password: choose one.
   - ✅ Tick **Auto Confirm User**.
2. Then run in SQL Editor:

```sql
insert into public.app_user (auth_user_id, first_name, last_name, username, email, role)
select id, 'Studio', 'Owner', 'towerofdovemusic@gmail.com', 'towerofdovemusic@gmail.com', 'Owner'
from auth.users where email = 'towerofdovemusic@gmail.com';
```

### Deploy the Edge Function

```bash
# Install Supabase CLI if needed: https://supabase.com/docs/guides/cli
supabase login
supabase link --project-ref <your-project-ref>
supabase functions deploy create-staff
```

### Configure Authentication

1. Dashboard → **Authentication → Providers → Email**:
   - ✅ Enable Email provider.
   - ✅ Enable **Confirm email** (so customers must verify before logging in).
   - Set **Site URL** to your production domain.
   - Set **Redirect URLs** to your production and local dev domains.
2. (Optional) Customise the confirmation and password-reset email templates under **Authentication → Email Templates**.

### Configure Storage

Storage buckets are created by `03_security.sql`. Verify in dashboard → **Storage**:
- `studio-images` — public
- `equipment-images` — public
- `rental-ids` — private

### Environment variables (frontend)

Create a `.env` file (or configure your hosting environment):

```
SUPABASE_URL=https://<your-project-ref>.supabase.co
SUPABASE_ANON_KEY=<your-anon-key>
```

Both values are safe for the browser. Find them in: dashboard → **Project Settings → API**.

---

## 12. Migrating an Existing Database

If your database is already running schema files `01` through `18`, run only the migration file:

```
19_remove_drum_vip_capacity.sql
```

Run it in the Supabase SQL Editor. The migration:

1. **Ensures** a single `Drums` category exists.
2. **Reassigns** any equipment from other drum-named categories (e.g. `Drum Sets`, `Drum kits`) to `Drums`.
3. **Migrates** drum model information from the old `drum_kit` and `is_vip` columns into the `description` field before dropping the columns.
4. **Deletes** now-empty duplicate drum categories.
5. **Drops** `is_drum_set`, `drum_kit`, and `is_vip` from `equipment`.
6. **Drops** `capacity` from `studio`.
7. **Refreshes** the `v_equipment_stock` view (removes the old columns).
8. **Updates** `rental_order_total` to remove the `is_drum_set` pricing branch.

**The migration is safe:**
- Existing equipment, drum set records, bookings, rentals, and rental history are fully preserved.
- Drum model information is migrated into `description` before columns are dropped.
- All `DROP COLUMN` and `DROP CONSTRAINT` statements use `IF EXISTS` so they are safe to re-run.

**After migration**, also deploy the updated frontend JavaScript (the JS files in `js/` no longer reference `is_drum_set`, `drum_kit`, or `is_vip`).

---

## 13. Deployment Instructions

### Hosting

The frontend is a static site (HTML + JS + CSS) with no build step. Deploy to any static host:

- **Netlify / Vercel:** connect the repository and set the publish directory to the project root.
- **Supabase Storage:** not recommended for the frontend (no custom domain without a CDN).
- **GitHub Pages:** set Pages source to the repository root or a `docs/` folder.

### Environment configuration

The Supabase URL and anon key are referenced in `js/shared/supabase.js` (or equivalent). Update them to your project's values. They are safe to hard-code in a public repository because RLS enforces all access control server-side.

### Supabase project settings checklist

| Setting | Value |
|---------|-------|
| Authentication → Email → Confirm email | ✅ Enabled |
| Authentication → Site URL | Production domain |
| Authentication → Redirect URLs | Production + dev domains |
| Storage → `studio-images` | Public |
| Storage → `equipment-images` | Public |
| Storage → `rental-ids` | Private |
| Edge Function → `create-staff` | Deployed |
| Database → Extensions → `btree_gist` | Enabled (in `extensions` schema) |

### Updating the schema

For any future schema changes:
1. Write a new numbered file, e.g. `20_my_change.sql`, that is safe to re-run.
2. Run it in the SQL Editor on production.
3. Update `all_in_one.sql` to include it at the end.
4. Deploy the updated frontend if any JS references changed.


---

## Addendum: Session extension payments (`23_extension_payment.sql`)

**What it does.** A customer extending a Confirmed/Active booking from *My bookings > Extend* now follows the booking workflow: 50% GCash down payment + 13-digit reference, status Pending, verified or rejected by staff/owner in the Payments tab. The extra hours are reserved while pending. On verification the booking's `end_at` moves (so the studio total rises by the extension cost) and the extension down payment is added to `booking.down_payment` (balance at the studio = total - down payment).

| Object | Notes |
|---|---|
| table `booking_extension` | one row per request: hours, rate, cost, 50% down payment, old/new end, status `Pending/Approved/Rejected`, reason, hold token. One Pending per booking. RLS: customer reads own, staff read all, no direct writes |
| `payment.extension_id` | new column; `payment_target_chk` now allows exactly one of booking / rental / extension. Unique per non-rejected extension |
| `customer_request_extension(ref, hours, token, gcash)` | validates availability, creates the request + Pending GCash payment + a reservation (`slot_hold` until the new end time) |
| `apply_booking_extension(id)` | called by the payment trigger on Verify: moves `end_at`, adds the down payment (older fully-paid bookings count what they already paid), releases the reservation |
| `payment_effects()` | extended: Verified -> apply extension, Rejected -> close the request and release the hours |
| `staff_reject_extension(id, reason)` | staff reject with a reason the customer sees |
| `staff_extension_info` | now blocks a second request while one is Pending |
| `staff_extend_booking` | staff only again (staff's own Extend, paid at the studio, is unchanged) |
| `reschedule_booking` / `cancel_booking` | reschedule blocked while pending; cancelling closes the pending request |
| views | new `v_booking_extension`; `v_payment_queue` (kind `Extension`, new column `extension_id`), `v_customer_spending` and `v_revenue_daily` now include extension payments |

## GCash screenshot (file 38)
Run `supabase/38_gcash_screenshots.sql` once. It creates the private bucket `gcash-screenshots` (JPG/PNG/WEBP, 5 MB) with an upload policy for customers and guests and a view policy for staff. No other Supabase change is needed.


## 39 - Add-ons are issued and returned with their session

Run `supabase/39_addon_auto_issue_return.sql` once in the SQL Editor. When a studio session starts, its add-on equipment (also equipment added later from the Rent equipment page, once staff verified its payment) becomes In Use. When the session is marked completed, the add-on becomes Returned and goes back to stock. The dashboard re-checks every 30 seconds, so a missed add-on is caught up. An add-on whose payment was never verified, on a booking that is over, is Cancelled.


## 40 - Later add-ons paid 50%: balance collected at the studio

Run `supabase/40_addon_balance_collection.sql` once (after file 39). Add-on equipment added later and paid with a 50% down payment stays a down payment (not fully paid) until staff collect the remaining half at the studio. It is not issued (In Use) before that, also when the session is already running. Staff use **Collect balance & issue** in the Rentals tab; starting the studio session collects it together with the booking balance. Each payment then becomes fully paid.


## 41 - Sessions complete by themselves

Run `supabase/41_auto_complete_sessions.sql` once (after file 40). A studio session that reaches its end time becomes Completed by itself (checked every 30 seconds while the admin / staff page is open); its add-on equipment is returned. A session with an extension request waiting for verification is not completed until staff verify or reject it. The Studio Sessions sidebar badge now appears 5 minutes before a session ends.


## 42 - Receipt email for onsite bookings and rentals

Run `supabase/42_onsite_receipt_email.sql` once (after file 41). The Onsite booking and Onsite rental forms have an optional **Email for the receipt** box. When it is filled, the address is saved on the onsite booking / rental and the customer gets the same "verified" email staff already send after verifying a payment (it uses the existing `send-receipt` Edge Function and its SMTP secrets, so nothing needs to be redeployed). An onsite add-on with no typed address uses the address saved with its onsite booking.


## 43 - Onsite outside rental: 50% down payment for a later day

Run `supabase/43_onsite_outside_down_payment.sql` once (after file 42). In the Onsite rental form, an **Outside** rental with a pick-up date after today shows a **Payment option** (full payment or 50% down payment). With 50%, the rental shows **Balance** in the Rentals tab and is issued only after staff press **Collect balance & issue** and collect the rest at pick-up. Today's rentals and onsite add-ons stay full payment.


## 44 - Onsite booking: 50% down payment for a later day

Run `supabase/44_onsite_booking_down_payment.sql` once (after file 43). In the Onsite booking form, a date after today shows a **Payment option** (full payment or 50% down payment). With 50% the booking shows **Balance** in the Bookings tab and its button reads **Collect balance & start**; staff collect the rest at the studio before the session. A booking for today stays full payment.

## 45. Add-on balance shown on its booking

Run `supabase/45_addon_balance_on_booking.sql` once (after file 44). When a customer (guest or account) adds equipment later with a 50% payment, the balance now also shows on the attached booking (Bookings tab: **Balance PHP x** instead of **Fully Paid**, also in Studio sessions and the booking details). The booking button reads **Collect balance & start**, and staff collect the add-on balance together with any booking balance. No other Supabase setting is needed.

The same file also makes the customer see it: the guest booking lookup and the signed-in booking receipt show **Equipment balance at the studio** when the booking was paid in full but equipment added later still has a balance (shown after staff verify that equipment's payment).

---

## 14. Migration 46 — Equipment Condition Documentation

### Overview

Migration `46_equipment_condition_docs.sql` adds per-line equipment condition recording for **outside rentals only**. Add-on rentals, booking flows, and automation are completely unchanged.

### What changes

| Area | Change |
|---|---|
| `rental_detail` | Four new nullable columns: `before_photo_path`, `return_condition`, `return_description`, `after_photo_path` |
| Storage | New private bucket `rental-photos`; staff can upload and read all; customers can read only their own |
| `v_rental_lines` | Four new columns appended at end (safe; no existing queries break) |
| New RPC | `staff_set_before_photo(detail_id, path)` — staff record the before-photo path |
| New RPC | `staff_return_rental_with_condition(ref, equipment_id, condition, description, after_path)` — outside rental return with documentation |
| New trigger | `trg_guard_outside_before_photo` — prevents issuing an outside rental if any line has no before photo |

### Supabase Setup Instructions (numbered, copy-paste SQL order)

**Step 1 — REQUIRED: Run the migration SQL**

In the Supabase SQL Editor, run the complete contents of `supabase/46_equipment_condition_docs.sql`.

This single file:
- Adds the four columns to `rental_detail`
- Creates and configures the `rental-photos` storage bucket
- Sets storage RLS policies
- Creates both new RPC functions
- Creates the before-photo trigger
- Recreates `v_rental_lines` with the four new columns appended

```sql
-- Paste the full contents of supabase/46_equipment_condition_docs.sql here
-- (copy the file; it is safe to re-run)
```

**Step 2 — REQUIRED: Verify the storage bucket was created**

In the Supabase Dashboard → Storage, confirm that `rental-photos` appears as a **private** bucket (the lock icon is shown, not "Public").

If it does not appear, run this manually:

```sql
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'rental-photos', 'rental-photos', false, 10485760,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
  SET public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
```

**Step 3 — REQUIRED: Verify storage policies**

In the SQL Editor, confirm the two policies exist:

```sql
SELECT policyname, cmd, roles::text
  FROM pg_policies
 WHERE tablename = 'objects'
   AND schemaname = 'storage'
   AND policyname LIKE 'tod_rental_photos%';
```

Expected rows:
- `tod_rental_photos_staff_all` — `ALL` for authenticated (staff gate inside)
- `tod_rental_photos_customer_own` — `SELECT` for authenticated (customer own only)

If missing, re-run `46_equipment_condition_docs.sql`.

**Step 4 — OPTIONAL: Verify new columns on rental_detail**

```sql
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name   = 'rental_detail'
   AND column_name  IN ('before_photo_path','return_condition','return_description','after_photo_path')
 ORDER BY ordinal_position;
```

All four should appear with `is_nullable = YES`.

**Step 5 — OPTIONAL: Verify new RPCs**

```sql
SELECT routine_name
  FROM information_schema.routines
 WHERE routine_schema = 'public'
   AND routine_name IN ('staff_set_before_photo','staff_return_rental_with_condition');
```

Both should appear.

**Step 6 — OPTIONAL: Verify trigger**

```sql
SELECT trigger_name, event_manipulation, action_timing
  FROM information_schema.triggers
 WHERE trigger_schema = 'public'
   AND trigger_name = 'trg_guard_outside_before_photo';
```

Should return one row: `BEFORE UPDATE`.

**Step 7 — OPTIONAL: Verify v_rental_lines new columns**

```sql
SELECT column_name
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name   = 'v_rental_lines'
   AND column_name  IN ('before_photo_path','return_condition','return_description','after_photo_path');
```

All four should appear.

### Historical records

Existing `rental_detail` rows have `NULL` for all four new columns. The admin and customer UIs display **"Not recorded"** in every place where condition or photo data would otherwise appear, so no historical record looks broken.

### No dashboard configuration required

The `rental-photos` bucket and its policies are fully managed by SQL. No manual clicks in the Supabase Storage dashboard are needed beyond verifying the bucket exists (Step 2).


## 49 - Sessions start and end even when nobody is logged in

Run `supabase/49_cron_auto_complete.sql` once (after file 41). It turns on the `pg_cron` extension and schedules the job `tod-start-sessions`, which calls `start_due_sessions()` every 30 seconds (every minute on older pg_cron). A studio session is therefore Completed at its end time by the database itself, with the admin / staff page closed; its add-on equipment is returned and the studio is freed. A session with an extension request still waiting for verification is not completed until staff verify or reject it. Check the job with `select * from cron.job;` and its runs with `select * from cron.job_run_details order by start_time desc limit 10;`.


## 50 - Equipment added during a running session is paid in full

Run `supabase/50_addon_full_payment_when_started.sql` once (after file 49). When a band adds equipment to a studio session that has already started (In Progress, or its start time has passed), `request_addon_rental()` accepts only full payment (100%); the website then shows only the Full Payment option. Nothing is left to collect, so the equipment is issued by itself as soon as staff verify the GCash payment. Before the session starts the customer still chooses 50% or 100%. Onsite add-ons recorded by staff were already full payment only (a down payment is refused for add-ons, file 43).


## 51 - Equipment stock is checked for the hours it is needed

Run `supabase/51_stock_by_time.sql` once (after file 50). Before, every approved or issued order counted against the stock until it was returned, whatever the day, and the check only happened when staff approved the order (after the customer paid). Now:

- A studio add-on needs the item during its booking's hours; an outside rental from pick-up to return (an overdue item stays counted until it is returned). Two orders only compete for the same items when their hours **overlap**; back-to-back hours (one ends at 6:00 PM, the next starts at 6:00 PM) do not.
- The check also runs when the customer **submits** the request (`request_rental`), so "Only 0 of Guitar Amp available for those hours" is shown before anything is paid. Staff approving, issuing, or recording an onsite rental are checked the same way (`assert_order_stock`).
- Approved (verified) and issued (In Use) orders hold stock. Pending, unverified requests do not.
- New functions: `order_window`, `equipment_in_use_between`, and `equipment_available_between(p_from, p_to)`, which the Rent equipment page, the booking form's equipment window and the staff onsite rental form call to show how many are free for the chosen hours.
- "Available / In use" on the staff Equipment page now means **right now**: an order for a later day does not lower it until its hours begin.

## 52 - Equipment is re-checked when a session is extended or rescheduled

Run `supabase/52_stock_on_booking_time_change.sql` once (after file 51). File 51 checked a studio add-on against stock for its session's hours only when the add-on was requested or approved. If the session was extended or rescheduled afterwards, the new hours were never checked, so two bands could hold the same item at the same time. Now:

- A trigger on `booking` (`trg_booking_time_stock`) re-checks the add-on equipment (orders Approved or Active, not returned) whenever `start_at` or `end_at` changes. Only the hours that are new are checked (for an extension, just the extra time). If an item is not free, the change is refused and nothing is saved. This covers staff extending, an extension payment being verified, and rescheduling.
- `staff_extension_info` also looks at stock. The Extend window (customer and staff) offers only the extra hours whose equipment is free and explains why when it is limited, so the customer finds out before paying the 50% down payment. `staff_extend_booking`, `customer_request_extension` and `staff_hold_extension` all use this function, so they follow it automatically.
- If another order takes the equipment while an extension payment is waiting, verifying that payment fails with a message telling staff to reject it with the reason "Equipment not available for the extra time".
- Rescheduling to a time when the add-on is not free is refused with a message that names the item and how many are free.
- New internal functions (not callable from the website): `equipment_held_by_others`, `booking_stock_conflict`, `booking_time_stock_trg`. Replaced: `staff_extension_info(text, text)`.
- No website (JS / HTML) changes: the existing screens already show the messages these functions return.

## 53 - Pending requests hold their equipment

Run `supabase/53_pending_orders_hold_stock.sql` once (after file 52). Files 51 and 52 let only Approved or issued orders hold stock, so two customers could both be told "available", both pay, and the second one was refused only when staff verified the payment. Now:

- A **Pending** add-on or outside-rental request holds its items for its hours from the moment it is submitted until staff verify it (Approved) or it is Rejected / Cancelled. There is **no time limit**, so slow staff never make a customer lose the items they paid a down payment for.
- A Pending add-on whose booking is Rejected, Cancelled or Completed holds nothing, so a dead request never blocks stock.
- The next customer is told "Only 0 of Guitar Amp available for those hours" when they submit, before paying. The Rent page, booking form and onsite form (`equipment_available_between`) count Pending requests too.
- Extending or rescheduling a booking respects other customers' Pending orders, and the booking's own Pending add-on is re-checked for the new hours.
- Staff approving an order are compared with Approved / issued orders only (the Pending ones were already checked on submit), so an approval never fails because of another waiting request.
- The staff Equipment page "In use" still counts only Approved / issued orders right now.
- Replaced: `equipment_in_use_between` (new last argument `p_include_pending`, default true), `equipment_in_use`, `equipment_available_between`, `assert_order_stock`, `equipment_held_by_others`, `booking_stock_conflict`. No website (JS / HTML) changes.
- Staff should still verify or reject Pending payments promptly: an unpaid or abandoned request keeps its items held until staff reject it.

## 54 - Reschedule greys out times where the add-on equipment is not free

Run `supabase/54_reschedule_stock_slots.sql` once (after file 53). Before, a customer rescheduling a booking that has add-on equipment picked a time and only then saw "Only 0 of Guitar Amp would be free...". Now:

- New function `reschedule_blocked_slots(p_booking_ref, p_date)` returns the start times of a day where the booking's equipment (Pending, Approved or issued add-on orders) is not free for the booking's whole length, with the reason. It uses the same check as the safety net in file 52, so what is greyed out is exactly what a save would refuse. Only the booking's owner (or staff) can call it.
- The Reschedule window (`js/customer/myBookings.js`) asks for it each time the date changes or the times are redrawn. Those start times are disabled and marked **No equipment** (hover shows the reason), with a short note under the times. If the picked time becomes blocked while the window is open, the pick is dropped and its hold released.
- A booking without add-on equipment sees no change. If the call fails, the window behaves as before and the server still refuses a conflicting time on save.

## 55 - A session can be extended without its add-on

Run `supabase/55_extend_without_addons.sql` once (after file 54). File 52 limited the Extend window to the hours the add-on equipment was free for, so a band could not extend just because one item was reserved later. Now:

- The Extend window (customer and staff) offers every hour the **studio** is free for (next booking, holds, 10:00 PM closing). The equipment no longer limits it.
- When the add-on equipment is not free for the chosen extra hours, the window shows a warning and, on submit, asks **"Extend without your add-on?"** (customer) / **"Extend without the add-on?"** (staff). **Yes**: only the booking is extended; the add-on keeps its original hours and is not recorded for the extra time, so the equipment must be returned when the original time ends. **No**: nothing changes.
- The add-on order is not cancelled or repriced. `rental_order.addon_cut_hours` records how many hours at the end of the session the add-on does not cover; `order_window` uses it, so the other bookings can use that equipment during the extra hours.
- A later extension never brings a shortened add-on back (its equipment is already returned).
- A customer's choice is saved with the request (`booking_extension.without_addons`) and applied when staff verify the extension payment. If the equipment is free again by then, the add-on is extended normally.
- If the equipment is free for the extra hours, nothing changes: the add-on is extended with the session.
- Without the confirmation the server still refuses an extension whose equipment is not free, so it cannot happen by accident.
- Replaced: `staff_extension_info` (new columns `addon_max_hours`, `addon_message`; `max_hours` no longer includes the equipment limit), `staff_extend_booking` (new argument `p_without_addons`, new column `addon_dropped`), `customer_request_extension` (new argument `p_without_addons`, new column `without_addons`), `apply_booking_extension`, `booking_stock_conflict`, `order_window`. New internal function: `apply_extension_addon_cut`.
- Website: `js/customer/myBookings.js` and `js/admin/bookings.js` (warning, confirmation, and the new argument).
- Staff must collect the equipment back when the original time ends. Staff are told so in the confirmation and the success message.

## Rent equipment: pick-up and return times in the Rental summary (website only, no SQL)

On the Rent equipment tab, **Outside rent** now shows the pick-up and return date and time inside the Rental summary (they used to be hidden in the checkout window). Customers set the hours first and the equipment cards show how many of each item are free from the pick-up to the return time (`equipment_available_between`). The line above the cards names the hours being checked, says "Checking what is free for your hours..." while it asks, and explains when the return is not after the pick-up. The checkout window shows the same four fields as before (pick-up date and time, return date and time) but locked, with the rental length under them. The note also now says items are reserved once the request is sent (file 53). Changed: `pages/customer.html`, `js/customer/rent.js`, `css/customer.css`.

---

## Mark completed collects the balance of an extended session (85) and no auto-complete while a balance is owed (86)
Run `supabase/85_collect_balance_on_complete.sql` once (after 84), then `supabase/86_block_autocomplete_with_balance.sql` once (after 85). Safe to re-run; no Edge Function change.
* **85**: `staff_collect_balance` also accepts an In Progress booking when called with `p_start = false` (it records the balance and leaves the status alone). Starting a session still needs a Confirmed booking. Each collection clears `payment.balance_email_sent_at`, so a second collection is emailed again. On the admin page, **Mark completed** on an Active session with a balance opens the **Collect balance & start** window (amount due, Cash with amount tendered and change, or GCash with a 13-digit reference), saves the balance as fully paid and then marks the booking Completed.
* **86**: `start_due_sessions()` (file 78's version) completes a session at its end time only when its balance due is zero. A session that owes a balance stays In Progress, over time, until staff collect it.
