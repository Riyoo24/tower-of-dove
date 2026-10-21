/* =====================================================================
   admin/bookings.js - Bookings tab
   Search / filter, confirm, start, complete, cancel.
   DB: table booking (status updates).
   ===================================================================== */

import { state } from './state.js';
import { BK, PAY, RL, refresh } from './data.js';
import { ACT, bkStatus, btn, dOf, dlg, money, num, run, showDlg, tOf, tabsHtml, tbl } from './helpers.js';
import { vdr } from './verify.js';
import { sb } from '../config/supabaseClient.js';
import { $, badge, esc, longDate, pl, shortDate, toast } from '../shared/utils.js';

const BK_TABS = ['All', 'Pending', 'Confirmed', 'Active', 'Completed', 'Cancelled', 'Rejected'];

export const findBk = ref => BK.find(b => b.booking_ref === ref);

function bkActions(b) {
  const id = b.booking_ref;
  if (b.status === 'Pending') return btn('bk-verify', id, 'Verify');   // opens the Verify drawer in the Payments tab
  if (b.status === 'Approved') return btn('bk-go', id, 'Start session') + btn('bk-det', id, 'Details', 1) + btn('bk-cx', id, 'Cancel', 1);
  if (b.status === 'In Progress') return btn('bk-done', id, 'Mark completed') + btn('bk-det', id, 'Details', 1);
  return btn('bk-det', id, 'Details', 1);
}

export function renderBookings() {
  const q = ($('#bk-q').value || '').toLowerCase(), sid = $('#bk-s').value, d = $('#bk-d').value, src = $('#bk-src').value;
  const rows = BK.filter(b =>
    (state.bkF === 'All' || bkStatus(b.status) === state.bkF) &&
    (!q || `${b.booking_ref} ${b.customer_name} ${b.customer_number || ''}`.toLowerCase().includes(q)) &&
    (!sid || String(b.studio_id) === sid) && (!d || dOf(b.start_at) === d) && (!src || b.source === src));
  $('#abk').innerHTML = tabsHtml(BK_TABS, state.bkF, 'bf') + '<div class="tw">' + tbl(
    ['Reference', 'Customer', 'Studio', 'Date', 'Time', 'Duration', 'Status', 'Payment', 'Actions'],
    rows.map(b => [b.booking_ref, esc(b.customer_name) + (b.is_guest ? ' <span class="mut">(guest)</span>' : ''), esc(b.studio_name),
      shortDate(dOf(b.start_at)), tOf(b.start_at), pl(Math.round(num(b.hours)), 'hr'),
      badge(bkStatus(b.status)), badge(b.payment_status || 'Pending'), bkActions(b)])) + '</div>';
}

$('#abk').addEventListener('click', e => { const t = e.target.closest('[data-bf]'); if (t) { state.bkF = t.dataset.bf; renderBookings(); } });

['#bk-q', '#bk-s', '#bk-d', '#bk-src'].forEach(s => $(s).addEventListener('input', renderBookings));

/* the small dialog and the Verify drawer both close after an action */
export const closeOverlays = () => { if (dlg.open) dlg.close(); if (vdr.open) vdr.close(); };

export const afterAction = async msg => { await refresh(); closeOverlays(); if (msg) toast(msg); };

const setBooking = (b, status, extra) => run(sb.from('booking').update({ status, ...(extra || {}) }).eq('booking_id', b.booking_id));

/* Verifying a booking payment also approves its add-on equipment (done by the database).
   These two helpers only choose the message shown afterwards. */
export const pendingAddons = ref => RL.some(l => l.booking_ref === ref && l.rental_type === 'Add-on' && l.status === 'Pending');

export const verifiedMsg = (ref, had) => !had ? `${ref} confirmed. Payment verified.`
  : pendingAddons(ref) ? `${ref} confirmed. Some add-on equipment is still pending (not enough stock). Check the Rentals tab.`
  : `${ref} confirmed. Add-on equipment approved too.`;

ACT['bk-ok'] = async ref => {
  const b = findBk(ref), had = pendingAddons(ref);
  const r = b.payment_id ? await run(sb.from('payment').update({ status: 'Verified' }).eq('payment_id', b.payment_id)) : await setBooking(b, 'Approved');
  if (r) { await refresh(); closeOverlays(); toast(verifiedMsg(ref, had)); }
};

ACT['bk-no'] = async ref => {
  const b = findBk(ref);
  const r = b.payment_id ? await run(sb.from('payment').update({ status: 'Rejected' }).eq('payment_id', b.payment_id)) : await setBooking(b, 'Rejected', { rejected_reason: 'Rejected by staff' });
  if (r) afterAction(`${ref} rejected.`);
};

ACT['bk-go'] = async ref => { if (await setBooking(findBk(ref), 'In Progress')) afterAction(`${ref} started.`); };

ACT['bk-done'] = async ref => { if (await setBooking(findBk(ref), 'Completed')) afterAction(`${ref} marked completed.`); };

ACT['bk-cx'] = async ref => {
  if (!confirm(`Cancel booking ${ref}? The time slot is released.`)) return;
  if (await run(sb.rpc('cancel_booking', { p_booking_ref: ref }))) afterAction(`${ref} cancelled.`);
};

ACT['bk-det'] = ref => {
  const b = findBk(ref);
  const ad = RL.filter(l => l.booking_ref === ref && l.rental_type === 'Add-on' && !['Rejected', 'Cancelled'].includes(l.status));
  const pay = PAY.find(p => p.reference === ref);
  showDlg(`<div class="row"><h2 style="margin:0">${esc(b.booking_ref)}</h2>${badge(bkStatus(b.status))}</div>
    <dl class="dl"><dt>Customer</dt><dd>${esc(b.customer_name)}${b.is_guest ? ' (guest)' : ''}</dd><dt>Phone</dt><dd>${esc(b.customer_number || 'Not on file')}</dd>
    <dt>Studio</dt><dd>${esc(b.studio_name)}</dd><dt>Date</dt><dd>${longDate(dOf(b.start_at))}</dd>
    <dt>Time</dt><dd>${tOf(b.start_at)} to ${tOf(b.end_at)} (${pl(Math.round(num(b.hours)), 'hr')})</dd>
    ${ad.length ? `<dt>Add-ons</dt><dd>${ad.map(l => esc(l.equipment_name) + ' x' + l.quantity + ' (' + money(num(l.unit_price_at_request) * l.quantity) + ')').join('<br>')}</dd>` : ''}
    <dt>Studio total</dt><dd>${money(b.total_amount)}</dd>${pay ? `<dt>Amount to pay</dt><dd><b>${money(pay.amount)}</b></dd>` : ''}<dt>Payment</dt><dd>${badge(b.payment_status || 'Pending')} ${esc(b.payment_method || '')}${b.gcash_reference ? ', ref ' + esc(b.gcash_reference) : ''}</dd>
    <dt>Source</dt><dd>${esc(b.source)}</dd></dl><div class="acts"><button class="btn line" data-close>Close</button></div>`);
};
