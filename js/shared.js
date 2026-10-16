/* =====================================================================
   Tower of Dove Music Studio: shared code (loaded by every page)
   ---------------------------------------------------------------------
   1. CONFIG      page links, studios, equipment, demo bookings
   2. HELPERS     DOM, formatting, dates, toast
   3. SLOT HOLDS  temporary locks while someone fills in a booking form
   4. NAVIGATION  sidebar, mobile drawer, navigate()
   (also: SESSION  getUser / setUser / logout)
   Load this file first, then the page's own script.
   ===================================================================== */


/* ============================ 1. CONFIG ============================ */

/* Site root, worked out from where this script was loaded (js/shared.js),
   so links work from index.html and from pages/. Routes are relative to it. */
const ROOT = new URL('../', document.currentScript.src).href;
const ASSETS = ROOT + 'assets/';

/* Where each link goes. Set a URL when you build that page.
   Query params are added automatically, for example
   book -> pages/customer.html?studio=A&date=2026-10-15&time=3:00 PM#book
   A route set to null shows a short "connect this page" message. */
const ROUTES = {
  home:     'index.html',
  book:     'pages/customer.html#book',
  rent:     'pages/customer.html#rent',
  mybook:   'pages/customer.html#my-bookings',
  myrent:   'pages/customer.html#my-rentals',
  login:    'pages/login.html#login',
  register: 'pages/login.html#register',
  admin:    'pages/admin.html#a-over'   // owner and staff dashboard
};

/* Studios. status: Available | Occupied | Maintenance | Unavailable
   c1 / c2 are the gradient colours used until you add real photos. */
const STUDIOS = [
  { id: 'A', desc: 'Drum and full band room',  rate: 350, status: 'Available',   c1: '#C92C3E', c2: '#3D0C14' },
  { id: 'B', desc: 'Vocal and acoustic booth', rate: 250, status: 'Occupied',    c1: '#C98512', c2: '#33220A' },
  { id: 'C', desc: 'Mid-size band room',       rate: 300, status: 'Available',   c1: '#8E161F', c2: '#1E0A0F' },
  { id: 'D', desc: 'Production room',          rate: 280, status: 'Maintenance', c1: '#4A4A55', c2: '#16161A' }
];

/* Equipment. addon = rentable inside the studio (price per session),
   outside = rentable to take away (price per day, 8 hrs minimum).
   Optional fields: img (image URL), desc (short description). */
const drumSet = (name, kit, vip, price) => ({
  name, category: 'Drums', addonPrice: price, outsidePrice: price,
  stock: 1, addon: true, outside: true, drum: { kit, vip }
});
const EQUIPMENT = [
  { name: 'Electric guitar',     category: 'Guitars',    addonPrice: 100, outsidePrice: 250, stock: 4, addon: true, outside: true },
  { name: 'Guitar amplifier',    category: 'Amplifiers', addonPrice: 150, outsidePrice: 350, stock: 4, addon: true, outside: true },
  drumSet('Set A Drum Set', 'RDX drum set', false, 2700),
  drumSet('Set B Drum Set', 'RDX drum set', true,  3000),
  drumSet('Set C Drum Set', 'Steely drum set (high-end model)', false, 2500),
  drumSet('Set D Drum Set', 'Steely drum set (high-end model)', true,  2800),
  { name: 'Drum kit add-ons',    category: 'Drums',      addonPrice: 120, outsidePrice: 0,   stock: 2, addon: true, outside: false },
  { name: 'Keyboard',            category: 'Keyboards',  addonPrice: 200, outsidePrice: 500, stock: 1, addon: true, outside: true },
  { name: 'Multi-effects pedal', category: 'Effects',    addonPrice: 80,  outsidePrice: 150, stock: 3, addon: true, outside: true }
];

/* Bookable hourly slots (10:00 AM to 9:00 PM start times). */
const SLOTS = ['10:00 AM', '11:00 AM', '12:00 PM', '1:00 PM', '2:00 PM', '3:00 PM',
               '4:00 PM', '5:00 PM', '6:00 PM', '7:00 PM', '8:00 PM', '9:00 PM'];


/* ============================ 2. HELPERS ============================ */

const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const esc  = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const peso = n => '₱' + n.toLocaleString('en-US');
const badge = status => `<span class="b ${status.toLowerCase().replace(/ /g, '')}">${status}</span>`;
const isClosed = s => s.status === 'Maintenance' || s.status === 'Unavailable';
const studioIndex = id => STUDIOS.findIndex(s => s.id === id);
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const pad = n => String(n).padStart(2, '0');
const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayOffset = n => { const d = new Date(); d.setDate(d.getDate() + n); return toISO(d); };
const TODAY = dayOffset(0);
const longDate  = iso => new Date(iso + 'T00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
const shortDate = iso => new Date(iso + 'T00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/* "2:00 PM" + 2 hours -> "4:00 PM" */
function endTime(startLabel, hours) {
  const h = 10 + SLOTS.indexOf(startLabel) + hours;
  return `${h % 12 || 12}:00 ${h < 12 ? 'AM' : 'PM'}`;
}

let toastTimer;
function toast(message) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
}

/* DEMO bookings so the calendar and availability check have something to show.
   status: Pending | Confirmed | Active | Completed | Cancelled
   mine: true = shown under "My bookings" for the signed-in customer.
   Replace this with a fetch() to your backend. */
const BOOKINGS = [
  { ref: 'TOD-1043', studio: 'B', date: dayOffset(0),  start: '1:00 PM',  hours: 3, status: 'Active',    payment: 'Verified', mine: true  },
  { ref: 'TOD-1042', studio: 'A', date: dayOffset(1),  start: '2:00 PM',  hours: 2, status: 'Confirmed', payment: 'Verified', mine: true  },
  { ref: 'TOD-1044', studio: 'C', date: dayOffset(0),  start: '6:00 PM',  hours: 2, status: 'Pending',   payment: 'Pending',  mine: false },
  { ref: 'TOD-1045', studio: 'A', date: dayOffset(3),  start: '10:00 AM', hours: 1, status: 'Pending',   payment: 'Pending',  mine: true  },
  { ref: 'TOD-1046', studio: 'D', date: dayOffset(-2), start: '4:00 PM',  hours: 2, status: 'Completed', payment: 'Verified', mine: true  },
  { ref: 'TOD-1047', studio: 'B', date: dayOffset(4),  start: '3:00 PM',  hours: 2, status: 'Cancelled', payment: 'Rejected', mine: true  },
  { ref: 'TOD-1048', studio: 'A', date: dayOffset(0),  start: '2:00 PM',  hours: 2, status: 'Confirmed', payment: 'Verified', mine: false }
];

/* Slot indexes already taken for a studio on a date.
   ignoreRef lets a booking ignore itself (used when rescheduling). */
function takenSlots(studioIdx, dateISO, ignoreRef) {
  const taken = new Set();
  const id = STUDIOS[studioIdx].id;

  BOOKINGS.forEach(b => {
    if (b.studio === id && b.date === dateISO && b.status !== 'Cancelled' && b.ref !== ignoreRef) {
      const first = SLOTS.indexOf(b.start);
      for (let h = 0; h < b.hours; h++) taken.add(first + h);
    }
  });

  // hours currently held by another customer's open booking form
  const locks = readLocks(), now = Date.now();
  for (const key in locks) {
    const [sid, d, idx] = key.split('|');
    if (locks[key].x > now && locks[key].o !== ME && sid === id && d === dateISO) taken.add(+idx);
  }
  return taken;
}


/* ============================ 3. SLOT HOLDS ============================
   lockAcquire claims every hour or none, so two customers can never hold
   the same hour. Holds expire (LOCK_TTL) and are mirrored to localStorage
   so other browser tabs see them. In production do this on the server. */

const ME = Math.random().toString(36).slice(2);
const LOCK_TTL = 2 * 60 * 1000;
const LOCK_KEY = 'tod_locks';

const readLocks  = () => { try { return JSON.parse(localStorage.getItem(LOCK_KEY) || '{}'); } catch (e) { return {}; } };
const writeLocks = o  => { try { localStorage.setItem(LOCK_KEY, JSON.stringify(o)); } catch (e) { /* storage blocked */ } };

function lockAcquire(keys, who) {
  const locks = readLocks(), now = Date.now();
  for (const k in locks) if (locks[k].x < now || locks[k].o === who) delete locks[k];
  if (keys.some(k => locks[k])) return false;
  keys.forEach(k => (locks[k] = { o: who, x: now + LOCK_TTL }));
  writeLocks(locks);
  return true;
}
function lockRelease(who) {
  const locks = readLocks();
  for (const k in locks) if (locks[k].o === who) delete locks[k];
  writeLocks(locks);
}
const lockKeys = (studioIdx, date, first, hours) =>
  Array.from({ length: hours }, (_, j) => `${STUDIOS[studioIdx].id}|${date}|${first + j}`);


/* ============================ SESSION ============================
   DEMO: the signed-in user is kept in localStorage so every page can show
   who is logged in. Replace with a real server session in production. */
const SESSION_KEY = 'tod_user';
const getUser = () => { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { return null; } };
const setUser = u => { try { localStorage.setItem(SESSION_KEY, JSON.stringify(u)); } catch (e) { /* storage blocked */ } };
const clearUser = () => { try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* storage blocked */ } };
function logout() { clearUser(); navigate('home'); }


/* ============================ 4. NAVIGATION ============================ */

/* Go to another page (see ROUTES). If the target is the page you are
   already on, scroll or switch the hash instead of reloading. */
function navigate(key, params = {}) {
  const url = ROUTES[key];
  if (!url) { toast(`Connect this page: set ROUTES.${key} in shared.js.`); return; }

  const [path, hash = ''] = url.split('#');
  const q = new URLSearchParams(params).toString();
  const target = new URL(ROOT + path + (q ? '?' + q : '') + (hash ? '#' + hash : ''), location.href);

  if (target.pathname === location.pathname && target.search === location.search) {
    if (target.hash && target.hash !== location.hash) location.hash = target.hash;
    else scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
    return;
  }
  location.href = target.href;
}

function goBook(studioIndex, date, time) {
  const params = {};
  if (studioIndex !== undefined && studioIndex !== null && studioIndex !== '') params.studio = STUDIOS[+studioIndex].id;
  if (date) params.date = date;
  if (time) params.time = time;
  navigate('book', params);
}
function goRent(itemIndex) {
  navigate('rent', itemIndex !== undefined ? { item: itemIndex } : {});
}

const ICONS = {
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
const icon = n => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n]}</svg>`;

/* [key, label, icon]. Keys match ROUTES. */
const NAV_ITEMS = [
  ['home',   'Home',           'home'],
  ['book',   'Book a Studio',  'cal'],
  ['rent',   'Rent Equipment', 'music'],
  ['mybook', 'My Bookings',    'list'],
  ['myrent', 'My Rental',      'box']
];

/* Owner and staff sidebar. [tab id, label, icon, ownerOnly]. Links are
   #hashes handled by admin.js, so they never leave pages/admin.html. */
const ADMIN_NAV = [
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

function injectChrome() {
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
function setActiveNav(key) {
  $$('#ps-main li').forEach(li => li.classList.toggle('active', li.dataset.side === key));
}

injectChrome();
