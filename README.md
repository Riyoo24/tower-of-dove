> **Reports export, analytics and room calendar (no database changes):** Reports has "Download CSV" (one file with a summary plus the detail tables of the selected report; `js/admin/export.js`) and "Save as PDF" (prints only the report; pick Save as PDF in the print window; rules in `css/print.css`). A new **Analytics** report (`js/admin/analytics.js`, `js/admin/charts.js`) shows revenue trend, busy times by weekday and hour, studio utilisation, repeat-customer rate and equipment usage. A new **Room Calendar** tab (`js/admin/calendar.js`, owner and staff) shows every studio on a day grid (hours down, studios across) and a week overview (one row per studio) so free time is easy to see; click a booking for details. Utilisation assumes open hours of 10 AM to 10 PM (`OPEN` / `CLOSE` at the top of `analytics.js` and `calendar.js`).

> **Before you book, FAQ, cost estimate and Add to calendar (no database changes):**
> - Home: a "Before you book" strip and a FAQ (`js/home/info.js`, drawn into `#byb-list` and `#faq-list` in `pages/customer.html`). The rules written there are the ones the system already enforces; the no-show minutes are read from the database (`loadGrace()`), the other numbers are constants at the top of that file (`HOLD_MINUTES`, `CUTOFF_HOURS`, and `BOOKING_WINDOW_DAYS` from `shared/availability.js`). If a rule changes, update that file too.
> - Cost estimate: the Book tab shows a 1 to 4 hour table under the selected day. Both come from `js/shared/estimate.js`, which uses the same `dueNow()` rule as the booking form.
> - Add to calendar: `js/shared/calendar.js` builds a `.ics` file (Apple, Outlook, Android) and a Google Calendar link. Buttons appear in the booking success pop-up (marked tentative while the booking is Pending), in the booking receipt (Pending and Confirmed), and as "Add to calendar" in My bookings > Actions. The event UID is the booking reference, so adding it again after a reschedule replaces the old entry in most calendar apps. Alarms: 1 day before and 2 hours before.
> - `js/shared/venue.js` holds the studio name, phone, address and Maps link, used by Contact Us and by the calendar file.
> - Styles: end of `css/home.css`, `css/customer.css` and `css/modals.css`.

> **One Browse equipment window:** the customer's "Add equipment to your booking" window and the staff's "Add equipment to the rental" window are both drawn by `js/shared/eqBrowse.js` (search box, category tabs, suggestions, cards with + / -, the Added list, toasts), so they stay identical. Each page only supplies its data and wording.

> **Equipment search, "In stock only" and "Frequently added with" (no database changes):** the Rent tab has a search box and an "In stock only" switch above the equipment cards, and the booking form's "Browse equipment" window has the search box. A "Frequently added with ..." strip suggests gear that goes with the studio or with what is already in the cart (for example a drum room suggests cymbals or a snare). The logic is in `js/shared/eqFilter.js`; the suggestions come from keyword rules (`RULES` in that file) matched against equipment names, categories and descriptions, so edit `RULES` to change what goes with what. Styles: end of `css/modals.css`.


> **UI polish update (no database changes):** light/dark theme toggle (`css/theme.css`, `js/shared/themeInit.js`), share/install metadata and `manifest.webmanifest`, responsive photos (`photo()` in `js/shared/cards.js`; set `IMAGE_TRANSFORMS = true` in `js/config/paths.js` only on the Supabase Pro plan), "Print receipt" + `css/print.css`, tab cross-fade, `404.html`, sticky price bars on phones, and phone fixes in `css/mobile.css`. Before going live: replace `https://tidings-unreal-gratuity.ngrok-free.dev` in the `og:image` tags of `index.html` and `pages/*.html` with the real domain, and set `ROOT` in `404.html` if the site is in a sub-folder. No new SQL files.
# Tower of Dove Music Studio - booking system (modular version)

> **Onsite booking / Onsite rental (GCash):** when the payment is GCash, staff now see the studio's GCash QR, an "Attach GCash Screenshot" field and the reference number box, the same as the customer booking window. The 13-digit reference number is read from the screenshot automatically (OCR) and can be corrected. The screenshot is required and is saved in the `gcash-screenshots` bucket under its reference number. No new SQL file: it uses `38_gcash_screenshots.sql` and `69_onsite_gcash_required.sql`, which should already be run.

Vanilla HTML5 + CSS3 + ES6 modules + Supabase. No build tools, no frameworks.

## Run it
ES modules do not load from `file://`. Serve the folder with any static server, then open the address:

    python3 -m http.server 8000      # then visit http://localhost:8000/

(VS Code "Live Server" works too.) Database scripts are in `supabase/` (unchanged).

## Directory tree
```
tower-of-dove-system/
├─ index.html                 forwards to pages/customer.html#home (old links keep working)
├─ pages/  login.html  customer.html (Home, Book, Rent, My Bookings, My Rental, Contact Us = tabs, no reloads)  admin.html  account.html
├─ css/
│  ├─ base.css                palette variables, reset, typography
│  ├─ components.css          cards, buttons, badges, forms, tables, tabs, alerts
│  ├─ layout.css              sidebar, mobile bar, page grids, phone rules
│  ├─ modals.css              toast, dialogs, drawers, success pop-up
│  ├─ home.css  customer.css  admin.css  login.css     (one per page)
├─ js/
│  ├─ config/    supabaseClient.js  paths.js
│  ├─ shared/    utils  catalog  cards  availability  holds  session  navigation  layout  datepicker
│  ├─ auth/      index  authService  passwordToggle
│  ├─ account/   index  profilePanel  profileService
│  ├─ home/      index  render  carousel  availability
│  ├─ customer/  index  state  ui  book  bookingForm  data  rent  myBookings  myRentals
│  └─ admin/     index  state  helpers  data  overview  bookings  payments  sessions
│                studios  equipment  rentals  verify  customers  settings  profile  onsite  reports
├─ assets/   supabase/
```
Each HTML page links the 4 shared stylesheets + its own, and loads ONE script: `js/<feature>/index.js`.
That entry file imports the other modules. The supabase-js library is still loaded by a normal
`<script>` tag first, so `window.supabase` exists before any module runs.

## Date pickers
`js/shared/datepicker.js` (a plain script, loaded with `defer` on the home, customer and admin pages) replaces every
`<input type="date">` with a dropdown-style button and calendar. Styles: the "DATE PICKERS" section at the end of `css/motion.css`.
The real date input stays in the page (hidden), so `.value`, `.min`, `.max`, `.disabled` and the `input` / `change` events work as before.
No database changes. Browsers without the Popover API keep the normal date field.

## Module responsibility map
| File | Feature / UI | Database |
|---|---|---|
| config/supabaseClient.js | the one shared `sb` client | - |
| config/paths.js | site root and page links | - |
| admin/damage.js | Damage fees of outside rentals: Damage fee window (photos, collect, verify / reject, change / waive, history), Cash / GCash fields used by the return window | v_damage_charge, damage_charge_log, rpc staff_collect_damage, staff_reject_damage_payment, staff_update_damage_charge; run supabase/58_damage_charges.sql (and 59_remove_damaged_stock.sql, then 60_out_of_service_stock.sql, then 61_swap_rental_item.sql for "Swap item", for "Remove from stock" / "Out of service") |
| admin/swapOffer.js, customer/swapChoice.js | "Let customer choose": staff offer 1 to 5 replacement items (shortage pop-up, Equipment warning, Rentals > Actions); the customer picks one in My rental / My bookings; deadline fallback | rental_swap_offer, rental_swap_offer_option, rpc staff_create_swap_offer, staff_cancel_swap_offer, my_swap_offers, customer_choose_swap, customer_decline_swap, expire_swap_offers; run supabase/71_customer_swap_choice.sql (after 61) |
| shared/utils.js | $, esc, peso, dates (Manila), time slots, toast, username->email | - |
| shared/catalog.js | studios and equipment lists, GCash QR link | studio, v_equipment_stock, storage studio-images |
| shared/availability.js | taken / held hours, past-hour rules | rpc get_busy_slots |
| shared/holds.js | 2-minute slot hold while booking | rpc hold_slot, release_hold |
| shared/session.js | who is logged in, logout, admin guard | auth session, customer, app_user |
| shared/layout.js, navigation.js | sidebar, mobile bar, page links | - |
| shared/cards.js | studio/equipment picture blocks | - |
| account/profileService.js, profilePanel.js, index.js | change username (shown in the sidebar) and first/last name, email and password through Supabase email links (customer account page; Owner/Staff profile view) | auth.updateUser (email), auth.resetPasswordForEmail, customer, app_user; run supabase/27_allow_username_change.sql |
| auth/authService.js | log in, register | auth sign-in / sign-up, app_user, customer |
| auth/index.js, passwordToggle.js | login/register forms, eye button | - |
| home/* | hero slider, cards, availability bar | via shared/catalog + availability |
| customer/book.js | Book tab: studio picker + calendar | via availability |
| customer/bookingForm.js | booking dialog, slots, add-ons, payment | holds, booking rpc, storage upload |
| customer/rent.js | Rent tab | rental request rpc, ID upload |
| customer/myBookings.js, myRentals.js | My bookings / My rental | bookings, rentals |
| customer/data.js | loads this customer's data | customer, bookings, rentals |
| customer/state.js, ui.js | shared page variables; tabs, tables, dialogs | - |
| admin/data.js | loads and refreshes all dashboard data | views, payments, staff, studios |
| admin/overview, bookings, payments, sessions | those tabs | booking, payment |
| admin/studios, equipment, rentals, customers | those tabs | studio, equipment, rentals, customer |
| admin/verify.js | payment verify drawer | payment |
| admin/settings.js, onsite.js, reports.js | settings/staff/QR, walk-ins, reports | app_user, storage, rpc |
| admin/helpers.js, state.js | shared helpers, click dispatcher; shared variables | - |

## Notes for defending the design
* **No inline handlers existed**, so nothing needs to be put on `window`; all events use `addEventListener` / `.onclick` inside modules.
* **Shared variables**: a module cannot reassign a variable it imported, so variables several modules change live in `state.js` (`state.selStudio`). Admin lists such as `BK` are loaded in `admin/data.js` and exported as live bindings.
* **CSS order matters**: keep the link order base, components, layout, modals, page file.
* Every function and rule was moved, not rewritten. The original `style.css` / `js/*.js` are intentionally gone.

## Update: shared equipment cart (customer page)
- `js/customer/cart.js` (new): one cart for Studio Add-ons + Outside Rent, combined stock rules, allocation message.
- `state.cart` is now `{ addon: {}, out: {} }` keyed by equipment id; switching modes no longer clears it.
- The booking form's "Browse equipment" window has its own cart (`state.cart.book`); it is not copied from the Rent tab, but all carts share the same stock.
- `ui.js`: new `showStockAlert()` popup. No Supabase changes are needed.

## Update: payment options (50% down payment or full payment)
- `supabase/31_payment_options.sql` (run once): `payment.payment_option`, new RPC parameters, `request_addon_rental`, updated views and revenue report.
- `js/shared/payOption.js`: the shared chooser and amount helper used by the booking form, Rent equipment page and Extend window.

## Update: verify the remaining balance before starting a session / issuing equipment
- `supabase/32_balance_collection.sql` (run once, after 31): `payment.balance_paid_*` columns, `booking_balance_due()`, `rental_balance_due()`, RPC `staff_collect_balance`, guard triggers, `start_due_sessions()` no longer auto-starts while a balance is due, extra view columns, `lookup_booking`.
- `js/admin/balance.js` (new): the verification window. Start session / Issue equipment open it when a 50% down payment still has a balance. Confirming turns the payment into a full payment and moves the booking to Active / the rental to In Use in one database call.

## Update: 4-week booking window
- Customers can book studios and pick up outside rentals only up to 28 days ahead (`lastBookableDate()` in `js/shared/availability.js`). `supabase/33_booking_window.sql` (run once) makes the database enforce it too.

## Performance pass

- Animations use only `transform` / `opacity`. The desktop sidebar collapse changes the page margin once and the page then slides with a `transform` (see `toggleSidebar` in `js/shared/layout.js`); the phone drawer already used `translateX`. No `transition: all` anywhere, and `will-change` is kept only on the phone drawer.
- Timers: `everyVisible()` in `js/shared/utils.js` pauses background polling while the tab is hidden and catches up once when it is shown again. The admin 30-second refresh also skips redrawing the tables when the data has not changed.
- Images: equipment / studio / admin thumbnails and ID / GCash / inspection photos use `loading="lazy"`, `decoding="async"` and `width` / `height`. The first carousel slide loads right away.
- Supabase reads go through `js/shared/query.js`: only the columns the site uses, and capped lists (newest 1000 bookings / payments, 1500 rental lines, 300 per customer). If a column is missing in an older database the read repeats once with `select('*')`.
- Fonts: Bricolage Grotesque is requested only at weight 700 (the only weight used).
- `path.js` + `css/signal.css`: the "How booking works" strip on the Home tab: round step nodes joined by a line; once, when it scrolls into view, node 1 lights, a red line travels to node 2, and so on to node 3, then it rests (no looping motion; stacks with a vertical line on phones; shown finished with reduced motion or without the script) (markup is in `pages/customer.html`, class `hx-how`).
- `rollup.js`: totals count up or down to their new peso value. The ids it watches are listed at the top of the file; add an id there to roll another total.
- Scripts: `flair.js` is only on `index.html`; `datepicker.js` only on the pages with date fields.
- Optional SQL: `supabase/48_performance_indexes.sql`.

## Update: button loading and success states

Submit buttons no longer just disable. `js/shared/btnState.js` (styles in `css/components.css`) shows a small spinner with "Sending…" while a request runs, then a brief check mark ("Sent", "Booked", "Saved"…) before the window moves on. If the request fails the button goes back to normal so the person can try again. Used by: the booking form, equipment/outside rental requests, extension and reschedule windows, log in / register / password reset, profile saves, and the staff windows (collect balance, extend, return, before photos, GCash QR, staff accounts). With reduced-motion turned on the spinner pulses instead of spinning. No database changes.

## Update: friendly empty states and inline field validation

- `js/shared/emptyState.js` draws an icon, one line and a button where a list is empty: My bookings ("Book a studio"), My rental ("Rent equipment"), the rental cart ("Browse equipment") and the equipment list.
- `js/shared/fieldCheck.js` marks a wrong field with a red border and a short message under it, and scrolls to the first one. A field is checked when it is left, and again on every key while it shows an error, so the message disappears as soon as it is fixed. Used by the booking form, the rental checkout (names, contact numbers, ID, GCash screenshot and reference, terms), the extension window, the register window and the log in / register / password pages. Messages about the server or the schedule (a slot taken, a hold expired) still use the banner of each form.
- Styles are in `css/components.css`. No database changes.


## Check-in: the time a customer arrived (87_booking_check_in.sql)
Run `supabase/87_booking_check_in.sql` once (after 86). Safe to re-run; no Edge Function change. Until it is run the admin page works as before and the check-in buttons are hidden.
* **What it is**: a record of when the customer arrived, for 50% down-payment bookings and fully paid ones alike. It does **not** start the session: fully paid bookings still start by themselves at their start time, and a booking with a balance is still started from Studio Sessions with **Collect balance & start**.
* **Staff**: Studio Sessions shows **Check in** on a confirmed booking whose time has come (and on a running session that has not been checked in). Bookings has an **Arrived** column, a **Check in** item in Actions, and an "Arrived" line in Details. Checking in twice keeps the first time.
* **No-show**: a customer who has checked in is not a no-show. The release countdown, **Hold** and **Release** disappear for that booking and the automatic release skips it while its session time is still running (a checked-in booking that is never paid or started is left for staff to cancel from Bookings).
* **Walk-ins**: an onsite booking that starts now (or within 15 minutes) is checked in automatically.
* **History**: every check-in is written to the booking's History ("Arrived 7 min late" / "10 min early" / "on time"). Only the **owner** can undo a check-in (Actions > Undo check-in, a note is required; the undo is logged too).
* **DB**: columns `booking.checked_in_at / checked_in_by / checked_in_by_name`; RPCs `staff_check_in`, `staff_undo_check_in`, `staff_check_in_times`; `release_no_show_bookings`, `staff_release_booking`, `staff_release_times`, `booking_release_time` and `my_booking_release` now skip a checked-in booking.
