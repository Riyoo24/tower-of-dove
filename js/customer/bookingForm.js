/* =====================================================================
   customer/bookingForm.js - booking form dialog, time slots, add-ons, payment
   DB: rpc hold_slot / release_hold (slot holds) and the booking creation rpc, plus
   storage upload of the payment screenshot. Opened from the Book Now button.
   ===================================================================== */

import { state } from './state.js';
import { sb } from '../config/supabaseClient.js';
import { refreshBook } from './book.js';
import { loadMyBookings, loadMyRentals, profileReady, rememberGuestBooking } from './data.js';
import { bkDlg, showSuccess, stampLabel } from './ui.js';
import { conflictKind, heldSlots, isPastSlot, loadBusy, takenSlots } from '../shared/availability.js';
import { equipmentImage } from '../shared/cards.js';
import { EQUIPMENT, STUDIOS, gcashQrUrl } from '../shared/catalog.js';
import { HOLD_TOKEN, LOCK_TTL, holdSlots, releaseHold } from '../shared/holds.js';
import { isMember } from '../shared/session.js';
import { $, SLOTS, endTime, esc, longDate, manilaDay, manilaTS, pad, peso, pl, toast } from '../shared/utils.js';

const bkError = msg => { const x = $('#bk-e'); x.textContent = msg; x.hidden = !msg; };

/* The studio closes at 10:00 PM, so a session must end by then: the last start time is 9:00 PM
   (one hour) and only the durations that still fit are offered. */
const durationOptions = (t, h) => {
  const max = Math.min(4, SLOTS.length - t);
  return Array.from({ length: max }, (_, i) => `<option value="${i + 1}" ${i + 1 === h ? 'selected' : ''}>${i + 1} hour${i ? 's' : ''}</option>`).join('');
};

/* add-on equipment picked in the booking form: [{ equipment_id, quantity }] */
const addOnSelection = () => Object.entries(state.draft ? state.draft.addons : {}).map(([id, q]) => ({ equipment_id: +id, quantity: +q })).filter(x => x.quantity > 0);

const addOnPrice = id => { const e = EQUIPMENT.find(x => x.id === id); return e ? e.addonPrice : 0; };

/* studio price + add-ons = total (also the amount to pay by GCash) */
function updateTotals() {
  const studio = STUDIOS[state.draft.si].rate * state.draft.h;
  const sel = addOnSelection(), addons = sel.reduce((n, x) => n + addOnPrice(x.equipment_id) * x.quantity, 0);
  $('#bk-hh').textContent = `${pl(state.draft.h, 'hr')}, ${SLOTS[state.draft.t]} to ${endTime(SLOTS[state.draft.t], state.draft.h)}`;
  $('#bk-st').textContent = peso(studio);
  $('#bk-adr').hidden = !sel.length;
  $('#bk-ao').textContent = peso(addons);
  $('#bk-t').textContent = peso(studio + addons);
  if ($('#bk-qa')) $('#bk-qa').textContent = peso(studio + addons);
}

/* Wording for a time that someone else holds or has booked */
const MSG_HELD = 'Someone is already trying to book this schedule. Please try again in a moment or choose another time.';

const MSG_BOOKED = 'That time was just booked by someone else. Please choose another time.';

const slotError = msg => /just taken by another customer/i.test(msg) ? MSG_HELD : /no longer available/i.test(msg) ? MSG_BOOKED : msg;

function drawSlots() {
  const taken = takenSlots(state.draft.si, state.draft.d), held = heldSlots(state.draft.si, state.draft.d);
  $('#bk-slots').innerHTML = SLOTS.map((t, i) => {
    const isHeld = taken.has(i) && held.has(i), past = isPastSlot(state.draft.d, i), late = i + state.draft.h > SLOTS.length;
    const tip = isHeld ? ' title="Someone is already trying to book this schedule"'
              : late ? ` title="A ${state.draft.h}-hour session from ${t} would run past the 10:00 PM closing time"` : '';
    return `<button type="button" data-i="${i}" class="${i === state.draft.t ? 'sel' : ''}${isHeld ? ' held' : ''}" ${taken.has(i) || past || late ? 'disabled' : ''}${tip}>${t}</button>`;
  }).join('');
  if ($('#bk-hint')) $('#bk-hint').hidden = !SLOTS.some((_, i) => taken.has(i) && held.has(i));
  updateTotals();
}

/* Try to hold hours t..t+h for this customer (held on the server for 2 minutes). */
async function moveDraft(t, h) {
  if (t + h > SLOTS.length) { bkError('That runs past closing time. Choose a shorter duration.'); return false; }
  const ok = await holdSlots(state.draft.si, state.draft.d, t, h);
  if (!state.draft) return false;                    // the form was closed while this request was running (the release is queued behind it)
  if (!ok) {
    await holdSlots(state.draft.si, state.draft.d, state.draft.t, state.draft.h);   // a failed move drops the old hold, so take it back
    if (!state.draft) return false;
    await loadBusy(state.draft.si, state.draft.d, state.draft.d);
    if (!state.draft) return false;
    bkError(conflictKind(state.draft.si, state.draft.d, t, h) === 'held' ? MSG_HELD : MSG_BOOKED);
    drawSlots();
    return false;
  }
  state.draft.t = t; state.draft.h = h;
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
  const q = state.draft.addons[e.id] || 0, max = Math.min(e.stock, 10);
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
  if (!state.draft) return;
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
  if (!s || !state.draft) return;
  state.draft.addons[s.dataset.aq] = +s.value;
  renderAddOnSummary();
  updateTotals();
  eqCount();
  if (bumpIdle) bumpIdle();
});

export async function openBook(startIndex) {
  await profileReady;
  const si = state.selStudio, d = state.selDate;
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

  state.draft = { si, d, t, h, addons: {} };
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
  state.idleUntil = Date.now() + LOCK_TTL;
  if (state.PROFILE) { $('#bk-fn').value = state.PROFILE.first; $('#bk-ln').value = state.PROFILE.last; $('#bk-p').value = state.PROFILE.number; }   // signed-in customers: fill in their details

  $('#bk-slots').onclick = e => {
    const b = e.target.closest('button');
    if (b && !b.disabled) moveDraft(+b.dataset.i, state.draft.h);
  };
  $('#bk-h').onchange = async e => { if (!(await moveDraft(state.draft.t, +e.target.value))) e.target.value = state.draft.h; };
  $('#bk-m').onchange = e => { $('#bk-gw').hidden = e.target.value !== 'GCash'; };
  $('#bk-x').onclick = () => bkDlg.close();
  $('#bk-ad-open').onclick = openAddOnModal;
  $('#bk-ad').onclick = e => {
    const r = e.target.closest('[data-rm-ad]');
    if (r) { delete state.draft.addons[r.dataset.rmAd]; renderAddOnSummary(); updateTotals(); }
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
    state.idleUntil = Date.now() + LOCK_TTL;
    if (state.draft && Date.now() - lastHold > 30000) { lastHold = Date.now(); holdSlots(state.draft.si, state.draft.d, state.draft.t, state.draft.h); }
  };
  bumpIdle = keepAlive;
  // refresh the day every 15 seconds so times someone else was holding open up again
  const slotPoll = setInterval(async () => {
    if (!state.draft || !bkDlg.open) return;
    await loadBusy(state.draft.si, state.draft.d, state.draft.d);
    drawSlots();
  }, 15000);
  ['pointerdown', 'keydown', 'input', 'touchstart'].forEach(ev => bkDlg.addEventListener(ev, keepAlive));
  bkDlg.addEventListener('scroll', keepAlive, true);

  clearInterval(state.idleTimer);
  state.idleTimer = setInterval(() => {
    const left = state.idleUntil - Date.now();
    if (left <= 0) { state.draft.why = 'timeout'; bkDlg.close(); return; }
    $('#bk-left').textContent = `Closes in ${Math.floor(left / 6e4)}:${pad(Math.floor(left / 1e3) % 60)} if idle`;
  }, 1000);

  bkDlg.onclose = () => {
    clearInterval(state.idleTimer);
    clearInterval(slotPoll);
    releaseHold();
    bumpIdle = null;
    if (eqDlg.open) eqDlg.close();
    const why = state.draft && state.draft.why;
    state.draft = null;
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
    const snap = { s: STUDIOS[state.draft.si], d: state.draft.d, t: state.draft.t, h: state.draft.h };
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

    state.draft.why = 'done';
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
