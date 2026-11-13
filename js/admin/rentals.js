/* =====================================================================
   admin/rentals.js - Rentals tab
   DB: rental tables (approve, issue, return, reject), signed ID image links.
   ===================================================================== */

import { afterAction, balanceOf, closeOverlays, findBk, startLabel } from './bookings.js';
import { PAY, RL, refresh } from './data.js';
import { state } from './state.js';
import { ACT, CONFIRM, askConfirm, dOf, dayDiff, mailNoteOf, money, notifyDamagePaid, notifyLateFeePaid, notifyReplacement, num, rnStatus, run, stampLabel, tOf, tbl, tblGrouped } from './helpers.js';
import { bindCollect, collectBox, dmgError, dmgOf, dmgOwed, dmgStatus } from './damage.js';
import { dueToday } from './overview.js';
import { repFlag } from './reputation.js';
import { focusRows, rowMark } from './jump.js';
import { photoBtn } from '../shared/imageViewer.js';
import { listGcashProofs } from '../shared/gcashProof.js';
import { lateFeeTrail } from './trail.js';
import { showStockShortage } from './equipment.js';
import { handoffWarnings, waitingForItem } from './handoff.js';
import { customerChose, equipmentImages, replacementPending, followUpOffer, groupByCategory, groupHeading, openOffersOfRental, outOfStockPending, paymentUnchecked, picHtml, shortOf, swapActions } from './swapOffer.js';
import { openActionMenu } from '../shared/actionMenu.js';
import { sb } from '../config/supabaseClient.js';
import { loadCatalog } from '../shared/catalog.js';
import { btnBusy, btnReset, btnSuccess } from '../shared/btnState.js';
import { $, badge, esc, pl, shortDate, sum, toast } from '../shared/utils.js';
import { PHOTO_BUCKET, makePhotoPicker, signedPhotoUrl, uploadHandoverPhoto, uploadInspectionPhoto, validatePhoto } from '../shared/inspectionPhoto.js';

/* ============================ 7. RENTALS ============================ */

let rf = 'All';

/* the tab for verified orders waiting to be handed over is shown as "To issue" (its filter value stays Verified) */
const RF_LABEL = { Verified: 'To issue' };
const RF = ['All', 'Pending', 'Verified', 'In Use', 'Due today', 'Overdue', 'Returned', 'Rejected'];

/* When a rental order starts: the pick-up time of an outside rental, the session start of the booking an add-on belongs to */
const rnTime = g => {
    const l = g.lines[0], b = g.type === 'Add-on' && g.booking ? findBk(g.booking) : null;
    return new Date((b && b.start_at) || l.pickup_date || l.created_at || 0).getTime() || 0;
};

/* Row order in the Rentals table: Pending orders first, then the other open ones, the soonest on top inside each;
   finished ones (Returned, Rejected, Cancelled) after them, the most recent first. */
const rnOrder = (a, b) => {
    const ca = isClosedRn(a), cb = isClosedRn(b);
    if (ca !== cb)
        return ca ? 1 : -1;
    if (!ca && (a.status === 'Pending') !== (b.status === 'Pending'))
        return a.status === 'Pending' ? -1 : 1;   // Pending orders stay at the top
    const diff = rnTime(a) - rnTime(b);
    return ca ? -diff : diff;
};

export const TYB = {
    'Add-on': '<span class="b addon">Add-on</span>',
    'Outside': '<span class="b out">Outside</span>'
};

export const lateDays = l => (l.line_returned_at && l.due_at) ? Math.max(0, dayDiff(dOf(l.line_returned_at), dOf(l.due_at))) : 0;

/* ---- overdue is measured in HOURS (a started hour counts as a full hour, like the late fee) ----
   hours_overdue comes from the v_rental_lines view (supabase/13_...sql). If the view has not been
   updated yet, the same number is worked out here from due_at, so the page still works. */
export function overdueHours(l) {
    if (l.hours_overdue !== undefined && l.hours_overdue !== null)
        return num(l.hours_overdue);
    if (l.status !== 'Active' || l.line_returned_at || !l.due_at)
        return 0;
    const late = Date.now() - new Date(l.due_at).getTime();
    return late > 0 ? Math.max(1, Math.ceil(late / 36e5)) : 0;
}

/* The late fee an outside rental line would be charged if it were returned now: price / 8 per hour, per item, a started hour counts
   as a full hour, counted from due_at (the end of the 8-hour window, the same moment it shows as Overdue). The database works it
   out with the same formula when the return is saved (supabase/83_late_fee_collection.sql). */
export function lateNow(l, now = Date.now()) {
    if (l.rental_type !== 'Outside' || l.status !== 'Active' || l.line_returned_at || !l.due_at)
        return { hours: 0, fee: 0 };
    const late = now - new Date(l.due_at).getTime();
    if (late <= 0)
        return { hours: 0, fee: 0 };
    const hours = Math.ceil(late / 36e5);
    return { hours, fee: Math.round(num(l.unit_price_at_request) * l.quantity / 8 * hours * 100) / 100 };
}

/* The late fee still owed on a returned rental: staff chose "Not now" at the return (late_fee_deferred) and it is not paid yet.
   Late fees of older returns are not counted: they were never flagged. Needs supabase/83_late_fee_collection.sql. */
export const lateUnpaid = ref => Math.round(sum(RL.filter(l => l.rental_ref === ref && l.late_fee_deferred && !l.late_fee_paid_at && num(l.late_fee) > 0)
    .map(l => num(l.late_fee))) * 100) / 100;

/* Of that, the part the customer already paid by GCash from My Rentals and staff still have to check (needs 83_late_fee_collection.sql). */
const latePendingLines = ref => RL.filter(l => l.rental_ref === ref && l.late_fee_deferred && !l.late_fee_paid_at && l.late_fee_pending_reference && num(l.late_fee) > 0);
export const latePending = ref => Math.round(sum(latePendingLines(ref).map(l => num(l.late_fee))) * 100) / 100;

/* hours a returned item was late (0 = on time) */
export const lateHours = l => {
    if (!l.line_returned_at || !l.due_at)
        return 0;
    const late = new Date(l.line_returned_at).getTime() - new Date(l.due_at).getTime();
    return late > 0 ? Math.max(1, Math.ceil(late / 36e5)) : 0;
};

/* A rental that is in use but past its due time shows as Overdue instead of In Use. */
export const lineStatus = l => (l.status === 'Active' && overdueHours(l) > 0) ? 'Overdue' : rnStatus(l.status);
export const groupStatus = g => (g.status === 'Active' && g.lines.some(l => overdueHours(l) > 0)) ? 'Overdue' : rnStatus(g.status);

export function dueB(l) {
    if (overdueHours(l) > 0)
        return `<span class="b overdue">${pl(overdueHours(l), 'hour')} overdue</span>`;
    if (l.line_returned_at)
        return lateHours(l) ? `<span class="b out">Returned ${pl(lateHours(l), 'hour')} late</span>` : '<span class="mut">Returned on time</span>';
    if (l.status === 'Active' && dueToday(l))
        return '<span class="b duetoday">Due today</span>';
    return '<span class="mut">-</span>';
}

export const dueLabel = l => !l.due_at ? '-' : shortDate(dOf(l.due_at)) + ', ' + tOf(l.due_at);

export function groups() {
    const map = new Map();
    RL.forEach(l => {
        if (!map.has(l.rental_ref))
            map.set(l.rental_ref, {
                ref: l.rental_ref,
                type: l.rental_type,
                source: l.source,
                status: l.status,
                customer: l.customer_name,
                customerId: l.customer_id,
                phone: l.customer_number,
                booking: l.booking_ref,
                reason: l.rejected_reason,
                lines: []
            });
        map.get(l.rental_ref).lines.push(l);
    });
    return [...map.values()];
}

const gMatch = (g, f) => f === 'All'
    || (f === 'Overdue' ? groupStatus(g) === 'Overdue' : f === 'Due today' ? g.lines.some(l => l.status === 'Active' && dueToday(l)) : groupStatus(g) === f);

/* Verify is shown only while something still has to be verified: the rental itself is Pending,
   or its payment (an add-on rides on its booking's payment) is Pending. After that it is a Details button. */
function needsVerify(g) {
    if (g.status === 'Pending')
        return true;
    const own = PAY.find(p => p.reference === g.ref);
    if (own && own.status === 'Pending')
        return true;
    if (g.type === 'Add-on' && g.booking) {
        const bp = PAY.find(p => p.reference === g.booking && p.kind === 'Booking');
        if (bp && bp.status === 'Pending')
            return true;
    }
    return false;
}

/* Rental total (outside rentals are billed per 8 hours, like rental_order_total in the database) */
export function rentalTotal(g) {
    const l0 = g.lines[0], out = g.type === 'Outside';
    const hrs = Math.max(8, Math.ceil(num(l0.rental_hours) || 8)), factor = out ? hrs / 8 : 1;
    return sum(g.lines.map(l => num(l.unit_price_at_request) * l.quantity * factor));
}

/* Status badge of a rental order. A verified order shows how it is paid: "Balance PHP x" while something is still to collect,
   "Fully Paid" when nothing is left. Every other status is shown as it is. */
/* The balance shown in the table for ONE rental order, so the rows of a booking add up to what staff really collect.
   An add-on ordered together with its booking has no balance of its own: rentalBalance() returns the booking's whole balance,
   which already contains the balance of add-ons added LATER (they have their own row). Those are taken out here,
   so the same peso is never shown twice. (The collect-balance windows keep using rentalBalance(): starting the booking collects it all.) */
export function rentalBalanceShown(g) {
    const total = rentalBalance(g), l0 = g.lines[0];
    if (!(g.type === 'Add-on' && g.booking && num(l0.down_payment) <= 0) || total <= 0.005)
        return total;
    const later = new Map();   // rental reference -> that order's own balance
    RL.filter(l => l.booking_ref === g.booking && l.rental_type === 'Add-on' && l.rental_ref !== l0.rental_ref
        && !['Rejected', 'Cancelled'].includes(l.status) && num(l.down_payment) > 0)
        .forEach(l => {
            const mine = RL.filter(x => x.rental_ref === l.rental_ref);
            later.set(l.rental_ref, l.balance_due !== undefined && l.balance_due !== null
                ? num(l.balance_due)
                : Math.max(0, sum(mine.map(x => num(x.unit_price_at_request) * x.quantity)) - num(l.down_payment) - num(l.balance_paid_amount)));
        });
    return Math.max(0, total - sum([...later.values()]));
}

const rnBadge = g => {
    const s = groupStatus(g);
    // flag so an unpaid late fee (staff chose "Not now" at the return) is not forgotten
    const lateOwed = s === 'Returned' ? lateUnpaid(g.ref) : 0;
    const lateChip = lateOwed > 0.005
        ? (latePending(g.ref) > 0.005
            ? '<span class="b pending" title="The customer sent a GCash payment for the late fee. Open Actions > Late fee (verify payment).">Late fee: check payment</span>'
            : `<span class="b balancedue" title="The rental is returned, but the late fee is not paid yet. Open Actions > Collect late fee.">Late fee ${money(lateOwed)} unpaid</span>`)
        : '';
    if (s === 'Returned' && dmgOf(g.ref).length) {
        // flag so an unpaid damage fee is not forgotten
        const owed = dmgOwed(g.ref), st = dmgStatus(g.ref);
        if (owed > 0.005)
            return lateChip + (lateChip ? ' ' : '') + `<span class="b balancedue" title="The rental is returned, but the damage fee is not paid yet. Open Actions > Damage fee.">${st === 'Pending' ? 'Damage fee: check payment' : 'Damage fee ' + money(owed) + ' unpaid'}</span>`;
    }
    if (lateChip)
        return lateChip;
    // a replacement offer is with the customer, or ended without a swap and needs staff
    const offerChip = ['Pending', 'Approved'].includes(g.status)
        ? (openOffersOfRental(g.ref).length ? ' <span class="b pending" title="You offered the customer replacement items. They are choosing in My rental.">Awaiting customer choice</span>'
            : g.lines.some(l => followUpOffer(l.rental_detail_id)) ? ' <span class="b overdue" title="The customer did not answer, or none of the offered items suit them. Swap the item or offer other items.">Replacement: follow up</span>' : '')
        : '';
    // a Pending rental whose item went out of stock cannot be verified as booked: show it as Out of stock until it is swapped
    if (s === 'Pending' && outOfStockPending(g.ref))
        return `<span class="b outofstock" title="${paymentUnchecked(g.ref) ? 'The item this customer booked is out of stock for these hours. Verify the payment first, then use Actions > Swap item.' : 'The item this customer booked is out of stock for these hours. Payment is verified: use Actions > Let customer choose or Swap item. The rental is approved by itself afterwards.'}">Out of stock</span>` + offerChip;
    // a risk that the item is not back in time for this rental (the same unit is out until about when this one starts)
    const tight = ['Pending', 'Approved'].includes(g.status) && handoffWarnings(g.ref).length
        ? ' <span class="b pending" title="' + esc(handoffWarnings(g.ref)[0].text) + '">Tight handoff</span>' : '';
    // verified and its start time has come, but the item is still out with another customer
    const waiting = s === 'Verified' ? waitingForItem(g) : null;
    if (waiting)
        return `<span class="b outofstock" title="${esc(waiting.line.equipment_name)} is still out with ${esc(waiting.blockers[0].customer_name)} (${esc(waiting.blockers[0].rental_ref)}). ${g.type === 'Add-on' ? 'It is issued by itself once it is returned.' : 'Issue it once it is returned, or use Actions > Swap item.'}">Waiting for item</span>` + offerChip;
    if (s === 'Overdue') {
        const fee = sum(g.lines.map(l => lateNow(l).fee));
        if (fee > 0)
            return badge(s) + ` <span class="b balancedue" title="Late fee so far: price / 8 per hour, per item. It is worked out again when you press Actions > Process return, and collected there.">Late fee ${money(fee)}</span>` + offerChip;
    }
    if (s !== 'Verified')
        return badge(s) + offerChip + tight;
    const bal = rentalBalanceShown(g);
    // equipment ordered with the booking: its balance is the booking's, so say so on hover
    const withBooking = g.type === 'Add-on' && g.booking && num(g.lines[0].down_payment) <= 0;
    const tip = withBooking ? ` title="Remaining balance of booking ${esc(g.booking)} (studio time and the equipment ordered with it), collected before the session starts. Equipment added later has its own row."` : '';
    return (bal > 0.005 ? `<span class="b balancedue"${tip}>Balance ${money(bal)}</span>` : badge('Fully Paid')) + offerChip + tight;
};

/* What the customer still has to pay before the equipment is handed over.
   Outside rental, or an add-on added later (paid 50% or full online): its own balance (the database works it out: v_rental_lines.balance_due).
   Add-on ordered together with the booking: the balance of its studio booking, collected before the session starts. */
export function rentalBalance(g) {
    const l0 = g.lines[0];
    if (g.type === 'Add-on' && num(l0.down_payment) <= 0) {
        // added together with the booking: paid with the booking, so its balance is the booking's
        const b = g.booking ? findBk(g.booking) : null;
        return b && b.status === 'Approved' && num(b.down_payment) > 0 ? balanceOf(b) : 0;
    }
    // an outside rental, or an add-on added later with its own down payment: its own balance
    if (num(l0.down_payment) <= 0)
        return 0;
    if (l0.balance_due !== undefined && l0.balance_due !== null)
        return num(l0.balance_due);   // fallback below only while 32_balance_collection.sql has not been run
    return Math.max(0, rentalTotal(g) - num(l0.down_payment) - num(l0.balance_paid_amount));
}

/* An add-on cannot be issued before its studio booking has started. While that booking is still Confirmed,
   this returns it, and the Issue button becomes the booking's Start session / Collect balance & start. */
export const addonWaitingBooking = g => {
    const b = g.type === 'Add-on' && g.booking ? findBk(g.booking) : null;
    return b && b.status === 'Approved' ? b : null;
};

export const issueLabel = g => addonWaitingBooking(g) ? startLabel(addonWaitingBooking(g)) : rentalBalance(g) > 0.005 ? 'Collect balance & issue' : 'Issue';

/* an item can be swapped only before the rental is issued (Pending or Verified) and while it is still out */
const canSwap = g => ['Pending', 'Approved'].includes(g.status) && g.lines.some(l => !l.line_returned_at);

/* A Pending rental whose own payment staff already verified (the approval step is what is left) */
const payVerifiedPending = g => g.status === 'Pending' && PAY.some(p => p.reference === g.ref && p.status === 'Verified');

/* The choices of a rental's Actions menu. The primary action (Verify, Issue, Process return) comes first. */
function rnMenuItems(g) {
    const item = (act, label) => ({ act, id: g.ref, label });
    const open = openOffersOfRental(g.ref);
    /* Pending, payment not verified: only Verify (a fake booking gets no swap).
       Pending, payment verified, item out of stock: Replace item (the pop-up opens by itself after Verify).
       Balance / Fully Paid: Swap item, or Replace item when the item is short or the customer declined / did not answer. */
    const short = outOfStockPending(g.ref) && !paymentUnchecked(g.ref);   // Pending, item out of stock AND the payment already verified (fake bookings get no action)
    /* The item cannot be given as booked (out of stock, or the customer declined / did not answer a replacement offer):
       staff MUST act, exactly like after a damaged return. Replace item opens the same locked pop-up: Let customer choose or Swap item. */
    const stuck = canSwap(g) && !open.length
        && (g.lines.some(l => !l.line_returned_at && followUpOffer(l.rental_detail_id)) || (shortOf(g.ref) && (g.status !== 'Pending' || short)));
    const atRisk = handoffWarnings(g.ref).length > 0 || !!waitingForItem(g);
    const swap = canSwap(g) && (!needsVerify(g) || short) ? [
        ...(open.length ? [{ act: 'rn-offer-cancel', id: open[0].offer_id, label: 'Cancel replacement offer' }, item('rn-swap', 'Swap item')]
            : stuck ? [item('rn-fix', 'Replace item')]
                : atRisk ? [item('rn-offer', 'Let customer choose'), item('rn-swap', 'Swap item')]   // the item may not be back in time (handoff.js): offer a replacement before it is a problem
                    : [item('rn-swap', 'Swap item')])   // not short: staff may still swap an item that cannot be given as booked (not issued yet)
    ] : [];
    if (needsVerify(g)) {
        if (short)
            return [...swap, item('rn-det', 'Details')];   // one Verify only: it was done already. Details has Reject if nothing can replace the item
        // payment verified but the approval did not happen (for example 73_approve_after_swap.sql not run): finish here
        return [payVerifiedPending(g) ? item('rn-ok', 'Approve rental') : item('rn-verify', 'Verify'), ...swap];   // Verify opens the Verify window in the Payments tab
    }
    if (g.status === 'Approved')
        return [...(replacementPending(g.ref) ? [] : [item('rn-issue', issueLabel(g))]), item('rn-det', 'Details'), ...swap];   // no issuing while a replacement is unsettled
    if (g.status === 'Active')
        return [item('rn-ret', 'Process return'), item('rn-det', 'Details')];
    if (g.status === 'Returned' && (dmgOf(g.ref).length || lateUnpaid(g.ref) > 0.005))
        return [...(lateUnpaid(g.ref) > 0.005 ? [item('rn-latepay', latePending(g.ref) > 0.005 ? 'Late fee (verify payment)' : 'Collect late fee')] : []),
            ...(dmgOf(g.ref).length ? [item('dmg-pay', dmgStatus(g.ref) === 'Pending' ? 'Damage fee (verify payment)' : dmgOwed(g.ref) > 0.005 ? 'Damage fee (unpaid)' : 'Damage fee')] : []),   // opens it in the Payments tab
            item('rn-det', 'Details')];
    return [item('rn-det', 'Details')];
}

const rnActions = g => `<button type="button" class="btn sm line menu-btn" data-rnmenu="${esc(g.ref)}" aria-haspopup="menu" aria-expanded="false">Actions <span aria-hidden="true">&#9662;</span></button>`;

document.addEventListener('click', e => {
    const menuButton = e.target.closest('[data-rnmenu]');
    const g = menuButton && groups().find(x => x.ref === menuButton.dataset.rnmenu);
    if (g)
        openActionMenu(menuButton, rnMenuItems(g));
});

let rsrc = '';

/* Used by the Overview cards: show the Rentals tab with this status filter (and all sources) */
export function setRentalFilter(f) {
    rf = RF.includes(f) ? f : 'All';
    rsrc = '';
    renderRentals();
}

/* Used by the links in the Payments tab: show the Rentals tab with this order highlighted.
   The status tab and source filter are reset, so the row is never hidden. */
export function revealRental(ref) {
    const g = groups().find(x => x.ref === ref);
    rf = 'All';
    rsrc = '';
    if (g && isClosedRn(g))
        state.pastOpen.rn = true;
    renderRentals();
    focusRows('a-rent', '#arn', ref);
}

export function renderRentals() {
    const gs = groups();
    const list = gs.filter(g => gMatch(g, rf) && (!rsrc || g.source === rsrc)).sort(rnOrder);
    if (rf === 'Overdue')
        list.sort((a, b) => Math.max(...b.lines.map(overdueHours)) - Math.max(...a.lines.map(overdueHours)));
    const cnt = f => f === 'Overdue' ? ' (' + gs.filter(g => gMatch(g, 'Overdue')).length + ')' : f === 'Pending' ? ' (' + gs.filter(g => g.status === 'Pending').length + ')' : '';
    const head = ['Order', 'Customer', 'Items', 'Rent type', 'Status', 'Actions'];
    const cells = g => [
        `<span ${rowMark(g.ref)}>${esc(g.type === 'Add-on' ? (g.booking || g.ref) : g.ref)}</span>`,   // plain text (open it from Actions); the mark lets the Payments tab's links find this row
        esc(g.customer) + repFlag(g.customerId, 'rental'),
        g.lines.length === 1 ? esc(g.lines[0].equipment_name) + ' x' + g.lines[0].quantity : g.lines.length + ' items',
        TYB[g.type],
        rnBadge(g),
        rnActions(g)
    ];
    let table;
    if (rf === 'All') {
        // Like the customer's My rental: open orders first, Returned / Rejected / Cancelled tucked into a closed "Past and closed" group
        const owing = list.filter(owesDamage), open = list.filter(g => !isClosedRn(g)), past = list.filter(isClosedRn);
        table = tblGrouped(head, [
            { title: 'Damage fee to collect', rows: owing.map(cells) },
            { title: 'In use and upcoming', rows: open.filter(g => !owesDamage(g)).map(cells) },
            {
                title: 'Past and closed',
                toggle: 'rn',
                collapsed: !state.pastOpen.rn,
                rows: past.map(cells),
                dimmed: i => ['Rejected', 'Cancelled'].includes(past[i].status)
            }
        ]);
    } else
        table = tbl(head, list.map(cells));   // a status tab is picked on purpose: show all of its rows
    $('#arn').innerHTML = `<div class="row" style="margin-bottom:10px;justify-content:flex-start"><select id="rn-src" style="max-width:190px" aria-label="Rental source"><option value="">Online and onsite</option><option value="Online" ${rsrc === 'Online' ? 'selected' : ''}>Online rentals</option><option value="Onsite" ${rsrc === 'Onsite' ? 'selected' : ''}>Onsite rentals</option></select></div><div class="tabs">${RF.map(x => `<button data-rf="${x}" class="${x === rf ? 'on' : ''}">${RF_LABEL[x] || x}${cnt(x)}</button>`).join('')}</div>` +
        '<div class="card">' + table + '</div>';
}

/* a rental order that is over: Returned, Rejected or Cancelled */
/* a returned rental whose damage fee is still unpaid is NOT closed: it stays in the open list until the fee is paid */
const owesDamage = g => g.status === 'Returned' && dmgOwed(g.ref) > 0.005;
const isClosedRn = g => ['Returned', 'Rejected', 'Cancelled'].includes(g.status) && !owesDamage(g);

$('#arn').addEventListener('click', e => {
    if (e.target.closest('[data-toggle="rn"]')) {
        state.pastOpen.rn = !state.pastOpen.rn;
        return renderRentals();
    }
    const t = e.target.closest('[data-rf]');
    if (t) {
        rf = t.dataset.rf;
        renderRentals();
    }
});

$('#arn').addEventListener('change', e => {
    if (e.target.id === 'rn-src') {
        rsrc = e.target.value;
        renderRentals();
    }
});

export const setRental = async (ref, status, reason) => {
    const patch = { status };
    if (reason)
        patch.rejected_reason = reason;
    if (await run(sb.from('rental_order').update(patch).eq('rental_ref', ref))) {
        await loadCatalog();
        afterAction({
            Approved: `${ref} approved.`,
            Active: `${ref} issued.`,
            Rejected: `${ref} rejected. The customer will see: ${reason}.`
        }[status]);
    }
};

const rnWho = ref => {
    const g = groups().find(x => x.ref === ref);
    return g ? `${ref} (${g.customer})` : ref;
};

CONFIRM['rn-ok'] = ref => ({
    title: 'Approve this rental?',
    message: `${rnWho(ref)} will be marked as Verified.` + (handoffWarnings(ref).length ? ' Heads up: ' + handoffWarnings(ref).map(w => w.text).join(' ') : ''),
    ok: 'Yes, approve'
});
/* Issue equipment (CONFIRM / ACT 'rn-issue') lives in balance.js: it collects and verifies the remaining balance first. */
/* Return CONFIRM: outside rentals skip the generic dialog and open the condition modal instead.
   Returning undefined here makes the ACT run directly (which opens the modal). */
CONFIRM['rn-ret'] = ref => {
    const g = groups().find(x => x.ref === ref);
    if (g && g.type === 'Outside') return undefined;   // condition modal handles it
    return {
        title: 'Process the return?',
        message: `All equipment in ${rnWho(ref)} will be marked as returned and put back in stock. Any late fee is worked out now.`,
        ok: 'Yes, process return'
    };
};
CONFIRM['rn-retline'] = id => {
    const [ref] = id.split(':');
    const g = groups().find(x => x.ref === ref);
    if (g && g.type === 'Outside') return undefined;   // condition modal handles it
    const [, eid] = id.split(':'), l = RL.find(x => x.rental_ref === ref && x.equipment_id === +eid);
    return {
        title: 'Return this item?',
        message: `${l ? l.equipment_name + ' from ' : ''}${rnWho(ref)} will be marked as returned and put back in stock.`,
        ok: 'Yes, return item'
    };
};
CONFIRM['rn-reject-go'] = ref => ({
    title: 'Reject this rental?',
    message: `${rnWho(ref)} will be rejected and the customer will see the reason.`,
    ok: 'Yes, reject',
    danger: true
});

ACT['rn-ok'] = ref => setRental(ref, 'Approved');

const lateFeeOf = (ref, eid) => sum(RL.filter(l => l.rental_ref === ref && (!eid || l.equipment_id === eid)).map(l => num(l.late_fee)));

const returnedMsg = (ref, eid, what) => lateFeeOf(ref, eid) > 0
    ? `${what} returned late. Collect the late fee of ${money(lateFeeOf(ref, eid))} from the customer.` : `${what} returned. Stock updated.`;

/* ---- Collect a late fee that was left unpaid at the return ("Not now") ---- */
ACT['rn-latepay'] = ref => openCollectLateFee(ref);

async function openCollectLateFee(ref) {
    const owed = lateUnpaid(ref);
    if (owed <= 0.005)
        return toast('There is no unpaid late fee on this rental.');
    const g = groups().find(x => x.ref === ref);
    const unpaid = RL.filter(l => l.rental_ref === ref && l.late_fee_deferred && !l.late_fee_paid_at && num(l.late_fee) > 0);
    // the customer already paid by GCash from My Rentals: staff check the reference and the screenshot, then accept or reject it
    const pendingRef = (unpaid.find(l => l.late_fee_pending_reference) || {}).late_fee_pending_reference || '';
    const shots = pendingRef ? await listGcashProofs(pendingRef) : [];
    const rejected = !pendingRef ? (unpaid.find(l => l.late_fee_reject_reason) || {}).late_fee_reject_reason : '';
    const md = document.createElement('dialog');
    md.className = 'dlg balance';
    md.setAttribute('aria-label', 'Collect late fee');
    document.body.appendChild(md);
    md.innerHTML = `<div class="in">
      <h2 style="margin:0 0 4px">${pendingRef ? 'Late fee payment sent' : 'Collect late fee'}</h2>
      <p class="mut" style="margin:0 0 10px">${esc(ref)}${g ? ' — ' + esc(g.customer) : ''}</p>
      <div class="dr-sum">${unpaid.map(l => `<div><span>${esc(l.equipment_name)} x${l.quantity}<span class="mut" style="display:block">${pl(lateHours(l), 'hour')} late</span></span>${unpaid.length > 1 ? `<span>${money(l.late_fee)}</span>` : ''}</div>`).join('')}
        <div class="tot-line"><b>Late fee unpaid</b><b>${money(owed)}</b></div></div>
      ${pendingRef ? `<div class="alert warn" role="note"><b>The customer sent a GCash payment</b> of ${money(owed)} (reference ${esc(pendingRef)}). Check it in your GCash app before you accept it.
        ${shots.length ? '<div class="dc-shots">' + shots.map((u, i) => `<div class="dc-shot">${photoBtn(u, 'GCash screenshot' + (shots.length > 1 ? ' ' + (i + 1) : ''), 'View GCash screenshot', { ref: pendingRef, amount: money(owed) })}</div>`).join('')
            + '<p class="mut dc-shothint">Check that its reference number and amount match the ones above.</p></div>' : '<br><span class="mut">No screenshot was found.</span>'}</div>
        <div id="lf-reject" hidden><label for="lf-why">Why is the payment rejected? <span class="req" aria-hidden="true">*</span></label>
          <textarea id="lf-why" rows="2" style="width:100%;resize:vertical" placeholder="For example: the reference does not match the amount"></textarea></div>`
        : `${rejected ? `<div class="alert warn" role="note">Last GCash payment was rejected: ${esc(rejected)}</div>` : ''}
        <div id="lf-collect">${collectBox({ label: `The customer pays ${money(owed)} by` })}</div>`}
      <div class="alert" id="lf-err" role="alert" hidden></div>
      ${lateFeeTrail(ref)}
      <div class="acts" style="margin-top:14px">
        <button type="button" class="btn line" id="lf-cancel">Cancel</button>
        ${pendingRef ? '<button type="button" class="btn bad" id="lf-rej">Reject payment</button>' : ''}
        <button type="button" class="btn gold" id="lf-ok">Payment received</button>
      </div></div>`;
    const collect = pendingRef ? null : bindCollect(md.querySelector('#lf-collect'), () => owed, () => {});
    const errBox = md.querySelector('#lf-err'), okBtn = md.querySelector('#lf-ok'), rejBtn = md.querySelector('#lf-rej');
    const showErr = t => {
        errBox.textContent = t;
        errBox.hidden = !t;
    };
    const close = () => {
        md.close();
        md.remove();
    };
    const dbErr = error => isMissingFn(error)
        ? 'This needs the database update. Run supabase/83_late_fee_collection.sql in the Supabase SQL Editor, then reload this page.'
        : error.message || 'Something went wrong. Try again.';
    md.showModal();
    md.querySelector('#lf-cancel').addEventListener('click', close);
    md.addEventListener('click', e => { if (e.target === md) close(); });
    okBtn.addEventListener('click', async () => {
        showErr('');
        if (collect && !collect.valid())
            return showErr(collect.method() === 'GCash' ? 'Enter the 13-digit GCash reference number.' : `The cash received is less than the late fee of ${money(owed)}.`);
        const method = collect ? collect.method() : 'GCash';
        const how = pendingRef ? `by GCash (reference ${pendingRef}). Only continue if you checked that the money was received` : `as paid (${method})`;
        if (!(await askConfirm({ title: 'Payment received?', message: `Record the late fee of ${money(owed)} for ${ref} ${how}.`, ok: 'Yes, payment received' })))
            return;
        btnBusy(okBtn, 'Saving…');
        const { error } = await sb.rpc('staff_collect_late_fee', {
            p_rental_ref: ref,
            p_method: method,
            p_reference: method === 'GCash' ? (pendingRef || collect.reference()) : null,
            p_tendered: method === 'Cash' ? collect.tendered() : null,
            p_expected: owed
        });
        if (error) {
            console.error(error);
            btnReset(okBtn);
            return showErr(dbErr(error));
        }
        // email the customer the fully paid receipt (a failed email never undoes the payment)
        const mail = await notifyLateFeePaid(ref);
        await refresh();
        close();
        toast(`Late fee of ${money(owed)} for ${ref} collected (${method}).` + mailNoteOf(mail));
    });
    if (rejBtn)
        rejBtn.addEventListener('click', async () => {
            const box = md.querySelector('#lf-reject');
            if (box.hidden) {
                box.hidden = false;
                md.querySelector('#lf-why').focus();
                rejBtn.textContent = 'Confirm rejection';
                return;
            }
            const why = md.querySelector('#lf-why').value.trim();
            if (!why)
                return showErr('Say why the payment is rejected. The customer will see it.');
            btnBusy(rejBtn, 'Saving…');
            const { error } = await sb.rpc('staff_reject_late_fee_payment', { p_rental_ref: ref, p_reason: why });
            if (error) {
                console.error(error);
                btnReset(rejBtn);
                return showErr(dbErr(error));
            }
            await refresh();
            close();
            toast('Payment rejected. The late fee is unpaid again.');
        });
}

/* ---- Return condition modal (outside rentals) ---- */
const CONDITIONS = ['No issue', 'Scratch', 'Damaged', 'Severely damaged', 'Others'];

/* Photo pop-up with its own dialog so it stacks on top of the return-condition window (closing it leaves that window open). */
let photoViewer = null;
function showPhotoViewer({ url, title }) {
    if (!photoViewer) {
        photoViewer = document.createElement('dialog');
        photoViewer.className = 'dlg';
        photoViewer.setAttribute('aria-label', 'Equipment photo');
        photoViewer.addEventListener('click', e => {
            if (e.target === photoViewer || e.target.closest('[data-close]'))
                photoViewer.close();
        });
        document.body.appendChild(photoViewer);
    }
    const u = esc(url);
    photoViewer.innerHTML = `<div class="in"><h2>${esc(title)}</h2>
      <img class="idfull" src="${u}" alt="${esc(title)}" decoding="async">
      <div class="acts"><a class="btn line" href="${u}" target="_blank" rel="noopener">Open in new tab</a>
      <button type="button" class="btn gold" data-close>Close</button></div></div>`;
    photoViewer.showModal();
}

function openReturnConditionModal({ ref, equipmentId = null }) {
    // Collect lines being returned
    const lines = RL.filter(l => l.rental_ref === ref && l.returned_at === null
        && (equipmentId === null || l.equipment_id === equipmentId));
    const g = groups().find(x => x.ref === ref);

    const md = document.createElement('dialog');
    md.className = 'dlg balance';
    md.setAttribute('role', 'dialog');
    md.setAttribute('aria-label', 'Record return condition');
    document.body.appendChild(md);

    const afterPicker = makePhotoPicker({ id: 'ret-after-photo', label: 'After-rental photo', required: true });

    // Each line gets a "View before photo" button (reference for comparing against the returned state).
    // The photo opens in a pop-up on top of this window; the signed URL is fetched on click so it never expires while the window is open.
    const linesHtml = lines.map(l =>
        `<div class="insp-line ret-line">
          <div class="ret-line-info"><b>${esc(l.equipment_name)}</b> x${l.quantity}</div>
          ${l.before_photo_path
            ? `<button type="button" class="btn sm line" data-view-before="${l.rental_detail_id}">View before photo</button>`
            : '<span class="mut ret-nophoto">No before photo on record</span>'}
        </div>`
    ).join('');

    md.innerHTML = `<div class="in">
      <h2 style="margin:0 0 4px">Record return condition</h2>
      <p class="mut" style="margin:0 0 10px">${esc(ref)}${g ? ' — ' + esc(g.customer) : ''}</p>
      <div style="margin-bottom:10px">${linesHtml}</div>
      <label for="ret-cond">Condition <span class="req" aria-hidden="true">*</span></label>
      <select id="ret-cond">
        ${CONDITIONS.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}
      </select>
      <label for="ret-desc">Description <span class="mut">(optional)</span></label>
      <textarea id="ret-desc" rows="3" style="width:100%;resize:vertical" placeholder="Notes about the condition…"></textarea>
      <div id="ret-dmg" hidden>
        <h3 style="font-size:14px;margin:14px 0 4px">Damage fee</h3>
        <p class="mut" style="margin:0 0 8px;font-size:13px">Money the customer owes for this damage. Leave it at 0 to waive it (a small scratch, for example). The return does not wait for payment: unpaid fees are saved as <b>Unpaid</b>. The customer sees the amount, your reason and the photos.</p>
        ${lines.map(l => `<div class="dc-line" data-dline="${l.rental_detail_id}">
          <b>${esc(l.equipment_name)} x${l.quantity}</b>
          <label>Damage fee</label>
          <div class="money-in"><span aria-hidden="true">&#8369;</span><input type="text" data-damt inputmode="decimal" autocomplete="off" placeholder="0.00" aria-label="Damage fee for ${esc(l.equipment_name)}"></div>
          <p class="dc-warn" data-dwarn hidden></p>
          <label>Reason for the fee <span class="req" data-dreq hidden aria-hidden="true">*</span> <span class="mut" data-dopt>(required when the fee is above 0)</span></label>
          <textarea data-dreason rows="2" style="width:100%;resize:vertical" placeholder="For example: cracked body, two keys missing"></textarea>
          <label class="terms" style="margin-top:10px"><input type="checkbox" data-dstock><span><b>Remove from stock</b><br><span class="mut">The item cannot be rented again right now. Leave this off to put it back in stock.</span></span></label>
          <div data-dstockopts hidden style="margin-top:8px">
            <label>What happens to it?</label>
            <select data-dstockmode aria-label="What happens to ${esc(l.equipment_name)}">
              <option value="service">Out of service: it will be repaired (lower Out of service in Equipment when it is)</option>
              <option value="remove">Remove permanently: written off, Total owned goes down</option>
            </select>
            <div data-dstockqty hidden style="margin-top:8px">
              <label>How many <span class="mut">(of ${l.quantity} returned)</span></label>
              <input type="number" data-dstockn min="1" max="${l.quantity}" step="1" value="${l.quantity}" inputmode="numeric" style="max-width:110px" aria-label="Quantity of ${esc(l.equipment_name)} to take out of stock">
            </div>
            <div class="alert warn" data-dshort role="status" hidden style="margin-top:8px"></div>
          </div>
        </div>`).join('')}
        <div class="dr-sum"><div class="tot-line"><b>Damage fee total</b><b id="ret-dmg-tot">${money(0)}</b></div></div>
      </div>
      <div id="ret-late" hidden>
        <h3 style="font-size:14px;margin:14px 0 4px">Late fee</h3>
        <p class="mut" style="margin:0 0 8px;font-size:13px">Worked out for you: price / 8 per hour, per item, from the end of the rental window. A started hour counts as a full hour.</p>
        <div class="dr-sum" id="ret-late-lines"></div>
      </div>
      <div id="ret-pay" hidden>
        <h3 style="font-size:14px;margin:14px 0 4px">Amount to collect</h3>
        <div class="dr-sum" id="ret-pay-sum"></div>
        <div id="ret-collect">${collectBox({ later: true, label: 'The customer pays by' })}</div>
        <div class="alert warn" id="ret-defer" role="status" hidden></div>
      </div>
      <div id="ret-after-wrap" style="margin-top:10px"></div>
      <div id="ret-cond-note" class="alert" style="margin-top:8px" hidden></div>
      <div class="alert" id="ret-err" role="alert" hidden></div>
      <div class="acts" style="margin-top:14px">
        <button type="button" class="btn line" id="ret-cancel">Cancel</button>
        <button type="button" class="btn gold" id="ret-ok">Confirm return</button>
      </div>
    </div>`;

    const afterWrap = md.querySelector('#ret-after-wrap');
    afterWrap.appendChild(afterPicker.el);

    const condSel  = md.querySelector('#ret-cond');
    const noteBox  = md.querySelector('#ret-cond-note');
    const errBox   = md.querySelector('#ret-err');
    const okBtn    = md.querySelector('#ret-ok');

    const dmgBox = md.querySelector('#ret-dmg');
    const lineEls = [...md.querySelectorAll('[data-dline]')];
    const lineOf = el => lines.find(l => String(l.rental_detail_id) === el.dataset.dline);
    const amtOf = el => {
        const v = el.querySelector('[data-damt]').value.replace(/,/g, '');
        return v === '' || v === '.' ? 0 : Math.round(Number(v) * 100) / 100;
    };
    const lineValue = l => num(l.unit_price_at_request) * l.quantity * Math.max(8, Math.ceil(num(l.rental_hours) || 8)) / 8;
    // a fee this high is probably a typo (5000 instead of 500): warn, never block
    const highAt = l => Math.max(1000, Math.min(5000, lineValue(l) * 10));
    const dmgTotal = () => lineEls.reduce((n, el) => n + amtOf(el), 0);
    // stock to take out for a line: 0 when the box is not ticked
    const stockOf = el => {
        if (!el.querySelector('[data-dstock]').checked)
            return 0;
        const l = lineOf(el), v = Math.floor(Number(el.querySelector('[data-dstockn]').value));
        return Number.isFinite(v) ? Math.min(Math.max(v, 0), l.quantity) : 0;
    };
    const modeOf = el => el.querySelector('[data-dstockmode]').value === 'remove' ? 'remove' : 'service';

    /* Which upcoming rentals would be short if these units are taken out? (62_stock_preview.sql)
       Each Pending / Verified one gets a Swap item button, so staff can fix it right here before confirming. */
    async function checkShort(el) {
        const box = el.querySelector('[data-dshort]'), l = lineOf(el), n = stockOf(el), mine = (el._shortSeq = (el._shortSeq || 0) + 1);
        box.hidden = true;
        if (n < 1 || !l.equipment_id)
            return;
        let rows = [];
        try {
            const { data, error } = await sb.rpc('equipment_stock_preview', { p_equipment_id: l.equipment_id, p_remove: n, p_exclude_ref: ref });
            if (error || mine !== el._shortSeq)
                return;   // not run yet (needs 62_stock_preview.sql) or an older answer: say nothing
            rows = data || [];
        } catch (e) {
            return;
        }
        if (!rows.length) {
            box.className = 'alert';
            box.innerHTML = `No upcoming rental is affected: enough ${esc(l.equipment_name)} is left for every booking.`;
            box.hidden = false;
            return;
        }
        const r0 = rows[0];
        box.className = 'alert warn';
        box.innerHTML = `<b>Heads up:</b> taking out ${n} x ${esc(l.equipment_name)} leaves ${r0.rentable} to rent, but these upcoming rentals need up to ${r0.rentable + r0.short_by} at the same time (short by ${r0.short_by}). `
            + 'Keep the earliest bookings and replace the later ones with an equivalent item: Let customer choose (you offer, the customer picks) or Swap item (you pick). No extra charge, no refund. You can also confirm the return first and do this afterwards.'
            + `<ul class="eq-short-list">${rows.map(r => `<li><b>${esc(r.rental_ref)}</b> ${esc(r.customer_name || '')} <span class="mut">${esc(r.order_status)}, ${esc(stampLabel(r.w_start))}${r.w_end ? ' to ' + esc(stampLabel(r.w_end)) : ''}, x${r.quantity}${r.booked_at ? ', booked ' + esc(stampLabel(r.booked_at)) : ''}</span>`
                + (r.rental_detail_id && ['Pending', 'Approved'].includes(r.order_status) ? swapActions(r.rental_ref, r.rental_detail_id, r.order_status) : ' <span class="mut">(already issued: cannot be swapped)</span>')
                + '</li>').join('')}</ul>`;
        box.hidden = false;
    }
    lineEls.forEach(el => {
        const box = el.querySelector('[data-dstock]'), opts = el.querySelector('[data-dstockopts]'), qty = el.querySelector('[data-dstockqty]');
        // ticked: choose out of service / remove permanently; more than one item: also choose how many
        box.addEventListener('change', () => {
            opts.hidden = !box.checked;
            qty.hidden = !box.checked || lineOf(el).quantity < 2;
            if (box.checked)
                el.querySelector('[data-dstockmode]').focus();
            checkShort(el);
        });
        el.querySelector('[data-dstockn]').addEventListener('input', () => checkShort(el));
    });
    // after a swap (from the list above) the list is worked out again
    const onSwapped = () => {
        if (!md.isConnected)
            return document.removeEventListener('tod:swapped', onSwapped);
        lineEls.forEach(checkShort);
    };
    document.addEventListener('tod:swapped', onSwapped);
    /* what the customer has to pay now: the late fee (worked out here) + the damage fee (typed by staff, only when there is an issue) */
    /* The late fee comes from the DATABASE (staff_late_fee_preview, 88_late_fee_preview.sql): it is the same calculation that charges the
       fee when the return is saved, so this window can never show less (or more) than will be charged. Until the answer arrives, or
       when 88 has not been run yet, the page's own estimate (lateNow) is shown. */
    let dbLate = null;   // { hours, due } from the database
    const lateOf = l => {
        if (!dbLate)
            return lateNow(l);
        return dbLate.hours > 0
            ? { hours: dbLate.hours, fee: Math.round(num(l.unit_price_at_request) * l.quantity / 8 * dbLate.hours * 100) / 100 }
            : { hours: 0, fee: 0 };
    };
    const askLate = async () => {
        try {
            const { data, error } = await sb.rpc('staff_late_fee_preview', { p_rental_ref: ref, p_equipment_id: equipmentId });
            const row = Array.isArray(data) ? data[0] : data;
            if (!error && row)
                dbLate = { hours: Number(row.hours) || 0, due: row.due_at };
        } catch (e) {
            /* needs 88_late_fee_preview.sql: keep the estimate */
        }
    };
    let latePromise = askLate().then(() => {
        if (!md.isConnected)
            return;
        if (lateTotal() > 0 && !collect.method())
            collectEl.querySelector('[data-dc="m"]').value = 'Cash';   // same start as when the estimate already showed a fee
        paintFees();
    });
    const lateTotal = () => Math.round(lines.reduce((n, l) => n + lateOf(l).fee, 0) * 100) / 100;
    const dmgNow = () => condSel.value === 'No issue' ? 0 : Math.round(dmgTotal() * 100) / 100;
    const grandTotal = () => Math.round((lateTotal() + dmgNow()) * 100) / 100;
    const collectEl = md.querySelector('#ret-collect');
    // with a late fee the form starts on Cash (the usual case), so leaving it unpaid is a deliberate choice: "Not now" is still there
    if (lateTotal() > 0)
        collectEl.querySelector('[data-dc="m"]').value = 'Cash';
    const collect = bindCollect(collectEl, grandTotal, () => {});
    // "Not now" with a late fee: say clearly that it is saved as unpaid and where to collect it later
    const deferBox = md.querySelector('#ret-defer');
    function paintDefer() {
        const late = lateTotal(), dmg = dmgNow(), show = late > 0 && !collect.method();
        deferBox.hidden = !show;
        if (show)
            deferBox.innerHTML = `<b>The late fee of ${money(late)}${dmg > 0 ? ' and the damage fee' : ''} will be saved as unpaid.</b> The rental shows <b>Late fee unpaid</b> in the list until you collect it with Actions &gt; Collect late fee.`;
    }
    collectEl.querySelector('[data-dc="m"]').addEventListener('change', paintDefer);
    function paintFees() {
        const late = lateTotal(), dmg = dmgNow(), grand = grandTotal();
        const lateLines = lines.filter(l => lateOf(l).hours > 0);
        md.querySelector('#ret-late').hidden = !(late > 0);
        // one item: its hours only (the amount is the "Late fee" line below); several items: each item's amount too
        md.querySelector('#ret-late-lines').innerHTML = lateLines.map(l => {
            const x = lateOf(l);
            return `<div><span>${esc(l.equipment_name)} x${l.quantity}<span class="mut" style="display:block">${pl(x.hours, 'hour')} late, since ${esc(stampLabel((dbLate && dbLate.due) || l.due_at))}</span></span>${lateLines.length > 1 ? `<span>${money(x.fee)}</span>` : ''}</div>`;
        }).join('') + `<div class="tot-line"><b>Late fee</b><b>${money(late)}</b></div>`;
        // the total is only repeated when a damage fee is added to the late fee; otherwise the amount is in the payment label
        md.querySelector('#ret-pay').hidden = !(grand > 0);
        md.querySelector('#ret-pay-sum').innerHTML = late > 0 && dmg > 0 ? `<div class="tot-line"><b>Total to collect (late fee + damage fee)</b><b>${money(grand)}</b></div>` : '';
        md.querySelector('#ret-pay-sum').hidden = !(late > 0 && dmg > 0);
        const label = collectEl.querySelector('label');
        if (label)
            label.textContent = `The customer pays ${money(grand)} by`;
        collect.sync();
        paintDefer();
    }
    // the late fee grows by the hour: keep the window up to date while it is open
    const feeTimer = setInterval(async () => {
        if (!md.isConnected)
            return clearInterval(feeTimer);
        await askLate();
        paintFees();
    }, 30000);
    function syncDamage() {
        const total = dmgTotal();
        lineEls.forEach(el => {
            const l = lineOf(el), a = amtOf(el), warn = el.querySelector('[data-dwarn]');
            el.querySelector('[data-dreq]').hidden = !(a > 0);
            el.querySelector('[data-dopt]').hidden = a > 0;
            warn.hidden = !(a > highAt(l));
            warn.textContent = `That is high for ${l.equipment_name} (its rental value is ${money(lineValue(l))}). Check that you did not type an extra zero.`;
        });
        md.querySelector('#ret-dmg-tot').textContent = money(total);
        paintFees();
    }
    lineEls.forEach(el => el.querySelector('[data-damt]').addEventListener('input', e => {
        let v = e.target.value.replace(/[^\d.]/g, '');
        const dot = v.indexOf('.');
        v = dot >= 0 ? v.slice(0, dot).slice(0, 7) + '.' + v.slice(dot + 1).replace(/\./g, '').slice(0, 2) : v.slice(0, 7);
        if (v !== e.target.value)
            e.target.value = v;
        syncDamage();
    }));

    function onCondChange() {
        const noIssue = condSel.value === 'No issue';
        dmgBox.hidden = noIssue;
        afterPicker.disable(noIssue);
        if (noIssue) {
            afterPicker.reset();
            noteBox.textContent = 'No after-photo needed when there is no issue.';
            noteBox.hidden = false;
        } else {
            noteBox.hidden = true;
        }
    }
    condSel.addEventListener('change', () => {
        onCondChange();
        paintFees();
    });
    onCondChange();
    paintFees();

    document.body.appendChild(md);
    md.showModal();

    md.querySelectorAll('[data-view-before]').forEach(btn => btn.addEventListener('click', async () => {
        const line = lines.find(l => String(l.rental_detail_id) === btn.dataset.viewBefore);
        if (!line) return;
        btn.disabled = true;
        const url = await signedPhotoUrl(line.before_photo_path);
        btn.disabled = false;
        if (!url) return toast('The before photo could not be loaded. Try again.');
        showPhotoViewer({ url, title: `Before photo: ${line.equipment_name}` });
    }));

    function showErr(msg) {
        errBox.textContent = msg;
        errBox.hidden = !msg;
    }

    md.querySelector('#ret-cancel').addEventListener('click', () => {
        md.close();
        md.remove();
    });
    md.addEventListener('click', e => { if (e.target === md) { md.close(); md.remove(); } });

    okBtn.addEventListener('click', async () => {
        showErr('');
        await latePromise;   // the late fee shown must be the database's figure before anything is sent
        const cond   = condSel.value;
        const desc   = md.querySelector('#ret-desc').value.trim();
        const file   = afterPicker.getFile();

        if (cond !== 'No issue' && !file)
            return showErr(`An after-photo is required for condition "${cond}".`);
        if (file) {
            const verr = validatePhoto(file);
            if (verr) return showErr(verr);
        }

        // damage fee checks (before anything is uploaded or saved)
        const outOfService = [], removedPerm = [];
        if (cond !== 'No issue') {
            const bad = lineEls.find(el => amtOf(el) > 0 && !el.querySelector('[data-dreason]').value.trim());
            if (bad)
                return showErr(`Describe the damage for ${lineOf(bad).equipment_name}: a reason is required when the damage fee is above 0.`);
            const badQty = lineEls.find(el => el.querySelector('[data-dstock]').checked && stockOf(el) < 1);
            if (badQty)
                return showErr(`Enter how many ${lineOf(badQty).equipment_name} to remove from stock (1 to ${lineOf(badQty).quantity}).`);
            lineEls.filter(el => stockOf(el) > 0).forEach(el => (modeOf(el) === 'remove' ? removedPerm : outOfService).push(`${stockOf(el)} x ${lineOf(el).equipment_name}`));
        }
        // the payment: late fee + damage fee, one payment
        const lateSum = lateTotal(), dmgSum = dmgNow(), grandSum = grandTotal();
        if (grandSum > 0 && !collect.valid())
            return showErr(collect.method() === 'GCash' ? 'Enter the 13-digit GCash reference number.' : `The cash received is less than the amount to collect of ${money(grandSum)}.`);
        const removed = [...outOfService, ...removedPerm];
        if (grandSum > 0 || removed.length) {
            const named = lineEls.filter(el => cond !== 'No issue' && amtOf(el) > 0).map(el => `${lineOf(el).equipment_name} x${lineOf(el).quantity}`).join(', ');
            const high = cond === 'No issue' ? [] : lineEls.filter(el => amtOf(el) > highAt(lineOf(el))).map(el => lineOf(el).equipment_name);
            const how = collect.method() ? `It will be recorded as paid (${collect.method()}).`
                : `${lateSum > 0 && dmgSum > 0 ? 'Both fees' : lateSum > 0 ? 'The late fee' : 'The damage fee'} will be saved as unpaid; ${lateSum > 0 ? 'collect it later from Actions' : 'the customer can pay later'}.`;
            const stockMsg = (outOfService.length ? ` ${outOfService.join(', ')} will be marked out of service and cannot be rented until you lower Out of service in Equipment.` : '')
                + (removedPerm.length ? ` ${removedPerm.join(', ')} will be removed from stock permanently (Total owned in Equipment goes down).` : '');
            const parts = [lateSum > 0 ? `late fee ${money(lateSum)}` : '', dmgSum > 0 ? `damage fee ${money(dmgSum)} for ${named}` : ''].filter(Boolean).join(' + ');
            const yes = await askConfirm({
                title: grandSum > 0 ? (collect.method() ? 'Collect the fees and confirm the return?' : 'Confirm the return with unpaid fees?') : 'Take items out of stock?',
                message: (grandSum > 0 ? `${collect.method() ? 'Collect' : 'Not collected now:'} ${money(grandSum)} ${collect.method() ? 'from' : 'owed by'} ${g ? g.customer : 'the customer'}: ${parts}. ${how}` + (high.length ? ` Warning: the damage fee for ${high.join(', ')} is unusually high. Check it.` : '') : 'No fee will be charged.') + stockMsg,
                ok: 'Yes, confirm return'
            });
            if (!yes)
                return;
        }

        btnBusy(okBtn, 'Saving…');

        try {
            // Upload after photo if needed
            let afterPath = null;
            if (file) {
                // We may be returning multiple lines; upload once per line targeted
                // Use first line's detail id as path namespace key
                const firstLine = lines[0];
                afterPath = await uploadInspectionPhoto(firstLine.rental_detail_id, 'after', file);
                // For multi-line returns (all lines share same condition), replicate path per line
                if (lines.length > 1) {
                    for (let i = 1; i < lines.length; i++) {
                        const lp = await uploadInspectionPhoto(lines[i].rental_detail_id, 'after', file);
                        // Each line gets its own storage object; afterPath just needs to match first
                        void lp;
                    }
                }
            }

            const charges = cond === 'No issue' ? [] : lineEls.map(el => ({
                rental_detail_id: +el.dataset.dline,
                amount: amtOf(el),
                reason: el.querySelector('[data-dreason]').value.trim() || null
            }));
            const total = charges.reduce((n, c) => n + c.amount, 0);   // damage fee
            const late = lateTotal();                                    // late fee, as shown in the window
            const method = total + late > 0 ? collect.method() : null;

            const rpcArgs = {
                p_rental_ref       : ref,
                p_equipment_id     : equipmentId,
                p_condition        : cond,
                p_description      : desc || null,
                p_after_photo_path : afterPath,
                p_charges          : charges,
                p_method           : method,
                p_reference        : method === 'GCash' ? collect.reference() : null,
                p_tendered         : method === 'Cash' ? collect.tendered() : null,
                p_late_expected    : late
            };
            // only sent when something is taken out, so a return without it still works before 60_out_of_service_stock.sql is run
            const stockChanges = cond === 'No issue' ? [] : lineEls.filter(el => stockOf(el) > 0).map(el => ({ rental_detail_id: +el.dataset.dline, qty: stockOf(el), mode: modeOf(el) }));
            if (stockChanges.length)
                rpcArgs.p_stock_changes = stockChanges;

            let { data: result, error: rpcError } = await sb.rpc('staff_return_rental_with_fees', rpcArgs);
            const missing = e => e && (e.code === 'PGRST202' || /schema cache|could not find/i.test(e.message || ''));
            if (missing(rpcError) && late <= 0) {   // 83_late_fee_collection.sql is not run yet: a return with no late fee works the old way
                delete rpcArgs.p_late_expected;
                ({ data: result, error: rpcError } = await sb.rpc('staff_return_rental_with_damage', rpcArgs));
            }
            if (missing(rpcError) && late > 0) {
                showErr('Collecting the late fee needs the database update. Run supabase/83_late_fee_collection.sql in the Supabase SQL Editor, then reload this page.');
                btnReset(okBtn);
                return;
            }
            if (rpcError && cond === 'No issue' && (rpcError.code === 'PGRST202' || /schema cache|could not find/i.test(rpcError.message || ''))) {
                // 58_damage_charges.sql is not run yet: a return with no damage still works the old way
                ({ error: rpcError } = await sb.rpc('staff_return_rental_with_condition', {
                    p_rental_ref: ref, p_equipment_id: equipmentId, p_condition: cond, p_description: desc || null, p_after_photo_path: null
                }));
                result = null;
            }
            if (rpcError) {
                console.error(rpcError);
                showErr(stockChanges.length && (rpcError.code === 'PGRST202' || /schema cache|could not find/i.test(rpcError.message || ''))
                    ? 'Taking items out of stock needs the database update. Run supabase/60_out_of_service_stock.sql in the Supabase SQL Editor, then reload this page.'
                    : dmgError(rpcError));
                btnReset(okBtn);
                return;
            }
            const row = Array.isArray(result) ? result[0] : result;
            const unpaid = row ? num(row.unpaid_total) : 0;
            // a damage fee collected right at the return: email the customer the fully paid receipt (a failed email never undoes the return)
            const mail = method && total - unpaid > 0.005 ? await notifyDamagePaid(ref) : null;
            // a late fee collected right at the return: its own fully paid receipt
            const mailLate = method && late > 0 ? await notifyLateFeePaid(ref) : null;
            const lateNote = mailLate && mailLate !== mail ? mailNoteOf(mailLate) : '';

            await btnSuccess(okBtn, 'Saved', { keep: true });
            await loadCatalog();
            await refresh();
            md.close();
            md.remove();
            closeOverlays();
            const qtyOf = mode => stockChanges.filter(r => r.mode === mode).reduce((n, r) => n + r.qty, 0);
            toast((late > 0 ? `${equipmentId ? 'Item' : ref} returned late. ` + (method ? `Late fee of ${money(late)} collected (${method}).${total - unpaid > 0.005 ? '' : lateNote}` : `Late fee of ${money(late)} saved as unpaid. Collect it later with Actions > Collect late fee.`) : returnedMsg(ref, equipmentId, equipmentId ? 'Item' : ref))
                + (total > 0 ? (unpaid > 0 ? ` Damage fee of ${money(unpaid)} saved as unpaid.` : ` Damage fee of ${money(total)} collected.` + mailNoteOf(mail)) : '')
                + (qtyOf('service') ? ` ${qtyOf('service')} marked out of service.` : '')
                + (qtyOf('remove') ? ` ${qtyOf('remove')} removed from stock.` : ''));
            // the return is always saved; if other customers are now short of the item, list them so staff can act
            if (stockChanges.length && row && num(row.shortage_count) > 0)
                await showStockShortage(stockChanges.map(r => lines.find(l => l.rental_detail_id === r.rental_detail_id)?.equipment_id).filter(Boolean));
        } catch (err) {
            showErr(err.message || 'Upload failed. Try again.');
            btnReset(okBtn);
        }
    });
}

/* ---------------- Swap item ----------------
   Replace an item on a rental that has not been issued yet (for example, the booked unit is damaged and another customer
   already reserved the last one). The customer gets an equivalent item for the same hours and keeps the price they agreed to:
   nothing extra is charged and nothing is refunded. Needs supabase/61_swap_rental_item.sql. */
const swapDbMsg = 'Swapping items needs the database update. Run supabase/61_swap_rental_item.sql in the Supabase SQL Editor, then reload this page.';
const isMissingFn = e => e && (e.code === 'PGRST202' || /schema cache|could not find/i.test(e.message || ''));

function openSwapModal(ref, detailId) {
    const g = groups().find(x => x.ref === ref);
    const lines = g ? g.lines.filter(l => !l.line_returned_at) : [];
    if (!g || !lines.length)
        return toast('That rental could not be found.');
    if (!canSwap(g))
        return toast('Only a rental that has not been issued yet can have an item swapped.');
    const first = lines.find(l => l.rental_detail_id === detailId) || lines[0];

    const md = document.createElement('dialog');
    md.className = 'dlg balance';
    md.setAttribute('role', 'dialog');
    md.setAttribute('aria-label', 'Swap item');
    md.innerHTML = `<div class="in">
      <h2 style="margin:0 0 4px">Swap item</h2>
      <p class="mut" style="margin:0 0 10px">${esc(ref)} — ${esc(g.customer)}</p>
      <p class="mut" style="margin:0 0 10px;font-size:13px">Use this when an item cannot be given as booked, for example because it was damaged. The customer gets a replacement for the same hours and keeps the price they agreed to: <b>nothing extra is charged and nothing is refunded</b>.</p>
      <label for="sw-line">Item to replace</label>
      <select id="sw-line">${lines.map(l => `<option value="${l.rental_detail_id}" ${l === first ? 'selected' : ''}>${esc(l.equipment_name)} x${l.quantity}</option>`).join('')}</select>
      <div class="so-curcat" id="sw-curcat" hidden></div>
      <label for="sw-new">Replace it with</label>
      <div id="sw-new" class="so-opts so-opts-tall" role="radiogroup" aria-label="Replacement item"><p class="mut">Loading…</p></div>
      <div class="so-curcat" id="sw-newcat" hidden></div>
      <p class="mut" id="sw-note" style="margin:6px 0 0;font-size:13px"></p>
      <label for="sw-why">Reason <span class="req" aria-hidden="true">*</span></label>
      <textarea id="sw-why" rows="2" style="width:100%;resize:vertical" placeholder="For example: the booked unit was damaged and is being repaired"></textarea>
      <div class="alert" id="sw-err" role="alert" hidden></div>
      <div class="acts" style="margin-top:14px">
        <button type="button" class="btn line" id="sw-cancel">Cancel</button>
        <button type="button" class="btn gold" id="sw-ok" disabled>Swap item</button>
      </div>
    </div>`;
    document.body.appendChild(md);

    const lineSel = md.querySelector('#sw-line'), newSel = md.querySelector('#sw-new'), note = md.querySelector('#sw-note');
    const errBox = md.querySelector('#sw-err'), okBtn = md.querySelector('#sw-ok');
    const showErr = m => {
        errBox.textContent = m;
        errBox.hidden = !m;
    };
    const lineNow = () => lines.find(l => String(l.rental_detail_id) === lineSel.value);
    let options = [], seq = 0;
    const selVal = () => (newSel.querySelector('input:checked') || {}).value;   // id of the replacement the staff ticked

    // category of the item being replaced (rental lines carry none, so read it from the stock view)
    const cats = {};
    const curCat = md.querySelector('#sw-curcat'), newCat = md.querySelector('#sw-newcat');
    const pill = (box, c) => {
        box.hidden = !c;
        box.innerHTML = c ? `<span class="so-cat">${esc(c)}</span>` : '';
    };
    const showCurCat = () => {
        const l = lineNow();
        pill(curCat, l && cats[l.equipment_id]);
    };
    lineSel.addEventListener('change', showCurCat);
    (async () => {
        try {
            const r = await sb.from('v_equipment_stock').select('equipment_id, category_name').in('equipment_id', [...new Set(lines.map(l => l.equipment_id))]);
            (r.data || []).forEach(x => { cats[x.equipment_id] = x.category_name; });
            [...lineSel.options].forEach(op => {
                const l = lines.find(x => String(x.rental_detail_id) === op.value), c = l && cats[l.equipment_id];
                if (c)
                    op.textContent += ' \u2014 ' + c;
            });
            showCurCat();
        } catch (e) { console.error(e); }
    })();

    const syncNote = () => {
        const l = lineNow(), o = options.find(x => String(x.equipment_id) === selVal());
        pill(newCat, o && o.category_name);
        note.textContent = !l || !o ? '' : `${l.quantity} x ${o.name} replaces ${l.equipment_name}. The customer still pays ${money(num(l.unit_price_at_request))} per unit for this line`
            + (num(o.rate) > num(l.unit_price_at_request) + 0.005 ? ` (this item normally costs ${money(num(o.rate))}; the difference is yours to absorb).` : '.');
    };

    async function loadOptions() {
        const mine = ++seq;
        okBtn.disabled = true;
        newSel.innerHTML = '<p class="mut">Loading…</p>';
        note.textContent = '';
        showErr('');
        const { data, error } = await sb.rpc('staff_swap_options', { p_rental_detail_id: +lineSel.value });
        if (mine !== seq)
            return;
        if (error) {
            console.error(error);
            newSel.innerHTML = '<p class="mut">Could not load.</p>';
            return showErr(isMissingFn(error) ? swapDbMsg : error.message);
        }
        options = data || [];
        if (!options.length) {
            newSel.innerHTML = '<p class="mut">No other item is free for these hours.</p>';
            pill(newCat, '');
            note.textContent = 'Nothing else can be offered for the hours of this rental. Try moving the rental to another date, or put a unit back in service in Equipment.';
            return;
        }
        const imgs = await equipmentImages(options.map(o => o.equipment_id));
        if (mine !== seq)
            return;
        // pictures, grouped by category (the category of the item being replaced first); the first item is ticked to start with
        const card = (o, i0) => `<label class="so-opt"><input type="radio" name="sw-pick" value="${o.equipment_id}"${i0 ? ' checked' : ''}> ${picHtml(o, imgs)}<span class="so-name">${esc(o.name)} <span class="mut">(${o.free} free)</span></span></label>`;
        let first = true;
        newSel.innerHTML = groupByCategory(options).map(gr => groupHeading(gr) + gr.list.map(o => {
            const h = card(o, first);
            first = false;
            return h;
        }).join('')).join('');
        okBtn.disabled = false;
        syncNote();
    }
    lineSel.addEventListener('change', loadOptions);
    newSel.addEventListener('change', syncNote);
    loadOptions();

    md.querySelector('#sw-cancel').addEventListener('click', () => {
        md.close();
        md.remove();
    });
    md.addEventListener('click', e => {
        if (e.target === md) {
            md.close();
            md.remove();
        }
    });

    okBtn.addEventListener('click', async () => {
        showErr('');
        const l = lineNow(), o = options.find(x => String(x.equipment_id) === selVal()), why = md.querySelector('#sw-why').value.trim();
        if (!l || !o)
            return showErr('Choose the item to swap in.');
        if (!why)
            return showErr('Enter a reason for the swap.');
        const yes = await askConfirm({
            title: 'Swap this item?',
            message: `${l.quantity} x ${l.equipment_name} in ${rnWho(ref)} will be replaced by ${o.name}. The customer pays and is refunded nothing extra.`,
            ok: 'Yes, swap item'
        });
        if (!yes)
            return;
        btnBusy(okBtn, 'Swapping…');
        const { error } = await sb.rpc('staff_swap_rental_item', { p_rental_detail_id: l.rental_detail_id, p_new_equipment_id: o.equipment_id, p_reason: why });
        if (error) {
            console.error(error);
            showErr(isMissingFn(error) ? swapDbMsg : error.message);
            btnReset(okBtn);
            return;
        }
        await btnSuccess(okBtn, 'Swapped', { keep: true });
        await loadCatalog();
        await refresh();
        md.close();
        md.remove();
        closeOverlays();
        document.dispatchEvent(new Event('tod:swapped'));
        const mail = await notifyReplacement('swap', l.rental_detail_id);   // the customer is emailed the new item and its price
        toast(`${ref}: ${l.equipment_name} swapped for ${o.name}. No extra charge.`
            + (mail === 'sent' ? ' Email sent.' : mail === 'noemail' ? ' No email on file, so no email was sent.' : ' The email could not be sent.'));
    });

    md.showModal();
}

// id = "REF" (from the Actions menu) or "REF:rental_detail_id" (from the shortage warning in Equipment)
// Replace item: the required-action pop-up (Let customer choose / Swap item), the same one shown after a damaged return
ACT['rn-fix'] = async ref => {
    const g = groups().find(x => x.ref === ref);
    if (!g)
        return;
    const ids = g.lines.filter(l => !l.line_returned_at).map(l => l.equipment_id).filter(Boolean);
    if (!(await showStockShortage(ids)))
        openSwapModal(ref, null);   // the item is no longer short (stock came back): plain Swap item
};

ACT['rn-swap'] = id => {
    const [ref, did] = String(id).split(':');
    openSwapModal(ref, did ? +did : null);
};

ACT['rn-ret'] = async ref => {
    const g = groups().find(x => x.ref === ref);
    if (g && g.type === 'Outside') {
        openReturnConditionModal({ ref, equipmentId: null });
        return;
    }
    // Add-on / onsite: original path
    if (!(await run(sb.rpc('staff_return_rental', { p_rental_ref: ref, p_equipment_id: null }))))
        return;
    await loadCatalog();
    await refresh();
    closeOverlays();
    toast(returnedMsg(ref, null, ref));
};

ACT['rn-retline'] = async id => {
    const [ref, eid] = id.split(':');
    const g = groups().find(x => x.ref === ref);
    if (g && g.type === 'Outside') {
        openReturnConditionModal({ ref, equipmentId: +eid });
        return;
    }
    // Add-on / onsite: original path
    if (!(await run(sb.rpc('staff_return_rental', { p_rental_ref: ref, p_equipment_id: +eid }))))
        return;
    await loadCatalog();
    await refresh();
    closeOverlays();
    toast(returnedMsg(ref, +eid, 'Item'));
};

ACT['rn-reject-go'] = ref => {
    let reason = $('#rrs').value;
    if (reason === 'Other')
        reason = $('#rrs-other').value.trim() || 'Other';
    return setRental(ref, 'Rejected', reason);
};

/* The customer's ID photo is stored in the private rental-ids bucket; only staff can open it.
   A temporary link (10 minutes) is made each time the dialog opens. */
export async function loadRentalId(ref, boxId = 'rn-id', asButton = false) {
    const box = $('#' + boxId);
    if (!box)
        return;
    const { data: o, error } = await sb.from('rental_order')
        .select('id_type, id_image_path, contact_number, backup_contact, source').eq('rental_ref', ref).maybeSingle();
    if (error || !o) {
        box.innerHTML = '<p class="mut">Could not load the ID details.</p>';
        return;
    }
    const meta = `<dl class="dl"><dt>ID type</dt><dd>${esc(o.id_type || 'Not recorded')}</dd><dt>Contact</dt><dd>${esc(o.contact_number || '-')}</dd>` +
        (o.backup_contact ? `<dt>Backup contact</dt><dd>${esc(o.backup_contact)}</dd>` : '')
        + '</dl>';
    if (!o.id_image_path) {
        box.innerHTML = meta
            + `<p class="mut">${o.source === 'Onsite' ? 'The ID was checked in person at the studio.' : 'No ID photo was attached.'}</p>`;
        return;
    }
    const { data: s, error: e2 } = await sb.storage.from('rental-ids').createSignedUrl(o.id_image_path, 600);
    if (e2 || !s) {
        box.innerHTML = meta + `<p class="mut">Could not open the ID file${e2 ? ': ' + esc(e2.message) : ''}.</p>`;
        return;
    }
    box.innerHTML = meta
        + (/\.pdf$/i.test(o.id_image_path)
            ? `<a class="btn line sm" href="${s.signedUrl}" target="_blank" rel="noopener">Open ID (PDF)</a>`
            : asButton
                ? `<button type="button" class="btn sm line" data-view-photo="${esc(s.signedUrl)}" data-title="Customer ID photo">View ID photo</button>`   // the Details window hides the picture behind a button
                : `<a href="${s.signedUrl}" target="_blank" rel="noopener" title="Open full size"><img class="idimg" src="${s.signedUrl}" alt="Customer ID photo" loading="lazy" decoding="async"></a><p class="mut">Click the photo to open it full size.</p>`);
}

/* =====================================================================
   Before-photo upload: shown in the Issue window (balance.js) of an outside rental. Staff must attach a before photo per line before
   the Issue button is enabled by the backend trigger.
   ===================================================================== */

/* Build the before-photo upload section for every unreturned line of an outside rental.
   Returns HTML string; binds events after inserting into the DOM. */
export async function renderBeforePhotoSection(ref, container) {
    const lines = RL.filter(l => l.rental_ref === ref && l.rental_type === 'Outside' && l.line_returned_at === null);
    if (!lines.length) {
        container.innerHTML = '';
        container.dispatchEvent(new CustomEvent('bph-render'));
        return;
    }

    let html = '';
    for (const l of lines) {
        const hasPhoto = !!l.before_photo_path;
        const statusHtml = hasPhoto
            ? '<span class="b verified" style="font-size:11px">Photo attached</span>'
            : '<span class="b pending" style="font-size:11px">No photo yet</span>';
        html += `<div class="insp-before-row" data-detail="${l.rental_detail_id}">
          <div class="row" style="margin-bottom:4px">
            <span>${esc(l.equipment_name)} x${l.quantity}</span>
            ${statusHtml}
          </div>
          <div id="bph-${l.rental_detail_id}"></div>
        </div>`;
    }
    container.innerHTML = html;

    // Mount pickers
    for (const l of lines) {
        const slot = container.querySelector(`#bph-${l.rental_detail_id}`);
        if (!slot) continue;

        if (l.before_photo_path) {
            // Show existing photo
            const signed = await signedPhotoUrl(l.before_photo_path);
            slot.innerHTML = signed
                ? photoBtn(signed, 'Before photo: ' + l.equipment_name, 'View before photo')
                + `<button type="button" class="btn sm line" data-replace-before="${l.rental_detail_id}" style="margin-left:8px">Replace photo</button>`
                : '<span class="mut">Photo saved (link expired; reload to view).</span>';
        } else {
            mountBeforePicker(slot, l, ref, container);
        }
    }

    container.dispatchEvent(new CustomEvent('bph-render'));   // lets an Issue window re-check its button

    // Replace-photo buttons
    container.querySelectorAll('[data-replace-before]').forEach(btn => {
        btn.addEventListener('click', () => {
            const detailId = +btn.dataset.replaceBefore;
            const l = RL.find(x => x.rental_detail_id === detailId);
            if (!l) return;
            const slot = container.querySelector(`#bph-${detailId}`);
            if (slot) mountBeforePicker(slot, l, ref, container);
        });
    });
}

/* =====================================================================
   Handover proof (outside rentals): ONE photo per rental showing the equipment being handed to the customer.
   It is separate from the per-item before photos. Required to issue; the customer sees it in My rentals.
   DB: rental_order.handover_photo_path, rpc staff_set_handover_photo (supabase/57_handover_proof.sql)
   ===================================================================== */
export async function renderHandoverSection(ref, container) {
    const lines = RL.filter(l => l.rental_ref === ref && l.rental_type === 'Outside');
    const l0 = lines[0];
    if (!l0) {
        container.innerHTML = '';
        container.dispatchEvent(new CustomEvent('bph-render'));
        return;
    }
    const path = l0.handover_photo_path;
    container.innerHTML = `<div class="insp-before-row">
      <div class="row" style="margin-bottom:4px"><span>Photo of the handover to the customer</span>
        ${path ? '<span class="b verified" style="font-size:11px">Photo attached</span>' : '<span class="b pending" style="font-size:11px">No photo yet</span>'}</div>
      <div id="hop-slot"></div></div>`;
    const slot = container.querySelector('#hop-slot');
    if (path) {
        const signed = await signedPhotoUrl(path);
        slot.innerHTML = signed
            ? photoBtn(signed, 'Handover proof', 'View handover proof')
            + '<button type="button" class="btn sm line" data-replace-handover style="margin-left:8px">Replace photo</button>'
            : '<span class="mut">Photo saved (link expired; reload to view).</span>';
        const rep = slot.querySelector('[data-replace-handover]');
        if (rep)
            rep.addEventListener('click', () => mountHandoverPicker(slot, l0, ref, container));
    } else {
        mountHandoverPicker(slot, l0, ref, container);
    }
    container.dispatchEvent(new CustomEvent('bph-render'));   // lets the Issue window re-check its button
}

function mountHandoverPicker(slot, line, ref, container) {
    const picker = makePhotoPicker({ id: `hpick-${line.rental_order_id}`, label: 'Handover proof photo', required: true });
    slot.innerHTML = '';
    slot.appendChild(picker.el);

    const uploadBtn = document.createElement('button');
    uploadBtn.type = 'button';
    uploadBtn.className = 'btn sm gold';
    uploadBtn.textContent = 'Upload';
    uploadBtn.style.marginTop = '6px';
    uploadBtn.hidden = true;   // no manual Upload step: choosing the photo uploads it at once (the button only shows while it uploads)
    slot.appendChild(uploadBtn);
    picker.el.querySelector('input[type="file"]').addEventListener('change', () => {
        if (picker.getFile()) {
            uploadBtn.hidden = false;
            uploadBtn.click();
        }
    });

    const errSpan = document.createElement('span');
    errSpan.className = 'alert';
    errSpan.style.cssText = 'display:none;margin-top:4px;font-size:13px';
    slot.appendChild(errSpan);

    uploadBtn.addEventListener('click', async () => {
        const file = picker.getFile();
        const verr = validatePhoto(file);
        if (verr) { errSpan.textContent = verr; errSpan.style.display = 'block'; uploadBtn.hidden = true; return; }
        errSpan.style.display = 'none';
        btnBusy(uploadBtn, 'Uploading…');
        try {
            const path = await uploadHandoverPhoto(line.rental_order_id, file);
            const { error } = await sb.rpc('staff_set_handover_photo', { p_rental_ref: ref, p_path: path });
            if (error) throw new Error(/staff_set_handover_photo/i.test(error.message) && /schema cache|could not find/i.test(error.message)
                ? 'The database is not updated yet. Run supabase/57_handover_proof.sql in the Supabase SQL Editor, then reload this page.' : error.message);
            await btnSuccess(uploadBtn, 'Saved', { keep: true });
            await refresh();
            toast('Handover proof saved.');
            renderHandoverSection(ref, container);
        } catch (err) {
            errSpan.textContent = err.message || 'Upload failed.';
            errSpan.style.display = 'block';
            btnReset(uploadBtn);
            uploadBtn.hidden = true;
        }
    });
}

function mountBeforePicker(slot, line, ref, container) {
    const picker = makePhotoPicker({ id: `bpick-${line.rental_detail_id}`, label: 'Before photo', required: true });
    slot.innerHTML = '';
    slot.appendChild(picker.el);

    const uploadBtn = document.createElement('button');
    uploadBtn.type = 'button';
    uploadBtn.className = 'btn sm gold';
    uploadBtn.textContent = 'Upload';
    uploadBtn.style.marginTop = '6px';
    uploadBtn.hidden = true;   // no manual Upload step: choosing the photo uploads it at once (the button only shows while it uploads)
    slot.appendChild(uploadBtn);
    picker.el.querySelector('input[type="file"]').addEventListener('change', () => {
        if (picker.getFile()) {
            uploadBtn.hidden = false;
            uploadBtn.click();
        }
    });

    const errSpan = document.createElement('span');
    errSpan.className = 'alert';
    errSpan.style.cssText = 'display:none;margin-top:4px;font-size:13px';
    slot.appendChild(errSpan);

    uploadBtn.addEventListener('click', async () => {
        const file = picker.getFile();
        const verr = validatePhoto(file);
        if (verr) { errSpan.textContent = verr; errSpan.style.display = 'block'; uploadBtn.hidden = true; return; }
        errSpan.style.display = 'none';
        btnBusy(uploadBtn, 'Uploading…');
        try {
            const path = await uploadInspectionPhoto(line.rental_detail_id, 'before', file);
            const { error } = await sb.rpc('staff_set_before_photo', {
                p_rental_detail_id: line.rental_detail_id,
                p_path: path
            });
            if (error) throw new Error(error.message);
            await btnSuccess(uploadBtn, 'Saved', { keep: true });
            await refresh();
            toast(`Before photo saved for ${line.equipment_name}.`);
            // Re-render the section with the new data
            renderBeforePhotoSection(ref, container);
        } catch (err) {
            errSpan.textContent = err.message || 'Upload failed.';
            errSpan.style.display = 'block';
            btnReset(uploadBtn);
            uploadBtn.hidden = true;
        }
    });
}

/* =====================================================================
   Show inspection photos in a details modal row (admin + customer view).
   l = a v_rental_lines row.  Staff = true means signed URLs are requested.
   ===================================================================== */
export async function inspectionPhotoRow(l, isStaff = true) {
    if (l.rental_type !== 'Outside') return '';
    const NA = '<span class="mut">Not recorded</span>';

    // Before photo
    let beforeHtml = NA;
    if (l.before_photo_path) {
        const url = isStaff ? await signedPhotoUrl(l.before_photo_path) : null;
        beforeHtml = url
            ? photoBtn(url, 'Before photo', 'View before photo')
            : '<span class="mut">(photo saved)</span>';
    }

    let handoverHtml = NA;
    if (l.handover_photo_path) {
        const url = isStaff ? await signedPhotoUrl(l.handover_photo_path) : null;
        handoverHtml = url
            ? photoBtn(url, 'Handover proof', 'View handover proof')
            : '<span class="mut">(photo saved)</span>';
    }
    const handoverRow = `<dt>Handover proof</dt><dd>${handoverHtml}</dd>`;

    // Condition + after photo (only after return)
    if (!l.line_returned_at) {
        return `<dt>Before photo</dt><dd>${beforeHtml}</dd>${handoverRow}`;
    }

    const cond = l.return_condition || null;
    let afterHtml = NA;
    if (l.after_photo_path) {
        const url = isStaff ? await signedPhotoUrl(l.after_photo_path) : null;
        afterHtml = url
            ? photoBtn(url, 'After photo', 'View after photo')
            : '<span class="mut">(photo saved)</span>';
    }

    return `
      <dt>Before photo</dt><dd>${beforeHtml}</dd>
      ${handoverRow}
      <dt>Return condition</dt><dd>${cond ? esc(cond) : NA}</dd>
      ${l.return_description ? `<dt>Notes</dt><dd>${esc(l.return_description)}</dd>` : ''}
      <dt>After photo</dt><dd>${afterHtml}</dd>`;
}
