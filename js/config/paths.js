/* =====================================================================
   config/paths.js - where the site lives and where each link goes
   ROOT is worked out from this file's own URL, so links work from index.html
   and from pages/. Routes are relative to it.
   ===================================================================== */

/* Site root, worked out from where this script was loaded (js/shared.js),
   so links work from index.html and from pages/. Routes are relative to it. */
export const ROOT = new URL('../../', import.meta.url).href;

export const ASSETS = ROOT + 'assets/';

/* Where each link goes. Set a URL when you build that page.
   Query params are added automatically, for example
   book -> pages/customer.html?studio=A&date=2026-10-15&time=3:00 PM#book
   Home, Book, Rent, My Bookings, My Rental and Contact Us are all tabs of ONE page (pages/customer.html), so
   moving between them never reloads the page and the equipment cart stays exactly as it was.
   A route set to null shows a short "connect this page" message. */
export const ROUTES = {
    home: 'pages/customer.html#home',
    book: 'pages/customer.html#book',
    rent: 'pages/customer.html#rent',
    mybook: 'pages/customer.html#my-bookings',
    myrent: 'pages/customer.html#my-rentals',
    contact: 'pages/customer.html#contact',
    login: 'pages/login.html#login',
    register: 'pages/login.html#register',
    account: 'pages/account.html',
    // customer profile (name, email, password)
    admin: 'pages/admin.html#a-over'
    // owner and staff dashboard
};

/* Responsive photos (srcset).
   Supabase can resize photos on the fly ("Image Transformations"), but that feature is only on the Pro plan.
   Leave this false on the Free plan: the photos then load as one file, with their size reserved so the page does not jump.
   Set it to true after you upgrade and the studio and equipment photos switch to small / medium / large versions. */
export const IMAGE_TRANSFORMS = false;
