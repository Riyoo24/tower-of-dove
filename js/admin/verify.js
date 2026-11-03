/* =====================================================================
   admin/verify.js - Verify drawer (Payments tab)
   One place to check a transaction before verifying or rejecting it.
   ===================================================================== */

import { addonPaidOf, balanceOf, closeOverlays, findBk, startLabel } from './bookings.js';
import { EXT, PAY, RL, STK, refresh } from './data.js';
import {
    ACT,
    bkStatus,
    btn,
    dOf,
    isFull,
    money,
    notifyVerified,
    num,
    payLabel,
    payWord,
    rnStatus,
    run,
    stampLabel,
    tOf,
    CONFIRM
} from './helpers.js';
import {
    TYB,
    dueB,
    dueLabel,
    groupStatus,
    groups,
    lineStatus,
    loadRentalId,
    overdueHours,
    rentalBalance,
    setRental,
    addonWaitingBooking
} from './rentals.js';
import { sb } from '../config/supabaseClient.js';
import { loadCatalog } from '../shared/catalog.js';
import { listGcashProofs } from '../shared/gcashProof.js';
import { $, $$, badge, esc, longDate, pl, shortDate, sum, toast } from '../shared/utils.js';

/* ============================ 7b. VERIFY DRAWER (Payments tab) ============================
   One place to check a transaction: who, what, how much, the GCash reference and (for outside
   rentals) the customer's ID. The Verify buttons in Bookings and Rentals open it here. */

export const vdr = $('#vdr');

let vKey = null;                                   // which transaction is open, so it can be redrawn

vdr.addEventListener('click', e => {
    if (e.target === vdr || e.target.closest('[data-close]'))
        vdr.close();
});

const REASONS_RENTAL = [
    'Payment not received',
    'Invalid or unclear ID',
    'Equipment not available',
    'Incomplete or unclear request',
    'Other'
];

const REASONS_BOOKING = [
    'Payment not received',
    'GCash reference or amount does not match',
    'Time slot is no longer available',
    'Incomplete or unclear booking details',
    'Other'
];

const REASONS_EXTENSION = [
    'Payment not received',
    'GCash reference or amount does not match',
    'Time slot is no longer available',
    'Booking is no longer active',
    'Other'
];

const reasonPicker = (list = REASONS_RENTAL) => `<label for="v-reason">Reason if rejecting (the customer sees this) <span class="req" aria-hidden="true">*</span></label>
  <select id="v-reason">${list.map(r => `<option>${r}</option>`).join('')}</select>
  <div id="v-other-wrap" hidden><label for="v-other">Message to customer</label><input id="v-other" maxlength="300" placeholder="Describe the reason"></div>`;

const pickedReason = () => {
    const r = $('#v-reason').value;
    return r === 'Other' ? ($('#v-other').value.trim() || 'Other') : r;
};

const drawerShell = (title, ref, badges, body) => `<div class="in"><div class="dr" style="padding:0">
  <div class="row"><div><p class="mut" style="margin:0">${title}</p><h2 style="margin:0">${esc(ref)}</h2></div><button type="button" class="btn sm line" data-close aria-label="Close">Close</button></div>
  <div>${badges}</div>${body}</div></div>`;

/* work out which booking or rental a Verify button means */
function resolveTx(key) {
    let pay = null, bookingRef = null, rentalRef = null;
    if (key.extensionId || (key.paymentId && (PAY.find(p => p.payment_id === +key.paymentId) || {}).kind === 'Extension')) {
        // a customer's session extension (its own down payment)
        const ext = key.extensionId ? EXT.find(x => x.extension_id === +key.extensionId)
            : EXT.find(x => x.payment_id === +key.paymentId);
        if (!ext)
            return null;
        return {
            type: 'extension',
            ref: ext.booking_ref,
            ext,
            pay: PAY.find(p => p.extension_id === ext.extension_id) || null
        };
    }
    if (key.paymentId) {
        pay = PAY.find(p => p.payment_id === +key.paymentId);
        if (!pay)
            return null;
        if (pay.kind === 'Booking')
            bookingRef = pay.reference; else
            rentalRef = pay.reference;
    } else if (key.bookingRef)
        bookingRef = key.bookingRef;
    else if (key.rentalRef) {
        rentalRef = key.rentalRef;
        const g = groups().find(x => x.ref === rentalRef);
        if (g && g.type === 'Add-on' && g.booking) {
            bookingRef = g.booking;
            rentalRef = null;
        }   // add-ons are paid with their booking
    }
    if (bookingRef)
        return {
            type: 'booking',
            ref: bookingRef,
            pay: PAY.find(p => p.reference === bookingRef && p.kind === 'Booking') || null
        };
    return {
        type: 'rental',
        ref: rentalRef,
        pay: pay || PAY.find(p => p.reference === rentalRef) || null
    };
}

function openVerify(key) {
    const tx = resolveTx(key);
    if (!tx)
        return toast('That transaction could not be found.');
    vKey = key;
    if (tx.type === 'booking')
        drawBookingTx(tx);
    else if (tx.type === 'extension')
        drawExtensionTx(tx);
    else
        drawRentalTx(tx);
    if (!vdr.open)
        vdr.showModal();
    loadGcashShots();
}

/* Fills the "GCash screenshot" boxes of the drawer (private bucket, 10 minute links). */
async function loadGcashShots() {
    for (const box of $$('#vdr .v-shot')) {
        const links = await listGcashProofs(box.dataset.ref);
        box.innerHTML = links.length
            ? links.map(u => `<a href="${esc(u)}" target="_blank" rel="noopener" title="Open full size"><img class="idimg" src="${esc(u)}" alt="Customer's GCash screenshot"></a>`).join('')
              + '<p class="mut">Click the screenshot to open it full size. Check that its reference number and amount match the ones above.</p>'
            : '<p class="mut">No screenshot attached (onsite payment or an older payment).</p>';
    }
}

/* Used by the Verify buttons in Bookings and Rentals: switch to Payments, then open the drawer */
function verifyFromTab(key) {
    if (location.hash.slice(1) !== 'a-pay')
        location.hash = 'a-pay';
    openVerify(key);
}

/* the checkboxes the staff member must tick before the main button works */
function wireChecks() {
    const checks = $$('#vdr .vchk'), go = $('#v-go');
    if (go) {
        go.disabled = checks.some(c => !c.checked);
        checks.forEach(c => c.addEventListener('change', () => {
            go.disabled = checks.some(x => !x.checked);
        }));
    }
    const sel = $('#v-reason');
    if (sel)
        sel.onchange = () => {
            $('#v-other-wrap').hidden = sel.value !== 'Other';
        };
}

const checkRow = text => `<label class="terms" style="margin:0"><input type="checkbox" class="vchk"><span>${text}</span></label>`;

const payBlock = (p, fallbackAmount) => p
    ? `<dl class="dl"><dt>Method</dt><dd>${esc(p.method)}</dd><dt>Amount</dt><dd><b>${money(p.amount)}</b></dd>
      ${p.method === 'GCash' ? `<dt>GCash reference</dt><dd><b style="letter-spacing:.04em">${esc(p.gcash_reference || '')}</b></dd>${p.gcash_reference ? `<dt>GCash screenshot</dt><dd><div class="v-shot" data-ref="${esc(p.gcash_reference)}"><span class="mut">Loading...</span></div></dd>` : ''}` : '<dt>Paid</dt><dd>Cash at the studio</dd>'}
      ${num(p.balance_paid_amount) > 0 ? `<dt>Balance collected</dt><dd><b>${money(p.balance_paid_amount)}</b> (${esc(p.balance_paid_method || 'Cash')}${p.balance_paid_at ? ', ' + stampLabel(p.balance_paid_at) : ''})</dd><dt>Total paid</dt><dd><b>${money(num(p.amount) + num(p.balance_paid_amount))}</b> <span class="mut">fully paid</span></dd>` : ''}
      <dt>Status</dt><dd>${badge(p.status)}</dd><dt>Sent</dt><dd>${p.created_at ? stampLabel(p.created_at) : '-'}</dd></dl>`
    : `<p class="mut">No payment record for this transaction. Amount: <b>${money(fallbackAmount)}</b>.</p>`;

/* ---- a studio booking (with any add-on equipment paid together) ---- */
function drawBookingTx(tx) {
    const b = findBk(tx.ref), pay = tx.pay;
    if (!b) {
        vdr.innerHTML = drawerShell('Booking', tx.ref, '', '<p class="mut">This booking could not be found.</p>');
        return;
    }
    const ad = RL.filter(l => l.booking_ref === b.booking_ref && l.rental_type === 'Add-on');
    const counted = ad.filter(l => !['Rejected', 'Cancelled'].includes(l.status));
    const adTotal = sum(counted.map(l => num(l.unit_price_at_request) * l.quantity)),
        studio = num(b.total_amount);
    const payPending = !!pay && pay.status === 'Pending',
        needsCheck = payPending || (!pay && b.status === 'Pending');
    const pendingOrders = !payPending ? [...new Set(ad.filter(l => l.status === 'Pending').map(l => l.rental_ref))] : [];

    let body = `<h3>Customer</h3><dl class="dl"><dt>Name</dt><dd>${esc(b.customer_name)}${b.is_guest ? ' <span class="mut">(guest)</span>' : ''}</dd><dt>Phone</dt><dd>${esc(b.customer_number || 'Not on file')}</dd></dl>
    <h3>Booking</h3><dl class="dl"><dt>Studio</dt><dd>${esc(b.studio_name)}</dd><dt>Date</dt><dd>${longDate(dOf(b.start_at))}</dd>
      <dt>Time</dt><dd>${tOf(b.start_at)} to ${tOf(b.end_at)} (${pl(Math.round(num(b.hours)), 'hr')})</dd><dt>Source</dt><dd>${esc(b.source)}</dd></dl>`;
    if (ad.length) {
        body += `<h3>Add-on equipment</h3><div class="dr-items">${ad.map(l => `<div class="dr-item"><div><b>${esc(l.equipment_name)}</b><div class="mut">${l.quantity} x ${money(l.unit_price_at_request)} ${badge(lineStatus(l))}</div></div><b>${money(num(l.unit_price_at_request) * l.quantity)}</b></div>`).join('')}</div>`;
    }
    const grand = studio + adTotal,
        paidOk = pay && pay.status === 'Verified' ? num(pay.amount) : 0,
        down = num(b.down_payment);
    const col = num(b.balance_paid_amount),   // balance already collected by staff (the payment is then a full payment)
        full = col > 0 ? false : isFull(pay ? pay.payment_option : b.payment_option),
        addPaid = addonPaidOf(b.booking_ref);
    const balance = down > 0 ? balanceOf(b) : pay && pay.status === 'Verified' ? balanceOf(b) : 0;   // fully paid booking: only a later add-on's 50% balance can be left
    body += `<h3>Amount</h3><div class="dr-sum"><div><span>Studio</span><span>${money(studio)}</span></div>${adTotal ? `<div><span>Add-on equipment</span><span>${money(adTotal)}</span></div>` : ''}<div class="tot-line"><b>Booking total</b><b>${money(grand)}</b></div>
    ${down > 0 ? `<div><span>${payLabel(full ? 'full' : 'down')}</span><span>${money(down)}</span></div>${addPaid > 0 ? `<div><span>Equipment added later, paid</span><span>${money(addPaid)}</span></div>` : ''}${col > 0 ? `<div><span>Balance collected${b.balance_paid_method ? ' (' + esc(b.balance_paid_method) + ')' : ''}</span><span>${money(col)}</span></div>` : ''}<div><span>Balance to collect at the studio</span>${balance > 0.005 ? `<b style="color:var(--warn)">${money(balance)}</b>` : '<b>Paid in full</b>'}</div>`
            : balance > 0 ? `<div><span>Already paid (verified)</span><span>${money(paidOk)}</span></div><div><span>Add-on balance to collect</span><b style="color:var(--warn)">${money(balance)}</b></div>` : ''}</div>
    <h3>${down > 0 ? (col > 0 ? 'Fully paid' : full ? 'Full payment' : 'Down payment') : 'Payment'}</h3>${payBlock(pay, down > 0 ? down : studio + adTotal)}`;

    if (b.status === 'Rejected')
        body += `<h3>Reason for rejection</h3><div class="alert">${esc(b.rejected_reason || 'No reason was recorded.')}</div>`;

    if (needsCheck) {
        body += pay
            ? checkRow(pay.method === 'GCash' ? `I checked GCash reference <b>${esc(pay.gcash_reference || '')}</b> and the ${down > 0 ? payWord(full ? 'full' : 'down') : 'amount'} of <b>${money(pay.amount)}</b> was received.` : `The cash payment of <b>${money(pay.amount)}</b> was received at the studio.`)
            : checkRow('I checked this booking and it can be confirmed.');
        body += reasonPicker(REASONS_BOOKING);
        body += `<div class="acts"><button class="btn line" data-close>Close</button>${btn('bk-no', b.booking_ref, pay ? (down > 0 ? 'Reject ' + payWord(full ? 'full' : 'down') : 'Reject payment') : 'Reject booking').replace('btn sm', 'btn bad')}
      <button class="btn gold" id="v-go" data-act="bk-ok" data-id="${esc(b.booking_ref)}" disabled>${pay ? (down > 0 ? 'Verify ' + payWord(full ? 'full' : 'down') : 'Verify payment') : 'Confirm booking'}</button></div>
      <p class="mut">Verifying also confirms the booking and approves its add-on equipment.${down > 0 && balance > 0 ? ` The customer pays the balance of ${money(balance)} at the studio.` : ''}${full && balance <= 0 ? ' The customer paid in full.' : ''}</p>`;
    } else {
        if (pendingOrders.length) {
            body += `<h3>Add-on equipment waiting for approval</h3><div class="alert">Some add-on equipment is still pending (it may be out of stock). Approve or reject it here.</div>${reasonPicker()}` +
                pendingOrders.map(r => `<div class="row" style="margin-top:8px"><span>${esc(r)}</span><span>${btn('rn-ok', r, 'Approve add-on')}${btn('v-rn-reject', r, 'Reject add-on', 1)}</span></div>`).join('');
        }
        if (b.status === 'Approved' && balance > 0.005)
            body += `<div class="alert warn">Collect the balance of <b>${money(balance)}</b> when the customer arrives. <b>${startLabel(b)}</b> asks you to confirm you received it, then marks the payment as fully paid and starts the session.</div>`;
        const acts = [];
        if (b.status === 'Approved')
            acts.push(btn('bk-go', b.booking_ref, startLabel(b)), btn('bk-cx', b.booking_ref, 'Cancel booking', 1));
        if (b.status === 'In Progress')
            acts.push(btn('bk-done', b.booking_ref, 'Mark completed'));
        body += `<div class="acts"><button class="btn line" data-close>Close</button>${acts.join('')}</div>`;
    }
    vdr.innerHTML = drawerShell(needsCheck ? 'Verify booking' : 'Booking details', b.booking_ref, `<span class="mut">Booking</span> ${badge(bkStatus(b.status))} `
        + (pay ? `<span class="mut">Payment</span> ${badge(pay.status)}` : ''), body);
    wireChecks();
}

/* ---- a customer's session extension: 50% down payment, verified like a booking payment ----
   Verifying moves the booking's end time, adds the extension cost to its total and the down payment to
   the booking's down payment (the database does it). Rejecting leaves the booking as it was. */
function drawExtensionTx(tx) {
    const x = tx.ext, pay = tx.pay, b = findBk(tx.ref);
    if (!b) {
        vdr.innerHTML = drawerShell('Extension', tx.ref, '', '<p class="mut">This booking could not be found.</p>');
        return;
    }
    const pending = x.status === 'Pending' && !!pay && pay.status === 'Pending';
    const approved = x.status === 'Approved';
    const ad = RL.filter(l => l.booking_ref === b.booking_ref && l.rental_type === 'Add-on' && !['Rejected', 'Cancelled'].includes(l.status));
    const adTotal = sum(ad.map(l => num(l.unit_price_at_request) * l.quantity));
    const studioAfter = approved ? num(b.total_amount) : num(b.total_amount) + num(x.extra_cost);
    const grandAfter = studioAfter + adTotal;

    let body = `<h3>Customer</h3><dl class="dl"><dt>Name</dt><dd>${esc(b.customer_name)}</dd><dt>Phone</dt><dd>${esc(b.customer_number || 'Not on file')}</dd></dl>
    <h3>Booking</h3><dl class="dl"><dt>Studio</dt><dd>${esc(b.studio_name)}</dd><dt>Date</dt><dd>${longDate(dOf(b.start_at))}</dd>
      <dt>Session</dt><dd>${tOf(b.start_at)} to ${tOf(x.old_end_at)}</dd><dt>Booking status</dt><dd>${badge(bkStatus(b.status))}</dd></dl>
    <h3>Extension requested</h3><dl class="dl"><dt>Extra time</dt><dd><b>+${pl(x.extra_hours, 'hr')}</b>, ${tOf(x.old_end_at)} to ${tOf(x.new_end_at)}</dd>
      <dt>Rate</dt><dd>${money(x.hourly_rate)} per hour</dd></dl>
    <h3>Amount</h3><div class="dr-sum"><div><span>Extension cost</span><span>${money(x.extra_cost)}</span></div>
      <div><span>${payLabel(x.payment_option)}</span><b>${money(x.down_payment)}</b></div>
      <div><span>Extension balance, paid at the studio</span>${num(x.extra_cost) - num(x.down_payment) > 0 ? `<b style="color:var(--warn)">${money(num(x.extra_cost) - num(x.down_payment))}</b>` : '<b>Paid in full</b>'}</div>
      <div class="tot-line"><b>Booking total ${approved ? '(includes this extension)' : 'after this extension'}</b><b>${money(grandAfter)}</b></div></div>
    <h3>${isFull(x.payment_option) ? 'Full payment' : 'Down payment'}</h3>${payBlock(pay, x.down_payment)}`;

    if (x.status === 'Rejected')
        body += `<h3>Reason for rejection</h3><div class="alert">${esc(x.rejected_reason || 'No reason was recorded.')}</div>`;

    if (pending) {
        body += checkRow(pay.method === 'GCash' ? `I checked GCash reference <b>${esc(pay.gcash_reference || '')}</b> and the ${payWord(x.payment_option)} of <b>${money(pay.amount)}</b> was received.` : `The payment of <b>${money(pay.amount)}</b> was received.`);
        body += reasonPicker(REASONS_EXTENSION);
        body += `<div class="acts"><button class="btn line" data-close>Close</button>
      <button class="btn bad" data-act="ext-no" data-id="${x.extension_id}">Reject extension</button>
      <button class="btn gold" id="v-go" data-act="ext-ok" data-id="${x.extension_id}" disabled>Verify ${payWord(x.payment_option)}</button></div>
      <p class="mut">Verifying adds ${pl(x.extra_hours, 'hr')} to the session (until ${tOf(x.new_end_at)}) and ${money(x.extra_cost)} to the booking total. ${num(x.extra_cost) - num(x.down_payment) > 0 ? `The customer pays the other ${money(num(x.extra_cost) - num(x.down_payment))} at the studio.` : 'The customer paid the extension in full.'} The extra hours are reserved until you decide.</p>`;
    } else {
        body += `<div class="acts"><button class="btn line" data-close>Close</button></div>`;
    }
    vdr.innerHTML = drawerShell(pending ? 'Verify extension' : 'Extension details', b.booking_ref,
        `<span class="mut">Extension</span> ${badge(approved ? 'Verified' : x.status)} ` + (pay ? `<span class="mut">Payment</span> ${badge(pay.status)}` : ''), body);
    wireChecks();
}

/* ---- a rental (outside rentals with down payment and ID, or any other rental order) ---- */
function drawRentalTx(tx) {
    const g = groups().find(x => x.ref === tx.ref), pay = tx.pay;
    if (!g) {
        vdr.innerHTML = drawerShell('Rental', tx.ref, '', '<p class="mut">This rental could not be found.</p>');
        return;
    }
    const out = g.type === 'Outside', l0 = g.lines[0];
    const hrs = Math.max(8, Math.ceil(num(l0.rental_hours) || 8)), factor = out ? hrs / 8 : 1;
    const lineTotal = l => num(l.unit_price_at_request) * l.quantity * factor,
        total = sum(g.lines.map(lineTotal)),
        down = num(l0.down_payment),
        rcol = num(l0.balance_paid_amount),       // balance already collected by staff
        rIssue = rentalBalance(g),                // what must be collected before the equipment is handed over (an add-on: its booking's balance)
        rBal = out ? rIssue : Math.max(0, total - down - rcol);   // shown in the Amount block
    const due = l0.due_at ? new Date(l0.due_at) : null, now = Date.now();
    const accr = out && due && g.status === 'Active' ? g.lines.filter(l => !l.line_returned_at && now > due) : [];
    const fee = sum(g.lines.map(l => num(l.late_fee)))
        + sum(accr.map(l => l.quantity * num(l.unit_price_at_request) / 8 * Math.ceil((now - due) / 36e5)));
    const short = g.lines.filter(l => {
        const s = STK.find(x => x.equipment_id === l.equipment_id);
        return !s || s.available < l.quantity;
    });
    const payPending = !!pay && pay.status === 'Pending', needApprove = g.status === 'Pending';
    const rFull = rcol > 0 ? false : (isFull(pay ? pay.payment_option : null) || (down > 0 && down >= total - 0.01));

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
    if (needApprove && short.length)
        body += `<div class="alert">Not enough stock for: ${short.map(l => esc(l.equipment_name)).join(', ')}. It can't be approved until stock comes back.</div>`;

    body += `<h3>Amount</h3><div class="dr-sum"><div class="tot-line"><b>Total</b><b>${money(total)}</b></div>
    ${down > 0 ? `<div><span>${payLabel(rFull ? 'full' : 'down')}</span><span>${money(down)}</span></div>${rcol > 0 ? `<div><span>Balance collected</span><span>${money(rcol)}</span></div>` : ''}<div><span>Balance to collect ${out ? 'at pick-up' : 'at the studio'}</span><span>${rBal > 0.005 ? money(rBal) : 'Paid in full'}</span></div>` : ''}
    ${fee > 0 ? `<div><span>Late fee ${accr.length ? 'so far' : 'charged'}</span><b style="color:var(--bad)">${money(fee)}</b></div>` : ''}</div>`;
    if (pay)
        body += `<h3>${down > 0 ? (rcol > 0 ? 'Fully paid' : rFull ? 'Full payment' : 'Down payment') : 'Payment'}</h3>${payBlock(pay, down)}`;
    if (out)
        body += `<h3>Customer's valid ID</h3><div id="v-id"><p class="mut">Loading the ID...</p></div>`;

    if (needApprove || payPending) {
        const checks = [];
        if (payPending)
            checks.push(pay.method === 'GCash' ? `I checked GCash reference <b>${esc(pay.gcash_reference || '')}</b> and the ${down > 0 ? payWord(rFull ? 'full' : 'down') : 'payment'} of <b>${money(pay.amount)}</b> was received.` : `The payment of <b>${money(pay.amount)}</b> was received.`);
        if (out && needApprove)
            checks.push('I checked the valid ID. The photo is clear and matches the customer.');
        body += checks.map(checkRow).join('') + reasonPicker();
        const label = needApprove ? (payPending ? 'Verify and approve rental' : 'Approve rental') : 'Verify ' + (down > 0 ? payWord(rFull ? 'full' : 'down') : 'payment');
        body += `<div class="acts"><button class="btn line" data-close>Close</button>
      <button class="btn bad" data-act="v-rn-no" data-id="${esc(g.ref)}">Reject</button>
      <button class="btn gold" id="v-go" data-act="v-rn-ok" data-id="${esc(g.ref)}" ${checks.length ? 'disabled' : ''}>${label}</button></div>`;
    } else {
        if (g.status === 'Approved' && addonWaitingBooking(g))
            body += `<div class="alert warn">This add-on belongs to booking <b>${esc(g.booking)}</b>, which has not started yet. The equipment can only be issued after the session starts. <b>${startLabel(addonWaitingBooking(g))}</b> starts the booking first.</div>`;
        else if (g.status === 'Approved' && rIssue > 0.005)
            body += `<div class="alert warn">Collect the balance of <b>${money(rIssue)}</b>${out ? '' : ` of booking ${esc(g.booking)}`} before handing over the equipment. <b>Collect balance & issue</b> asks you to confirm you received it, then marks the payment as fully paid.</div>`;
        if (g.status === 'Active' && fee > 0)
            body += `<div class="alert">The equipment is late. A late fee of ${money(fee)} (price / 8 per hour, per item) is charged when you process the return. Collect it then.</div>`;
        else if (g.lines.some(l => overdueHours(l) > 0))
            body += '<div class="alert">This order is overdue. Contact the customer to arrange the return.</div>';
        const acts = g.status === 'Approved' ? btn('rn-issue', g.ref, addonWaitingBooking(g) ? startLabel(addonWaitingBooking(g)) : rIssue > 0.005 ? 'Collect balance & issue' : 'Issue equipment') : g.status === 'Active' ? btn('rn-ret', g.ref, 'Return everything') : '';
        body += `<div class="acts"><button class="btn line" data-close>Close</button>${acts}</div>`;
    }
    vdr.innerHTML = drawerShell(needApprove || payPending ? 'Verify rental' : 'Rental details', g.type === 'Add-on' ? (g.booking || g.ref) : g.ref, `<span class="mut">Rental</span> ${badge(groupStatus(g))} `
        + (pay ? `<span class="mut">Payment</span> ${badge(pay.status)}` : ''), body);
    wireChecks();
    if (out)
        loadRentalId(g.ref, 'v-id');
}

const txWho = ref => {
    const g = groups().find(x => x.ref === ref);
    return g ? `${ref} (${g.customer})` : ref;
};

CONFIRM['v-rn-ok'] = ref => {
    const g = groups().find(x => x.ref === ref);
    return {
        title: g && g.status === 'Pending' ? 'Verify and approve this rental?' : 'Verify this payment?',
        message: `${txWho(ref)}: you confirm that everything ticked above was checked.`,
        ok: 'Yes, confirm'
    };
};
CONFIRM['v-rn-no'] = ref => ({
    title: 'Reject this request?',
    message: `${txWho(ref)} will be rejected with the reason you picked.`,
    ok: 'Yes, reject',
    danger: true
});
CONFIRM['v-rn-reject'] = CONFIRM['v-rn-no'];

/* the two buttons that need more than one database change */
ACT['v-rn-ok'] = async ref => {
    const g = groups().find(x => x.ref === ref), pay = PAY.find(p => p.reference === ref);
    if (pay && pay.status === 'Pending'
        && !(await run(sb.from('payment').update({ status: 'Verified' }).eq('payment_id', pay.payment_id))))
        return;
    if (pay && pay.status === 'Pending')
        notifyVerified(pay.payment_id);   // email the customer (does not wait)
    if (g && g.status === 'Pending'
        && !(await run(sb.from('rental_order').update({ status: 'Approved' }).eq('rental_ref', ref)))) {
        await refresh();                       // the payment was verified, the approval failed (for example no stock)
        if (vKey)
            openVerify(vKey);
        return;
    }
    await loadCatalog();
    await refresh();
    closeOverlays();
    toast(g && g.status === 'Pending' ? `${ref} verified and approved.` : `${ref} payment verified.`);
};

ACT['v-rn-no'] = async ref => {
    const g = groups().find(x => x.ref === ref),
        pay = PAY.find(p => p.reference === ref),
        reason = pickedReason();
    if (pay && pay.status === 'Pending'
        && !(await run(sb.from('payment').update({ status: 'Rejected' }).eq('payment_id', pay.payment_id))))
        return;
    if (g && g.status === 'Pending')
        return setRental(ref, 'Rejected', reason);
    await refresh();
    closeOverlays();
    toast('Payment rejected.');
};

ACT['v-rn-reject'] = ref => setRental(ref, 'Rejected', pickedReason());

/* the buttons in the tables */
ACT['pay-verify'] = id => openVerify({ paymentId: id });

ACT['bk-verify'] = ref => verifyFromTab({ bookingRef: ref });

ACT['rn-verify'] = ref => verifyFromTab({ rentalRef: ref });

ACT['rn-det'] = ref => openVerify({ rentalRef: ref });   // Details: open it right here, no redirect

/* ---- customer extension requests ---- */
const extWho = id => {
    const x = EXT.find(e => e.extension_id === +id);
    return x ? `${x.booking_ref} extension (+${pl(x.extra_hours, 'hr')}, ${money(x.down_payment)} ${payWord(x.payment_option)})` : 'this extension';
};

CONFIRM['ext-ok'] = id => ({
    title: 'Verify this extension payment?',
    message: `${extWho(id)}: the session end time and the booking total are updated right away. Only continue if you checked that the money was received.`,
    ok: 'Yes, verify and extend'
});

CONFIRM['ext-no'] = id => {
    const why = pickedReason();
    if (!why || why.length < 3)
        throw new Error('Describe the reason for rejecting this extension. The customer will see it.');
    return {
        title: 'Reject this extension?',
        message: `${extWho(id)} will be rejected and the reserved hours are released. The customer will see this reason: "${why}"`,
        ok: 'Yes, reject',
        danger: true
    };
};

ACT['ext-verify'] = id => verifyFromTab({ extensionId: id });

ACT['ext-ok'] = async id => {
    const x = EXT.find(e => e.extension_id === +id);
    if (!x || !x.payment_id)
        return toast('That extension payment could not be found.');
    if (!(await run(sb.from('payment').update({ status: 'Verified' }).eq('payment_id', x.payment_id))))
        return;   // the database says why (for example the booking is no longer active or the time was taken)
    notifyVerified(x.payment_id);   // email the customer (does not wait)
    await refresh();
    closeOverlays();
    toast(`${x.booking_ref} extended by ${pl(x.extra_hours, 'hr')}. The booking time and total are updated.`);
};

ACT['ext-no'] = async id => {
    const why = pickedReason();
    if (!(await run(sb.rpc('staff_reject_extension', { p_extension_id: +id, p_reason: why }))))
        return;
    await refresh();
    closeOverlays();
    toast('Extension rejected. The customer can see the reason.');
};
