/* =====================================================================
   customer/myRentals.js - "My rental" tab
   Grouped rental orders, centered details receipt, cancel and guest lookup.
   ===================================================================== */

import { state } from './state.js';
import { sb } from '../config/supabaseClient.js';
import { RN_STATUS, loadMyRentals } from './data.js';
import { normRef, notFound, startsAt } from './myBookings.js';
import { fmtDT } from './rent.js';
import { okDlg } from './book.js';
import { closeActionMenu, openActionMenu } from '../shared/actionMenu.js';
import { dlg, showDialog, showIdViewer, showSuccess, tableGrouped, tableNotes, whyRejected } from './ui.js';
import { BOOKINGS } from '../shared/availability.js';
import { getUser } from '../shared/session.js';
import { $, badge, esc, manilaParts, peso, shortDate, sum, toast } from '../shared/utils.js';

/* ============================ 5. MY RENTAL ============================ */

/* Signed in: show the account tables. Guest: show the reference-code lookup. */
export function applyAccessMode() {
    const member = !!getUser();
    $('#bk-member').hidden = !member;
    $('#bk-guest').hidden = member;
    $('#rt-member').hidden = !member;
    $('#rt-guest').hidden = member;
}

export function initRentalLookup() {
    $('#gr-form').addEventListener('submit', async e => {
        e.preventDefault();
        const ref = normRef($('#gr-ref').value), box = $('#gr-res');
        box.hidden = false;
        const { data: list, error } = await sb.rpc('lookup_rental', { p_ref: ref });
        if (error || !list || !list.length) {
            box.innerHTML = notFound(ref, 'rental');
            return;
        }
        // one row per rental order, with all of its items listed in that row
        const orders = [];
        list.forEach(r => {
            let o = orders.find(x => x.rental_ref === r.rental_ref);
            if (!o) {
                o = {
                    rental_ref: r.rental_ref,
                    rental_type: r.rental_type,
                    status: r.status,
                    return_by: r.return_by,
                    rejected_reason: r.rejected_reason,
                    items: []
                };
                orders.push(o);
            }
            o.items.push(`${esc(r.equipment)} x${r.quantity}`);
        });
        box.innerHTML = `<div class="tw" style="margin-top:8px">${tableNotes(['Reference', 'Items', 'Rent type', 'Return by', 'Status'],
            orders.map(order => ({
                cells: [
                    `<span class="ref-static">${esc(order.rental_ref)}</span>`,
                    `<span class="itm">${order.items.join('<br>')}</span>`,
                    order.rental_type === 'Add-on' ? '<span class="b addon">Add-on</span>' : '<span class="b out">Outside</span>',
                    order.return_by ? shortDate(manilaParts(order.return_by).date) : '',
                    badge(RN_STATUS[order.status] || order.status)
                ],
                note: whyRejected(order.status, order.rejected_reason)
            })))}</div>`;
    });
}

/* A rental can be cancelled until 24 hours before pick-up (outside) or before the booked session (add-on). */
const rentalStart = r => {
    if (r.type === 'out')
        return r.pickup ? new Date(r.pickup) : null;
    const b = BOOKINGS.find(x => x.ref === r.ref);
    return b ? startsAt(b) : null;
};

const rentalLocked = r => {
    const d = rentalStart(r);
    return !!d && d - Date.now() < 24 * 60 * 60 * 1000;
};

const rentalCutoffMsg = r => `Changes and cancellations close 24 hours before ${r.type === 'out' ? 'pick-up' : 'your session'}.`;

/* One rental order = every item that shares the same rental reference. */
export function rentalOrders() {
    const map = new Map();
    state.RENTALS.forEach(r => {
        if (!map.has(r.rentalRef)) {
            map.set(r.rentalRef, {
                rentalRef: r.rentalRef,
                ref: r.ref,
                type: r.type,
                status: r.status,
                rawStatus: r.rawStatus,
                when: r.when,
                ret: r.ret,
                reason: r.reason,
                lines: []
            });
        }
        map.get(r.rentalRef).lines.push(r);
    });
    const now = Date.now();
    // an order that is in use but past its return time shows as Overdue instead of In Use
    map.forEach(o => {
        if (o.rawStatus === 'Active' && o.lines.some(l => !l.returnedAt && l.due && now > new Date(l.due).getTime()))
            o.status = 'Overdue';
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

/* One "Actions" button per rental order (My rental and the add-on lines under a booking); the menu lists what applies to that order. */
const rentalMenuBtn = ref => `<button type="button" class="btn sm line menu-btn" data-rmenu="${esc(ref)}" aria-haspopup="menu" aria-expanded="false">Actions <span aria-hidden="true">&#9662;</span></button>`;

function rentalMenuItems(o) {
    const items = [{ act: 'details', label: 'Details' }];
    if (o.type === 'out')
        items.push({ act: 'viewid', label: 'View ID' });
    if (['Pending', 'Approved'].includes(o.rawStatus))
        items.push({ act: 'cancel', label: o.type === 'out' ? 'Cancel rental' : 'Cancel add-on', danger: true });
    return items;
}

function runRentalAction(action, rentalRef) {
    if (action === 'details')
        return showRentalDetails(rentalRef);
    if (action === 'viewid')
        return viewRentalId(rentalRef);
    startCancelRental(rentalRef);
}

/* Which "Past and closed" groups are open (closed by default; the button in the group row toggles it). */
export const pastOpen = { bk: false, rn: false };

const rentalPickup = o => new Date((o.lines[0] && o.lines[0].pickup) || 0).getTime() || 0;
const orderTotal = o => sum(o.lines.map(l => (l.unit || 0) * l.qty));

/* The add-on equipment orders of one booking, as indented lines under that booking in My bookings.
   Cancelled and rejected ones stay in the list (struck through) so the customer sees why the total changed.
   plain = for a past booking: just the item and price, no status and no buttons. */
export function addonSubRows(bookingRef, plain = false) {
    return rentalOrders().filter(o => o.type === 'addon' && o.ref === bookingRef).map(o => {
        const closed = ['Cancelled', 'Rejected'].includes(o.rawStatus);
        return `<div class="subin${closed ? ' strike' : ''}">
            <span class="b addon">Add-on</span>
            <span class="subtxt">${itemSummary(o.lines, true)} <span class="mut">(${peso(orderTotal(o))})</span></span>
            ${plain ? '' : `${badge(o.status)}
            <span class="subact">${rentalMenuBtn(o.rentalRef)}</span>`}
        </div>`;
    });
}

/* My rental: outside rentals, grouped In use (overdue first) > Upcoming (next pick-up first) > Past and closed (newest first).
   Add-on equipment is listed under its booking in My bookings; only an add-on whose booking is not in the account shows up here. */
export function renderMyRentals() {
    closeActionMenu();
    const mineBookings = new Set(BOOKINGS.filter(b => b.mine).map(b => b.ref));
    const orders = rentalOrders().filter(o => o.type === 'out' || !mineBookings.has(o.ref));
    if (!orders.length) {
        $('#myrent').innerHTML = '<p class="mut" style="padding:8px">No rentals yet.</p>';
        return;
    }
    const row = o => {
        const actions = rentalMenuBtn(o.rentalRef);
        return {
            cells: [
                o.when,
                o.ret,
                `<span class="itm">${itemSummary(o.lines)}</span>`,
                `<span class="ref-static">${esc(o.ref)}</span>${o.type === 'addon' ? ' <span class="b addon">Add-on</span>' : ''}`,
                badge(o.status),
                actions
            ],
            note: whyRejected(o.status, o.reason),
            dim: ['Cancelled', 'Rejected'].includes(o.rawStatus)
        };
    };
    const inUse = orders.filter(o => o.rawStatus === 'Active')
        .sort((x, y) => (y.status === 'Overdue') - (x.status === 'Overdue') || rentalPickup(x) - rentalPickup(y));
    const upcoming = orders.filter(o => ['Pending', 'Approved'].includes(o.rawStatus)).sort((x, y) => rentalPickup(x) - rentalPickup(y));
    const past = orders.filter(o => !['Active', 'Pending', 'Approved'].includes(o.rawStatus)).sort((x, y) => rentalPickup(y) - rentalPickup(x));
    const groups = [
        { title: 'In use', rows: inUse.map(row) },
        { title: 'Upcoming', rows: upcoming.map(row) },
        { title: 'Past and closed', toggle: 'rn', collapsed: !pastOpen.rn, rows: past.map(row) }
    ].filter(g => g.rows.length);
    $('#myrent').innerHTML = tableGrouped(['Pick-up', 'Return', 'Items', 'Reference', 'Status', ''], groups);
    // while "Past and closed" is open the table scrolls inside its box (like the admin page); the page itself stays put
    $('#myrent').classList.toggle('tw-scroll', groups.some(g => g.toggle && !g.collapsed));
}

/* The customer can open the valid ID they sent with an outside rental (private bucket, 10 minute link). */
async function viewRentalId(rentalRef) {
    const { data: rentalOrder, error: loadError } = await sb.from('rental_order')
        .select('id_type, id_image_path').eq('rental_ref', rentalRef).maybeSingle();
    if (loadError || !rentalOrder)
        return toast('Could not load your ID details.');
    if (!rentalOrder.id_image_path)
        return toast('No ID photo was attached to this rental.');
    const { data: signedLink, error: signedLinkError } = await sb.storage.from('rental-ids')
        .createSignedUrl(rentalOrder.id_image_path, 600);
    if (signedLinkError || !signedLink)
        return toast('Could not open your ID' + (signedLinkError ? ': ' + signedLinkError.message : '.'));
    showIdViewer({
        url: signedLink.signedUrl,
        pdf: /\.pdf$/i.test(rentalOrder.id_image_path),
        title: 'Valid ID' + (rentalOrder.id_type ? ' (' + rentalOrder.id_type + ')' : '')
    });
}

/* ---- Rental details: a centered receipt modal, the same one My Bookings uses ---- */
const HOURS_INCLUDED_IN_BASE_PRICE = 8;
const MILLISECONDS_PER_HOUR = 3600e3;

/* What the customer pays for one order. Outside rentals are billed per 8 hours, add-ons at their listed price. */
function calculateRentalCosts(order) {
    const isOutsideRental = order.type === 'out';
    const firstLine = order.lines[0];
    const scheduledHours = isOutsideRental ? Math.round((firstLine.hours || 0) * 100) / 100 : 0;
    const billedHours = isOutsideRental ? Math.max(HOURS_INCLUDED_IN_BASE_PRICE, Math.ceil(firstLine.hours || HOURS_INCLUDED_IN_BASE_PRICE)) : 0;
    const billingFactor = isOutsideRental ? billedHours / HOURS_INCLUDED_IN_BASE_PRICE : 1;

    const priceOfLine = line => line.unit * line.qty * billingFactor;
    const basePrice = sum(order.lines.map(line => line.unit * line.qty));
    const totalPrice = sum(order.lines.map(priceOfLine));

    // late fees: those already charged, plus the hours still running on items not yet returned
    const dueDate = firstLine.due ? new Date(firstLine.due) : null;
    const now = Date.now();
    const linesStillLate = dueDate
        ? order.lines.filter(line => line.rawStatus === 'Active' && !line.returnedAt && now > dueDate)
        : [];
    const feeStillGrowing = sum(linesStillLate.map(line => {
        const hoursLate = Math.ceil((now - dueDate) / MILLISECONDS_PER_HOUR);
        return line.qty * line.unit / HOURS_INCLUDED_IN_BASE_PRICE * hoursLate;
    }));
    const lateFee = sum(order.lines.map(line => line.late)) + feeStillGrowing;

    return {
        scheduledHours,
        billedHours,
        priceOfLine,
        basePrice,
        totalPrice,
        lateFee,
        lateFeeIsStillGrowing: linesStillLate.length > 0,
        downPayment: firstLine.down,
        paidAtPickup: firstLine.atPickup || 0,
        paidInFull: firstLine.down > 0 && firstLine.down >= totalPrice - 0.01,   // the customer chose Full Payment (100%)
        balanceAtPickup: Math.max(0, totalPrice - firstLine.down - (firstLine.atPickup || 0))
    };
}

/* The rows of the receipt, in the order the customer reads them. Every value is plain text (showSuccess escapes it). */
function buildRentalReceiptLines(order, costs) {
    const isOutsideRental = order.type === 'out';
    const firstLine = order.lines[0];
    const extraBilledHours = costs.billedHours - HOURS_INCLUDED_IN_BASE_PRICE;

    const receiptLines = isOutsideRental
        ? [
            ['Pick-up', order.when],
            ['Return by', order.ret],
            ['Scheduled length', `${costs.scheduledHours} hours (billed as ${costs.billedHours})`],
            ['Late fees start', firstLine.due ? fmtDT(firstLine.due) : '-']
        ]
        : [
            ['Session starts', order.when],
            ['Session ends', order.ret],
            ['Booking', order.ref]
        ];

    order.lines.forEach(line => {
        const unitLabel = isOutsideRental ? 'per 8 hours' : 'each';
        const returnedLabel = line.returnedAt ? ', Returned' : '';
        receiptLines.push(['Item', `${line.item} x${line.qty} (${peso(costs.priceOfLine(line))}, ${peso(line.unit)} ${unitLabel}${returnedLabel})`]);
    });

    receiptLines.push([isOutsideRental ? 'Rental (first 8 hours)' : 'Add-on equipment', peso(costs.basePrice)]);
    if (isOutsideRental && extraBilledHours > 0)
        receiptLines.push([`Extra hours (${extraBilledHours} x ${peso(costs.basePrice / HOURS_INCLUDED_IN_BASE_PRICE)})`, peso(costs.totalPrice - costs.basePrice)]);
    receiptLines.push(['Total', peso(costs.totalPrice)]);

    // paid now with GCash: an outside rental, or add-on equipment added later to a booking
    if (costs.downPayment > 0) {
        receiptLines.push(['Payment option', costs.paidInFull ? 'Full payment (100%)' : '50% down payment']);
        receiptLines.push([costs.paidInFull ? 'Full payment' : 'Down payment (50%)', `${peso(costs.downPayment)}, non-refundable if cancelled`]);
        if (costs.paidAtPickup > 0)
            receiptLines.push(['Balance paid at pick-up', peso(costs.paidAtPickup)]);
        receiptLines.push([isOutsideRental ? 'Balance at pick-up' : 'Balance at the studio', costs.paidInFull ? 'Paid in full' : peso(costs.balanceAtPickup)]);
    }
    if (isOutsideRental) {
        if (costs.lateFee > 0)
            receiptLines.push([costs.lateFeeIsStillGrowing ? 'Late fee so far' : 'Late fee', peso(costs.lateFee)]);
    }
    if (order.status === 'Rejected')
        receiptLines.push(['Reason for rejection', order.reason || 'No reason was given. Please contact the studio.']);
    return receiptLines;
}

function showRentalDetails(rentalRef) {
    const order = rentalOrders().find(rentalOrder => rentalOrder.rentalRef === rentalRef);
    if (!order)
        return;
    const isOutsideRental = order.type === 'out';
    const canCancel = ['Pending', 'Approved'].includes(order.rawStatus);
    const costs = calculateRentalCosts(order);

    const extraActions = [];
    if (isOutsideRental)
        extraActions.push({
            label: 'View ID',
            className: 'line',
            onClick: () => viewRentalId(order.rentalRef)
        });
    if (canCancel)
        extraActions.push({
            label: 'Cancel rental',
            className: 'bad',
            onClick: () => startCancelRental(order.rentalRef)
        });

    showSuccess({
        title: 'Rental receipt',
        label: 'Reference code',
        ref: order.ref,
        icon: 'receipt',
        status: `${badge(order.status)} ${isOutsideRental ? '<span class="b out">Outside</span>' : '<span class="b addon">Add-on</span>'}`,
        lines: buildRentalReceiptLines(order, costs),
        doneLabel: 'Close',
        extraActions,
        shot: 'It is your official receipt. Show it to our staff when you collect or use the equipment so we can verify your rental.',
        note: isOutsideRental
            ? 'Each hour beyond 8 hours adds one-eighth of the item price. Returning late adds the same charge for every hour late.'
            : ''
    });
}

function startCancelRental(rentalRef) {
    const rentalLine = state.RENTALS.find(line => line.rentalRef === rentalRef);
    if (!rentalLine)
        return;
    if (rentalLocked(rentalLine))
        return toast(rentalCutoffMsg(rentalLine));
    if (okDlg.open)
        okDlg.close();
    confirmCancelRental(rentalRef);
}

/* an order whose payment covered the whole price */
function paidFullOrder(o) {
    return calculateRentalCosts(o).paidInFull;
}

function confirmCancelRental(ref) {
    const o = rentalOrders().find(x => x.rentalRef === ref);
    if (!o)
        return;
    const out = o.type === 'out';
    showDialog(`
    <h2>Cancel ${esc(o.ref)}?</h2>
    <p class="mut">${itemSummary(o.lines, true)}</p>
    <p class="mut" style="margin-top:8px">${out
            ? `Your ${paidFullOrder(o) ? 'full payment' : '50% down payment'} of <b>${peso(o.lines[0].down)}</b> is <b>non-refundable</b> once the rental is cancelled.`
            : `The add-on equipment is removed from your booking. Your studio booking stays as it is.${o.lines[0].down > 0 ? ` The ${peso(o.lines[0].down)} you paid for it is non-refundable.` : ''}`}</p>
    <div class="acts">
      <button class="btn line" data-close>Keep rental</button>
      <button class="btn bad" id="do-cancel-r">Cancel rental</button>
    </div>`);
    $('#do-cancel-r').onclick = async () => {
        const { error } = await sb.rpc('cancel_rental', { p_rental_ref: ref });
        if (error)
            return toast(error.message);
        dlg.close();
        await loadMyRentals();
        toast(`${o.ref} cancelled.`);
    };
}

export function initMyRentals() {
    // the same buttons live in My rental (outside rentals) and under a booking in My bookings (its add-ons)
    const onClick = clickEvent => {
        const menuButton = clickEvent.target.closest('[data-rmenu]');
        if (menuButton) {
            const order = rentalOrders().find(o => o.rentalRef === menuButton.dataset.rmenu);
            if (order)
                openActionMenu(menuButton, rentalMenuItems(order), action => runRentalAction(action, order.rentalRef));
            return;
        }
        const toggle = clickEvent.target.closest('[data-toggle="rn"]');
        if (toggle) {
            pastOpen.rn = !pastOpen.rn;
            return renderMyRentals();
        }
    };
    $('#myrent').addEventListener('click', onClick);
    $('#mybk').addEventListener('click', onClick);
}
