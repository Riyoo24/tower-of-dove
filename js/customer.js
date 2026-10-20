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
let selDate = firstBookableDate();   // day picked on the calendar (tomorrow once today's last start time has passed)
let calMonth = new Date(selDate + 'T00:00');   // month shown on the calendar
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
  if (selDate < firstBookableDate()) selDate = firstBookableDate();   // the page was left open past closing time
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
    html += `<button class="cd ${cls}" data-d="${ds}" ${ds < firstBookableDate() ? 'disabled' : ''}>${d}<i>${n ? n + 'h' : ''}</i></button>`;
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
const stampLabel = ts => new Date(ts).toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const ICON_OK = '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
const ICON_RECEIPT = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h12v20l-3-2-3 2-3-2-3 2z"/><path d="M9 7h6M9 11h6M9 15h4"/></svg>';

/* Success pop-up and booking receipt. Stays open until the customer presses the button (no timer).
   shot = the sentence shown after "Take a screenshot of this page." (it is the official receipt). */
function showSuccess({ title, label, ref, lines, note, shot, icon, status, doneLabel }) {
  okDlg.innerHTML = `
    <div class="in ok">
      <div class="okic" aria-hidden="true">${icon === 'receipt' ? ICON_RECEIPT : ICON_OK}</div>
      <h2>${esc(title)}</h2>
      ${status ? `<div style="margin:4px 0">${status}</div>` : ''}
      <p class="mut">${esc(label)}</p>
      <div class="okref" id="ok-ref">${esc(ref)}</div>
      <button type="button" class="btn line sm" id="ok-copy">Copy code</button>
      ${(lines && lines.length) ? `<dl class="dl" style="text-align:left;margin-top:14px">${lines.map(l => `<dt>${esc(l[0])}</dt><dd>${esc(l[1])}</dd>`).join('')}</dl>` : ''}
      ${shot ? `<div class="shot"><b>Take a screenshot of this page.</b> ${esc(shot)}</div>` : ''}
      ${note ? `<p class="mut" style="margin-top:12px">${esc(note)}</p>` : ''}
      <div class="acts" style="justify-content:center"><button type="button" class="btn gold" id="ok-done">${esc(doneLabel || 'Done')}</button></div>
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

/* The studio closes at 10:00 PM, so a session must end by then: the last start time is 9:00 PM
   (one hour) and only the durations that still fit are offered. */
const durationOptions = (t, h) => {
  const max = Math.min(4, SLOTS.length - t);
  return Array.from({ length: max }, (_, i) => `<option value="${i + 1}" ${i + 1 === h ? 'selected' : ''}>${i + 1} hour${i ? 's' : ''}</option>`).join('');
};

/* add-on equipment picked in the booking form: [{ equipment_id, quantity }] */
const addOnSelection = () => Object.entries(draft ? draft.addons : {}).map(([id, q]) => ({ equipment_id: +id, quantity: +q })).filter(x => x.quantity > 0);
const addOnPrice = id => { const e = EQUIPMENT.find(x => x.id === id); return e ? e.addonPrice : 0; };

/* studio price + add-ons = total (also the amount to pay by GCash) */
function updateTotals() {
  const studio = STUDIOS[draft.si].rate * draft.h;
  const sel = addOnSelection(), addons = sel.reduce((n, x) => n + addOnPrice(x.equipment_id) * x.quantity, 0);
  $('#bk-hh').textContent = `${pl(draft.h, 'hr')}, ${SLOTS[draft.t]} to ${endTime(SLOTS[draft.t], draft.h)}`;
  $('#bk-st').textContent = peso(studio);
  $('#bk-adr').hidden = !sel.length;
  $('#bk-ao').textContent = peso(addons);
  $('#bk-t').textContent = peso(studio + addons);
  if ($('#bk-qa')) $('#bk-qa').textContent = peso(studio + addons);
}
const pl = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

/* Wording for a time that someone else holds or has booked */
const MSG_HELD = 'Someone is already trying to book this schedule. Please try again in a moment or choose another time.';
const MSG_BOOKED = 'That time was just booked by someone else. Please choose another time.';
const slotError = msg => /just taken by another customer/i.test(msg) ? MSG_HELD : /no longer available/i.test(msg) ? MSG_BOOKED : msg;

function drawSlots() {
  const taken = takenSlots(draft.si, draft.d), held = heldSlots(draft.si, draft.d);
  $('#bk-slots').innerHTML = SLOTS.map((t, i) => {
    const isHeld = taken.has(i) && held.has(i), past = isPastSlot(draft.d, i), late = i + draft.h > SLOTS.length;
    const tip = isHeld ? ' title="Someone is already trying to book this schedule"'
              : late ? ` title="A ${draft.h}-hour session from ${t} would run past the 10:00 PM closing time"` : '';
    return `<button type="button" data-i="${i}" class="${i === draft.t ? 'sel' : ''}${isHeld ? ' held' : ''}" ${taken.has(i) || past || late ? 'disabled' : ''}${tip}>${t}</button>`;
  }).join('');
  if ($('#bk-hint')) $('#bk-hint').hidden = !SLOTS.some((_, i) => taken.has(i) && held.has(i));
  updateTotals();
}

/* Try to hold hours t..t+h for this customer (held on the server for 2 minutes). */
async function moveDraft(t, h) {
  if (t + h > SLOTS.length) { bkError('That runs past closing time. Choose a shorter duration.'); return false; }
  const ok = await holdSlots(draft.si, draft.d, t, h);
  if (!draft) return false;                    // the form was closed while this request was running (the release is queued behind it)
  if (!ok) {
    await holdSlots(draft.si, draft.d, draft.t, draft.h);   // a failed move drops the old hold, so take it back
    if (!draft) return false;
    await loadBusy(draft.si, draft.d, draft.d);
    if (!draft) return false;
    bkError(conflictKind(draft.si, draft.d, t, h) === 'held' ? MSG_HELD : MSG_BOOKED);
    drawSlots();
    return false;
  }
  draft.t = t; draft.h = h;
  $('#bk-h').innerHTML = durationOptions(t, h);
  bkError('');
  drawSlots();
  return true;
}

/* ---- dedicated add-on equipment window (opened from the booking form) ----
   Filter by category, see the photo and the full description, pick a quantity. */
const eqDlg = $('#eqdlg');
let eqCat = 'All';
let bumpIdle = null;   // set while the booking form is open, keeps its 2-minute hold alive

function renderAddOnSummary() {
  const sel = addOnSelection();
  $('#bk-ad').innerHTML = sel.length
    ? sel.map(x => {
        const e = EQUIPMENT.find(y => y.id === x.equipment_id);
        return `<div class="adrow"><span>${esc(e.name)} x${x.quantity}</span><span>${peso(e.addonPrice * x.quantity)} <button type="button" class="lk" data-rm-ad="${x.equipment_id}">Remove</button></span></div>`;
      }).join('')
    : '<p class="mut">No equipment added.</p>';
}

function addOnCard(e) {
  const q = draft.addons[e.id] || 0, max = Math.min(e.stock, 10);
  const info = e.drum
    ? `<p class="mut">${esc(e.drum.kit)}, ${e.drum.vip ? 'VIP' : 'Basic'} set-up</p>${e.desc ? `<p>${esc(e.desc)}</p>` : ''}
       <ul class="mut" style="margin:6px 0 0 18px"><li>Cymbals (Trojan B8): ${e.drum.vip ? '2 crash, 1 ride, hi-hat, splash' : '1 crash, 1 ride, hi-hat'}</li><li>Hardware: stands, throne, carpet</li><li>Skins: Remo and Evans</li><li>No service</li></ul>`
    : (e.desc ? `<p>${esc(e.desc)}</p>` : '<p class="mut">No description yet.</p>');
  return `<div class="eqcard">
      ${equipmentImage(e)}
      <p class="cat">${esc(e.category || '')}</p>
      <h3>${esc(e.name)}</h3>
      ${info}
      <p class="mut" style="margin-top:6px">${e.stock} available</p>
      <div class="row" style="margin-top:8px">
        <b>${peso(e.addonPrice)} <span class="mut" style="font-weight:400">${e.drum ? 'per rental' : 'per session'}</span></b>
        <label class="qtyl">Qty <select data-aq="${e.id}" aria-label="Quantity of ${esc(e.name)}">${Array.from({ length: max + 1 }, (_, n) => `<option value="${n}" ${n === q ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      </div>
    </div>`;
}

function drawAddOnModal() {
  const list = EQUIPMENT.filter(e => e.addon && e.stock > 0);
  const cats = ['All', ...new Set(list.map(e => e.category).filter(Boolean))];
  const shown = list.filter(e => eqCat === 'All' || e.category === eqCat);
  eqDlg.innerHTML = `<div class="in">
    <div class="row"><h2 style="margin:0">Add equipment to your booking</h2><button type="button" class="btn sm line" data-close>Close</button></div>
    <p class="mut" style="margin-top:4px">Used inside the studio during your session. Choose a quantity for each item you want.</p>
    <div class="tabs" style="margin-top:10px">${cats.map(c => `<button type="button" data-cat="${esc(c)}" class="${c === eqCat ? 'on' : ''}">${esc(c)}</button>`).join('')}</div>
    <div class="eqgrid">${shown.map(addOnCard).join('') || '<p class="mut">Nothing available in this category.</p>'}</div>
    <div class="acts"><span class="mut" id="eqd-n" style="margin-right:auto"></span><button type="button" class="btn gold" data-close>Done</button></div>
  </div>`;
  eqCount();
}
function eqCount() {
  const n = addOnSelection().length;
  const el = $('#eqd-n');
  if (el) el.textContent = n ? `${n} item${n === 1 ? '' : 's'} selected` : 'Nothing selected yet';
}
function openAddOnModal() {
  if (!draft) return;
  eqCat = 'All';
  drawAddOnModal();
  eqDlg.showModal();
}
eqDlg.addEventListener('click', e => {
  const cat = e.target.closest('[data-cat]');
  if (cat) { eqCat = cat.dataset.cat; drawAddOnModal(); }
  else if (e.target.closest('[data-close]')) eqDlg.close();
  if (bumpIdle) bumpIdle();
});
eqDlg.addEventListener('change', e => {
  const s = e.target.closest('[data-aq]');
  if (!s || !draft) return;
  draft.addons[s.dataset.aq] = +s.value;
  renderAddOnSummary();
  updateTotals();
  eqCount();
  if (bumpIdle) bumpIdle();
});

async function openBook(startIndex) {
  await profileReady;
  const si = selStudio, d = selDate;
  await loadBusy(si, d, d);
  const taken = takenSlots(si, d);
  let t = startIndex;
  // never start in the past: on today's date the default is the next upcoming free hour (e.g. 11:31 AM -> 12:00 PM)
  if (t == null || t < 0 || isPastSlot(d, t)) t = SLOTS.findIndex((_, i) => !taken.has(i) && !isPastSlot(d, i));
  if (t < 0) return toast(d === manilaDay(0) ? 'No more times are available today. Choose another date.' : 'No free times for that day.');
  if (taken.has(t)) return toast('No free times for that day.');

  const h = (t + 1 < SLOTS.length && !taken.has(t + 1)) ? 2 : 1;
  if (!(await holdSlots(si, d, t, h))) {
    await loadBusy(si, d, d);
    return toast(conflictKind(si, d, t, h) === 'held' ? MSG_HELD : MSG_BOOKED);
  }

  draft = { si, d, t, h, addons: {} };
  const s = STUDIOS[si];

  bkDlg.innerHTML = `
    <div class="in">
      <form id="bkf" novalidate>
        <div class="row"><h2 style="margin:0">Book Studio ${s.id}</h2><span class="mut" id="bk-left"></span></div>
        <p class="mut">${longDate(d)}. ${peso(s.rate)} per hour. Your slot is held while this form is open and released after 2 minutes of inactivity.</p>

        <label>Start time</label>
        <div class="slots" id="bk-slots"></div>
        <p class="mut" style="margin-top:6px">The studio is open 10:00 AM to 10:00 PM. The last session starts at 9:00 PM, so every session ends by closing time.</p>
        <p class="mut" id="bk-hint" style="margin-top:6px" hidden>Times with a dashed outline are being booked by someone else right now. They may open up again in about 2 minutes.</p>

        <label for="bk-h">Duration</label>
        <select id="bk-h">${durationOptions(t, h)}</select>

        <div class="fg2">
          <div><label for="bk-fn">First name</label><input id="bk-fn" autocomplete="given-name"></div>
          <div><label for="bk-ln">Last name</label><input id="bk-ln" autocomplete="family-name"></div>
        </div>
        <label for="bk-p">Phone</label>
        <input id="bk-p" placeholder="09XX XXX XXXX" autocomplete="tel">

        <label>Add-on equipment <span class="mut" style="font-weight:400">(optional)</span></label>
        <div class="adsum" id="bk-ad"></div>
        <button type="button" class="btn line sm" id="bk-ad-open" style="margin-top:8px">Browse equipment</button>

        <label for="bk-m">Payment method</label>
        <div class="payfix"><b>GCash</b> <span class="mut">Online bookings are paid with GCash only.</span></div>
        <input type="hidden" id="bk-m" value="GCash">
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
  $('#bk-ad-open').onclick = openAddOnModal;
  $('#bk-ad').onclick = e => {
    const r = e.target.closest('[data-rm-ad]');
    if (r) { delete draft.addons[r.dataset.rmAd]; renderAddOnSummary(); updateTotals(); }
  };
  renderAddOnSummary();
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
  bumpIdle = keepAlive;
  // refresh the day every 15 seconds so times someone else was holding open up again
  const slotPoll = setInterval(async () => {
    if (!draft || !bkDlg.open) return;
    await loadBusy(draft.si, draft.d, draft.d);
    drawSlots();
  }, 15000);
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
    clearInterval(slotPoll);
    releaseHold();
    bumpIdle = null;
    if (eqDlg.open) eqDlg.close();
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
    if (error) return bkError(slotError(error.message));

    const row = Array.isArray(data) ? data[0] : data;
    if (!isMember()) rememberGuestBooking({ ref: row.booking_ref, studio: snap.s.id, date: snap.d, start: SLOTS[snap.t], hours: snap.h });
    const lines = [
      ['Name', `${first} ${last}`],
      ['Studio', `Studio ${snap.s.id}`],
      ['Date', longDate(snap.d)],
      ['Time', `${SLOTS[snap.t]} to ${endTime(SLOTS[snap.t], snap.h)}`]
    ];
    items.forEach(x => { const e = EQUIPMENT.find(y => y.id === x.equipment_id); lines.push(['Add-on', `${e.name} x${x.quantity}`]); });
    lines.push(['Total', peso(Number(row.total_amount) || 0)]);
    lines.push(['Payment', method === 'GCash' ? 'GCash, waiting for staff to verify' : 'Cash, pay at the studio']);
    lines.push(['Booked on', stampLabel(new Date())]);

    draft.why = 'done';
    bkDlg.close();
    showSuccess({
      title: 'Successfully booked!', label: 'Your booking reference code', ref: row.booking_ref, lines,
      shot: 'It is your official receipt. Show it to our staff when you arrive so we can verify your reservation.',
      note: 'You can also use this code to look up your booking later. Staff confirm it once your payment is verified.'
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
        payment: r.payment_status || 'Pending', mine: true,
        name: r.customer_name, method: r.payment_method, created: r.created_at
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
        when: addon ? (bk ? `${shortDate(bk.date)}, ${bk.start}` : fmtD(r.due_at)) : fmtDT(r.pickup_date),
        ret:  addon ? (bk ? `${shortDate(bk.date)}, ${endTime(bk.start, bk.hours)}` : fmtD(r.due_at)) : fmtDT(r.return_date),
        rentalRef: r.rental_ref, rawStatus: r.status, unit: Number(r.unit_price_at_request) || 0, hours: Number(r.rental_hours) || 0,
        pickup: r.pickup_date, due: r.due_at, down: Number(r.down_payment) || 0, late: Number(r.late_fee) || 0, returnedAt: r.line_returned_at,
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

const sum = a => a.reduce((x, y) => x + y, 0);
const hourLabel = h => `${h % 12 || 12}:00 ${h < 12 ? 'AM' : 'PM'}`;
const fmtDT = ts => { const p = manilaParts(ts); return `${shortDate(p.date)}, ${hourLabel(p.hour)}`; };

/* Guests may add equipment to a studio booking, but outside rentals need an account. */
const outBlocked = () => rentMode === 'out' && !isMember();

/* Outside rentals: the price covers the first 8 hours; every extra hour adds price / 8. */
function outsideHours() {
  const pd = $('#pd').value, rd = $('#rd').value;
  if (!pd || !rd) return null;
  const h = (new Date(manilaTS(rd, +$('#rt').value)) - new Date(manilaTS(pd, +$('#pt').value))) / 3600e3;
  return h > 0 ? h : null;
}
const billedHours = () => Math.max(8, Math.ceil(outsideHours() || 8));

function lineTotal(i) {
  const e = EQUIPMENT[i], c = cart[i], unit = unitPrice(e);
  return rentMode === 'out' ? unit * c.q * billedHours() / 8 : unit * c.q;
}

/* base price, extra hours, total, down payment (50%) and balance for the current outside rental */
function rentalMoney() {
  const keys = Object.keys(cart), hrs = billedHours();
  const base = sum(keys.map(i => unitPrice(EQUIPMENT[i]) * cart[i].q));
  const extraHrs = hrs - 8, extra = base / 8 * extraHrs, total = base + extra, down = Math.round(total * 50) / 100;
  return { base, extraHrs, extra, total, down, balance: total - down };
}

function renderSummary() {
  const box = $('#rsum'), keys = Object.keys(cart);
  if (rentMode !== 'out' || !keys.length) { box.hidden = true; return; }
  const m = rentalMoney();
  box.hidden = false;
  box.innerHTML =
    `<div><span>Rental (first 8 hours)</span><span>${peso(m.base)}</span></div>` +
    (m.extraHrs ? `<div><span>Extra hours (${m.extraHrs} x ${peso(m.base / 8)})</span><span>${peso(m.extra)}</span></div>` : '') +
    `<div><b style="color:var(--ink)">Down payment due now (50%)</b><b style="color:var(--ink)">${peso(m.down)}</b></div>` +
    `<div><span>Balance to pay at pick-up</span><span>${peso(m.balance)}</span></div>`;
  if ($('#oq-amt')) $('#oq-amt').textContent = peso(m.down);
}

function renderDuration() {
  const el = $('#rdur'), h = outsideHours();
  el.textContent = h === null ? 'The return must be after the pick-up.'
    : h < 8 ? `Rental length: ${h} hour${h === 1 ? '' : 's'}. The price covers up to 8 hours, so returning early does not lower it.`
    : h === 8 ? 'Rental length: 8 hours (the full base duration, included in the price).'
    : `Rental length: ${h} hours. ${Math.ceil(h) - 8} extra hour${Math.ceil(h) - 8 === 1 ? '' : 's'} added to the price.`;
}

/* category filter above the equipment cards (same idea as the add-on equipment window) */
let rentCat = 'All';
/* Only equipment offered for the chosen kind of rent is listed:
   studio add-ons show the items allowed as add-ons, outside rent shows the items allowed to be taken out. */
const isOffered = e => rentMode === 'addon' ? e.addon : e.outside;

function renderCategories() {
  const cats = ['All', ...new Set(EQUIPMENT.filter(isOffered).map(e => e.category).filter(Boolean))];
  if (!cats.includes(rentCat)) rentCat = 'All';
  $('#eq-cats').innerHTML = cats.map(c => `<button type="button" data-cat="${esc(c)}" class="${c === rentCat ? 'on' : ''}">${esc(c)}</button>`).join('');
}

function renderEquipment() {
  renderCategories();
  const shown = EQUIPMENT.filter(isOffered).filter(e => rentCat === 'All' || e.category === rentCat);
  if (!shown.length) {
    $('#eq').innerHTML = `<p class="mut">No equipment is offered ${rentMode === 'addon' ? 'as a studio add-on' : 'for outside rent'} right now.</p>`;
    return;
  }
  $('#eq').innerHTML = EQUIPMENT.map((e, i) => {
    if (!isOffered(e) || (rentCat !== 'All' && e.category !== rentCat)) return '';   // hidden, not shown as unavailable
    const ok = e.stock > 0 && !outBlocked();
    const unit = rentMode === 'addon' ? (e.drum ? 'per rental' : 'per session') : 'per 8 hours, then 1/8 per extra hour';

    const info = e.drum
      ? `<p class="mut">${esc(e.drum.kit)}, ${e.drum.vip ? 'VIP' : 'Basic'} set-up</p>
         ${e.desc ? `<p class="mut" style="margin-top:4px">${esc(e.desc)}</p>` : ''}
         <details class="dset"><summary>What's included</summary><ul>
           <li>Cymbals (Trojan B8): ${e.drum.vip ? '2 crash, 1 ride, hi-hat, splash' : '1 crash, 1 ride, hi-hat'}</li>
           <li>Hardware: stands, throne, carpet</li>
           <li>Skins: Remo and Evans</li>
           <li>Base rental: 8 hours</li>
           <li>No service</li></ul></details>`
      : `${e.desc ? `<p class="mut" style="margin-top:4px">${esc(e.desc)}</p>` : ''}<p class="mut">${e.stock} available</p>`;

    const control = e.drum
      ? '<span class="mut" style="white-space:nowrap">1 set</span>'
      : `<input class="qty" type="number" min="1" max="${e.stock}" value="1" aria-label="Quantity" data-q="${i}" ${ok ? '' : 'disabled'}>`;

    return `
      <div class="card" data-eq="${i}">
        ${equipmentImage(e)}
        <p class="cat">${esc(e.category || '')}</p>
        <div class="row"><h3>${esc(e.name)}</h3>${e.stock < 2 && !e.drum ? badge('Low') : ''}</div>
        ${info}
        <p style="margin-top:6px">${e.addon ? '<span class="b addon">Add-on</span> ' : ''}${e.outside ? '<span class="b out">Outside</span>' : ''}</p>
        <div class="row" style="margin-top:10px;flex-wrap:wrap">
          <span><b>${peso(unitPrice(e))}</b> <span class="mut">${unit}</span></span>
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
        const label = rentMode === 'out' ? `${esc(e.name)} x ${c.q} (${billedHours()} hrs)` : `${esc(e.name)} x ${c.q}`;
        return `<li><span>${label} <button class="lk" data-rm="${i}" aria-label="Remove ${esc(e.name)}">Remove</button></span><span>${peso(lineTotal(i))}</span></li>`;
      }).join('')
    : '<li><span class="mut">Nothing added yet</span><span></span></li>';

  $('#ctt').textContent = peso(keys.reduce((n, i) => n + lineTotal(i), 0));
  renderSummary();
  renderDuration();
}

/* A guest has no account, so they type the booking reference code. The booking must exist, belong to
   a guest booking (the database hides registered accounts' bookings) and still be open. */
let attachBooking = null;   // { ref, text } once the guest's code has been found

async function findGuestBooking() {
  const info = $('#lb-info'), ref = normRef($('#lb-ref').value);
  attachBooking = null;
  if (!ref) { info.className = 'mut'; info.textContent = 'Enter the booking reference code first.'; updateRequestButton(); return; }
  info.className = 'mut'; info.textContent = 'Looking for that booking...';
  const { data, error } = await sb.rpc('lookup_booking', { p_ref: ref });
  if (error || !data) {
    info.className = 'bad-text'; info.textContent = `No booking found for ${ref}. Check the code and try again. If you booked with an account, log in instead.`;
  } else if (!['Pending', 'Approved', 'In Progress'].includes(data.status)) {
    info.className = 'bad-text'; info.textContent = `${data.booking_ref} is ${data.status.toLowerCase()}, so equipment can't be added to it.`;
  } else {
    const a = manilaParts(data.start_at), z = manilaParts(data.end_at);
    attachBooking = { ref: data.booking_ref };
    info.className = 'ok-text';
    info.textContent = `Found ${data.booking_ref}: ${data.studio}, ${longDate(a.date)}, ${hourLabel(a.hour)} to ${hourLabel(z.hour)}. Current total ${peso(+(data.grand_total ?? data.total))}.`;
  }
  updateRequestButton();
}

function renderRentMode() {
  $('#fa-member').hidden = !isMember();
  $('#fa-guest').hidden = isMember();
  $('#fa').hidden = rentMode !== 'addon';
  $('#fo').hidden = rentMode === 'addon';
  $('#fo-guest').hidden = !outBlocked();
  $('#fo-form').hidden = outBlocked();
  $('#rmh').textContent = rentMode === 'addon'
    ? 'Used inside the studio you booked. Tied to your booking reference. Priced per session; drum sets are priced per rental.'
    : 'Taken out of the studio, for registered customers. The price covers 8 hours and every extra hour adds one-eighth of the price. Pay a 50% down payment now and the rest at pick-up. You get an OUT reference instead of a booking reference.';
  $$('#rm button').forEach(b => b.classList.toggle('on', b.dataset.m === rentMode));
  renderEquipment();
  updateRequestButton();
}

/* Outside rentals need a member account and an ID file before the request button unlocks. */
function updateRequestButton() {
  $('#rq').disabled = rentMode === 'out' ? (outBlocked() || !$('#vf').files.length)
                                         : (!isMember() && !attachBooking);   // a guest needs a found booking first
}

/* Bookings an add-on can be attached to: upcoming and not cancelled. */
function renderAttachOptions() {
  const usable = BOOKINGS.filter(b => b.mine && b.date >= TODAY && ['Pending', 'Confirmed', 'Active'].includes(b.status));
  $('#lb').innerHTML = usable.length
    ? usable.map(b => `<option value="${b.ref}">${b.ref} - Studio ${b.studio}, ${b.date === TODAY ? 'today' : shortDate(b.date)} ${b.start}</option>`).join('')
    : '<option value="">No upcoming booking. Book a studio first.</option>';
}

function loadRentalQr() {
  const img = $('#oq-img');
  img.onload = () => { img.hidden = false; };
  img.onerror = () => {
    img.hidden = true;
    $('#oq-note').innerHTML = 'Pay the down payment of <b id="oq-amt"></b> using the studio\'s GCash account, then enter the reference number from your receipt below. Ask staff if you need the account details.';
    renderSummary();
  };
  img.src = gcashQrUrl();
}

function initRentTab() {
  // pick-up times: studio hours; return times also allow 10:00 PM closing
  $('#pt').innerHTML = SLOTS.map((t, i) => `<option value="${10 + i}">${t}</option>`).join('');
  $('#rt').innerHTML = SLOTS.map((t, i) => `<option value="${10 + i}">${t}</option>`).join('') + '<option value="22">10:00 PM</option>';
  $('#pd').min = $('#rd').min = TODAY;
  $('#pd').value = $('#rd').value = dayOffset(1);
  $('#pt').value = '10';
  $('#rt').value = '18';
  loadRentalQr();

  $('#rm').addEventListener('click', e => {
    const m = e.target.dataset.m;
    if (!m) return;
    rentMode = m;
    cart = {};
    renderCart();
    renderRentMode();
  });

  $('#eq-cats').addEventListener('click', e => {
    const c = e.target.closest('[data-cat]');
    if (!c) return;
    rentCat = c.dataset.cat;
    renderEquipment();
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

  $('#pd').addEventListener('change', () => {
    $('#rd').min = $('#pd').value || TODAY;
    if ($('#rd').value < $('#pd').value) $('#rd').value = $('#pd').value;
    renderCart();
  });
  ['#rd', '#pt', '#rt'].forEach(sel => $(sel).addEventListener('change', renderCart));
  $('#or-agree').addEventListener('change', e => { if (e.target.checked) $('#or-terms').classList.remove('err'); });
  $('#vf').addEventListener('change', updateRequestButton);
  $('#rq').addEventListener('click', requestRental);
  $('#lb-find').addEventListener('click', findGuestBooking);
  $('#lb-ref').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); findGuestBooking(); } });
  $('#lb-ref').addEventListener('input', () => { attachBooking = null; updateRequestButton(); });
}

async function requestRental() {
  const keys = Object.keys(cart);
  if (!keys.length) return toast('Add at least one item first.');
  const items = keys.map(i => ({ equipment_id: EQUIPMENT[i].id, quantity: cart[i].q }));
  const btn = $('#rq');
  btn.disabled = true;

  try {
    if (rentMode === 'addon') {
      const ref = isMember() ? $('#lb').value : (attachBooking && attachBooking.ref);
      if (!ref) return toast(isMember() ? 'Attach the rental to a studio booking first.' : 'Find your booking with its reference code first.');
      const { error } = await sb.rpc('request_rental', { p_type: 'Add-on', p_items: items, p_booking_ref: ref });
      if (error) return toast(error.message);
      const added = items.map(x => { const e = EQUIPMENT.find(y => y.id === x.equipment_id); return ['Added', `${e.name} x${x.quantity}`]; });
      cart = {};
      renderCart();
      await loadMyBookings();
      await loadMyRentals();
      // the booking's total now includes the new equipment
      const { data: bk } = await sb.rpc('lookup_booking', { p_ref: ref });
      if (!isMember()) { $('#lb-ref').value = ''; attachBooking = null; $('#lb-info').className = 'mut'; $('#lb-info').textContent = 'Enter the reference code from your booking confirmation. The equipment is added to that booking and its total is updated.'; }
      showSuccess({ title: 'Equipment added to your booking!', label: 'Booking reference code', ref,
        lines: [...added, ...(bk ? [['Booking total now', peso(+(bk.grand_total ?? bk.total))]] : [])],
        shot: 'It is your official receipt. Show it to our staff when you arrive so we can verify your booking and equipment.',
        note: 'Staff review the equipment request. The new total is shown when you look up this booking.' });
      return;
    }

    /* ---- outside rental (members only, with a 50% down payment) ---- */
    if (!isMember()) return toast('Please log in to rent equipment outside the studio.');
    const pd = $('#pd').value, rd = $('#rd').value, ph = +$('#pt').value, rh = +$('#rt').value;
    const first = $('#on-fn').value.trim(), last = $('#on-ln').value.trim();
    const contact = $('#oc').value.trim(), backup = $('#sm-link').value.trim();
    const gref = $('#og').value.replace(/\s/g, ''), file = $('#vf').files[0], hours = outsideHours();

    if (!first || !last) return toast('Enter your first and last name.');
    if (!pd || !rd) return toast('Choose the pick-up and return dates.');
    if (pd < TODAY || (pd === TODAY && ph <= manilaParts(new Date()).hour)) return toast('The pick-up time must be later than now.');
    if (hours === null) return toast('The return time must be after the pick-up time.');
    if (!/^[\d\s+()-]{7,}$/.test(contact)) return toast('Enter a valid contact number.');
    if (backup && !/^[\d\s+()-]{7,}$/.test(backup)) return toast('The backup contact must be a phone number.');
    if (!file) return toast('Attach a valid ID.');
    if (!/^\d{13}$/.test(gref)) return toast('Enter the 13-digit GCash reference number of your down payment.');
    if (!$('#or-agree').checked) {
      $('#or-terms').classList.add('err');
      return toast('Please tick the box to confirm you agree to the rental terms.');
    }

    // upload the ID photo first; the request stores only its path
    const ext = ((file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '')) || 'jpg';
    const path = `${crypto.randomUUID()}/${Date.now()}.${ext}`;
    const up = await sb.storage.from('rental-ids').upload(path, file, { contentType: file.type });
    if (up.error) return toast('Could not upload your ID: ' + up.error.message);

    const money = rentalMoney();
    const { data, error } = await sb.rpc('request_outside_rental', {
      p_items: items, p_first_name: first, p_last_name: last, p_number: contact,
      p_pickup_date: manilaTS(pd, ph), p_return_date: manilaTS(rd, rh),
      p_contact_number: contact, p_backup_contact: backup || null,
      p_id_type: $('#vt').value, p_id_image_path: path, p_gcash_reference: gref
    });
    if (error) return toast(error.message);
    const row = Array.isArray(data) ? data[0] : data;

    cart = {};
    $('#vf').value = '';
    $('#og').value = '';
    $('#or-agree').checked = false;
    renderCart();
    await loadMyRentals();
    showSuccess({
      title: 'Rental request sent!', label: 'Your rental reference code', ref: row.rental_ref,
      lines: [
        ['Pick-up', `${shortDate(pd)}, ${hourLabel(ph)}`],
        ['Return', `${shortDate(rd)}, ${hourLabel(rh)}`],
        ['Total', peso(Number(row.total_amount) || money.total)],
        ['Down payment sent', peso(Number(row.down_payment) || money.down)],
        ['Balance at pick-up', peso((Number(row.total_amount) || money.total) - (Number(row.down_payment) || money.down))]
      ],
      shot: 'It is your official receipt. Show it to our staff when you pick up the equipment so we can verify your rental.',
      note: 'Staff will check your ID and verify your down payment. Bring the same ID when you pick up the equipment.'
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
  `<div class="alert">No ${what} found for <b>${esc(ref)}</b>. Check the code and try again. If you booked with an account, log in to see it. Or email us.</div>`;
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
      const details = `<button class="btn sm line" data-act="details" data-ref="${b.ref}">Details</button>`;
      const actions = editable
        ? details + `<button class="btn sm" data-act="resched" data-ref="${b.ref}">Reschedule</button><button class="btn sm line" data-act="cancel" data-ref="${b.ref}">Cancel</button>`
        : details;
      return [b.ref, 'Studio ' + b.studio, shortDate(b.date), b.start, b.hours + (b.hours > 1 ? ' hrs' : ' hr'),
              badge(b.status), badge(b.payment), actions];
    }));
}

/* The booking receipt: the same layout as the success pop-up, so a customer can screenshot it. */
function showDetails(b) {
  const s = STUDIOS[studioIndex(b.studio)], ad = ADDONS[b.ref] || [];
  const total = s.rate * b.hours + ad.reduce((n, a) => n + a.price * a.qty, 0);
  const lines = [
    ['Name', b.name || (PROFILE ? `${PROFILE.first} ${PROFILE.last}`.trim() : '')],
    ['Studio', `Studio ${b.studio}`],
    ['Date', longDate(b.date)],
    ['Time', `${b.start} to ${endTime(b.start, b.hours)} (${b.hours} hr${b.hours > 1 ? 's' : ''})`],
    ...ad.map(a => ['Add-on', `${a.name} x${a.qty} (${peso(a.price * a.qty)})`]),
    ['Total', peso(total)],
    ['Payment', `${b.method || 'Payment'}, ${b.payment}`]
  ].filter(l => l[1]);
  if (b.created) lines.push(['Booked on', stampLabel(b.created)]);
  showSuccess({
    title: 'Booking receipt', label: 'Reference code', ref: b.ref, lines, icon: 'receipt', status: badge(b.status), doneLabel: 'Close',
    shot: 'It is your official receipt. Show it to our staff when you arrive so we can verify your reservation.',
    note: 'Bookings are confirmed after staff verify your payment.'
  });
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
    <input id="rs-d" type="date" min="${firstBookableDate()}" value="${b.date}">
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
    // one row per rental order, with all of its items listed in that row
    const orders = [];
    list.forEach(r => {
      let o = orders.find(x => x.rental_ref === r.rental_ref);
      if (!o) { o = { rental_ref: r.rental_ref, rental_type: r.rental_type, status: r.status, return_by: r.return_by, rejected_reason: r.rejected_reason, items: [] }; orders.push(o); }
      o.items.push(`${esc(r.equipment)} x${r.quantity}`);
    });
    box.innerHTML = `<div class="tw" style="margin-top:8px">${tableNotes(['Reference', 'Items', 'Rent type', 'Return by', 'Status'],
      orders.map(o => ({
        cells: [esc(o.rental_ref), `<span class="itm">${o.items.join('<br>')}</span>`,
          o.rental_type === 'Add-on' ? '<span class="b addon">Add-on</span>' : '<span class="b out">Outside</span>',
          o.return_by ? shortDate(manilaParts(o.return_by).date) : '', badge(RN_STATUS[o.status] || o.status)],
        note: whyRejected(o.status, o.rejected_reason)
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

/* A rental can be cancelled until 24 hours before pick-up (outside) or before the booked session (add-on). */
const rentalStart = r => {
  if (r.type === 'out') return r.pickup ? new Date(r.pickup) : null;
  const b = BOOKINGS.find(x => x.ref === r.ref);
  return b ? startsAt(b) : null;
};
const rentalLocked = r => { const d = rentalStart(r); return !!d && d - Date.now() < 24 * 60 * 60 * 1000; };
const rentalCutoffMsg = r => `Changes and cancellations close 24 hours before ${r.type === 'out' ? 'pick-up' : 'your session'}.`;

/* One rental order = every item that shares the same rental reference. */
function rentalOrders() {
  const map = new Map();
  RENTALS.forEach(r => {
    if (!map.has(r.rentalRef)) {
      map.set(r.rentalRef, { rentalRef: r.rentalRef, ref: r.ref, type: r.type, status: r.status, rawStatus: r.rawStatus,
        when: r.when, ret: r.ret, reason: r.reason, lines: [] });
    }
    map.get(r.rentalRef).lines.push(r);
  });
  return [...map.values()];
}

/* "3 items: Electric guitar x2, Guitar amplifier x1" (long orders end with "+2 more") */
function itemSummary(lines, all) {
  const count = sum(lines.map(l => l.qty));
  const names = lines.map(l => `${esc(l.item)} x${l.qty}`);
  const shown = all ? names.join(', ') : names.slice(0, 2).join(', ') + (names.length > 2 ? `, +${names.length - 2} more` : '');
  return `<b>${count} item${count === 1 ? '' : 's'}</b>: ${shown}`;
}

function renderMyRentals() {
  const orders = rentalOrders();
  if (!orders.length) {
    $('#myrent').innerHTML = '<p class="mut" style="padding:8px">No rentals yet.</p>';
    return;
  }
  $('#myrent').innerHTML = tableNotes(
    ['Reference', 'Items', 'Rent type', 'Session or pick-up', 'Return', 'Status', ''],
    orders.map(o => {
      const canCancel = ['Pending', 'Approved'].includes(o.rawStatus);
      const actions = `<button class="btn sm line" data-rn="details" data-ref="${esc(o.rentalRef)}">Details</button>` +
        (canCancel ? `<button class="btn sm line" data-rn="cancel" data-ref="${esc(o.rentalRef)}">Cancel</button>` : '');
      return {
        cells: [
          `<button type="button" class="lk" data-rn="details" data-ref="${esc(o.rentalRef)}">${esc(o.ref)}</button>`,
          `<span class="itm">${itemSummary(o.lines)}</span>`,
          o.type === 'addon' ? '<span class="b addon">Add-on</span>' : '<span class="b out">Outside</span>',
          o.when, o.ret, badge(o.status), actions
        ],
        note: whyRejected(o.status, o.reason)
      };
    }));
}

/* Side drawer: every item of the order, prices, totals, status. */
const rnDrawer = $('#rndrawer');
rnDrawer.addEventListener('click', e => {
  if (e.target === rnDrawer || e.target.closest('[data-close]')) return rnDrawer.close();
  const c = e.target.closest('[data-rn="cancel"]');
  if (c) startCancelRental(c.dataset.ref);
});

function showRentalDetails(ref) {
  const o = rentalOrders().find(x => x.rentalRef === ref);
  if (!o) return;
  const out = o.type === 'out', r0 = o.lines[0];
  const hrs = out ? Math.max(8, Math.ceil(r0.hours || 8)) : 0, factor = out ? hrs / 8 : 1;
  const lineTotal = l => l.unit * l.qty * factor;
  const base = sum(o.lines.map(l => l.unit * l.qty)), total = sum(o.lines.map(lineTotal));
  const canCancel = ['Pending', 'Approved'].includes(o.rawStatus);

  let money = `<div class="dr-sum"><div><span>${out ? 'Rental (first 8 hours)' : 'Add-on equipment'}</span><span>${peso(base)}</span></div>`;
  if (out && hrs > 8) money += `<div><span>Extra hours (${hrs - 8} x ${peso(base / 8)})</span><span>${peso(total - base)}</span></div>`;
  money += `<div class="tot-line"><b>Total</b><b>${peso(total)}</b></div>`;
  if (out) {
    const due = r0.due ? new Date(r0.due) : null, now = Date.now();
    const accruing = due ? o.lines.filter(l => l.rawStatus === 'Active' && !l.returnedAt && now > due) : [];
    const fee = sum(o.lines.map(l => l.late)) + sum(accruing.map(l => l.qty * l.unit / 8 * Math.ceil((now - due) / 3600e3)));
    money += `<div><span>Down payment (50%, non-refundable if cancelled)</span><span>${peso(r0.down)}</span></div>
      <div><span>Balance to pay at pick-up</span><span>${peso(Math.max(0, total - r0.down))}</span></div>` +
      (fee > 0 ? `<div><span>Late fee ${accruing.length ? 'so far' : ''}</span><b style="color:var(--bad)">${peso(fee)}</b></div>` : '');
  }
  money += '</div>';

  rnDrawer.innerHTML = `
    <div class="dr">
      <div class="row">
        <div><p class="mut" style="margin:0">Rental order</p><h2 style="margin:0">${esc(o.ref)}</h2></div>
        <button type="button" class="btn sm line" data-close aria-label="Close details">Close</button>
      </div>
      <div>${badge(o.status)} ${out ? '<span class="b out">Outside</span>' : '<span class="b addon">Add-on</span>'}</div>
      ${o.status === 'Rejected' ? `<div class="alert">${whyRejected(o.status, o.reason)}</div>` : ''}

      <h3>${out ? 'Pick-up and return' : 'Studio session'}</h3>
      <dl class="dl">
        <dt>${out ? 'Pick-up' : 'Starts'}</dt><dd>${o.when}</dd>
        <dt>${out ? 'Return by' : 'Ends'}</dt><dd>${o.ret}</dd>
        ${out ? `<dt>Scheduled length</dt><dd>${Math.round((r0.hours || 0) * 100) / 100} hours (billed as ${hrs})</dd><dt>Late fees start</dt><dd>${r0.due ? fmtDT(r0.due) : '-'}</dd>` : `<dt>Booking</dt><dd>${esc(o.ref)}</dd>`}
      </dl>

      <h3>Items (${sum(o.lines.map(l => l.qty))})</h3>
      <div class="dr-items">
        ${o.lines.map(l => `
          <div class="dr-item">
            <div><b>${esc(l.item)}</b><div class="mut">${l.qty} x ${peso(l.unit)} ${out ? 'per 8 hours' : 'each'}${l.returnedAt ? ' &middot; Returned' : ''}</div></div>
            <b>${peso(lineTotal(l))}</b>
          </div>`).join('')}
      </div>

      <h3>Summary</h3>
      ${money}
      ${out ? '<p class="mut">Each hour beyond 8 hours adds one-eighth of the item price. Returning late adds the same charge for every hour late.</p>' : ''}
      <div class="acts">
        ${canCancel ? `<button type="button" class="btn bad" data-rn="cancel" data-ref="${esc(o.rentalRef)}">Cancel rental</button>` : ''}
        <button type="button" class="btn line" data-close>Close</button>
      </div>
    </div>`;
  rnDrawer.showModal();
}

function startCancelRental(ref) {
  const r = RENTALS.find(x => x.rentalRef === ref);
  if (!r) return;
  if (rentalLocked(r)) return toast(rentalCutoffMsg(r));
  if (rnDrawer.open) rnDrawer.close();
  confirmCancelRental(ref);
}

function confirmCancelRental(ref) {
  const o = rentalOrders().find(x => x.rentalRef === ref);
  if (!o) return;
  const out = o.type === 'out';
  showDialog(`
    <h2>Cancel ${esc(o.ref)}?</h2>
    <p class="mut">${itemSummary(o.lines, true)}</p>
    <p class="mut" style="margin-top:8px">${out
      ? `Your 50% down payment of <b>${peso(o.lines[0].down)}</b> is <b>non-refundable</b> once the rental is cancelled.`
      : 'The add-on equipment is removed from your booking. Your studio booking stays as it is.'}</p>
    <div class="acts">
      <button class="btn line" data-close>Keep rental</button>
      <button class="btn bad" id="do-cancel-r">Cancel rental</button>
    </div>`);
  $('#do-cancel-r').onclick = async () => {
    const { error } = await sb.rpc('cancel_rental', { p_rental_ref: ref });
    if (error) return toast(error.message);
    dlg.close();
    await loadMyRentals();
    toast(`${o.ref} cancelled.`);
  };
}

function initMyRentals() {
  $('#myrent').addEventListener('click', e => {
    const b = e.target.closest('[data-rn]');
    if (!b) return;
    if (b.dataset.rn === 'details') return showRentalDetails(b.dataset.ref);
    startCancelRental(b.dataset.ref);
  });
}


/* ============================ 6. START ============================ */

async function applyUrlParams() {
  const q = new URLSearchParams(location.search);

  const studio = studioIndex(q.get('studio'));
  if (studio >= 0) selStudio = studio;

  const date = q.get('date');
  if (/^\d{4}-\d{2}-\d{2}$/.test(date || '') && date >= firstBookableDate()) {
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
initMyRentals();
applyAccessMode();
window.addEventListener('hashchange', showTab);

// wait for studios and equipment to load, then draw everything
dataReady.then(async () => {
  selStudio = Math.max(0, STUDIOS.findIndex(s => !isClosed(s)));
  renderEquipment();
  renderCart();
  renderRentMode();
  profileReady.then(() => {
    if (!PROFILE) return;
    if (!$('#on-fn').value) $('#on-fn').value = PROFILE.first;
    if (!$('#on-ln').value) $('#on-ln').value = PROFILE.last;
    if (!$('#oc').value) $('#oc').value = PROFILE.number;
  });
  showTab();
  await loadMyBookings();
  await loadMyRentals();
  await applyUrlParams();
});
