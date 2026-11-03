/* =====================================================================
   admin/payments.js - Payments tab
   DB: table payment (verify / reject).
   ===================================================================== */

import { state } from './state.js';
import { closeOverlays, findBk, pendingAddons, verifiedMsg } from './bookings.js';
import { PAY, RL, refresh } from './data.js';
import { ACT, btn, money, notifyVerified, num, run, tabsHtml, tbl, tblGrouped, CONFIRM } from './helpers.js';
import { sb } from '../config/supabaseClient.js';
import { $, badge, esc, toast } from '../shared/utils.js';

let payKind = '', paySrc = '', payMeth = '';

/* where a payment came from: the source of its booking or rental (Online or Onsite) */
const paySource = p => p.kind !== 'Rental' ? (findBk(p.reference) || {}).source : (RL.find(l => l.rental_ref === p.reference) || {}).source;

/* a booking payment is a down payment (50%, balance paid at the studio) when its booking has one; rentals show it in the verify drawer */
const isDown = p => p.kind === 'Booking' && num((findBk(p.reference) || {}).down_payment) > 0;

/* Amount column. When staff collected the balance, the payment became a full payment:
   show the total paid; the online + studio breakdown is in Details. */
function amountCell(p) {
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
    if (p.kind === 'Rental') {
        const l = RL.find(x => x.rental_ref === p.reference), b = l && l.booking_ref ? findBk(l.booking_ref) : null;
        t = (b && b.start_at) || (l && l.pickup_date);
    } else
        t = (findBk(p.reference) || {}).start_at;
    return new Date(t || p.created_at || 0).getTime() || 0;
}

/* Row order: Pending payments first, then the other open ones; inside each, the booking / rental that starts soonest is on top.
   Past and closed payments come after them, the most recent first. */
function payOrder(a, b) {
    const ca = isClosedPay(a), cb = isClosedPay(b);
    if (ca !== cb)
        return ca ? 1 : -1;
    if (!ca && (a.status === 'Pending') !== (b.status === 'Pending'))
        return a.status === 'Pending' ? -1 : 1;   // Pending payments stay at the top
    const diff = payTime(a) - payTime(b);
    return ca ? -diff : diff;
}

export function renderPayments() {
    const rows = PAY.filter(p => (state.payF === 'All' || p.status === state.payF) && (!payKind || p.kind === payKind)
        && (!paySrc || paySource(p) === paySrc)
        && (!payMeth || p.method === payMeth))
        .sort(payOrder);
    const head = ['Reference', 'Customer', 'Amount', 'Method', 'Payment reference', 'Status', 'Actions'];
    const cells = p => [
        esc(p.reference) + ` <span class="mut">${p.kind}</span>`,
        esc(p.customer_name),
        amountCell(p),
        esc(p.method),
        p.method === 'GCash' ? (p.gcash_reference ? esc(p.gcash_reference) : '<span class="mut">No reference</span>') : 'Pay at studio',
        badge(p.status),
        p.status === 'Pending' ? btn('pay-verify', p.payment_id, 'Verify') : btn('pay-verify', p.payment_id, 'Details', 1)
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
        sel('pay-kind', 'Payments for', [['', 'Bookings, extensions and rentals'], ['Booking', 'Bookings'], ['Extension', 'Extensions'], ['Rental', 'Rentals']], payKind) +
        sel('pay-src', 'Where it was made', [['', 'Online and onsite'], ['Online', 'Online'], ['Onsite', 'Onsite']], paySrc) +
        sel('pay-meth', 'Payment method', [['', 'GCash and cash'], ['GCash', 'GCash'], ['Cash', 'Cash']], payMeth)
        + '</div>' +
        tabsHtml(['All', 'Pending', 'Verified', 'Rejected'], state.payF, 'pf')
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
