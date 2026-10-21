/* =====================================================================
   shared/layout.js - sidebar and mobile bar (injected into every page)
   Call injectChrome() once at the start of each page script.
   ===================================================================== */

import { ASSETS } from '../config/paths.js';
import { navigate } from './navigation.js';
import { getUser, logout } from './session.js';
import { $, $$, esc } from './utils.js';

export const ICONS = {
  home:  '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
  cal:   '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  list:  '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  box:   '<path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  login: '<path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M15 12H3"/>',
  edit:  '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
  menu:  '<path d="M3 6h18M3 12h18M3 18h18"/>',
  x:     '<path d="M5 5l14 14M19 5L5 19"/>',
  user:  '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-3.5 3-5.5 7-5.5s7 2 7 5.5M16 4.5a3.5 3.5 0 010 7M22 20c0-2.5-1.5-4.2-4-5"/>',
  card:  '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
  grid:  '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
  chart: '<path d="M3 3v18h18"/><path d="M8 16v-5M13 16V7M18 16v-8"/>',
  gear:  '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
  door:  '<path d="M5 21V3h14v18M3 21h18"/><circle cx="15" cy="12" r="1"/>',
  plus:  '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
  tag:   '<path d="M3 12V3h9l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1"/>',
  logout:'<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/>'
};

export const icon = n => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n]}</svg>`;

/* [key, label, icon]. Keys match ROUTES. */
export const NAV_ITEMS = [
  ['home',   'Home',           'home'],
  ['book',   'Book a Studio',  'cal'],
  ['rent',   'Rent Equipment', 'music'],
  ['mybook', 'My Bookings',    'list'],
  ['myrent', 'My Rental',      'box']
];

/* Owner and staff sidebar. [tab id, label, icon, ownerOnly]. Links are
   #hashes handled by admin.js, so they never leave pages/admin.html. */
export const ADMIN_NAV = [
  ['a-over', 'Overview',          'grid'],
  ['a-onb',  'Onsite Booking',    'plus'],
  ['a-onr',  'Onsite Rental',     'tag'],
  ['a-book', 'Bookings',          'cal'],
  ['a-sess', 'Studio Sessions',   'clock'],
  ['a-eqp',  'Equipment',         'music'],
  ['a-rent', 'Rentals',           'box'],
  ['a-pay',  'Payments',          'card'],
  ['a-cust', 'Customers',         'users'],
  ['a-stud', 'Studio Management', 'door',  true],
  ['a-rep',  'Reports',           'chart', true],
  ['a-set',  'Settings',          'gear',  true]
];

export function injectChrome() {
  const isAdmin = document.body.dataset.role === 'admin';
  const user = getUser();
  const navList = isAdmin
    ? ADMIN_NAV.filter(n => !n[3] || (user && user.role === 'owner'))
    : NAV_ITEMS;
  document.body.classList.add('hasside');
  document.body.insertAdjacentHTML('afterbegin', `
    <div class="mbar">
      <button id="mb-open" aria-label="Open menu">${icon('menu')}</button>
      <span class="mb-brand"><img src="${ASSETS}img/logo.png" alt=""> Tower of Dove</span>
      <button id="mb-user" aria-label="${getUser() ? 'Account' : 'Log in'}" ${getUser() ? '' : 'data-route="login"'}>${icon('user')}</button>
    </div>
    <div class="scrim" id="scrim"></div>
    <aside class="pubside" id="pubside" aria-label="Main navigation">
      <button class="ps-x" id="ps-x" aria-label="Close menu">${icon('x')}</button>
      <div class="ps-menu" id="ps-toggle" role="button" tabindex="0" aria-label="Expand or collapse menu" aria-expanded="true">${icon('menu')}</div>
      <ul class="ps-links" id="ps-main">
        ${navList.map(([key, label, ic]) => `
        <li data-side="${key}">
          <div class="curve-top"></div>
          <a href="${isAdmin ? '#' + key : '#'}" ${isAdmin ? '' : `data-route="${key}"`}><span class="ico">${icon(ic)}</span><span class="lbl">${label}</span></a>
          <div class="curve-bottom"></div>
        </li>`).join('')}
      </ul>
      <ul class="ps-links ps-auth" id="ps-auth">
        ${getUser() ? `
        <li><a href="#" ${isAdmin ? 'aria-current="page"' : 'data-route="mybook"'}><span class="ico">${icon('user')}</span><span class="lbl">${esc(getUser().label)}</span></a></li>
        <li><a href="#" id="logout"><span class="ico">${icon('logout')}</span><span class="lbl">Log out</span></a></li>` : `
        <li><a href="#" data-route="login"><span class="ico">${icon('login')}</span><span class="lbl">Log in</span></a></li>
        <li><a href="#" data-route="register"><span class="ico">${icon('edit')}</span><span class="lbl">Register</span></a></li>`}
      </ul>
      <div class="ps-logo">
        <img src="${ASSETS}img/logo.png" alt="Tower of Dove logo">
        <div class="ps-title">Tower of Dove</div>
      </div>
    </aside>`);

  const setDrawer = open => {
    $('#pubside').classList.toggle('open', open);
    $('#scrim').classList.toggle('on', open);
  };
  const toggleSidebar = () => {
    const collapsed = $('#pubside').classList.toggle('collapsed');
    document.body.classList.toggle('sc', collapsed);
    $('#ps-toggle').setAttribute('aria-expanded', String(!collapsed));
  };

  $('#ps-toggle').addEventListener('click', toggleSidebar);
  $('#ps-toggle').addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSidebar(); }
  });
  $('#mb-open').addEventListener('click', () => setDrawer(true));
  $('#ps-x').addEventListener('click', () => setDrawer(false));
  $('#scrim').addEventListener('click', () => setDrawer(false));
  $('#pubside').addEventListener('click', e => { if (e.target.closest('a')) setDrawer(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') setDrawer(false); });

  // every [data-route] link or button in the page
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-route]');
    if (!el) return;
    e.preventDefault();
    navigate(el.dataset.route);
  });

  const lo = $('#logout');
  if (lo) lo.addEventListener('click', e => { e.preventDefault(); logout(); });

  setActiveNav(document.body.dataset.active);
}

/* Highlight a sidebar item by its key (home, book, rent, mybook, myrent). */
export function setActiveNav(key) {
  $$('#ps-main li').forEach(li => li.classList.toggle('active', li.dataset.side === key));
}
