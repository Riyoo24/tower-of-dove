/* =====================================================================
   Tower of Dove Music Studio: landing page
   ---------------------------------------------------------------------
   1. CONFIG      page links, studios, equipment, demo bookings
   2. HELPERS
   3. RENDERING   studio cards, equipment cards, carousel
   4. AVAILABILITY  the quick "Check availability" bar
   5. NAVIGATION  sidebar, mobile drawer, button routing
   ===================================================================== */


/* ============================ 1. CONFIG ============================ */

/* Where each link goes. Set a URL when you build that page.
   While a route is null, "book" and "rent" scroll to the matching section
   on this page and every other link shows a short message.
   "book" receives ?studio=A&date=2026-10-15&time=3:00 PM when known.
   "rent" receives ?item=2 (the index of the equipment card). */
const ROUTES = {
  book:     null,   // e.g. 'booking.html'
  rent:     null,   // e.g. 'rental.html'
  mybook:   null,   // e.g. 'my-bookings.html'
  myrent:   null,   // e.g. 'my-rentals.html'
  login:    null,   // e.g. 'login.html'
  register: null    // e.g. 'register.html'
};

/* Studios. status: Available | Occupied | Maintenance | Unavailable
   c1 / c2 are the gradient colours used until you add real photos. */
const STUDIOS = [
  { id: 'A', desc: 'Drum and full band room',   rate: 350, status: 'Available',   c1: '#C92C3E', c2: '#3D0C14' },
  { id: 'B', desc: 'Vocal and acoustic booth',  rate: 250, status: 'Occupied',    c1: '#C98512', c2: '#33220A' },
  { id: 'C', desc: 'Mid-size band room',        rate: 300, status: 'Available',   c1: '#8E161F', c2: '#1E0A0F' },
  { id: 'D', desc: 'Production room',           rate: 280, status: 'Maintenance', c1: '#4A4A55', c2: '#16161A' }
];

/* Equipment. addon = rentable inside the studio (price per session),
   outside = rentable to take away (price per day, 8 hrs minimum).
   Optional fields: img (image URL), desc (short description). */
const drumSet = (name, kit, vip, price) => ({
  name, category: 'Drums', addonPrice: price, outsidePrice: price,
  stock: 1, addon: true, outside: true, drum: { kit, vip }
});
const EQUIPMENT = [
  { name: 'Electric guitar',    category: 'Guitars',     addonPrice: 100, outsidePrice: 250, stock: 4, addon: true, outside: true },
  { name: 'Guitar amplifier',   category: 'Amplifiers',  addonPrice: 150, outsidePrice: 350, stock: 4, addon: true, outside: true },
  drumSet('Set A Drum Set', 'RDX drum set', false, 2700),
  drumSet('Set B Drum Set', 'RDX drum set', true,  3000),
  drumSet('Set C Drum Set', 'Steely drum set (high-end model)', false, 2500),
  drumSet('Set D Drum Set', 'Steely drum set (high-end model)', true,  2800),
  { name: 'Drum kit add-ons',   category: 'Drums',       addonPrice: 120, outsidePrice: 0,   stock: 2, addon: true, outside: false },
  { name: 'Keyboard',           category: 'Keyboards',   addonPrice: 200, outsidePrice: 500, stock: 1, addon: true, outside: true },
  { name: 'Multi-effects pedal', category: 'Effects',    addonPrice: 80,  outsidePrice: 150, stock: 3, addon: true, outside: true }
];

/* Carousel slides. To use photos, set img: 'images/studio-a.jpg'. */
const SLIDES = [
  { label: 'Studio A',    c1: '#C92C3E', c2: '#3D0C14', img: null },
  { label: 'Studio B',    c1: '#C98512', c2: '#33220A', img: null },
  { label: 'Studio C',    c1: '#8E161F', c2: '#1E0A0F', img: null },
  { label: 'Studio D',    c1: '#4A4A55', c2: '#16161A', img: null },
  { label: 'Rental gear', c1: '#6E0F1C', c2: '#0B0B0D', img: null }
];

/* Bookable hourly slots. */
const SLOTS = ['10:00 AM', '11:00 AM', '12:00 PM', '1:00 PM', '2:00 PM', '3:00 PM',
               '4:00 PM', '5:00 PM', '6:00 PM', '7:00 PM', '8:00 PM', '9:00 PM'];

/* DEMO bookings so "Check availability" has something to show.
   Dates are relative to today (0 = today). Replace this with a fetch()
   to your backend that returns each studio's existing bookings. */
const BOOKINGS = [
  { studio: 'A', day: 0, start: '2:00 PM',  hours: 2 },
  { studio: 'B', day: 0, start: '1:00 PM',  hours: 3 },
  { studio: 'C', day: 0, start: '6:00 PM',  hours: 2 },
  { studio: 'A', day: 1, start: '10:00 AM', hours: 1 },
  { studio: 'B', day: 2, start: '3:00 PM',  hours: 2 }
];


/* ============================ 2. HELPERS ============================ */

const $  = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const esc = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const peso = n => '₱' + n.toLocaleString('en-US');
const badge = status => `<span class="b ${status.toLowerCase().replace(/ /g, '')}">${status}</span>`;
const isClosed = s => s.status === 'Maintenance' || s.status === 'Unavailable';
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const pad = n => String(n).padStart(2, '0');
const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayOffset = n => { const d = new Date(); d.setDate(d.getDate() + n); return toISO(d); };
const longDate = iso => new Date(iso + 'T00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

let toastTimer;
function toast(message) {
  const t = $('#toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
}

/* Returns a Set of slot indexes already taken for a studio on a date. */
function takenSlots(studioIndex, dateISO) {
  const taken = new Set();
  const id = STUDIOS[studioIndex].id;
  BOOKINGS.forEach(b => {
    if (b.studio === id && dayOffset(b.day) === dateISO) {
      const first = SLOTS.indexOf(b.start);
      for (let h = 0; h < b.hours; h++) taken.add(first + h);
    }
  });
  return taken;
}


/* ============================ 3. RENDERING ============================ */

const IMAGE_ICON =
  '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/>' +
  '<circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-8 8"/></svg>';

const studioThumb = s =>
  `<div class="ph" style="background:linear-gradient(135deg,${s.c1},${s.c2})">${s.id}</div>`;

const equipmentImage = e => e.img
  ? `<div class="eqimg has"><img src="${esc(e.img)}" alt="${esc(e.name)}"></div>`
  : `<div class="eqimg" role="img" aria-label="No image yet">${IMAGE_ICON}</div>`;

function renderStudioOptions() {
  $('#qs').innerHTML = STUDIOS
    .map((s, i) => `<option value="${i}">Studio ${s.id}, ${peso(s.rate)}/hr</option>`)
    .join('');
}

function renderStudios() {
  $('#studio-grid').innerHTML = STUDIOS.map((s, i) => {
    const closed = isClosed(s);
    return `
      <div class="card">
        ${studioThumb(s)}
        <div class="row"><h3>Studio ${s.id}</h3>${badge(s.status)}</div>
        <p class="mut">${esc(s.desc)}</p>
        <div class="row" style="margin-top:12px">
          <span><b>${peso(s.rate)}</b> <span class="mut">per hour</span></span>
          <button class="btn gold" data-book-studio="${i}" ${closed ? 'disabled' : ''}>${closed ? 'Closed' : 'Book now'}</button>
        </div>
      </div>`;
  }).join('');
}

function renderEquipment() {
  $('#equipment-grid').innerHTML = EQUIPMENT.map((e, i) => {
    const lines = [];
    if (e.addon)   lines.push(`<div><span class="b addon">Add-on</span> ${peso(e.addonPrice)} ${e.drum ? 'per rental' : 'per session'}</div>`);
    if (e.outside) lines.push(`<div><span class="b out">Outside</span> ${peso(e.outsidePrice)} ${e.drum ? 'per rental' : 'per day, 8 hrs minimum'}</div>`);

    const sub = e.drum
      ? `${e.drum.kit}, ${e.drum.vip ? 'VIP' : 'Basic'} set-up. 8 hrs minimum, no service.`
      : `${e.stock} available`;

    return `
      <div class="card">
        ${equipmentImage(e)}
        <p class="cat">${esc(e.category || '')}</p>
        <h3>${esc(e.name)}</h3>
        ${e.desc ? `<p class="mut" style="margin-top:4px">${esc(e.desc)}</p>` : ''}
        <p class="mut">${esc(sub)}</p>
        <div class="price-lines">${lines.join('')}</div>
        <button class="btn gold full" data-rent-item="${i}">Rent</button>
      </div>`;
  }).join('');
}

/* Carousel: scroll-snap slider with dots and autoplay. */
function initCarousel() {
  const slider = $('#slider'), dots = $('#sdots'), wrap = $('#sw');
  let current = 0, timer;

  slider.innerHTML = SLIDES.map(s => s.img
    ? `<div class="slide"><img src="${esc(s.img)}" alt="${esc(s.label)}"></div>`
    : `<div class="slide" style="background:linear-gradient(135deg,${s.c1},${s.c2})">${esc(s.label)}</div>`
  ).join('');
  dots.innerHTML = SLIDES.map((_, i) => `<button aria-label="Slide ${i + 1}"></button>`).join('');

  const mark = () => [...dots.children].forEach((d, i) => d.classList.toggle('active', i === current));
  const goTo = i => {
    if (!slider.clientWidth) return;
    current = i;
    slider.scrollTo({ left: i * slider.clientWidth, behavior: reducedMotion() ? 'auto' : 'smooth' });
    mark();
  };
  const start = () => {
    clearInterval(timer);
    if (!reducedMotion()) timer = setInterval(() => goTo((current + 1) % SLIDES.length), 3500);
  };

  slider.addEventListener('scroll', () => {
    const n = Math.round(slider.scrollLeft / (slider.clientWidth || 1));
    if (n !== current) { current = n; mark(); }
  });
  dots.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b) { goTo([...dots.children].indexOf(b)); start(); }
  });
  wrap.addEventListener('mouseenter', () => clearInterval(timer));
  wrap.addEventListener('mouseleave', start);
  wrap.addEventListener('touchstart', () => clearInterval(timer), { passive: true });
  wrap.addEventListener('touchend', start);

  mark();
  start();
}


/* ============================ 4. AVAILABILITY ============================ */

function checkAvailability() {
  const i = +$('#qs').value, studio = STUDIOS[i];
  const date = $('#qd').value, time = $('#qt').value;
  const box = $('#avail');

  box.hidden = false;
  box.dataset.studio = i;
  box.dataset.date = date;

  if (!date) {
    box.innerHTML = '<div class="card"><h3>Pick a date</h3><p class="mut">Choose a date, then check availability again.</p></div>';
    return;
  }

  const taken = takenSlots(i, date);
  const openTimes = SLOTS.filter((_, k) => !taken.has(k));
  let html;

  if (isClosed(studio)) {
    const others = STUDIOS.map((s, k) => [s, k]).filter(([s]) => !isClosed(s));
    html = `
      <div class="row"><h3>Studio ${studio.id} is closed</h3>${badge(studio.status)}</div>
      <p class="mut">It is not taking bookings right now. These studios are open:</p>
      <div>${others.map(([s, k]) => `<button class="chip" data-pick-studio="${k}">Studio ${s.id}, ${peso(s.rate)}/hr</button>`).join('')}</div>`;
  } else if (openTimes.includes(time)) {
    html = `
      <div class="row"><h3>Studio ${studio.id} is free on ${longDate(date)} at ${time}</h3>${badge('Available')}</div>
      <p class="mut">${peso(studio.rate)} per hour. ${esc(studio.desc)}.</p>
      <div><button class="btn gold" data-book-time="${esc(time)}">Book this slot</button></div>`;
  } else {
    html = `
      <div class="row"><h3>Studio ${studio.id} is booked on ${longDate(date)} at ${time}</h3><span class="b unavailable">Booked</span></div>
      <p class="mut">${openTimes.length ? 'These times are still open that day. Pick one to continue.' : 'Nothing is open that day. Try another date or studio.'}</p>
      <div>${openTimes.map(t => `<button class="chip" data-book-time="${esc(t)}">${t}</button>`).join('')}</div>`;
  }

  box.innerHTML = `<div class="card">${html}</div>`;
}

function initAvailability() {
  const today = dayOffset(0);
  $('#qd').value = today;
  $('#qd').min = today;

  $('#qb-check').addEventListener('click', checkAvailability);

  // re-run the check automatically if the person changes a field afterwards
  ['#qs', '#qd', '#qt'].forEach(sel =>
    $(sel).addEventListener('change', () => { if (!$('#avail').hidden) checkAvailability(); })
  );

  $('#avail').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const box = $('#avail');
    if (b.dataset.bookTime !== undefined) {
      goBook(box.dataset.studio, box.dataset.date, b.dataset.bookTime);
    } else if (b.dataset.pickStudio !== undefined) {
      $('#qs').value = b.dataset.pickStudio;
      checkAvailability();
    }
  });
}


/* ============================ 5. NAVIGATION ============================ */

/* Go to another page (see ROUTES). Pure scroll fallbacks keep the demo usable. */
function navigate(key, params = {}) {
  const url = ROUTES[key];
  const hasParams = Object.keys(params).length > 0;

  if (url) {
    const q = new URLSearchParams(params).toString();
    location.href = q ? url + (url.includes('?') ? '&' : '?') + q : url;
    return;
  }
  if (key === 'home') {
    scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
    return;
  }
  const sectionFallback = { book: '#studios', rent: '#equipment' }[key];
  if (sectionFallback && !hasParams) {
    $(sectionFallback).scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth' });
    return;
  }
  toast(`Connect this page: set ROUTES.${key} in script.js.`);
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

/* Sidebar collapse (desktop) */
function toggleSidebar() {
  const collapsed = $('#pubside').classList.toggle('collapsed');
  document.body.classList.toggle('sc', collapsed);
  $('#ps-toggle').setAttribute('aria-expanded', String(!collapsed));
}

/* Mobile drawer */
function setDrawer(open) {
  $('#pubside').classList.toggle('open', open);
  $('#scrim').classList.toggle('on', open);
}

function initNavigation() {
  $('#ps-toggle').addEventListener('click', toggleSidebar);
  $('#ps-toggle').addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSidebar(); }
  });

  $('#mb-open').addEventListener('click', () => setDrawer(true));
  $('#ps-x').addEventListener('click', () => setDrawer(false));
  $('#scrim').addEventListener('click', () => setDrawer(false));
  $('#pubside').addEventListener('click', e => { if (e.target.closest('a')) setDrawer(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') setDrawer(false); });

  // every [data-route] link or button
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-route]');
    if (!el) return;
    e.preventDefault();
    navigate(el.dataset.route);
  });

  // buttons inside the generated cards
  $('#studio-grid').addEventListener('click', e => {
    const b = e.target.closest('[data-book-studio]');
    if (b) goBook(b.dataset.bookStudio);
  });
  $('#equipment-grid').addEventListener('click', e => {
    const b = e.target.closest('[data-rent-item]');
    if (b) goRent(b.dataset.rentItem);
  });
}


/* ============================ START ============================ */

renderStudioOptions();
renderStudios();
renderEquipment();
initCarousel();
initAvailability();
initNavigation();
