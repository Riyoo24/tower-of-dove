/* =====================================================================
   admin/verify.js - Verify drawer (Payments tab)
   One place to check a transaction before verifying or rejecting it.
   ===================================================================== */

import { closeOverlays, findBk } from './bookings.js';
import { PAY, RL, STK, refresh } from './data.js';
import { ACT, bkStatus, btn, dOf, money, num, rnStatus, run, stampLabel, tOf } from './helpers.js';
import { TYB, dueB, dueLabel, groupStatus, groups, lineStatus, loadRentalId, overdueHours, setRental } from './rentals.js';
import { sb } from '../config/supabaseClient.js';
import { loadCatalog } from '../shared/catalog.js';
import { $, $$, badge, esc, longDate, pl, shortDate, sum, toast } from '../shared/utils.js';

/* ============================ 7b. VERIFY DRAWER (Payments tab) ============================
   One place to check a transaction: who, what, how much, the GCash reference and (for outside
   rentals) the customer's ID. The Verify buttons in Bookings and Rentals open it here. */

export const vdr = $('#vdr');

let vKey = null;                                   // which transaction is open, so it can be redrawn

vdr.addEventListener('click', e => { if (e.target === vdr || e.target.closest('[data-close]')) vdr.close(); });

const REASONS_RENTAL = ['Down payment not received', 'Invalid or unclear ID', 'Equipment not available', 'Incomplete or unclear request', 'Other'];

const reasonPicker = () => `<label for="v-reason">Reason if rejecting (the customer sees this)</label>
  <select id="v-reason">${REASONS_RENTAL.map(r => `<option>${r}</option>`).join('')}</select>
  <div id="v-other-wrap" hidden><label for="v-other">Message to customer</label><input id="v-other" maxlength="300" placeholder="Describe the reason"></div>`;

const pickedReason = () => { const r = $('#v-reason').value; return r === 'Other' ? ($('#v-other').value.trim() || 'Other') : r; };

const drawerShell = (title, ref, badges, body) => `<div class="in"><div class="dr" style="padding:0">
  <div class="row"><div><p class="mut" style="margin:0">${title}</p><h2 style="margin:0">${esc(ref)}</h2></div><button type="button" class="btn sm line" data-close aria-label="Close">Close</button></div>
  <div>${badges}</div>${body}</div></div>`;

/* work out which booking or rental a Verify button means */
function resolveTx(key) {
  let pay = null, bookingRef = null, rentalRef = null;
  if (key.paymentId) {
    pay = PAY.find(p => p.payment_id === +key.paymentId);
    if (!pay) return null;
    if (pay.kind === 'Booking') bookingRef = pay.reference; else rentalRef = pay.reference;
  } else if (key.bookingRef) bookingRef = key.bookingRef;
  else if (key.rentalRef) {
    rentalRef = key.rentalRef;
    const g = groups().find(x => x.ref === rentalRef);
    if (g && g.type === 'Add-on' && g.booking) { bookingRef = g.booking; rentalRef = null; }   // add-ons are paid with their booking
  }
  if (bookingRef) return { type: 'booking', ref: bookingRef, pay: PAY.find(p => p.reference === bookingRef && p.kind === 'Booking') || null };
  return { type: 'rental', ref: rentalRef, pay: pay || PAY.find(p => p.reference === rentalRef) || null };
}

function openVerify(key) {
  const tx = resolveTx(key);
  if (!tx) return toast('That transaction could not be found.');
  vKey = key;
  if (tx.type === 'booking') drawBookingTx(tx); else drawRentalTx(tx);
  if (!vdr.open) vdr.showModal();
}

/* Used by the Verify buttons in Bookings and Rentals: switch to Payments, then open the drawer */
function verifyFromTab(key) {
  if (location.hash.slice(1) !== 'a-pay') location.hash = 'a-pay';
  openVerify(key);
}

/* the checkboxes the staff member must tick before the main button works */
function wireChecks() {
  const checks = $$('#vdr .vchk'), go = $('#v-go');
  if (go) { go.disabled = checks.some(c => !c.checked); checks.forEach(c => c.addEventListener('change', () => { go.disabled = checks.some(x => !x.checked); })); }
  const sel = $('#v-reason');
  if (sel) sel.onchange = () => { $('#v-other-wrap').hidden = sel.value !== 'Other'; };
}

const checkRow = text => `<label class="terms" style="margin:0"><input type="checkbox" class="vchk"><span>${text}</span></label>`;

const payBlock = (p, fallbackAmount) => p
  ? `<dl class="dl"><dt>Method</dt><dd>${esc(p.method)}</dd><dt>Amount</dt><dd><b>${money(p.amount)}</b></dd>
      ${p.method === 'GCash' ? `<dt>GCash reference</dt><dd><b style="letter-spacing:.04em">${esc(p.gcash_reference || '')}</b></dd>` : '<dt>Paid</dt><dd>Cash at the studio</dd>'}
      <dt>Status</dt><dd>${badge(p.status)}</dd><dt>Sent</dt><dd>${p.created_at ? stampLabel(p.created_at) : '-'}</dd></dl>`
  : `<p class="mut">No payment record for this transaction. Amount: <b>${money(fallbackAmount)}</b>.</p>`;

/* ---- a studio booking (with any add-on equipment paid together) ---- */
function drawBookingTx(tx) {
  const b = findBk(tx.ref), pay = tx.pay;
  if (!b) { vdr.innerHTML = drawerShell('Booking', tx.ref, '', '<p class="mut">This booking could not be found.</p>'); return; }
  const ad = RL.filter(l => l.booking_ref === b.booking_ref && l.rental_type === 'Add-on');
  const counted = ad.filter(l => !['Rejected', 'Cancelled'].includes(l.status));
  const adTotal = sum(counted.map(l => num(l.unit_price_at_request) * l.quantity)), studio = num(b.total_amount);
  const payPending = !!pay && pay.status === 'Pending', needsCheck = payPending || (!pay && b.status === 'Pending');
  const pendingOrders = !payPending ? [...new Set(ad.filter(l => l.status === 'Pending').map(l => l.rental_ref))] : [];

  let body = `<h3>Customer</h3><dl class="dl"><dt>Name</dt><dd>${esc(b.customer_name)}${b.is_guest ? ' <span class="mut">(guest)</span>' : ''}</dd><dt>Phone</dt><dd>${esc(b.customer_number || 'Not on file')}</dd></dl>
    <h3>Booking</h3><dl class="dl"><dt>Studio</dt><dd>${esc(b.studio_name)}</dd><dt>Date</dt><dd>${longDate(dOf(b.start_at))}</dd>
      <dt>Time</dt><dd>${tOf(b.start_at)} to ${tOf(b.end_at)} (${pl(Math.round(num(b.hours)), 'hr')})</dd><dt>Source</dt><dd>${esc(b.source)}</dd></dl>`;
  if (ad.length) {
    body += `<h3>Add-on equipment</h3><div class="dr-items">${ad.map(l => `<div class="dr-item"><div><b>${esc(l.equipment_name)}</b><div class="mut">${l.quantity} x ${money(l.unit_price_at_request)} ${badge(lineStatus(l))}</div></div><b>${money(num(l.unit_price_at_request) * l.quantity)}</b></div>`).join('')}</div>`;
  }
  const grand = studio + adTotal, paidOk = pay && pay.status === 'Verified' ? num(pay.amount) : 0, balance = pay && pay.status === 'Verified' ? Math.max(0, grand - paidOk) : 0;
  body += `<h3>Amount</h3><div class="dr-sum"><div><span>Studio</span><span>${money(studio)}</span></div>${adTotal ? `<div><span>Add-on equipment</span><span>${money(adTotal)}</span></div>` : ''}<div class="tot-line"><b>Booking total</b><b>${money(grand)}</b></div>
    ${balance > 0 ? `<div><span>Already paid (verified)</span><span>${money(paidOk)}</span></div><div><span>Add-on balance to collect</span><b style="color:var(--warn)">${money(balance)}</b></div>` : ''}</div>
    <h3>Payment</h3>${payBlock(pay, studio + adTotal)}`;

  if (needsCheck) {
    body += pay
      ? checkRow(pay.method === 'GCash' ? `I checked GCash reference <b>${esc(pay.gcash_reference || '')}</b> and the amount of <b>${money(pay.amount)}</b> was received.` : `The cash payment of <b>${money(pay.amount)}</b> was received at the studio.`)
      : checkRow('I checked this booking and it can be confirmed.');
    body += `<div class="acts"><button class="btn line" data-close>Close</button>${btn('bk-no', b.booking_ref, pay ? 'Reject payment' : 'Reject booking').replace('btn sm', 'btn bad')}
      <button class="btn gold" id="v-go" data-act="bk-ok" data-id="${esc(b.booking_ref)}" disabled>${pay ? 'Verify payment' : 'Confirm booking'}</button></div>
      <p class="mut">Verifying also confirms the booking and approves its add-on equipment.</p>`;
  } else {
    if (pendingOrders.length) {
      body += `<h3>Add-on equipment waiting for approval</h3><div class="alert">Some add-on equipment is still pending (it may be out of stock). Approve or reject it here.</div>${reasonPicker()}` +
        pendingOrders.map(r => `<div class="row" style="margin-top:8px"><span>${esc(r)}</span><span>${btn('rn-ok', r, 'Approve add-on')}${btn('v-rn-reject', r, 'Reject add-on', 1)}</span></div>`).join('');
    }
    const acts = [];
    if (b.status === 'Approved') acts.push(btn('bk-go', b.booking_ref, 'Start session'), btn('bk-cx', b.booking_ref, 'Cancel booking', 1));
    if (b.status === 'In Progress') acts.push(btn('bk-done', b.booking_ref, 'Mark completed'));
    body += `<div class="acts"><button class="btn line" data-close>Close</button>${acts.join('')}</div>`;
  }
  vdr.innerHTML = drawerShell(needsCheck ? 'Verify booking' : 'Booking details', b.booking_ref, `<span class="mut">Booking</span> ${badge(bkStatus(b.status))} ` + (pay ? `<span class="mut">Payment</span> ${badge(pay.status)}` : ''), body);
  wireChecks();
}

/* ---- a rental (outside rentals with down payment and ID, or any other rental order) ---- */
function drawRentalTx(tx) {
  const g = groups().find(x => x.ref === tx.ref), pay = tx.pay;
  if (!g) { vdr.innerHTML = drawerShell('Rental', tx.ref, '', '<p class="mut">This rental could not be found.</p>'); return; }
  const out = g.type === 'Outside', l0 = g.lines[0];
  const hrs = Math.max(8, Math.ceil(num(l0.rental_hours) || 8)), factor = out ? hrs / 8 : 1;
  const lineTotal = l => num(l.unit_price_at_request) * l.quantity * factor, total = sum(g.lines.map(lineTotal)), down = num(l0.down_payment);
  const due = l0.due_at ? new Date(l0.due_at) : null, now = Date.now();
  const accr = out && due && g.status === 'Active' ? g.lines.filter(l => !l.line_returned_at && now > due) : [];
  const fee = sum(g.lines.map(l => num(l.late_fee))) + sum(accr.map(l => l.quantity * num(l.unit_price_at_request) / 8 * Math.ceil((now - due) / 36e5)));
  const short = g.lines.filter(l => { const s = STK.find(x => x.equipment_id === l.equipment_id); return !s || s.available < l.quantity; });
  const payPending = !!pay && pay.status === 'Pending', needApprove = g.status === 'Pending';

  let body = `<h3>Customer</h3><dl class="dl"><dt>Name</dt><dd>${esc(g.customer)}</dd><dt>Phone</dt><dd>${esc(g.phone || 'Not on file')}</dd></dl>
    <h3>${out ? 'Pick-up and return' : 'Rental'}</h3><dl class="dl"><dt>Rent type</dt><dd>${TYB[g.type]}</dd>
      ${out ? `<dt>Pick-up</dt><dd>${l0.pickup_date ? shortDate(dOf(l0.pickup_date)) + ', ' + tOf(l0.pickup_date) : '-'}</dd><dt>Return by</dt><dd>${l0.return_date ? shortDate(dOf(l0.return_date)) + ', ' + tOf(l0.return_date) : '-'}</dd>
            <dt>Overdue after</dt><dd>${dueLabel(l0)} <span class="mut">(end of the 8-hour window)</span></dd><dt>Length</dt><dd>${Math.round(num(l0.rental_hours) * 100) / 100} hours scheduled, billed as ${hrs}</dd>`
            : `<dt>Booking</dt><dd>${esc(g.booking || '-')}</dd>`}
      ${g.reason ? `<dt>Reason</dt><dd>${esc(g.reason)}</dd>` : ''}</dl>
    <h3>Items (${sum(g.lines.map(l => l.quantity))})</h3>
    <div class="dr-items">${g.lines.map(l => `<div class="dr-item"><div><b>${esc(l.equipment_name)}</b><div class="mut">${l.quantity} x ${money(l.unit_price_at_request)}${out ? ' per 8 hours' : ''} ${dueB(l).includes('>-<') ? '' : dueB(l)}</div>
      ${g.status === 'Active' && !l.line_returned_at ? `<div style="margin-top:6px">${btn('rn-retline', g.ref + ':' + l.equipment_id, 'Return this item', 1)}</div>` : l.line_returned_at ? '<div class="mut">Returned</div>' : ''}</div>
      <b>${money(lineTotal(l))}</b></div>`).join('')}</div>`;
  if (needApprove && short.length) body += `<div class="alert">Not enough stock for: ${short.map(l => esc(l.equipment_name)).join(', ')}. It can't be approved until stock comes back.</div>`;

  body += `<h3>Amount</h3><div class="dr-sum"><div class="tot-line"><b>Total</b><b>${money(total)}</b></div>
    ${out && down > 0 ? `<div><span>Down payment (50%)</span><span>${money(down)}</span></div><div><span>Balance to collect at pick-up</span><span>${money(Math.max(0, total - down))}</span></div>` : ''}
    ${fee > 0 ? `<div><span>Late fee ${accr.length ? 'so far' : 'charged'}</span><b style="color:var(--bad)">${money(fee)}</b></div>` : ''}</div>`;
  if (pay) body += `<h3>${out ? 'Down payment' : 'Payment'}</h3>${payBlock(pay, down)}`;
  if (out) body += `<h3>Customer's valid ID</h3><div id="v-id"><p class="mut">Loading the ID...</p></div>`;

  if (needApprove || payPending) {
    const checks = [];
    if (payPending) checks.push(pay.method === 'GCash' ? `I checked GCash reference <b>${esc(pay.gcash_reference || '')}</b> and the down payment of <b>${money(pay.amount)}</b> was received.` : `The payment of <b>${money(pay.amount)}</b> was received.`);
    if (out && needApprove) checks.push('I checked the valid ID. The photo is clear and matches the customer.');
    body += checks.map(checkRow).join('') + reasonPicker();
    const label = needApprove ? (payPending ? 'Verify and approve rental' : 'Approve rental') : 'Verify down payment';
    body += `<div class="acts"><button class="btn line" data-close>Close</button>
      <button class="btn bad" data-act="v-rn-no" data-id="${esc(g.ref)}">Reject</button>
      <button class="btn gold" id="v-go" data-act="v-rn-ok" data-id="${esc(g.ref)}" ${checks.length ? 'disabled' : ''}>${label}</button></div>`;
  } else {
    if (g.status === 'Approved' && down > 0) body += `<div class="alert">Collect the balance of ${money(Math.max(0, total - down))} before handing over the equipment.</div>`;
    if (g.status === 'Active' && fee > 0) body += `<div class="alert">The equipment is late. A late fee of ${money(fee)} (price / 8 per hour, per item) is charged when you process the return. Collect it then.</div>`;
    else if (g.lines.some(l => overdueHours(l) > 0)) body += '<div class="alert">This order is overdue. Contact the customer to arrange the return.</div>';
    const acts = g.status === 'Approved' ? btn('rn-issue', g.ref, 'Issue equipment') : g.status === 'Active' ? btn('rn-ret', g.ref, 'Return everything') : '';
    body += `<div class="acts"><button class="btn line" data-close>Close</button>${acts}</div>`;
  }
  vdr.innerHTML = drawerShell(needApprove || payPending ? 'Verify rental' : 'Rental details', g.type === 'Add-on' ? (g.booking || g.ref) : g.ref, `<span class="mut">Rental</span> ${badge(groupStatus(g))} ` + (pay ? `<span class="mut">Payment</span> ${badge(pay.status)}` : ''), body);
  wireChecks();
  if (out) loadRentalId(g.ref, 'v-id');
}

/* the two buttons that need more than one database change */
ACT['v-rn-ok'] = async ref => {
  const g = groups().find(x => x.ref === ref), pay = PAY.find(p => p.reference === ref);
  if (pay && pay.status === 'Pending' && !(await run(sb.from('payment').update({ status: 'Verified' }).eq('payment_id', pay.payment_id)))) return;
  if (g && g.status === 'Pending' && !(await run(sb.from('rental_order').update({ status: 'Approved' }).eq('rental_ref', ref)))) {
    await refresh();                       // the payment was verified, the approval failed (for example no stock)
    if (vKey) openVerify(vKey);
    return;
  }
  await loadCatalog();
  await refresh(); closeOverlays();
  toast(g && g.status === 'Pending' ? `${ref} verified and approved.` : `${ref} down payment verified.`);
};

ACT['v-rn-no'] = async ref => {
  const g = groups().find(x => x.ref === ref), pay = PAY.find(p => p.reference === ref), reason = pickedReason();
  if (pay && pay.status === 'Pending' && !(await run(sb.from('payment').update({ status: 'Rejected' }).eq('payment_id', pay.payment_id)))) return;
  if (g && g.status === 'Pending') return setRental(ref, 'Rejected', reason);
  await refresh(); closeOverlays(); toast('Payment rejected.');
};

ACT['v-rn-reject'] = ref => setRental(ref, 'Rejected', pickedReason());

/* the buttons in the tables */
ACT['pay-verify'] = id => openVerify({ paymentId: id });

ACT['bk-verify'] = ref => verifyFromTab({ bookingRef: ref });

ACT['rn-verify'] = ref => verifyFromTab({ rentalRef: ref });

ACT['rn-det'] = ref => openVerify({ rentalRef: ref });   // Details: open it right here, no redirect
