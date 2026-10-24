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
   A route set to null shows a short "connect this page" message. */
export const ROUTES = {
  home:     'index.html#home',
  book:     'pages/customer.html#book',
  rent:     'pages/customer.html#rent',
  mybook:   'pages/customer.html#my-bookings',
  myrent:   'pages/customer.html#my-rentals',
  contact:  'index.html#contact',
  login:    'pages/login.html#login',
  register: 'pages/login.html#register',
  admin:    'pages/admin.html#a-over'   // owner and staff dashboard
};
