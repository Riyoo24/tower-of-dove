# 🕊️ Tower of Dove Music Studio

**A full-stack studio room booking and equipment rental platform** for a rehearsal studio in the Philippines, with a customer-facing site, a staff and owner admin dashboard, GCash payment verification, and a Supabase backend.

🌐 **Live site:** [tower-of-dove.vercel.app](https://tower-of-dove.vercel.app)

![HTML5](https://img.shields.io/badge/HTML5-E34F26?logo=html5&logoColor=white)
![CSS3](https://img.shields.io/badge/CSS3-1572B6?logo=css3&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ES%20Modules-F7DF1E?logo=javascript&logoColor=black)
![Supabase](https://img.shields.io/badge/Supabase-Postgres%20%7C%20Auth%20%7C%20Storage-3FCF8E?logo=supabase&logoColor=white)
![No build step](https://img.shields.io/badge/build-none-blue)

---

## Table of Contents

1. [Project Overview](#project-overview)
2. [Key Features](#key-features)
3. [Tech Stack & Architecture](#tech-stack--architecture)
4. [Directory Structure](#directory-structure)
5. [Getting Started](#getting-started)
6. [Database & Migrations](#database--migrations)
7. [Edge Functions](#edge-functions)
8. [Deployment](#deployment)
9. [Security Notes](#security-notes)
10. [Further Documentation](#further-documentation)

---

## Project Overview

Tower of Dove is a web platform that lets a music studio:

- take **room bookings** (open daily, 10 AM – 10 PM, Asia/Manila time),
- **rent out equipment**, either as an add-on to a studio session or as an outside rental to take away,
- **verify GCash payments** with a reference number and screenshot,
- and run day-to-day operations (sessions, check-in, returns, damage fees, no-shows, reports) from one admin dashboard.

Customers can book **as a guest (no account needed)** or register to keep their history. Studio staff and the owner work from a role-based dashboard. All business rules (no double booking, stock limits, payment math, the 28-day booking window, no-show release) are **enforced in the database**, not only in the browser.

---

## Key Features

### Customer-facing site

- **Studio booking**: pick a studio and a date on a live availability calendar, choose hourly slots, and see a cost estimate before you commit.
- **2-minute slot hold**: chosen hours are held while the customer fills in the form, so two people can't grab the same slot.
- **Guest or member checkout**: continue as a guest, or register at checkout. Guest bookings made on the same device are claimed by the account after login.
- **Equipment rental**: add gear to a studio session (**add-on**) or rent it for pick-up (**outside rental**). A shared cart with search, category tabs, an "In stock only" switch and "Frequently added with…" suggestions.
- **Flexible payments**: **50% down payment or 100% full payment** via GCash. A session can also be extended and paid **after** the session.
- **GCash proof**: the studio's QR code is shown, the customer attaches a screenshot, and the 13-digit reference number is **read from the screenshot automatically (OCR)** and can be corrected.
- **Self-service management**: reschedule, cancel (24-hour rule), extend a running session, "Running late" (+15 min no-show grace), and "Book again".
- **Guest lookup**: find a booking or rental by reference code plus phone number.
- **Receipts and emails**: booking and rental receipts, "payment verified" and "fully paid" emails, no-show reminders, and replacement-item notices.
- **Calendar export**: add a booking to Apple/Outlook (`.ics`) or Google Calendar.
- **Replacement choice**: when a unit becomes unavailable, customers can pick a replacement item from options offered by staff.
- **Account page**: change username, name, email and password via Supabase email links.
- **Polish**: light/dark theme, installable PWA (`manifest.webmanifest`), skeleton loaders, inline field validation, empty states, print-friendly receipts, and a mobile-first layout.

### Admin dashboard (Owner & Staff)

| Area | What it does |
|---|---|
| **Overview** | Live counts, alerts and a global search across bookings, rentals and customers. |
| **Bookings** | Full booking list with approve / reject (with reason), reschedule, cancel, extend, check-in, history trail and actions menu. |
| **Room Calendar** | Day grid (hours × studios) and week overview to spot free time at a glance. |
| **Studio Sessions** | Start, extend, check in and complete sessions. Sessions end by themselves at their end time, unless a balance is still owed. |
| **Payments** | **GCash verification queue**: review the screenshot and reference number, then **verify or reject**. Verification moves the booking or rental forward and emails the customer. |
| **Balance collection** | Collect the remaining balance (cash with change calculation, or GCash reference) before starting a session, issuing equipment or completing an extended session. |
| **Rentals & equipment tracking** | Approve, issue, return and swap items. Overdue rentals are flagged and late fees are calculated automatically. |
| **Condition logging** | Before-photos, handover proof and return inspection photos, with damaged units marked **Out of service** or removed from stock. |
| **Damage fees** | Record, collect, verify, waive or defer damage fees. Unpaid fees block new bookings, and every change is logged. |
| **Equipment** | Stock levels (owned / out of service / rentable), pricing, categories, and **drag-and-drop ordering** of what customers see. |
| **Studios** | Manage studio details, rates, photos and availability (owner only). |
| **Onsite booking / Onsite rental** | Walk-in bookings and rentals with cash or GCash, a 2-minute "held by staff" slot lock, and optional down payments. |
| **Customers** | Customer list, spending, and **reputation flags** (late returns, damage fees, no-shows) with notes and dismissals. |
| **No-show handling** | Auto-release of unpaid bookings after a grace period, hold / release controls, and forfeiture emails. |
| **Reports & Analytics** | Revenue, utilisation, busy hours, repeat customers and equipment usage, with **CSV export** and **Save as PDF**. |
| **Settings & Profile** | GCash QR, staff accounts (created through an Edge Function), no-show grace time, and profile management. |

**Roles:** *Owner* has full control (studios, staff, overrides, undo check-in, fee waivers). *Staff* run daily operations only.

---

## Tech Stack & Architecture

| Layer | Technology |
|---|---|
| **Frontend** | Vanilla **HTML5**, **CSS3**, and **ES6 modules**: no framework, no bundler, no build step |
| **Backend** | **Supabase**: PostgreSQL, Auth, Storage, Row Level Security, RPC functions, `pg_cron` |
| **Serverless** | Supabase **Edge Functions** (Deno / TypeScript) |
| **Email** | SMTP (e.g. Gmail App Password) through the `send-receipt` Edge Function |
| **Client libraries (CDN)** | `@supabase/supabase-js` v2, `tesseract.js` (GCash OCR), Google Fonts (Bricolage Grotesque, Instrument Sans) |
| **Hosting** | Any static host (deployed on Vercel) |

### How the frontend is organised

- **One feature = one folder.** Each page loads a single entry script, `js/<feature>/index.js`, which imports the rest of that feature's modules.
- **One shared client.** Every module imports `sb` from `js/config/supabaseClient.js`.
- **Shared logic lives in `js/shared/`**: availability, slot holds, session handling, catalog, cart helpers, the date picker, receipts, and the equipment browser used by both customer and staff.
- **Shared state** (for example `state.js` in `customer/` and `admin/`) holds variables that several modules change, since an imported binding can't be reassigned.
- **Customer pages are a single-page app.** Home, Book, Rent, My Bookings, My Rental and Contact are tabs of `pages/customer.html`, so moving between them never reloads the page and the cart is preserved.
- **CSS is layered by role**: `base → components → layout → modals`, then a page-specific file, then the theme, motion, mobile and print layers.

### How the backend is organised

- **The schema is built from numbered SQL files**, run in order, with later files layering features on top. They are safe to re-run.
- **Business rules live in Postgres.** Constraints, triggers and `SECURITY DEFINER` RPCs enforce no double booking (a `btree_gist` exclusion constraint), stock by time window, payment maths, the booking window, and no-show release.
- **Row Level Security** means customers see only their own data. Guests can only use specific RPCs. Only staff can see GCash screenshots and inspection photos.
- **Core tables:** `app_user`, `customer`, `studio`, `equipment_category`, `equipment`, `booking`, `booking_extension`, `booking_event`, `rental_order`, `rental_detail`, `payment`, `slot_hold`, `equipment_hold`, `damage_charge`, `damage_charge_log`, `late_fee_log`, `rental_item_swap`, `rental_swap_offer`, `incident_review`, `app_setting`, and more.
- **Storage buckets:** `studio-images` and `equipment-images` (public), `rental-ids`, `rental-photos` and `gcash-screenshots` (private).
- **Scheduled jobs (`pg_cron`)** auto-complete sessions, release no-shows, expire swap offers, and trigger reminder emails.

---

## Directory Structure

This tree lists every file in the repository.

- `pages/` holds the four HTML pages.
- `css/` and `js/` sit at the top level, next to `assets/`.
- `assets/` contains only images (`assets/img/`).

<details>
<summary><strong>Click to expand the full file tree</strong></summary>

```text
riyoo24-tower-of-dove/
├── .vscode
│   └── settings.json
├── assets
│   └── img
│       ├── reviewers
│       │   ├── reviewer-1.jpg
│       │   ├── reviewer-2.jpg
│       │   └── reviewer-3.jpg
│       ├── apple-touch-icon.png
│       ├── favicon-32.png
│       ├── icon-192.png
│       ├── icon-512.png
│       ├── icon-maskable-512.png
│       ├── logo.png
│       └── og-cover.png
├── css
│   ├── admin.css
│   ├── base.css
│   ├── components.css
│   ├── customer.css
│   ├── depth.css
│   ├── home.css
│   ├── layout.css
│   ├── login.css
│   ├── mobile.css
│   ├── modals.css
│   ├── motion.css
│   ├── mycards-sticky.css
│   ├── mycards.css
│   ├── print.css
│   ├── refresh.css
│   ├── signal.css
│   ├── skeleton-extra.css
│   └── theme.css
├── docs
│   └── supabase_setup_summary.md
├── js
│   ├── account
│   │   ├── index.js
│   │   ├── profilePanel.js
│   │   └── profileService.js
│   ├── admin
│   │   ├── alerts.js
│   │   ├── analytics.js
│   │   ├── balance.js
│   │   ├── bookings.js
│   │   ├── calendar.js
│   │   ├── cashBox.js
│   │   ├── charts.js
│   │   ├── checkIn.js
│   │   ├── checkInInfo.js
│   │   ├── customers.js
│   │   ├── damage.js
│   │   ├── data.js
│   │   ├── equipCalendar.js
│   │   ├── equipment.js
│   │   ├── export.js
│   │   ├── globalSearch.js
│   │   ├── handoff.js
│   │   ├── helpers.js
│   │   ├── index.js
│   │   ├── jump.js
│   │   ├── noShow.js
│   │   ├── onsite.js
│   │   ├── overview.js
│   │   ├── payments.js
│   │   ├── profile.js
│   │   ├── rentals.js
│   │   ├── reports.js
│   │   ├── reputation.js
│   │   ├── sessions.js
│   │   ├── settings.js
│   │   ├── state.js
│   │   ├── studios.js
│   │   ├── swapOffer.js
│   │   ├── topbar.js
│   │   ├── trail.js
│   │   └── verify.js
│   ├── auth
│   │   ├── authService.js
│   │   ├── index.js
│   │   └── passwordToggle.js
│   ├── config
│   │   ├── paths.js
│   │   └── supabaseClient.js
│   ├── customer
│   │   ├── alerts.js
│   │   ├── book.js
│   │   ├── bookingForm.js
│   │   ├── cart.js
│   │   ├── cartStore.js
│   │   ├── damageBlock.js
│   │   ├── data.js
│   │   ├── index.js
│   │   ├── myBookings.js
│   │   ├── myCards.js
│   │   ├── myRentals.js
│   │   ├── noShow.js
│   │   ├── registerModal.js
│   │   ├── rent.js
│   │   ├── returnCountdown.js
│   │   ├── state.js
│   │   ├── swapChoice.js
│   │   └── ui.js
│   ├── home
│   │   ├── availability.js
│   │   ├── carousel.js
│   │   ├── contact.js
│   │   ├── index.js
│   │   ├── info.js
│   │   ├── render.js
│   │   └── reviews.js
│   └── shared
│       ├── actionMenu.js
│       ├── availability.js
│       ├── backToTop.js
│       ├── boot.js
│       ├── btnState.js
│       ├── calendar.js
│       ├── cards.js
│       ├── catalog.js
│       ├── datepicker.js
│       ├── emptyState.js
│       ├── eqBrowse.js
│       ├── eqFilter.js
│       ├── eqModal.js
│       ├── estimate.js
│       ├── fieldCheck.js
│       ├── flair.js
│       ├── formRules.js
│       ├── gcashProof.js
│       ├── guestStore.js
│       ├── holds.js
│       ├── holdTimer.js
│       ├── imageViewer.js
│       ├── inspectionPhoto.js
│       ├── layout.js
│       ├── liveAvail.js
│       ├── mobileUx.js
│       ├── modalTop.js
│       ├── motion.js
│       ├── navigation.js
│       ├── path.js
│       ├── payOption.js
│       ├── qrZoom.js
│       ├── query.js
│       ├── receipt.js
│       ├── rollup.js
│       ├── session.js
│       ├── sideSkeleton.js
│       ├── skeleton.js
│       ├── themeInit.js
│       ├── topSkeleton.js
│       ├── utils.js
│       └── venue.js
├── pages
│   ├── account.html
│   ├── admin.html
│   ├── customer.html
│   └── login.html
├── supabase
│   ├── functions
│   │   ├── create-staff
│   │   │   └── index.ts
│   │   └── send-receipt
│   │       └── index.ts
│   ├── tests
│   │   └── qa_tests.sql
│   ├── 01_schema.sql
│   ├── 02_functions.sql
│   ├── 03_security.sql
│   ├── 04_seed.sql
│   ├── 05_booking_addons.sql
│   ├── 06_lookup_addons.sql
│   ├── 07_auto_approve_addons.sql
│   ├── 08_outside_rental.sql
│   ├── 09_random_refs.sql
│   ├── 10_guest_lookup_privacy.sql
│   ├── 11_cash_autostart_addons.sql
│   ├── 12_rental_base_hours_autostatus.sql
│   ├── 13_overdue_hours_addon_return.sql
│   ├── 14_email_login_names_id_view.sql
│   ├── 15_extend_booking.sql
│   ├── 16_extension_slot_hold.sql
│   ├── 17_customer_extend.sql
│   ├── 18_booking_reject_reason.sql
│   ├── 19_remove_drum_vip_capacity.sql
│   ├── 20_booking_down_payment.sql
│   ├── 21_fix_rental_total_8h.sql
│   ├── 22_owner_email.sql
│   ├── 23_extension_payment.sql
│   ├── 24_onsite_gcash_optional.sql
│   ├── 25_reschedule_slot_hold.sql
│   ├── 26_profile_management.sql
│   ├── 27_allow_username_change.sql
│   ├── 28_default_username_first_name.sql
│   ├── 29_optional_backfill_first_name_usernames.sql
│   ├── 30_claim_guest_bookings.sql
│   ├── 31_payment_options.sql
│   ├── 32_balance_collection.sql
│   ├── 33_booking_window.sql
│   ├── 34_receipt_emails.sql
│   ├── 35_verified_emails.sql
│   ├── 36_onsite_slot_hold.sql
│   ├── 37_hold_two_minutes.sql
│   ├── 38_gcash_screenshots.sql
│   ├── 39_addon_auto_issue_return.sql
│   ├── 40_addon_balance_collection.sql
│   ├── 41_auto_complete_sessions.sql
│   ├── 42_onsite_receipt_email.sql
│   ├── 43_onsite_outside_down_payment.sql
│   ├── 44_onsite_booking_down_payment.sql
│   ├── 45_addon_balance_on_booking.sql
│   ├── 46_equipment_condition_docs.sql
│   ├── 47_fix_customer_photo_policy.sql
│   ├── 48_performance_indexes.sql
│   ├── 49_cron_auto_complete.sql
│   ├── 50_addon_full_payment_when_started.sql
│   ├── 51_stock_by_time.sql
│   ├── 52_stock_on_booking_time_change.sql
│   ├── 53_pending_orders_hold_stock.sql
│   ├── 54_reschedule_stock_slots.sql
│   ├── 55_extend_without_addons.sql
│   ├── 56_balance_payment_proof.sql
│   ├── 57_handover_proof.sql
│   ├── 58_damage_charges.sql
│   ├── 59_remove_damaged_stock.sql
│   ├── 60_out_of_service_stock.sql
│   ├── 61_swap_rental_item.sql
│   ├── 62_stock_preview.sql
│   ├── 63_out_of_stock_status.sql
│   ├── 64_damage_block_reputation.sql
│   ├── 65_outside_no_auto_issue.sql
│   ├── 66_balance_receipt_email.sql
│   ├── 67_balance_cash_tendered.sql
│   ├── 68_damage_paid_email.sql
│   ├── 69_onsite_gcash_required.sql
│   ├── 70_no_max_booking_hours.sql
│   ├── 71_customer_swap_choice.sql
│   ├── 72_customer_swap_followup.sql
│   ├── 73_approve_after_swap.sql
│   ├── 75_onsite_cash_tendered.sql
│   ├── 76_replacement_emails.sql
│   ├── 77_equipment_sort_order.sql
│   ├── 78_no_show_release.sql
│   ├── 79_no_show_emails.sql
│   ├── 80_lock_equipment_on_request.sql
│   ├── 81_qa_fixes.sql
│   ├── 82_no_show_in_flag.sql
│   ├── 83_late_fee_collection.sql
│   ├── 84_late_fee_block.sql
│   ├── 85_collect_balance_on_complete.sql
│   ├── 86_block_autocomplete_with_balance.sql
│   ├── 87_booking_check_in.sql
│   ├── 88_late_fee_preview.sql
│   ├── 89_equipment_checkout_hold.sql
│   ├── 90_addon_balance_in_session.sql
│   ├── 91_extension_pay_later.sql
│   ├── 92_extension_active_no_down.sql
│   ├── 93_staff_extend_session_payment.sql
│   ├── 94_qa_hardening .sql
│   ├── all_in_one.sql
│   └── README.md
├── 404.html
├── index.html
├── manifest.webmanifest
├── README.md
└── settings.json
```

</details>

**What each top-level folder is for:**

| Path | Purpose |
|---|---|
| `pages/` | `customer.html` (single-page customer app), `admin.html` (Owner / Staff dashboard), `login.html`, `account.html` |
| `css/` | Layered stylesheets: `base → components → layout → modals`, then page files (`home`, `customer`, `admin`, `login`), plus theme, motion, mobile and print |
| `js/config/` | Shared Supabase client and route/path settings |
| `js/shared/` | Modules used by several pages (availability, holds, session, catalog, receipts, GCash OCR proof, date picker, skeletons, ...) |
| `js/auth/`, `js/account/`, `js/home/`, `js/customer/`, `js/admin/` | One folder per feature, each with an `index.js` entry point |
| `assets/img/` | Logo, favicons, PWA icons, social cover image, reviewer photos |
| `supabase/` | Numbered SQL migrations (`01`–`94`), `all_in_one.sql`, Edge Functions and QA tests |
| `docs/` | Backend reference (`supabase_setup_summary.md`) |

---

## Getting Started

### Prerequisites

- A modern browser
- A static file server (Python 3, Node, or VS Code **Live Server**)
- A free [Supabase](https://supabase.com) account (to run your own backend)

> ES modules do not load from `file://`, so **do not** open `index.html` by double-clicking it. Serve the folder over `http://`.

### 1. Clone the repository

```bash
git clone https://github.com/<your-username>/tower-of-dove.git
cd tower-of-dove
```

### 2. Run it locally

```bash
python3 -m http.server 8000
# then open http://localhost:8000/
```

Or use any equivalent (`npx serve`, VS Code Live Server, etc.). There is no `npm install` and no build.

> With the bundled config the site will talk to the original Supabase project. To use **your own** backend, continue below.

### 3. Create your Supabase backend

1. Create a new project at [supabase.com](https://supabase.com).
2. Open **SQL Editor** and run, in order: `01_schema.sql`, `02_functions.sql`, `03_security.sql`, `04_seed.sql`.
3. Then run the numbered migrations `05_…` through `94_…` **in numeric order**. Each is safe to re-run. See [Database & Migrations](#database--migrations).
4. Enable **Authentication → Providers → Email → Confirm email**, and configure a custom SMTP sender so real customers receive the confirmation link.
5. Under **Authentication → URL Configuration**, set the **Site URL** and add a **Redirect URL** such as `http://localhost:8000/**` (and your production URL with `/**`).
6. **Create the owner account** by following the comment block at the bottom of `04_seed.sql` (create the Auth user, then insert the matching `app_user` row with role `Owner`).
7. Deploy the two [Edge Functions](#edge-functions).

### 4. Point the frontend at your project

Edit `js/config/supabaseClient.js`:

```js
export const SUPABASE_URL = 'https://<your-project-ref>.supabase.co';
export const SUPABASE_ANON_KEY = '<your-anon-public-key>';
```

> Use only the **anon** key here. **Never** put the `service_role` key in frontend code.

### 5. Open the app

| Page | URL |
|---|---|
| Customer site | `http://localhost:8000/pages/customer.html` |
| Login / Register | `http://localhost:8000/pages/login.html` |
| Admin dashboard | `http://localhost:8000/pages/admin.html` (Owner / Staff login) |

### Optional configuration

- **Domain-specific tags:** update the `og:image`, `og:url` and `canonical` tags in `index.html` and `pages/*.html` to your own domain, and set `ROOT` in `404.html` if the site lives in a sub-folder.
- **Image transformations:** set `IMAGE_TRANSFORMS = true` in `js/config/paths.js` only on the Supabase **Pro** plan.
- **Studio details:** edit `js/shared/venue.js` (name, phone, address, map link).
- **Opening hours** used by analytics and the room calendar: `OPEN` / `CLOSE` at the top of `js/admin/analytics.js` and `js/admin/calendar.js`.

---

## Database & Migrations

The `supabase/` folder contains the full schema history as numbered scripts:

| Range | Focus |
|---|---|
| `01`–`04` | Core schema, functions, security (RLS), seed data |
| `05`–`18` | Add-ons, guest lookup privacy, random references, extensions, reject reasons |
| `19`–`37` | Down payments, profile management, payment options, balance collection, booking window, receipt/verification emails, slot holds |
| `38`–`58` | GCash screenshots, automatic session completion (`pg_cron`), stock-by-time checks, equipment condition docs, handover proof, damage fees |
| `59`–`73` | Out-of-service stock, item swaps, customer replacement choice, damage-based reputation blocks, balance receipts |
| `75`–`94` | Equipment ordering, no-show release and emails, QA fixes, late fees, check-in, pay-later extensions, QA hardening |

Notes:

- There is intentionally no `74_*.sql`.
- `29_optional_backfill_first_name_usernames.sql` is optional.
- `79_no_show_emails.sql` needs extra setup (a `CRON_SECRET` secret and an `email_job_config` row, described at the bottom of the file and in `supabase/README.md`).
- `all_in_one.sql` bundles only the early files. For a fresh install, follow the numbered order above.
- Existing databases: run only the newest files you have not yet applied.
- **Tests:** paste `supabase/tests/qa_tests.sql` into the SQL Editor to check double-booking, payment maths, no-show release and data-access rules. Everything is rolled back.

For the full table, RPC, RLS and storage reference, see [`docs/supabase_setup_summary.md`](docs/supabase_setup_summary.md) and [`supabase/README.md`](supabase/README.md).

---

## Edge Functions

| Function | Purpose |
|---|---|
| `create-staff` | Lets the **Owner** create staff accounts, reset staff passwords and remove customer accounts. Uses the `service_role` key server-side only. |
| `send-receipt` | Sends booking/rental receipts, "payment verified" and "fully paid" emails, damage and late-fee receipts, replacement-item notices, and no-show reminders / forfeiture notices. |

**Deploy (CLI):**

```bash
supabase functions deploy create-staff --project-ref <your-project-ref>
supabase functions deploy send-receipt --project-ref <your-project-ref>
```

**Secrets for `send-receipt`** (Dashboard → Edge Functions → Secrets):
`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `CRON_SECRET` for the no-show jobs. Optional: `RECEIPT_FROM_EMAIL`, `STUDIO_NAME`, `STUDIO_CONTACT_EMAIL`.

---

## Deployment

The app is plain static files, so it deploys to Vercel, Netlify, GitHub Pages or Cloudflare Pages with no build command. After deploying:

1. Set the Supabase **Site URL** and **Redirect URLs** to your production domain (`https://your-domain/**`).
2. Update the `og:*` / `canonical` tags to the new domain.
3. Make sure SMTP secrets are set so confirmation and receipt emails are delivered.

---

## Security Notes

- The Supabase **anon key is public by design**. Data is protected by **Row Level Security** and `SECURITY DEFINER` RPCs.
- The **`service_role` key never touches the browser**. Staff creation goes through the `create-staff` Edge Function.
- Guest lookups require the **reference code and the phone number** used for the booking.
- `hold_slot` is rate-limited per caller to prevent slot hoarding.
- GCash screenshots, rental IDs and inspection photos are stored in **private buckets** that only staff can read.

---

## Further Documentation

- [`supabase/README.md`](supabase/README.md): setup order, email verification, forgot password, per-migration instructions
- [`docs/supabase_setup_summary.md`](docs/supabase_setup_summary.md): complete backend reference

---

© Tower of Dove Music Studio. All rights reserved.