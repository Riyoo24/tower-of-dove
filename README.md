# Tower of Dove Music Studio - booking system (modular version)

Vanilla HTML5 + CSS3 + ES6 modules + Supabase. No build tools, no frameworks.

## Run it
ES modules do not load from `file://`. Serve the folder with any static server, then open the address:

    python3 -m http.server 8000      # then visit http://localhost:8000/

(VS Code "Live Server" works too.) Database scripts are in `supabase/` (unchanged).

## Directory tree
```
tower-of-dove-system/
├─ index.html                 landing page
├─ pages/  login.html  customer.html  admin.html  account.html
├─ css/
│  ├─ base.css                palette variables, reset, typography
│  ├─ components.css          cards, buttons, badges, forms, tables, tabs, alerts
│  ├─ layout.css              sidebar, mobile bar, page grids, phone rules
│  ├─ modals.css              toast, dialogs, drawers, success pop-up
│  ├─ home.css  customer.css  admin.css  login.css     (one per page)
├─ js/
│  ├─ config/    supabaseClient.js  paths.js
│  ├─ shared/    utils  catalog  cards  availability  holds  session  navigation  layout
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

## Module responsibility map
| File | Feature / UI | Database |
|---|---|---|
| config/supabaseClient.js | the one shared `sb` client | - |
| config/paths.js | site root and page links | - |
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
