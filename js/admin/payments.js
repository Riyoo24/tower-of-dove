/* =====================================================================
   admin/payments.js - Payments tab
   DB: table payment (verify / reject).
   ===================================================================== */

import { state } from './state.js';
import { closeOverlays, findBk, pendingAddons, verifiedMsg } from './bookings.js';
import { DMG, PAY, RL, refresh } from './data.js';
import { dmgOf, dmgStatus } from './damage.js';
import { repFlag } from './reputation.js';
import { ACT, btn, money, notifyVerified, num, run, tabsHtml, tbl, tblGrouped, CONFIRM } from './helpers.js';
import { sb } from '../config/supabaseClient.js';
import { refLink, rowMark } from './jump.js';
import { revealBooking } from './bookings.js';
import { revealRental } from './rentals.js';
import { $, badge, esc, toast } from '../shared/utils.js';

let payKind = '', paySrc = '', payMeth = '';

/* Damage fees (money the customer OWES after a return) are listed here as their own row type, one row per rental order.
   They come from the damage_charge table, never from the payment table, so they are not counted as revenue until Paid. */
const DMG_KIND = 'Damage fee';
function damageRows() {
    const refs = [...new Set(DMG.filter(d => Number(d.amount) > 0).map(d => d.rental_ref))];
    return refs.map(ref => {
        const list = dmgOf(ref).filter(d => Number(d.amount) > 0), first = list[0];
        const paid = list.filter(d => d.status === 'Paid');
        return {
            payment_id: 'dmg:' + ref, kind: DMG_KIND, reference: ref, customer_name: first.customer_name,
            amount: list.reduce((n, d) => n + Number(d.amount), 0), status: dmgStatus(ref),
            method: (paid[0] || list.find(d => d.paid_method) || {}).paid_method || '',
            gcash_reference: (list.find(d => d.gcash_reference) || {}).gcash_reference || '',
            created_at: list.map(d => d.created_at).sort()[0]
        };
    });
}
/* Late fees that were left unpaid at the return ("Not now") or paid at the return are listed the same way, one row per rental order
   (rental_detail late_fee columns, 83_late_fee_collection.sql). Late fees of older returns were never flagged, so they are not listed. */
const LATE_KIND = 'Late fee';
const isFee = p => p.kind === DMG_KIND || p.kind === LATE_KIND;
function lateRows() {
    const refs = [...new Set(RL.filter(l => num(l.late_fee) > 0 && (l.late_fee_deferred || l.late_fee_paid_at)).map(l => l.rental_ref))];
    return refs.map(ref => {
        const list = RL.filter(l => l.rental_ref === ref && num(l.late_fee) > 0 && (l.late_fee_deferred || l.late_fee_paid_at));
        const open = list.filter(l => !l.late_fee_paid_at), paid = list.find(l => l.late_fee_paid_at);
        return {
            payment_id: 'late:' + ref, kind: LATE_KIND, reference: ref, customer_name: list[0].customer_name,
            amount: list.reduce((n, l) => n + num(l.late_fee), 0),
            status: !open.length ? 'Paid' : open.some(l => !l.late_fee_pending_reference) ? 'Unpaid' : 'Pending',
            method: paid ? paid.late_fee_paid_method || '' : '',
            gcash_reference: (list.find(l => l.late_fee_reference || l.late_fee_pending_reference) || {}).late_fee_reference
                || (list.find(l => l.late_fee_pending_reference) || {}).late_fee_pending_reference || '',
            created_at: list.map(l => l.line_returned_at || l.created_at).sort()[0]
        };
    });
}

/* the status tab a row belongs to: a paid fee is listed under Verified */
const tabOf = p => isFee(p) && p.status === 'Paid' ? 'Verified' : p.status;

/* where a payment came from: the source of its booking or rental (Online or Onsite) */
const paySource = p => !['Rental', DMG_KIND, LATE_KIND].includes(p.kind) ? (findBk(p.reference) || {}).source : (RL.find(l => l.rental_ref === p.reference) || {}).source;

/* a booking payment is a down payment (50%, balance paid at the studio) when its booking has one; rentals show it in the verify drawer */
/* the payment list has no customer id: find it from the booking, rental or damage fee the payment belongs to */
const payCustomerId = p => {
    if (p.kind === DMG_KIND)
        return (dmgOf(p.reference)[0] || {}).customer_id;
    if (p.kind === 'Rental' || p.kind === LATE_KIND)
        return (RL.find(l => l.rental_ref === p.reference) || {}).customer_id;
    return (findBk(p.reference) || {}).customer_id;   // Booking or Extension: the reference is the booking
};

const isDown = p => p.kind === 'Booking' && num((findBk(p.reference) || {}).down_payment) > 0;

/* Amount column. When staff collected the balance, the payment became a full payment:
   show the total paid; the online + studio breakdown is in Details. */
function amountCell(p) {
    if (isFee(p))
        return `${money(p.amount)} <span class="mut">${p.status === 'Paid' ? 'paid' : 'owed by the customer'}</span>`;
    const col = num(p.balance_paid_amount);
    if (col > 0)
        return `${money(num(p.amount) + col)} <span class="mut">fully paid</span>`;   // the online + studio breakdown is in Details
    // an onsite outside rental recorded with a 50% down payment (its rental has a down payment) is labelled too
    const onsiteDown = p.kind === 'Rental' && paySource(p) === 'Onsite' && p.payment_option === 'down'
        && num((RL.find(l => l.rental_ref === p.reference) || {}).down_payment) > 0;
    return money(p.amount) + (isDown(p) || onsiteDown || p.kind === 'Extension' || (p.kind === 'Rental' && paySource(p) === 'Online')
        ? ` <span class="mut">${p.payment_option === 'full' ? 'fully paid' : 'down payment'}</span>` : '');
}

/* A payment is "past and closed" when it was rejected, or when the booking / rental it belongs to is over
   (Completed, Cancelled, Rejected or Returned). A Pending payment always stays in the open list. */
function isClosedPay(p) {
    if (isFee(p))
        return ['Paid', 'Waived'].includes(p.status);   // Unpaid and Pending fees stay in the open list
    if (p.status === 'Pending')
        return false;
    if (p.status === 'Rejected')
        return true;
    if (p.kind === 'Rental') {
        const l = RL.find(x => x.rental_ref === p.reference);
        return !l || ['Returned', 'Rejected', 'Cancelled'].includes(l.status);
    }
    const b = findBk(p.reference);   // a booking payment, or the payment of an extension of that booking
    return !b || ['Completed', 'Rejected', 'Cancelled'].includes(b.status);
}

/* When the booking or rental of a payment starts: the session start of a booking (or of the booking an add-on belongs to),
   the pick-up time of an outside rental. A payment with no match falls back to the time it was made. */
function payTime(p) {
    let t;
    if (isFee(p))
        return new Date(p.created_at || 0).getTime() || 0;
    if (p.kind === 'Rental') {
        const l = RL.find(x => x.rental_ref === p.reference), b = l && l.booking_ref ? findBk(l.booking_ref) : null;
        t = (b && b.start_at) || (l && l.pickup_date);
    } else
        t = (findBk(p.reference) || {}).start_at;
    return new Date(t || p.created_at || 0).getTime() || 0;
}

/* Row order: Unpaid (money the customer owes, such as a damage fee) first so it is not forgotten, then Pending payments,
   then the other open ones; inside each, the booking / rental that starts soonest is on top.
   Past and closed payments come after them, the most recent first. */
function payOrder(a, b) {
    const ca = isClosedPay(a), cb = isClosedPay(b);
    if (ca !== cb)
        return ca ? 1 : -1;
    if (!ca && (a.status === 'Unpaid') !== (b.status === 'Unpaid'))
        return a.status === 'Unpaid' ? -1 : 1;   // Unpaid stays at the very top
    if (!ca && (a.status === 'Pending') !== (b.status === 'Pending'))
        return a.status === 'Pending' ? -1 : 1;   // Pending payments stay at the top
    const diff = payTime(a) - payTime(b);
    return ca ? -diff : diff;
}

/* The Reference column: a link to the booking (Booking and Extension payments) or the rental (Rental payments and damage fees).
   If that booking / rental is no longer in the list, the reference stays plain text. */
function refCell(p) {
    const rental = ['Rental', DMG_KIND, LATE_KIND].includes(p.kind);
    const found = rental ? RL.some(l => l.rental_ref === p.reference) : !!findBk(p.reference);
    const mark = `<span ${rowMark(p.reference)}></span>`;
    return mark + (found ? refLink(rental ? 'rental' : 'booking', p.reference, rental ? 'Open this rental' : 'Open this booking') : esc(p.reference))
        + ` <span class="mut">${p.kind}</span>`;
}

export function renderPayments() {
    const rows = [...PAY, ...damageRows(), ...lateRows()].filter(p => (state.payF === 'All' || tabOf(p) === state.payF) && (!payKind || p.kind === payKind)
        && (!paySrc || paySource(p) === paySrc)
        && (!payMeth || p.method === payMeth))
        .sort(payOrder);
    const head = ['Reference', 'Customer', 'Amount', 'Method', 'Payment reference', 'Status', 'Actions'];
    const cells = p => [
        refCell(p),
        esc(p.customer_name) + repFlag(payCustomerId(p)),
        amountCell(p),
        isFee(p) ? (p.method ? esc(p.method) : '<span class="mut">Not paid yet</span>') : esc(p.method),
        isFee(p) ? (p.method === 'GCash' || (!p.method && p.gcash_reference) ? esc(p.gcash_reference || '-') : p.method === 'Cash' ? 'Paid at studio' : '<span class="mut">-</span>')
            : p.method === 'GCash' ? (p.gcash_reference ? esc(p.gcash_reference) : '<span class="mut">No reference</span>') : 'Pay at studio',
        badge(p.status),
        p.kind === LATE_KIND ? (p.status === 'Unpaid' ? btn('rn-latepay', p.reference, 'Collect') : p.status === 'Pending' ? btn('rn-latepay', p.reference, 'Verify') : btn('rn-det', p.reference, 'Details', 1))
            : p.kind === DMG_KIND ? (p.status === 'Unpaid' ? btn('dmg-open', p.reference, 'Collect') : p.status === 'Pending' ? btn('dmg-open', p.reference, 'Verify') : btn('dmg-open', p.reference, 'Details', 1))
            : p.status === 'Pending' ? btn('pay-verify', p.payment_id, 'Verify') : btn('pay-verify', p.payment_id, 'Details', 1)
    ];
    let table;
    if (state.payF === 'All' || state.payF === 'Verified') {
        // Like the customer tables: payments still in play first, payments of finished bookings / rentals (and rejected ones) in a closed group
        const open = rows.filter(p => !isClosedPay(p)), past = rows.filter(isClosedPay);
        table = tblGrouped(head, [
            { title: 'Open payments', rows: open.map(cells) },
            {
                title: 'Past and closed',
                toggle: 'pay',
                collapsed: !state.pastOpen.pay,
                rows: past.map(cells),
                dimmed: i => past[i].status === 'Rejected'
            }
        ]);
    } else
        table = tbl(head, rows.map(cells));   // Pending / Rejected tab: show every row
    const sel = (id, label, opts, cur) => `<select id="${id}" aria-label="${label}" style="max-width:200px">${opts.map(([v, t]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
    $('#apy').innerHTML = '<div class="row" style="justify-content:flex-start;gap:10px;flex-wrap:wrap;margin-bottom:12px">' +
        sel('pay-kind', 'Payments for', [['', 'All payment types'], ['Booking', 'Bookings'], ['Extension', 'Extensions'], ['Rental', 'Rentals'], [DMG_KIND, 'Damage fees'], [LATE_KIND, 'Late fees']], payKind) +
        sel('pay-src', 'Where it was made', [['', 'Online and onsite'], ['Online', 'Online'], ['Onsite', 'Onsite']], paySrc) +
        sel('pay-meth', 'Payment method', [['', 'GCash and cash'], ['GCash', 'GCash'], ['Cash', 'Cash']], payMeth)
        + '</div>' +
        tabsHtml(['All', 'Pending', 'Unpaid', 'Verified', 'Rejected'], state.payF, 'pf')
        + table;
}

$('#apy').addEventListener('change', e => {
    if (e.target.id === 'pay-kind')
        payKind = e.target.value;
    else if (e.target.id === 'pay-src')
        paySrc = e.target.value;
    else if (e.target.id === 'pay-meth')
        payMeth = e.target.value;
    else
        return;
    renderPayments();
});

$('#apy').addEventListener('click', e => {
    const j = e.target.closest('a[data-jump]');
    if (j) {
        e.preventDefault();
        return j.dataset.jump === 'booking' ? revealBooking(j.dataset.ref) : revealRental(j.dataset.ref);
    }
    if (e.target.closest('[data-toggle="pay"]')) {
        state.pastOpen.pay = !state.pastOpen.pay;
        return renderPayments();
    }
    const t = e.target.closest('[data-pf]');
    if (t) {
        state.payF = t.dataset.pf;
        renderPayments();
    }
});

const setPay = async (id, status) => {
    const p = PAY.find(x => x.payment_id === +id),
        ref = p && p.kind === 'Booking' ? p.reference : null,
        had = !!ref && pendingAddons(ref);
    if (!(await run(sb.from('payment').update({ status }).eq('payment_id', +id))))
        return;
    if (status === 'Verified')
        notifyVerified(+id);   // email the customer (does not wait)
    await refresh();
    closeOverlays();
    toast(p && p.kind === 'Extension' ? (status === 'Verified' ? `${p.reference} extension verified. The booking time and total are updated.` : 'Extension payment rejected.')
        : status === 'Verified' && ref ? verifiedMsg(ref, had) : 'Payment ' + status.toLowerCase() + '.');
};

const payWho = id => {
    const p = PAY.find(x => x.payment_id === +id);
    return p ? `${p.reference}${p.customer_name ? ' (' + p.customer_name + ')' : ''}` : 'this payment';
};

CONFIRM['pay-ok'] = id => ({
    title: 'Verify this payment?',
    message: `${payWho(id)} will be marked as verified. Only continue if you checked that the money was received.`,
    ok: 'Yes, verify payment'
});
CONFIRM['pay-no'] = id => ({
    title: 'Reject this payment?',
    message: `${payWho(id)} will be rejected.`,
    ok: 'Yes, reject',
    danger: true
});

ACT['pay-ok'] = id => setPay(id, 'Verified');

ACT['pay-no'] = id => setPay(id, 'Rejected');
