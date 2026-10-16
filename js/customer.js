/* =====================================================================
   Tower of Dove Music Studio: customer page (pages/customer.html)
   Data, helpers, slot holds, sidebar and navigation live in shared.js.
   ---------------------------------------------------------------------
   1. STATE & TABS
   2. BOOK A STUDIO   studio picker, calendar, booking form
   3. RENT EQUIPMENT  equipment cards, rental summary, request
   4. MY BOOKINGS     table, details, reschedule, cancel, guest lookup
   5. MY RENTAL
   6. START
   ===================================================================== */


/* ============================ 1. STATE & TABS ============================ */

/* DEMO rentals so "My rental" has rows. Replace with data from your backend.
   type: 'addon' (tied to a booking) | 'out' (taken outside the studio)
   status: Pending | Approved | In Use | Returned | Rejected */
const RENTALS = [
  { ref: 'TOD-1043', item: 'Electric guitar',     qty: 1, type: 'addon', when: `${shortDate(dayOffset(0))}, 1:00 PM`,  ret: `${shortDate(dayOffset(0))}, 4:00 PM`,  status: 'In Use'   },
  { ref: 'TOD-1043', item: 'Guitar amplifier',    qty: 1, type: 'addon', when: `${shortDate(dayOffset(0))}, 1:00 PM`,  ret: `${shortDate(dayOffset(0))}, 4:00 PM`,  status: 'In Use'   },
  { ref: 'TOD-1042', item: 'Keyboard',            qty: 1, type: 'addon', when: `${shortDate(dayOffset(1))}, 2:00 PM`,  ret: `${shortDate(dayOffset(1))}, 4:00 PM`,  status: 'Pending'  },
  { ref: 'OUT-2003', item: 'Set B Drum Set',      qty: 1, type: 'out',   when: `${shortDate(dayOffset(3))} to ${shortDate(dayOffset(4))}`, ret: shortDate(dayOffset(4)), status: 'Approved' },
  { ref: 'TOD-1046', item: 'Multi-effects pedal', qty: 1, type: 'addon', when: `${shortDate(dayOffset(-2))}, 4:00 PM`, ret: `${shortDate(dayOffset(-2))}, 6:00 PM`, status: 'Returned' }
];
let outCounter = 2005;            // last OUT- reference number used

const firstOpenStudio = Math.max(0, STUDIOS.findIndex(s => !isClosed(s)));
let selStudio = firstOpenStudio;  // studio picked in the booking tab
let selDate = TODAY;              // day picked on the calendar
let calMonth = new Date();        // month shown on the calendar
calMonth.setDate(1);
let draft = null;                 // booking form in progress
let idleUntil = 0, idleTimer = 0;
let rentMode = 'addon';           // 'addon' | 'out'
let cart = {};                    // { equipmentIndex: { q: quantity } }

/* The sidebar links use #book, #rent, #my-bookings and #my-rentals. */
const TABS = { 'book': 'c-book', 'rent': 'c-rent', 'my-bookings': 'c-bk', 'my-rentals': 'c-rental' };
const NAV_KEY = { 'book': 'book', 'rent': 'rent', 'my-bookings': 'mybook', 'my-rentals': 'myrent' };

function showTab() {
  const name = TABS[location.hash.slice(1)] ? location.hash.slice(1) : 'book';
  $$('.pg').forEach(p => p.classList.toggle('on', p.id === TABS[name]));
  setActiveNav(NAV_KEY[name]);
  scrollTo(0, 0);
}

const table = (head, rows) =>
  `<table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead>` +
  `<tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

/* Shared dialog for details, reschedule and cancel */
const dlg = $('#dlg');
function showDialog(html) {
  dlg.innerHTML = `<div class="in">${html}</div>`;
  dlg.showModal();
}
dlg.addEventListener('click', e => {
  if (e.target === dlg || e.target.closest('[data-close]')) dlg.close();   // backdrop or any [data-close] button
});


/* ============================ 2. BOOK A STUDIO ============================ */

const studioThumb = s =>
  `<div class="ph" style="background:linear-gradient(135deg,${s.c1},${s.c2})">${s.id}</div>`;

function renderBook() {
  $('#cs').innerHTML = STUDIOS.map((s, i) => `
    <div class="card pick ${i === selStudio ? 'sel' : ''}" data-i="${i}">
      ${studioThumb(s)}
      <div class="row"><h3>Studio ${s.id}</h3>${badge(s.status)}</div>
      <p class="mut">${esc(s.desc)}</p>
      <p style="margin-top:6px"><b>${peso(s.rate)}</b> <span class="mut">per hour</span></p>
    </div>`).join('');

  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  const firstWeekday = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  $('#cal-t').textContent = calMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) + ', Studio ' + STUDIOS[selStudio].id;

  let html = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => `<small class="mut">${d}</small>`).join('')
           + '<span></span>'.repeat(firstWeekday);
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${y}-${pad(m + 1)}-${pad(d)}`;
    const n = takenSlots(selStudio, ds).size;
    const cls = ds === selDate ? 'sel' : n >= SLOTS.length ? 'full' : n ? 'part' : '';
    html += `<button class="cd ${cls}" data-d="${ds}" ${ds < TODAY ? 'disabled' : ''}>${d}<i>${n ? n + 'h' : ''}</i></button>`;
  }
  $('#cal').innerHTML = html;

  const occupied = [...takenSlots(selStudio, selDate)].sort((a, b) => a - b);
  $('#dayocc').innerHTML = `<h3 style="font-size:14px">${longDate(selDate)}</h3>` + (occupied.length
    ? `<p class="mut">Occupied: ${occupied.map(i => SLOTS[i]).join(', ')}</p>`
    : '<p class="mut">No occupied times. The whole day is open.</p>');

  $('#bk-now').disabled = isClosed(STUDIOS[selStudio]);
}

function initBookTab() {
  $('#c-book').addEventListener('click', e => {
    const pick = e.target.closest('.pick'), day = e.target.closest('.cd');
    if (pick) selStudio = +pick.dataset.i;
    else if (day) selDate = day.dataset.d;
    else if (e.target.closest('#cal-p')) calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1);
    else if (e.target.closest('#cal-n')) calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1);
    else if (e.target.closest('#bk-now')) return openBook();
    else return;
    renderBook();
  });
}

/* ---- booking form (modal) ---- */
const bkDlg = $('#bkdlg');
const bkError = msg => { const x = $('#bk-e'); x.textContent = msg; x.hidden = !msg; };

function drawSlots() {
  const taken = takenSlots(draft.si, draft.d);
  $('#bk-slots').innerHTML = SLOTS.map((t, i) =>
    `<button type="button" data-i="${i}" class="${i === draft.t ? 'sel' : ''}" ${taken.has(i) ? 'disabled' : ''}>${t}</button>`).join('');
  $('#bk-t').textContent = peso(STUDIOS[draft.si].rate * draft.h);
}

/* Try to hold hours t..t+h for this customer. */
function moveDraft(t, h) {
  if (t + h > SLOTS.length) { bkError('That runs past closing time. Choose a shorter duration.'); return false; }
  if (!lockAcquire(lockKeys(draft.si, draft.d, t, h), ME)) {
    bkError('Those hours were just taken by another customer.');
    drawSlots();
    return false;
  }
  draft.t = t; draft.h = h;
  bkError('');
  drawSlots();
  return true;
}

function openBook(startIndex) {
  const si = selStudio, d = selDate, taken = takenSlots(si, d);
  let t = startIndex;
  if (t == null || t < 0) t = SLOTS.findIndex((_, i) => !taken.has(i));
  if (t < 0 || taken.has(t)) return toast('No free times for that day.');

  const h = (t + 1 < SLOTS.length && !taken.has(t + 1)) ? 2 : 1;
  if (!lockAcquire(lockKeys(si, d, t, h), ME)) return toast('That slot was just taken. Pick another time.');

  draft = { si, d, t, h };
  const s = STUDIOS[si];

  bkDlg.innerHTML = `
    <div class="in">
      <form id="bkf" novalidate>
        <div class="row"><h2 style="margin:0">Book Studio ${s.id}</h2><span class="mut" id="bk-left"></span></div>
        <p class="mut">${longDate(d)}. ${peso(s.rate)} per hour. Your slot is held while this form is open and released after 2 minutes of inactivity.</p>

        <label>Start time</label>
        <div class="slots" id="bk-slots"></div>

        <label for="bk-h">Duration</label>
        <select id="bk-h">${[1, 2, 3, 4].map(x => `<option value="${x}" ${x === h ? 'selected' : ''}>${x} hour${x > 1 ? 's' : ''}</option>`).join('')}</select>

        <label for="bk-n">Name</label>
        <input id="bk-n" autocomplete="name">
        <label for="bk-p">Phone</label>
        <input id="bk-p" placeholder="09XX XXX XXXX" autocomplete="tel">

        <label for="bk-m">Payment method</label>
        <select id="bk-m"><option>GCash</option><option>Cash</option></select>
        <div id="bk-gw">
          <label for="bk-g">GCash reference number</label>
          <input id="bk-g" placeholder="13-digit reference" inputmode="numeric">
        </div>

        <div class="tot"><span>Total</span><span id="bk-t"></span></div>
        <div class="alert" id="bk-e" hidden></div>
        <p class="hold">Payment starts as Pending until staff verify it.</p>
        <div class="acts">
          <button type="button" class="btn line" id="bk-x">Cancel</button>
          <button class="btn gold">Submit booking</button>
        </div>
      </form>
    </div>`;

  drawSlots();
  idleUntil = Date.now() + LOCK_TTL;

  $('#bk-slots').onclick = e => {
    const b = e.target.closest('button');
    if (b && !b.disabled) moveDraft(+b.dataset.i, draft.h);
  };
  $('#bk-h').onchange = e => { if (!moveDraft(draft.t, +e.target.value)) e.target.value = draft.h; };
  $('#bk-m').onchange = e => { $('#bk-gw').hidden = e.target.value !== 'GCash'; };
  $('#bk-x').onclick = () => bkDlg.close();

  // any activity keeps the hold alive
  const keepAlive = () => { idleUntil = Date.now() + LOCK_TTL; if (draft) lockAcquire(lockKeys(draft.si, draft.d, draft.t, draft.h), ME); };
  ['pointerdown', 'keydown', 'input', 'touchstart'].forEach(ev => bkDlg.addEventListener(ev, keepAlive));
  bkDlg.addEventListener('scroll', keepAlive, true);

  clearInterval(idleTimer);
  idleTimer = setInterval(() => {
    const left = idleUntil - Date.now();
    if (left <= 0) { draft.why = 'timeout'; bkDlg.close(); return; }
    $('#bk-left').textContent = `Closes in ${Math.floor(left / 6e4)}:${pad(Math.floor(left / 1e3) % 60)} if idle`;
  }, 1000);

  bkDlg.onclose = () => {
    clearInterval(idleTimer);
    lockRelease(ME);
    const why = draft && draft.why;
    draft = null;
    renderBook();
    if (why === 'timeout') toast('Booking closed after 2 minutes of inactivity. Your slot was released.');
  };

  $('#bkf').onsubmit = ev => {
    ev.preventDefault();
    const name = $('#bk-n').value.trim(), phone = $('#bk-p').value.trim();
    const method = $('#bk-m').value, gcash = $('#bk-g').value.replace(/\s/g, '');

    if (!name) return bkError('Enter your name.');
    if (!/^[\d\s+()-]{7,}$/.test(phone)) return bkError('Enter a valid phone number.');
    if (method === 'GCash' && !/^\d{13}$/.test(gcash)) return bkError('Enter the 13-digit GCash reference.');

    const now = takenSlots(draft.si, draft.d);
    if (Array.from({ length: draft.h }, (_, j) => draft.t + j).some(i => now.has(i))) {
      return bkError('Your slot is no longer available. Pick another time.');
    }

    const ref = addBooking({ si: draft.si, d: draft.d, t: draft.t, h: draft.h, name, phone, method, gcash });
    draft.why = 'done';
    bkDlg.close();
    toast(`Booking ${ref} submitted. Keep this reference to look it up later.`);
  };

  bkDlg.showModal();
}

/* Adds the booking to BOOKINGS. In production, send this to your server. */
function addBooking(o) {
  const next = Math.max(...BOOKINGS.map(b => +b.ref.slice(4))) + 1;
  const ref = 'TOD-' + next;
  BOOKINGS.push({
    ref, studio: STUDIOS[o.si].id, date: o.d, start: SLOTS[o.t], hours: o.h,
    status: 'Pending', payment: 'Pending', mine: true,
    name: o.name, phone: o.phone, method: o.method, gcash: o.gcash
  });
  renderMyBookings();
  renderAttachOptions();
  return ref;
}


/* ============================ 3. RENT EQUIPMENT ============================ */

const IMAGE_ICON =
  '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/>' +
  '<circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-8 8"/></svg>';
const equipmentImage = e => e.img
  ? `<div class="eqimg has"><img src="${esc(e.img)}" alt="${esc(e.name)}"></div>`
  : `<div class="eqimg" role="img" aria-label="No image yet">${IMAGE_ICON}</div>`;

const unitPrice = e => rentMode === 'addon' ? e.addonPrice : e.outsidePrice;

/* Outside rentals are priced per day. Drum sets are per rental. */
function rentDays() {
  const p = $('#pd').value, r = $('#rd').value;
  if (!p || !r) return 1;
  return Math.max(1, Math.round((new Date(r + 'T00:00') - new Date(p + 'T00:00')) / 864e5));
}
function lineTotal(i) {
  const e = EQUIPMENT[i], c = cart[i], unit = unitPrice(e);
  if (e.drum) return unit * c.q;
  return rentMode === 'out' ? unit * c.q * rentDays() : unit * c.q;
}

function renderEquipment() {
  $('#eq').innerHTML = EQUIPMENT.map((e, i) => {
    const offered = rentMode === 'addon' ? e.addon : e.outside;
    const ok = offered && e.stock > 0;
    const unit = e.drum ? 'per rental, 8 hrs minimum' : rentMode === 'addon' ? 'per session' : 'per day, 8 hrs minimum';

    const info = e.drum
      ? `<p class="mut">${esc(e.drum.kit)}, ${e.drum.vip ? 'VIP' : 'Basic'} set-up</p>
         ${e.desc ? `<p class="mut" style="margin-top:4px">${esc(e.desc)}</p>` : ''}
         <details class="dset"><summary>What's included</summary><ul>
           <li>Cymbals (Trojan B8): ${e.drum.vip ? '2 crash, 1 ride, hi-hat, splash' : '1 crash, 1 ride, hi-hat'}</li>
           <li>Hardware: stands, throne, carpet</li>
           <li>Skins: Remo and Evans</li>
           <li>Minimum rent: 8 hours</li>
           <li>No service</li></ul></details>`
      : `${e.desc ? `<p class="mut" style="margin-top:4px">${esc(e.desc)}</p>` : ''}<p class="mut">${e.stock} available</p>`;

    const control = e.drum
      ? '<span class="mut" style="white-space:nowrap">8 hrs</span>'
      : `<input class="qty" type="number" min="1" max="${e.stock}" value="1" aria-label="Quantity" data-q="${i}" ${ok ? '' : 'disabled'}>`;

    return `
      <div class="card" data-eq="${i}" style="${offered ? '' : 'opacity:.55'}">
        ${equipmentImage(e)}
        <p class="cat">${esc(e.category || '')}</p>
        <div class="row"><h3>${esc(e.name)}</h3>${e.stock < 2 && !e.drum ? badge('Low') : ''}</div>
        ${info}
        <p style="margin-top:6px">${e.addon ? '<span class="b addon">Add-on</span> ' : ''}${e.outside ? '<span class="b out">Outside</span>' : ''}</p>
        <div class="row" style="margin-top:10px;flex-wrap:wrap">
          <span><b>${offered ? peso(unitPrice(e)) : 'Not offered'}</b> <span class="mut">${offered ? unit : ''}</span></span>
          <span class="row" style="margin-left:auto">${control}<button class="btn sm" data-add="${i}" ${ok ? '' : 'disabled'}>Add</button></span>
        </div>
      </div>`;
  }).join('');
}

function renderCart() {
  const keys = Object.keys(cart);

  $('#bundle-tag-wrap').innerHTML = rentMode === 'out' && keys.length >= 2
    ? `<div class="bundle-tag">Rental bundle: ${keys.length} items</div>` : '';

  $('#cart').innerHTML = keys.length
    ? keys.map(i => {
        const e = EQUIPMENT[i], c = cart[i];
        const label = e.drum ? `${esc(e.name)} (8 hrs)`
          : rentMode === 'out' ? `${esc(e.name)} x ${c.q} (${rentDays()} day${rentDays() > 1 ? 's' : ''})`
          : `${esc(e.name)} x ${c.q}`;
        return `<li><span>${label} <button class="lk" data-rm="${i}" aria-label="Remove ${esc(e.name)}">Remove</button></span><span>${peso(lineTotal(i))}</span></li>`;
      }).join('')
    : '<li><span class="mut">Nothing added yet</span><span></span></li>';

  $('#ctt').textContent = peso(keys.reduce((sum, i) => sum + lineTotal(i), 0));
}

function renderRentMode() {
  $('#fa').hidden = rentMode !== 'addon';
  $('#fo').hidden = rentMode === 'addon';
  $('#rmh').textContent = rentMode === 'addon'
    ? 'Used inside the studio you booked. Tied to your booking reference. Priced per session; drum sets are priced per rental.'
    : 'Taken out of the studio. Minimum rent is 8 hours. Priced per day; drum sets are priced per rental (8 hours, no service). You get an OUT reference instead of a booking reference.';
  $$('#rm button').forEach(b => b.classList.toggle('on', b.dataset.m === rentMode));
  updateRequestButton();
}

/* Outside rentals need an ID file before the request button unlocks. */
function updateRequestButton() {
  $('#rq').disabled = rentMode === 'out' && !$('#vf').files.length;
}

/* Bookings an add-on can be attached to: upcoming and not cancelled. */
function renderAttachOptions() {
  const usable = BOOKINGS.filter(b => b.mine && b.date >= TODAY && ['Pending', 'Confirmed', 'Active'].includes(b.status));
  $('#lb').innerHTML = usable.length
    ? usable.map(b => `<option value="${b.ref}">${b.ref} - Studio ${b.studio}, ${b.date === TODAY ? 'today' : shortDate(b.date)} ${b.start}</option>`).join('')
    : '<option value="">No upcoming booking. Book a studio first.</option>';
}

function initRentTab() {
  const today = TODAY;
  $('#pd').min = $('#rd').min = today;
  $('#pd').value = dayOffset(1);
  $('#rd').value = dayOffset(2);

  $('#rm').addEventListener('click', e => {
    const m = e.target.dataset.m;
    if (!m) return;
    rentMode = m;
    cart = {};
    renderEquipment();
    renderCart();
    renderRentMode();
  });

  $('#eq').addEventListener('click', e => {
    const btn = e.target.closest('[data-add]');
    if (!btn) return;
    const i = btn.dataset.add, input = $(`[data-q="${i}"]`);
    cart[i] = { q: input ? Math.min(Math.max(+input.value || 1, 1), EQUIPMENT[i].stock) : 1 };
    renderCart();
  });

  $('#cart').addEventListener('click', e => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { delete cart[rm.dataset.rm]; renderCart(); }
  });

  ['#pd', '#rd'].forEach(sel => $(sel).addEventListener('change', renderCart));
  $('#vf').addEventListener('change', updateRequestButton);
  $('#rq').addEventListener('click', requestRental);
}

function requestRental() {
  const keys = Object.keys(cart);
  if (!keys.length) return toast('Add at least one item first.');

  let ref, when, ret;
  if (rentMode === 'addon') {
    const b = BOOKINGS.find(x => x.ref === $('#lb').value);
    if (!b) return toast('Attach the rental to a studio booking first.');
    ref = b.ref;
    when = `${shortDate(b.date)}, ${b.start}`;
    ret = `${shortDate(b.date)}, ${endTime(b.start, b.hours)}`;
  } else {
    const pd = $('#pd').value, rd = $('#rd').value;
    if (!pd || !rd) return toast('Choose a pick-up and return date.');
    if (pd < TODAY) return toast('Pick-up date cannot be in the past.');
    if (rd < pd) return toast('Return date must be on or after the pick-up date.');
    if (!/^[\d\s+()-]{7,}$/.test($('#oc').value.trim())) return toast('Enter a valid contact number.');
    if (!$('#vf').files.length) return toast('Attach a valid ID.');
    ref = 'OUT-' + (++outCounter);
    when = `${shortDate(pd)} to ${shortDate(rd)}`;
    ret = shortDate(rd);
  }

  keys.forEach(i => RENTALS.push({
    ref, item: EQUIPMENT[i].name, qty: cart[i].q, type: rentMode, when, ret, status: 'Pending'
  }));

  cart = {};
  $('#vf').value = '';
  renderCart();
  updateRequestButton();
  renderMyRentals();
  toast(`Rental request ${ref} submitted. Staff will review it. Keep this reference.`);
}


/* ============================ 4. MY BOOKINGS ============================ */

const startsAt = b => new Date(`${b.date}T${pad(10 + SLOTS.indexOf(b.start))}:00`);
const insideCutoff = b => startsAt(b) - Date.now() < 24 * 60 * 60 * 1000;
const findBooking = ref => BOOKINGS.find(b => b.ref === ref);
const normRef = v => v.trim().toUpperCase().replace(/\s+/g, '');
const notFound = (ref, what) =>
  `<div class="alert">No ${what} found for <b>${esc(ref)}</b>. Check the code and try again, or email us.</div>`;
const CUTOFF_MSG = 'Changes and cancellations close 24 hours before your session.';

function renderMyBookings() {
  const mine = BOOKINGS.filter(b => b.mine).sort((a, b) => startsAt(a) - startsAt(b));
  if (!mine.length) {
    $('#mybk').innerHTML = '<p class="mut" style="padding:8px">No bookings yet. Book a studio to get started.</p>';
    return;
  }
  $('#mybk').innerHTML = table(
    ['Reference', 'Studio', 'Date', 'Time', 'Duration', 'Status', 'Payment', ''],
    mine.map(b => {
      const editable = b.status === 'Confirmed' || b.status === 'Pending';
      const actions = editable
        ? `<button class="btn sm" data-act="resched" data-ref="${b.ref}">Reschedule</button><button class="btn sm line" data-act="cancel" data-ref="${b.ref}">Cancel</button>`
        : `<button class="btn sm line" data-act="details" data-ref="${b.ref}">Details</button>`;
      return [b.ref, 'Studio ' + b.studio, shortDate(b.date), b.start, b.hours + (b.hours > 1 ? ' hrs' : ' hr'),
              badge(b.status), badge(b.payment), actions];
    }));
}

function showDetails(b) {
  const s = STUDIOS[studioIndex(b.studio)];
  showDialog(`
    <div class="row"><h2 style="margin:0">${b.ref}</h2>${badge(b.status)}</div>
    <dl class="dl">
      <dt>Studio</dt><dd>Studio ${b.studio}, ${esc(s.desc)}</dd>
      <dt>Date</dt><dd>${longDate(b.date)}</dd>
      <dt>Time</dt><dd>${b.start} to ${endTime(b.start, b.hours)} (${b.hours} hr${b.hours > 1 ? 's' : ''})</dd>
      <dt>Total</dt><dd>${peso(s.rate * b.hours)}</dd>
      <dt>Payment</dt><dd>${badge(b.payment)}</dd>
    </dl>
    <p class="mut">Bookings are confirmed after staff verify your payment.</p>
    <div class="acts"><button class="btn line" data-close>Close</button></div>`);
}

function confirmCancel(b) {
  showDialog(`
    <h2>Cancel ${b.ref}?</h2>
    <p class="mut">Studio ${b.studio}, ${longDate(b.date)} at ${b.start}. The time slot is released for other customers.</p>
    <div class="acts">
      <button class="btn line" data-close>Keep booking</button>
      <button class="btn bad" id="do-cancel">Cancel booking</button>
    </div>`);
  $('#do-cancel').onclick = () => {
    b.status = 'Cancelled';
    dlg.close();
    renderMyBookings();
    renderAttachOptions();
    renderBook();
    toast(`${b.ref} cancelled.`);
  };
}

function openReschedule(b) {
  const si = studioIndex(b.studio), pick = { date: b.date, t: -1 };
  showDialog(`
    <h2>Reschedule ${b.ref}</h2>
    <p class="mut">Studio ${b.studio}, ${b.hours} hr${b.hours > 1 ? 's' : ''}. Pick a new date and start time.</p>
    <label for="rs-d">New date</label>
    <input id="rs-d" type="date" min="${TODAY}" value="${b.date}">
    <label>New start time</label>
    <div class="slots" id="rs-slots"></div>
    <div class="acts">
      <button class="btn line" data-close>Keep current time</button>
      <button class="btn gold" id="rs-save" disabled>Save new time</button>
    </div>`);

  const draw = () => {
    const taken = takenSlots(si, pick.date, b.ref);
    $('#rs-slots').innerHTML = SLOTS.map((t, i) => {
      const fits = i + b.hours <= SLOTS.length && Array.from({ length: b.hours }, (_, j) => !taken.has(i + j)).every(Boolean);
      return `<button type="button" data-i="${i}" class="${i === pick.t ? 'sel' : ''}" ${fits ? '' : 'disabled'}>${t}</button>`;
    }).join('');
    $('#rs-save').disabled = pick.t < 0;
  };
  draw();

  $('#rs-d').onchange = e => { pick.date = e.target.value || b.date; pick.t = -1; draw(); };
  $('#rs-slots').onclick = e => {
    const btn = e.target.closest('button');
    if (btn && !btn.disabled) { pick.t = +btn.dataset.i; draw(); }
  };
  $('#rs-save').onclick = () => {
    b.date = pick.date;
    b.start = SLOTS[pick.t];
    dlg.close();
    renderMyBookings();
    renderBook();
    toast(`${b.ref} moved to ${shortDate(b.date)} at ${b.start}.`);
  };
}

function initBookingsTab() {
  $('#mybk').addEventListener('click', e => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const b = findBooking(btn.dataset.ref);
    if (!b) return;

    if (btn.dataset.act === 'details') return showDetails(b);
    if (insideCutoff(b)) return toast(CUTOFF_MSG);
    if (btn.dataset.act === 'resched') openReschedule(b);
    else if (btn.dataset.act === 'cancel') confirmCancel(b);
  });

  /* Guest lookup by reference code. DEMO: checks the in-page data only. */
  $('#gb-form').addEventListener('submit', e => {
    e.preventDefault();
    const ref = normRef($('#gb-ref').value), b = findBooking(ref), box = $('#gb-res');
    box.hidden = false;
    if (!b) { box.innerHTML = notFound(ref, 'booking'); return; }
    const s = STUDIOS[studioIndex(b.studio)];
    box.innerHTML = `
      <div class="row"><h3>${b.ref}</h3>${badge(b.status)}</div>
      <dl class="dl">
        <dt>Studio</dt><dd>Studio ${b.studio}, ${esc(s.desc)}</dd>
        <dt>Date</dt><dd>${longDate(b.date)}</dd>
        <dt>Time</dt><dd>${b.start} to ${endTime(b.start, b.hours)} (${b.hours} hr${b.hours > 1 ? 's' : ''})</dd>
        <dt>Total</dt><dd>${peso(s.rate * b.hours)}</dd>
        <dt>Payment</dt><dd>${badge(b.payment)}</dd>
      </dl>
      <p class="mut">Bookings are confirmed after staff verify your payment.</p>`;
  });
}


/* ============================ 5. MY RENTAL ============================ */

/* Signed in: show the account tables. Guest: show the reference-code lookup. */
function applyAccessMode() {
  const member = !!getUser();
  $('#bk-member').hidden = !member;  $('#bk-guest').hidden = member;
  $('#rt-member').hidden = !member;  $('#rt-guest').hidden = member;
}

function initRentalLookup() {
  $('#gr-form').addEventListener('submit', e => {
    e.preventDefault();
    const ref = normRef($('#gr-ref').value), list = RENTALS.filter(r => r.ref === ref), box = $('#gr-res');
    box.hidden = false;
    if (!list.length) { box.innerHTML = notFound(ref, 'rental'); return; }
    const type = list[0].type === 'addon' ? '<span class="b addon">Add-on</span>' : '<span class="b out">Outside</span>';
    box.innerHTML = `<div class="row"><h3>${ref}</h3><span>${type}</span></div>
      <div class="tw" style="margin-top:8px">${table(['Equipment', 'Qty', 'Return by', 'Status'],
        list.map(r => [esc(r.item), String(r.qty), r.ret, badge(r.status)]))}</div>`;
  });
}

function renderMyRentals() {
  if (!RENTALS.length) {
    $('#myrent').innerHTML = '<p class="mut" style="padding:8px">No rentals yet.</p>';
    return;
  }
  $('#myrent').innerHTML = table(
    ['Reference', 'Equipment', 'Qty', 'Rent type', 'Session or dates', 'Return date', 'Status'],
    RENTALS.map(r => [
      r.ref, esc(r.item), String(r.qty),
      r.type === 'addon' ? '<span class="b addon">Add-on</span>' : '<span class="b out">Outside</span>',
      r.when, r.ret, badge(r.status)
    ]));
}


/* ============================ 6. START ============================ */

function applyUrlParams() {
  const q = new URLSearchParams(location.search);

  const studio = studioIndex(q.get('studio'));
  if (studio >= 0) selStudio = studio;

  const date = q.get('date');
  if (/^\d{4}-\d{2}-\d{2}$/.test(date || '') && date >= TODAY) {
    selDate = date;
    calMonth = new Date(date + 'T00:00');
    calMonth.setDate(1);
  }

  renderBook();

  const time = q.get('time');
  if (time && SLOTS.includes(time) && !isClosed(STUDIOS[selStudio])) openBook(SLOTS.indexOf(time));

  const item = q.get('item');
  if (item !== null && EQUIPMENT[+item]) {
    const card = $(`#eq [data-eq="${+item}"]`);
    if (card) {
      card.classList.add('hl');
      if (location.hash === '#rent') card.scrollIntoView({ block: 'center' });
    }
  }
}

initBookTab();
initRentTab();
initBookingsTab();
initRentalLookup();
applyAccessMode();

renderEquipment();
renderCart();
renderRentMode();
renderAttachOptions();
renderMyBookings();
renderMyRentals();
showTab();
applyUrlParams();

window.addEventListener('hashchange', showTab);
// another browser tab opened or closed a booking form: refresh what is taken
window.addEventListener('storage', () => { renderBook(); if (draft) drawSlots(); });
