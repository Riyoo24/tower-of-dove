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

/* Rentals of the signed-in customer (loaded from the database).
   type: 'addon' (tied to a booking) | 'out' (taken outside the studio)
   status: Pending | Approved | In Use | Returned | Rejected | Cancelled */
let RENTALS = [];
let ADDONS = {};   // booking reference -> [{ name, qty, price }] add-on equipment on that booking

let selStudio = 0;               // studio picked in the booking tab (set once data loads)
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

const studioThumb = s => s.img
  ? `<div class="ph has"><img src="${esc(s.img)}" alt="Studio ${esc(s.id)}" loading="lazy"></div>`
  : `<div class="ph" style="background:linear-gradient(135deg,${s.c1},${s.c2})">${s.id}</div>`;

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

/* Load the month's taken hours from the database, then draw the calendar. */
async function refreshBook() {
  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  await loadBusy(selStudio, `${y}-${pad(m + 1)}-01`, `${y}-${pad(m + 1)}-${pad(new Date(y, m + 1, 0).getDate())}`);
  renderBook();
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
    (day ? renderBook : refreshBook)();
  });
}

/* ---- success pop-up: stays open until the customer presses Done (no timer) ---- */
const okDlg = $('#okdlg');
function showSuccess({ title, label, ref, lines, note }) {
  okDlg.innerHTML = `
    <div class="in ok">
      <div class="okic" aria-hidden="true"><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></div>
      <h2>${esc(title)}</h2>
      <p class="mut">${esc(label)}</p>
      <div class="okref" id="ok-ref">${esc(ref)}</div>
      <button type="button" class="btn line sm" id="ok-copy">Copy code</button>
      ${(lines && lines.length) ? `<dl class="dl" style="text-align:left;margin-top:14px">${lines.map(l => `<dt>${esc(l[0])}</dt><dd>${esc(l[1])}</dd>`).join('')}</dl>` : ''}
      <p class="mut" style="margin-top:12px">${esc(note)}</p>
      <div class="acts" style="justify-content:center"><button type="button" class="btn gold" id="ok-done">Done</button></div>
    </div>`;
  $('#ok-done').onclick = () => okDlg.close();
  $('#ok-copy').onclick = async e => {
    try { await navigator.clipboard.writeText(ref); e.target.textContent = 'Copied'; }
    catch (err) { e.target.textContent = 'Select the code above to copy'; }
  };
  okDlg.showModal();
  $('#ok-done').focus();
}

/* ---- booking form (modal) ---- */
const bkDlg = $('#bkdlg');
const bkError = msg => { const x = $('#bk-e'); x.textContent = msg; x.hidden = !msg; };

/* add-on equipment picked in the booking form: [{ equipment_id, quantity }] */
const addOnSelection = () => $$('#bk-ad select').map(s => ({ equipment_id: +s.dataset.eq, quantity: +s.value })).filter(x => x.quantity > 0);
const addOnPrice = id => { const e = EQUIPMENT.find(x => x.id === id); return e ? e.addonPrice : 0; };

/* studio price + add-ons = total (also the amount to pay by GCash) */
function updateTotals() {
  const studio = STUDIOS[draft.si].rate * draft.h;
  const sel = addOnSelection(), addons = sel.reduce((n, x) => n + addOnPrice(x.equipment_id) * x.quantity, 0);
  $('#bk-hh').textContent = pl(draft.h, 'hr');
  $('#bk-st').textContent = peso(studio);
  $('#bk-adr').hidden = !sel.length;
  $('#bk-ao').textContent = peso(addons);
  $('#bk-t').textContent = peso(studio + addons);
  if ($('#bk-qa')) $('#bk-qa').textContent = peso(studio + addons);
}
const pl = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

function drawSlots() {
  const taken = takenSlots(draft.si, draft.d);
  $('#bk-slots').innerHTML = SLOTS.map((t, i) =>
    `<button type="button" data-i="${i}" class="${i === draft.t ? 'sel' : ''}" ${taken.has(i) ? 'disabled' : ''}>${t}</button>`).join('');
  updateTotals();
}

/* Try to hold hours t..t+h for this customer (held on the server for 2 minutes). */
async function moveDraft(t, h) {
  if (t + h > SLOTS.length) { bkError('That runs past closing time. Choose a shorter duration.'); return false; }
  if (!(await holdSlots(draft.si, draft.d, t, h))) {
    await holdSlots(draft.si, draft.d, draft.t, draft.h);   // a failed move drops the old hold, so take it back
    await loadBusy(draft.si, draft.d, draft.d);
    bkError('Those hours were just taken by another customer.');
    drawSlots();
    return false;
  }
  draft.t = t; draft.h = h;
  bkError('');
  drawSlots();
  return true;
}

function addOnRows() {
  const list = EQUIPMENT.filter(e => e.addon && e.stock > 0);
  if (!list.length) return '<p class="mut">No add-on equipment is available right now.</p>';
  return list.map(e => `
    <div class="ad">
      <div><b>${esc(e.name)}</b><div class="mut">${peso(e.addonPrice)} ${e.drum ? 'per rental' : 'per session'}</div></div>
      <select data-eq="${e.id}" aria-label="Quantity of ${esc(e.name)}">${Array.from({ length: Math.min(e.stock, 10) + 1 }, (_, n) => `<option value="${n}">${n}</option>`).join('')}</select>
    </div>`).join('');
}

async function openBook(startIndex) {
  await profileReady;
  const si = selStudio, d = selDate;
  await loadBusy(si, d, d);
  const taken = takenSlots(si, d);
  let t = startIndex;
  if (t == null || t < 0) t = SLOTS.findIndex((_, i) => !taken.has(i));
  if (t < 0 || taken.has(t)) return toast('No free times for that day.');

  const h = (t + 1 < SLOTS.length && !taken.has(t + 1)) ? 2 : 1;
  if (!(await holdSlots(si, d, t, h))) return toast('That slot was just taken. Pick another time.');

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

        <div class="fg2">
          <div><label for="bk-fn">First name</label><input id="bk-fn" autocomplete="given-name"></div>
          <div><label for="bk-ln">Last name</label><input id="bk-ln" autocomplete="family-name"></div>
        </div>
        <label for="bk-p">Phone</label>
        <input id="bk-p" placeholder="09XX XXX XXXX" autocomplete="tel">

        <label>Add-on equipment <span class="mut" style="font-weight:400">(optional)</span></label>
        <div class="adl" id="bk-ad">${addOnRows()}</div>

        <label for="bk-m">Payment method</label>
        <select id="bk-m"><option>GCash</option><option>Cash</option></select>
        <div id="bk-gw">
          <div class="gq">
            <img id="bk-qr" alt="GCash QR code to scan" hidden>
            <p class="mut" id="bk-qn">Scan this QR code with GCash and pay <b id="bk-qa"></b>. Then enter the reference number from your GCash receipt below.</p>
          </div>
          <label for="bk-g">GCash reference number</label>
          <input id="bk-g" placeholder="13-digit reference" inputmode="numeric">
        </div>

        <div class="bkt">
          <div><span>Studio (<span id="bk-hh"></span>)</span><span id="bk-st"></span></div>
          <div id="bk-adr" hidden><span>Add-on equipment</span><span id="bk-ao"></span></div>
        </div>
        <div class="tot"><span>Total</span><span id="bk-t"></span></div>

        <label class="terms" id="bk-terms">
          <input type="checkbox" id="bk-agree">
          <span>I understand and agree that there is <b>no refund</b> of the down payment I pay for this booking/reservation if it is cancelled.</span>
        </label>
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
  if (PROFILE) { $('#bk-fn').value = PROFILE.first; $('#bk-ln').value = PROFILE.last; $('#bk-p').value = PROFILE.number; }   // signed-in customers: fill in their details

  $('#bk-slots').onclick = e => {
    const b = e.target.closest('button');
    if (b && !b.disabled) moveDraft(+b.dataset.i, draft.h);
  };
  $('#bk-h').onchange = async e => { if (!(await moveDraft(draft.t, +e.target.value))) e.target.value = draft.h; };
  $('#bk-m').onchange = e => { $('#bk-gw').hidden = e.target.value !== 'GCash'; };
  $('#bk-x').onclick = () => bkDlg.close();
  $('#bk-ad').onchange = updateTotals;
  $('#bk-agree').onchange = e => { if (e.target.checked) { $('#bk-terms').classList.remove('err'); bkError(''); } };

  // the studio's GCash QR (uploaded by the owner in Settings), shown above the reference number
  const qr = $('#bk-qr');
  qr.onload = () => { qr.hidden = false; };
  qr.onerror = () => {
    qr.hidden = true;
    $('#bk-qn').innerHTML = 'Pay <b id="bk-qa"></b> using the studio\'s GCash account, then enter the reference number from your receipt below. Ask staff if you need the account details.';
    updateTotals();
  };
  qr.src = gcashQrUrl();
  updateTotals();

  // any activity keeps the hold alive
  let lastHold = Date.now();
  const keepAlive = () => {
    idleUntil = Date.now() + LOCK_TTL;
    if (draft && Date.now() - lastHold > 30000) { lastHold = Date.now(); holdSlots(draft.si, draft.d, draft.t, draft.h); }
  };
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
    releaseHold();
    const why = draft && draft.why;
    draft = null;
    refreshBook();
    if (why === 'timeout') toast('Booking closed after 2 minutes of inactivity. Your slot was released.');
  };

  $('#bkf').onsubmit = async ev => {
    ev.preventDefault();
    const first = $('#bk-fn').value.trim(), last = $('#bk-ln').value.trim(), phone = $('#bk-p').value.trim();
    const method = $('#bk-m').value, gcash = $('#bk-g').value.replace(/\s/g, '');

    if (!first) return bkError('Enter your first name.');
    if (!last) return bkError('Enter your last name.');
    if (!/^[\d\s+()-]{7,}$/.test(phone)) return bkError('Enter a valid phone number.');
    if (method === 'GCash' && !/^\d{13}$/.test(gcash)) return bkError('Enter the 13-digit GCash reference.');
    if (!$('#bk-agree').checked) {
      $('#bk-terms').classList.add('err');
      return bkError('Please tick the box to confirm you understand the no-refund policy.');
    }

    const items = addOnSelection();
    const snap = { s: STUDIOS[draft.si], d: draft.d, t: draft.t, h: draft.h };
    const btn = ev.target.querySelector('.btn.gold');
    btn.disabled = true;
    const { data, error } = await sb.rpc('create_booking_with_addons', {
      p_studio_id: snap.s.dbId,
      p_start_at: manilaTS(snap.d, 10 + snap.t),
      p_end_at: manilaTS(snap.d, 10 + snap.t + snap.h),
      p_first_name: first, p_last_name: last, p_number: phone,
      p_payment_method: method, p_gcash_reference: method === 'GCash' ? gcash : null,
      p_hold_token: HOLD_TOKEN, p_items: items
    });
    btn.disabled = false;
    if (error) return bkError(error.message);

    const row = Array.isArray(data) ? data[0] : data;
    if (!isMember()) rememberGuestBooking({ ref: row.booking_ref, studio: snap.s.id, date: snap.d, start: SLOTS[snap.t], hours: snap.h });
    const lines = [
      ['Studio', `Studio ${snap.s.id}`],
      ['Date', longDate(snap.d)],
      ['Time', `${SLOTS[snap.t]} to ${endTime(SLOTS[snap.t], snap.h)}`]
    ];
    items.forEach(x => { const e = EQUIPMENT.find(y => y.id === x.equipment_id); lines.push(['Add-on', `${e.name} x${x.quantity}`]); });
    lines.push(['Total', peso(Number(row.total_amount) || 0)]);

    draft.why = 'done';
    bkDlg.close();
    showSuccess({
      title: 'Successfully booked!', label: 'Your booking reference code', ref: row.booking_ref, lines,
      note: 'Keep this code to look up your booking later. Staff will confirm it once your payment is verified.'
    });
    loadMyBookings().then(loadMyRentals);
  };

  bkDlg.showModal();
}

/* ---- data from the database ---- */

/* The signed-in customer's own details, used to pre-fill the booking and rental forms. */
let PROFILE = null;
async function loadProfile() {
  if (!isMember()) return;
  const { data: auth } = await sb.auth.getUser();
  if (!auth || !auth.user) return;
  const { data } = await sb.from('customer').select('first_name, last_name, number').eq('auth_user_id', auth.user.id).maybeSingle();
  if (data) PROFILE = { first: data.first_name || '', last: data.last_name || '', number: data.number || '' };
}
const profileReady = loadProfile().catch(() => {});

const BK_STATUS = { 'Approved': 'Confirmed', 'In Progress': 'Active' };   // database -> labels used on this page
const RN_STATUS = { 'Active': 'In Use' };
const studioLetter = dbId => (STUDIOS.find(s => s.dbId === dbId) || {}).id;
const fmtD = ts => ts ? shortDate(manilaParts(ts).date) : '';

/* Guests have no account, so their booking references are remembered in this browser
   (only so they can attach rentals). Everything else for guests is the reference lookup. */
const GUEST_KEY = 'tod_guest_bookings';
const guestBookings = () => { try { return JSON.parse(localStorage.getItem(GUEST_KEY) || '[]'); } catch (e) { return []; } };
function rememberGuestBooking(b) {
  try { localStorage.setItem(GUEST_KEY, JSON.stringify([...guestBookings(), b])); } catch (e) { /* storage blocked */ }
}

async function loadMyBookings() {
  BOOKINGS.length = 0;
  if (isMember()) {
    const { data, error } = await sb.from('v_booking_summary').select('*').order('start_at');
    if (error) { console.error(error); toast('Could not load your bookings.'); }
    (data || []).forEach(r => {
      const p = manilaParts(r.start_at);
      BOOKINGS.push({
        ref: r.booking_ref, studio: studioLetter(r.studio_id), date: p.date, start: SLOTS[p.hour - 10],
        hours: Math.round(+r.hours), status: BK_STATUS[r.status] || r.status,
        payment: r.payment_status || 'Pending', mine: true
      });
    });
  } else {
    guestBookings().forEach(b => BOOKINGS.push({ ...b, status: 'Pending', payment: 'Pending', mine: true }));
  }
  renderMyBookings();
  renderAttachOptions();
}

async function loadMyRentals() {
  RENTALS = [];
  ADDONS = {};
  if (isMember()) {
    const { data, error } = await sb.from('v_rental_lines').select('*').order('created_at', { ascending: false });
    if (error) console.error(error);
    (data || []).forEach(r => {
      const addon = r.rental_type === 'Add-on', bk = addon ? BOOKINGS.find(b => b.ref === r.booking_ref) : null;
      if (addon && r.booking_ref && !['Rejected', 'Cancelled'].includes(r.status)) {
        (ADDONS[r.booking_ref] = ADDONS[r.booking_ref] || []).push({ name: r.equipment_name, qty: r.quantity, price: Number(r.unit_price_at_request) || 0 });
      }
      RENTALS.push({
        ref: addon ? r.booking_ref : r.rental_ref, item: r.equipment_name, qty: r.quantity,
        type: addon ? 'addon' : 'out',
        when: addon ? (bk ? `${shortDate(bk.date)}, ${bk.start}` : fmtD(r.due_at)) : `${fmtD(r.pickup_date)} to ${fmtD(r.return_date)}`,
        ret:  addon ? (bk ? `${shortDate(bk.date)}, ${endTime(bk.start, bk.hours)}` : fmtD(r.due_at)) : fmtD(r.return_date),
        status: RN_STATUS[r.status] || r.status, reason: r.rejected_reason || ''
      });
    });
  }
  renderMyRentals();
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
  $('#on-wrap').hidden = isMember();
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

async function requestRental() {
  const keys = Object.keys(cart);
  if (!keys.length) return toast('Add at least one item first.');
  const items = keys.map(i => ({ equipment_id: EQUIPMENT[i].id, quantity: cart[i].q }));
  const btn = $('#rq');
  btn.disabled = true;

  try {
    let args;
    if (rentMode === 'addon') {
      const ref = $('#lb').value;
      if (!ref) return toast('Attach the rental to a studio booking first.');
      args = { p_type: 'Add-on', p_items: items, p_booking_ref: ref };
    } else {
      const pd = $('#pd').value, rd = $('#rd').value, contact = $('#oc').value.trim();
      const first = isMember() ? '' : $('#on-fn').value.trim(), last = isMember() ? '' : $('#on-ln').value.trim();
      const file = $('#vf').files[0];
      if (!pd || !rd) return toast('Choose a pick-up and return date.');
      if (pd < TODAY) return toast('Pick-up date cannot be in the past.');
      if (rd < pd) return toast('Return date must be on or after the pick-up date.');
      if (!isMember() && (!first || !last)) return toast('Enter your first and last name.');
      if (!/^[\d\s+()-]{7,}$/.test(contact)) return toast('Enter a valid contact number.');
      if (!file) return toast('Attach a valid ID.');

      // upload the ID photo first; the request stores only its path
      const ext = ((file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '')) || 'jpg';
      const path = `${crypto.randomUUID()}/${Date.now()}.${ext}`;
      const up = await sb.storage.from('rental-ids').upload(path, file, { contentType: file.type });
      if (up.error) return toast('Could not upload your ID: ' + up.error.message);

      // pick-up 10:00 AM (or the next hour if today); same-day rentals run 8 hours, otherwise whole days
      const nowHour = manilaParts(new Date()).hour;
      const pickHour = pd === TODAY ? Math.min(21, Math.max(10, nowHour + 1)) : 10;
      const pickup = new Date(manilaTS(pd, pickHour));
      const days = Math.round((new Date(rd + 'T00:00') - new Date(pd + 'T00:00')) / 864e5);
      const back = new Date(pickup.getTime() + (days > 0 ? days * 24 : 8) * 3600e3);

      args = {
        p_type: 'Outside', p_items: items,
        p_first_name: first || null, p_last_name: last || null, p_number: contact,
        p_pickup_date: pickup.toISOString(), p_return_date: back.toISOString(),
        p_contact_number: contact, p_backup_contact: $('#sm-link').value.trim() || null,
        p_id_type: $('#vt').value, p_id_image_path: path
      };
    }

    const { data, error } = await sb.rpc('request_rental', args);
    if (error) return toast(error.message);
    const row = Array.isArray(data) ? data[0] : data;

    cart = {};
    $('#vf').value = '';
    renderCart();
    await loadMyRentals();
    showSuccess({
      title: 'Rental request sent!', label: 'Your reference code',
      ref: rentMode === 'addon' ? args.p_booking_ref : row.rental_ref,
      note: 'Staff will review your request. Keep this code to look up your rental later.'
    });
  } finally {
    btn.disabled = false;
    updateRequestButton();
  }
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
      ${(ADDONS[b.ref] || []).length ? `<dt>Add-ons</dt><dd>${ADDONS[b.ref].map(a => `${esc(a.name)} x${a.qty} (${peso(a.price * a.qty)})`).join('<br>')}</dd>` : ''}
      <dt>Total</dt><dd>${peso(s.rate * b.hours + (ADDONS[b.ref] || []).reduce((n, a) => n + a.price * a.qty, 0))}</dd>
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
  $('#do-cancel').onclick = async () => {
    const { error } = await sb.rpc('cancel_booking', { p_booking_ref: b.ref });
    if (error) return toast(error.message);
    dlg.close();
    await loadMyBookings();
    await refreshBook();
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

  const draw = async () => {
    await loadBusy(si, pick.date, pick.date);
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
  $('#rs-save').onclick = async () => {
    const date = pick.date, t = pick.t;
    const { error } = await sb.rpc('reschedule_booking', {
      p_booking_ref: b.ref, p_start_at: manilaTS(date, 10 + t), p_end_at: manilaTS(date, 10 + t + b.hours)
    });
    if (error) return toast(error.message);
    dlg.close();
    await loadMyBookings();
    await refreshBook();
    toast(`${b.ref} moved to ${shortDate(date)} at ${SLOTS[t]}.`);
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

  /* Guest lookup by reference code. */
  $('#gb-form').addEventListener('submit', async e => {
    e.preventDefault();
    const ref = normRef($('#gb-ref').value), box = $('#gb-res');
    box.hidden = false;
    const { data, error } = await sb.rpc('lookup_booking', { p_ref: ref });
    if (error || !data) { box.innerHTML = notFound(ref, 'booking'); return; }
    const a = manilaParts(data.start_at), z = manilaParts(data.end_at), hrs = z.hour - a.hour;
    const status = BK_STATUS[data.status] || data.status;
    box.innerHTML = `
      <div class="row"><h3>${esc(data.booking_ref)}</h3>${badge(status)}</div>
      <dl class="dl">
        <dt>Studio</dt><dd>${esc(data.studio)}${data.studio_description ? ', ' + esc(data.studio_description) : ''}</dd>
        <dt>Date</dt><dd>${longDate(a.date)}</dd>
        <dt>Time</dt><dd>${SLOTS[a.hour - 10]} to ${endTime(SLOTS[a.hour - 10], hrs)} (${hrs} hr${hrs > 1 ? 's' : ''})</dd>
        <dt>Studio price</dt><dd>${peso(+(data.studio_total ?? data.total))}</dd>
        ${(data.addons || []).map(a => `<dt>Add-on</dt><dd>${esc(a.equipment)} x${a.quantity} (${peso(+a.price)})</dd>`).join('')}
        <dt>Total</dt><dd><b>${peso(+(data.grand_total ?? data.total))}</b></dd>
        <dt>Payment</dt><dd>${badge(data.payment_status || 'Pending')}</dd>
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
  $('#gr-form').addEventListener('submit', async e => {
    e.preventDefault();
    const ref = normRef($('#gr-ref').value), box = $('#gr-res');
    box.hidden = false;
    const { data: list, error } = await sb.rpc('lookup_rental', { p_ref: ref });
    if (error || !list || !list.length) { box.innerHTML = notFound(ref, 'rental'); return; }
    const type = list[0].rental_type === 'Add-on' ? '<span class="b addon">Add-on</span>' : '<span class="b out">Outside</span>';
    box.innerHTML = `<div class="row"><h3>${esc(ref)}</h3><span>${type}</span></div>
      <div class="tw" style="margin-top:8px">${tableNotes(['Equipment', 'Qty', 'Return by', 'Status'],
        list.map(r => ({
          cells: [esc(r.equipment), String(r.quantity), r.return_by ? shortDate(manilaParts(r.return_by).date) : '', badge(RN_STATUS[r.status] || r.status)],
          note: whyRejected(r.status, r.rejected_reason)
        })))}</div>`;
  });
}

/* The staff's reason for a rejected rental, shown on its own line under the row. */
const whyRejected = (status, reason) =>
  status === 'Rejected' ? `<b>Reason for rejection:</b> ${esc(reason || 'No reason was given. Please contact the studio.')}` : '';

/* Like table(), but a row may also carry a note that is shown full width right under it. */
const tableNotes = (head, rows) =>
  `<table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>` +
  rows.map(r => {
    const cells = r.cells, note = r.note;
    return `<tr class="${note ? 'has-why' : ''}">${cells.map(c => `<td>${c}</td>`).join('')}</tr>` +
           (note ? `<tr class="why-row"><td colspan="${head.length}">${note}</td></tr>` : '');
  }).join('') + '</tbody></table>';

function renderMyRentals() {
  if (!RENTALS.length) {
    $('#myrent').innerHTML = '<p class="mut" style="padding:8px">No rentals yet.</p>';
    return;
  }
  $('#myrent').innerHTML = tableNotes(
    ['Reference', 'Equipment', 'Qty', 'Rent type', 'Session or dates', 'Return date', 'Status'],
    RENTALS.map(r => ({
      cells: [
        r.ref, esc(r.item), String(r.qty),
        r.type === 'addon' ? '<span class="b addon">Add-on</span>' : '<span class="b out">Outside</span>',
        r.when, r.ret, badge(r.status)
      ],
      note: whyRejected(r.status, r.reason)
    })));
}


/* ============================ 6. START ============================ */

async function applyUrlParams() {
  const q = new URLSearchParams(location.search);

  const studio = studioIndex(q.get('studio'));
  if (studio >= 0) selStudio = studio;

  const date = q.get('date');
  if (/^\d{4}-\d{2}-\d{2}$/.test(date || '') && date >= TODAY) {
    selDate = date;
    calMonth = new Date(date + 'T00:00');
    calMonth.setDate(1);
  }

  await refreshBook();

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
window.addEventListener('hashchange', showTab);

// wait for studios and equipment to load, then draw everything
dataReady.then(async () => {
  selStudio = Math.max(0, STUDIOS.findIndex(s => !isClosed(s)));
  renderEquipment();
  renderCart();
  renderRentMode();
  profileReady.then(() => { if (PROFILE && !$('#oc').value) $('#oc').value = PROFILE.number; });
  showTab();
  await loadMyBookings();
  await loadMyRentals();
  await applyUrlParams();
});
