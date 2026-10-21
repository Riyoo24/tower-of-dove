/* =====================================================================
   customer/myRentals.js - "My rental" tab
   Grouped rental orders, side drawer, cancel and guest lookup.
   ===================================================================== */

import { state } from './state.js';
import { sb } from '../config/supabaseClient.js';
import { RN_STATUS, loadMyRentals } from './data.js';
import { normRef, notFound, startsAt } from './myBookings.js';
import { fmtDT } from './rent.js';
import { dlg, showDialog } from './ui.js';
import { BOOKINGS } from '../shared/availability.js';
import { getUser } from '../shared/session.js';
import { $, badge, esc, manilaParts, peso, shortDate, sum, toast } from '../shared/utils.js';

/* ============================ 5. MY RENTAL ============================ */

/* Signed in: show the account tables. Guest: show the reference-code lookup. */
export function applyAccessMode() {
  const member = !!getUser();
  $('#bk-member').hidden = !member;  $('#bk-guest').hidden = member;
  $('#rt-member').hidden = !member;  $('#rt-guest').hidden = member;
}

export function initRentalLookup() {
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
  state.RENTALS.forEach(r => {
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

export function renderMyRentals() {
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
  const r = state.RENTALS.find(x => x.rentalRef === ref);
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

export function initMyRentals() {
  $('#myrent').addEventListener('click', e => {
    const b = e.target.closest('[data-rn]');
    if (!b) return;
    if (b.dataset.rn === 'details') return showRentalDetails(b.dataset.ref);
    startCancelRental(b.dataset.ref);
  });
}
