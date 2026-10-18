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

/* Studios and equipment are loaded from Supabase when the page opens (see loadCatalog).
   Page scripts must wait for `dataReady` before using them.
   Studio: { dbId, id: 'A', desc, rate, status, c1, c2 }   status: Available | Maintenance | Unavailable */
const STUDIOS = [];
const EQUIPMENT = [];
const STUDIO_COLORS = [['#C92C3E', '#3D0C14'], ['#C98512', '#33220A'], ['#8E161F', '#1E0A0F'], ['#4A4A55', '#16161A']];

async function loadCatalog() {
  const [st, eq] = await Promise.all([
    sb.from('studio').select('*').order('studio_id'),
    sb.from('v_equipment_stock').select('*').order('equipment_id')
  ]);
  if (st.error || eq.error) {
    console.error(st.error, eq.error);
    toast('Could not load studios and equipment. Check your connection.');
    return;
  }
  STUDIOS.length = 0;
  EQUIPMENT.length = 0;
  st.data.forEach((s, i) => {
    const c = STUDIO_COLORS[i % STUDIO_COLORS.length];
    STUDIOS.push({
      dbId: s.studio_id, id: s.name.replace(/^studio\s*/i, ''), desc: s.description || '',
      rate: +s.hourly_rate, status: s.status, img: s.image, c1: c[0], c2: c[1]
    });
  });
  eq.data.filter(e => e.stock_status !== 'Unavailable').forEach(e => EQUIPMENT.push({   // hidden items are not shown to customers
    id: e.equipment_id, name: e.name, category: e.category_name, desc: e.description, img: e.image,
    addonPrice: +e.add_on_rate || 0, outsidePrice: +e.outside_rate || 0,
    stock: e.stock_status === 'Unavailable' ? 0 : e.available, total: e.total_quantity,
    addon: e.allow_addon, outside: e.allow_outside, minHours: e.min_hours,
    drum: e.is_drum_set ? { kit: e.drum_kit, vip: e.is_vip } : null
  }));
}
const dataReady = loadCatalog();

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

/* The signed-in customer's own bookings (filled by customer.js).
   status: Pending | Confirmed | Active | Completed | Cancelled | Rejected */
const BOOKINGS = [];

/* Taken hours per studio and day, loaded from the database (get_busy_slots).
   Key: 'studioDbId|YYYY-MM-DD'  ->  Set of slot indexes (0 = 10:00 AM). */
const BUSY = {};
const HELD = {};     // same key -> slots that are only being held by someone filling in the booking form (2 minutes)
const BOOKED = {};   // same key -> slots that are really booked

async function loadBusy(studioIdx, fromDate, toDate) {
  const s = STUDIOS[studioIdx];
  if (!s) return;
  for (const k of Object.keys(BUSY)) {
    const [id, d] = k.split('|');
    if (+id === s.dbId && d >= fromDate && d <= toDate) { delete BUSY[k]; delete HELD[k]; delete BOOKED[k]; }
  }
  const { data, error } = await sb.rpc('get_busy_slots', {
    p_studio_id: s.dbId,
    p_from: manilaTS(fromDate, 0),
    p_to: new Date(new Date(manilaTS(toDate, 0)).getTime() + 864e5).toISOString(),
    p_token: HOLD_TOKEN
  });
  if (error) { console.error(error); toast('Could not load availability.'); return; }
  (data || []).forEach(r => {
    const end = new Date(r.end_at).getTime();
    for (let t = new Date(r.start_at).getTime(); t < end; t += 3600e3) {
      const p = manilaParts(new Date(t)), idx = p.hour - 10;
      if (idx < 0 || idx >= SLOTS.length) continue;
      const key = s.dbId + '|' + p.date;
      (BUSY[key] = BUSY[key] || new Set()).add(idx);
      const bucket = r.kind === 'held' ? HELD : BOOKED;
      (bucket[key] = bucket[key] || new Set()).add(idx);
    }
  });
}

/* Has this hour already started or passed (Manila time)? Index 0 = 10:00 AM.
   Bookings must start at a later hour, so the current hour counts as past too. */
function isPastSlot(dateISO, i) {
  const now = manilaParts(new Date());
  return dateISO < now.date || (dateISO === now.date && 10 + i <= now.hour);
}

/* Slots held (not booked) by someone else right now. */
const heldSlots = (studioIdx, dateISO) => new Set(HELD[STUDIOS[studioIdx].dbId + '|' + dateISO] || []);

/* Why can't these hours be used? 'booked' = already booked, 'held' = someone is filling in a booking for them */
function conflictKind(studioIdx, dateISO, first, hours) {
  const booked = BOOKED[STUDIOS[studioIdx].dbId + '|' + dateISO] || new Set();
  for (let i = first; i < first + hours; i++) if (booked.has(i)) return 'booked';
  return 'held';
}

/* Slot indexes already taken for a studio on a date (call loadBusy first).
   ignoreRef lets a booking ignore itself (used when rescheduling). */
function takenSlots(studioIdx, dateISO, ignoreRef) {
  const s = STUDIOS[studioIdx];
  const taken = new Set(BUSY[s.dbId + '|' + dateISO] || []);
  if (ignoreRef) {
    const b = BOOKINGS.find(x => x.ref === ignoreRef);
    if (b && b.studio === s.id && b.date === dateISO) {
      const first = SLOTS.indexOf(b.start);
      for (let h = 0; h < b.hours; h++) taken.delete(first + h);
    }
  }
  return taken;
}


/* ============================ 3. SLOT HOLDS ============================
   While someone fills in a booking form, the hours are held on the server
   for 2 minutes (hold_slot). One token = one browser = one hold at a time. */

/* The token lives in sessionStorage, so reloading the page keeps the same token and the old hold
   is simply replaced (it never shows up as "someone else" to the same person). */
const HOLD_TOKEN = (() => {
  const fresh = () => 'h' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  try {
    let t = sessionStorage.getItem('tod_hold');
    if (!t) { t = fresh(); sessionStorage.setItem('tod_hold', t); }
    return t;
  } catch (e) { return fresh(); }
})();
const ME = HOLD_TOKEN;                  // old name, still used by admin.js
const LOCK_TTL = 2 * 60 * 1000;

/* Hold and release calls run one after another. That way a release can never be overtaken by a
   hold request that was still on its way when the form was closed. */
let holdChain = Promise.resolve();
let holdActive = false;                 // true while this browser may be holding hours
const queueHold = fn => { const run = holdChain.then(fn); holdChain = run.catch(() => {}); return run; };

function holdSlots(studioIdx, date, first, hours) {
  return queueHold(async () => {
    const s = STUDIOS[studioIdx];
    const { data, error } = await sb.rpc('hold_slot', {
      p_studio_id: s.dbId,
      p_start_at: manilaTS(date, 10 + first),
      p_end_at: manilaTS(date, 10 + first + hours),
      p_token: HOLD_TOKEN
    });
    if (error) { console.error(error); return false; }
    holdActive = data === true;
    return data === true;
  });
}
function releaseHold() {
  holdActive = false;
  return queueHold(async () => {
    try { await sb.rpc('release_hold', { p_token: HOLD_TOKEN }); } catch (e) { /* ignore */ }
  });
}

/* Closing the tab, leaving the page or the browser going away: free the hours right away
   (a normal request would be cancelled, so this one is sent with keepalive). */
window.addEventListener('pagehide', () => {
  if (!holdActive) return;
  try {
    fetch(SUPABASE_URL + '/rest/v1/rpc/release_hold', {
      method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY },
      body: JSON.stringify({ p_token: HOLD_TOKEN })
    });
  } catch (e) { /* ignore */ }
});


/* ============================ SESSION ============================
   The real login lives in Supabase Auth. We also keep { role, label } in
   localStorage so the sidebar can render instantly on every page. */
const SESSION_KEY = 'tod_user';
const getUser = () => { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { return null; } };
const setUser = u => { try { localStorage.setItem(SESSION_KEY, JSON.stringify(u)); } catch (e) { /* storage blocked */ } };
const clearUser = () => { try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* storage blocked */ } };
const isMember = () => { const u = getUser(); return !!u && u.role === 'customer'; };

async function logout() {
  try { await sb.auth.signOut(); } catch (e) { /* ignore */ }
  clearUser();
  navigate('home');
}

// the Supabase session ended (expired or signed out elsewhere): forget the cached user
sb.auth.getSession().then(({ data }) => {
  if (!data.session && getUser()) { clearUser(); location.reload(); }
});

// the dashboard is for owner and staff only
if (document.body.dataset.role === 'admin') {
  const u = getUser();
  if (!u || (u.role !== 'owner' && u.role !== 'staff')) location.replace(ROOT + 'pages/login.html#login');
}


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
