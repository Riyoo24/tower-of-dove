/* =====================================================================
   customer/myBookings.js - "My bookings" tab
   Table, details, reschedule, cancel and guest reference lookup.
   ===================================================================== */

import { state } from './state.js';
import { sb } from '../config/supabaseClient.js';
import { refreshBook } from './book.js';
import { BK_STATUS, loadMyBookings } from './data.js';
import { dlg, showDialog, showSuccess, stampLabel, table } from './ui.js';
import { BOOKINGS, firstBookableDate, loadBusy, takenSlots } from '../shared/availability.js';
import { STUDIOS, studioIndex } from '../shared/catalog.js';
import { $, SLOTS, badge, endTime, esc, longDate, manilaParts, manilaTS, pad, peso, shortDate, toast } from '../shared/utils.js';

/* ============================ 4. MY BOOKINGS ============================ */

export const startsAt = b => new Date(`${b.date}T${pad(10 + SLOTS.indexOf(b.start))}:00`);

const insideCutoff = b => startsAt(b) - Date.now() < 24 * 60 * 60 * 1000;

const findBooking = ref => BOOKINGS.find(b => b.ref === ref);

export const normRef = v => v.trim().toUpperCase().replace(/\s+/g, '');

export const notFound = (ref, what) =>
  `<div class="alert">No ${what} found for <b>${esc(ref)}</b>. Check the code and try again. If you booked with an account, log in to see it. Or email us.</div>`;

const CUTOFF_MSG = 'Changes and cancellations close 24 hours before your session.';

export function renderMyBookings() {
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
  const s = STUDIOS[studioIndex(b.studio)], ad = state.ADDONS[b.ref] || [];
  const total = s.rate * b.hours + ad.reduce((n, a) => n + a.price * a.qty, 0);
  const lines = [
    ['Name', b.name || (state.PROFILE ? `${state.PROFILE.first} ${state.PROFILE.last}`.trim() : '')],
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

export function initBookingsTab() {
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
