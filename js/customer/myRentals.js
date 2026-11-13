/* =====================================================================
   customer/myRentals.js - "My rental" tab
   Grouped rental orders, centered details receipt, cancel and guest lookup.
   ===================================================================== */

import { state } from './state.js';
import { sb } from '../config/supabaseClient.js';
import { RN_STATUS, loadMyRentals } from './data.js';
import { PHOTO_BUCKET } from '../shared/inspectionPhoto.js';
import { normRef, notFound, startsAt } from './myBookings.js';
import { fmtDT } from './rent.js';
import { okDlg } from './book.js';
import { loadDamageBlock, onPayDamage } from './damageBlock.js';
import { awaitingStudio, offersFor, openSwapChoice } from './swapChoice.js';
import { closeActionMenu, openActionMenu } from '../shared/actionMenu.js';
import { emptyState } from '../shared/emptyState.js';
import { askConfirm, dlg, showDialog, showIdViewer, showSuccess, tableGrouped, tableNotes, whyRejected } from './ui.js';
import { gcashQrUrl } from '../shared/catalog.js';
import { gcashProofHtml, initGcashProof, uploadGcashProof } from '../shared/gcashProof.js';
import { applyChecks, check, liveCheck } from '../shared/fieldCheck.js';
import { btnBusy, btnReset, btnSuccess } from '../shared/btnState.js';
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
    if (o.type === 'out' && damageOwed(o.rentalRef) > 0)
        items.unshift({ act: 'paydamage', label: `Pay damage fee (${peso(damageOwed(o.rentalRef))})` });
    if (o.type === 'out' && lateOwed(o.rentalRef) > 0)
        items.unshift({ act: 'paylate', label: `Pay late fee (${peso(lateOwed(o.rentalRef))})` });
    if (o.type === 'out')
        items.push({ act: 'viewid', label: 'View ID' });
    const offer = offersFor(o.rentalRef)[0];
    if (offer)
        items.unshift({ act: 'choose', label: 'Choose replacement item' });   // staff offered other items instead of the one booked
    if (['Pending', 'Approved'].includes(o.rawStatus))
        items.push({ act: 'cancel', label: o.type === 'out' ? 'Cancel rental' : 'Cancel add-on', danger: true });
    return items;
}

function runRentalAction(action, rentalRef) {
    if (action === 'details')
        return showRentalDetails(rentalRef);
    if (action === 'viewid')
        return viewRentalId(rentalRef);
    if (action === 'paydamage')
        return startDamagePay(rentalRef);
    if (action === 'paylate')
        return startLatePay(rentalRef);
    if (action === 'choose')
        return openSwapChoice((offersFor(rentalRef)[0] || {}).id);
    startCancelRental(rentalRef);
}

/* Which "Past and closed" groups are open (closed by default; the button in the group row toggles it). */
export const pastOpen = { bk: false, rn: false };

/* ---- Damage fees (money the customer owes after a return; supabase/58_damage_charges.sql) ---- */
export const damageOf = ref => state.DAMAGE[ref] || [];
const damageSum = (ref, statuses) => sum(damageOf(ref).filter(d => statuses.includes(d.status)).map(d => d.amount));
export const damageOwed = ref => damageSum(ref, ['Unpaid']);          // still to pay (nothing sent yet)
export const damageWaiting = ref => damageSum(ref, ['Pending']);              // GCash sent, staff are checking it
export const damageTotal = ref => sum(damageOf(ref).map(d => d.amount));
/* Late fee left unpaid at the return ("Not now"): lines still owed / waiting for staff to check the GCash payment (83_late_fee_collection.sql) */
const lateLinesOf = ref => state.RENTALS.filter(l => l.rentalRef === ref && l.lateDeferred && !l.latePaid && l.late > 0);
export const lateOwed = ref => sum(lateLinesOf(ref).filter(l => !l.latePendingRef).map(l => l.late));   // nothing sent yet
export const lateWaiting = ref => sum(lateLinesOf(ref).filter(l => l.latePendingRef).map(l => l.late));   // GCash sent, staff are checking it
const lateBadge = ref => {
    if (lateOwed(ref) > 0)
        return ` <span class="b balancedue" title="Open Actions > Pay late fee">Late fee ${peso(lateOwed(ref))} unpaid</span>`;
    if (lateWaiting(ref) > 0)
        return ' <span class="b pending">Late fee: payment being checked</span>';
    return '';
};
const damageBadge = ref => {
    if (damageOwed(ref) > 0)
        return ` <span class="b balancedue" title="Open Details to see the reason and the photos">Damage fee ${peso(damageOwed(ref))} unpaid</span>`;
    if (damageWaiting(ref) > 0)
        return ' <span class="b pending">Damage fee: payment being checked</span>';
    return '';
};

/* the status badge of a rental: once the customer declined the replacement items, the studio is the one to act */
const statusBadge = o => ['Pending', 'Approved'].includes(o.rawStatus) && awaitingStudio(o.rentalRef) && !offersFor(o.rentalRef).length
    ? '<span class="b pending" title="You said none of the replacement items suit you. The studio will contact you.">Studio will contact you</span>'
    : badge(o.status);

/* a rental waiting for the customer to choose a replacement item */
const swapChip = ref => offersFor(ref).length ? ' <span class="b balancedue" title="Open Actions > Choose replacement item">Choose a replacement</span>' : '';

const rentalPickup = o => new Date((o.lines[0] && o.lines[0].pickup) || 0).getTime() || 0;
const orderTotal = o => sum(o.lines.map(l => (l.unit || 0) * l.qty));

/* The add-on equipment orders of one booking, as indented lines under that booking in My bookings.
   Cancelled and rejected ones stay in the list (struck through) so the customer sees why the total changed.
   plain = for a past booking: just the item and price, no status and no buttons. */
export function addonSubRows(bookingRef, plain = false) {
    /* Each add-on is returned as { text, strike, tail }. tail = cells for the LAST columns of the table (Status, Payment, Actions),
       so tableGrouped puts the add-on's status and Actions button under the same columns as the booking row's. */
    return rentalOrders().filter(o => o.type === 'addon' && o.ref === bookingRef).map(o => {
        const closed = ['Cancelled', 'Rejected'].includes(o.rawStatus);
        return {
            strike: closed,
            text: `<span class="b addon">Add-on</span>
                <span class="subtxt">${itemSummary(o.lines, true)} <span class="mut">(${peso(orderTotal(o))})</span></span>`,
            tail: plain ? [] : [statusBadge(o) + swapChip(o.rentalRef), '', rentalMenuBtn(o.rentalRef)]
        };
    });
}

/* My rental: outside rentals, grouped In use (overdue first) > Upcoming (next pick-up first) > Past and closed (newest first).
   Add-on equipment is listed under its booking in My bookings; only an add-on whose booking is not in the account shows up here. */
export function renderMyRentals() {
    closeActionMenu();
    const mineBookings = new Set(BOOKINGS.filter(b => b.mine).map(b => b.ref));
    const orders = rentalOrders().filter(o => o.type === 'out' || !mineBookings.has(o.ref));
    if (!orders.length) {
        $('#myrent').innerHTML = emptyState({
            icon: 'headphones',
            title: 'No rentals yet',
            text: 'Rent gear to take outside the studio, or add it to a studio booking.',
            action: { label: 'Rent equipment', href: '#rent' }
        });
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
                // a returned rental with a fee still to pay (or being checked) shows only the fee status
                o.rawStatus === 'Returned' && (damageOwed(o.rentalRef) > 0 || damageWaiting(o.rentalRef) > 0 || lateOwed(o.rentalRef) > 0 || lateWaiting(o.rentalRef) > 0)
                    ? (lateBadge(o.rentalRef) + damageBadge(o.rentalRef)).trim() : statusBadge(o) + swapChip(o.rentalRef) + damageBadge(o.rentalRef),
                actions
            ],
            note: whyRejected(o.status, o.reason),
            dim: ['Cancelled', 'Rejected'].includes(o.rawStatus)
        };
    };
    const inUse = orders.filter(o => o.rawStatus === 'Active')
        .sort((x, y) => (y.status === 'Overdue') - (x.status === 'Overdue') || rentalPickup(x) - rentalPickup(y));
    const upcoming = orders.filter(o => ['Pending', 'Approved'].includes(o.rawStatus)).sort((x, y) => rentalPickup(x) - rentalPickup(y));
    // a returned rental with a damage fee or late fee still to pay stays in the open list, so it is not forgotten
    const owing = o => o.rawStatus === 'Returned' && (damageOwed(o.rentalRef) > 0 || lateOwed(o.rentalRef) > 0);
    const owes = orders.filter(owing).sort((x, y) => rentalPickup(y) - rentalPickup(x));
    // a returned rental whose fee payment staff are still checking is not closed yet either
    const checking = o => o.rawStatus === 'Returned' && !owing(o) && (damageWaiting(o.rentalRef) > 0 || lateWaiting(o.rentalRef) > 0);
    const checks = orders.filter(checking).sort((x, y) => rentalPickup(y) - rentalPickup(x));
    const past = orders.filter(o => !['Active', 'Pending', 'Approved'].includes(o.rawStatus) && !owing(o) && !checking(o)).sort((x, y) => rentalPickup(y) - rentalPickup(x));
    const groups = [
        { title: 'Fees to pay', rows: owes.map(row) },
        { title: 'Fees being checked', rows: checks.map(row) },
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
            receiptLines.push([costs.lateFeeIsStillGrowing ? 'Late fee so far' : 'Late fee', peso(costs.lateFee)
                + (lateOwed(order.rentalRef) > 0 ? ' (unpaid)' : lateWaiting(order.rentalRef) > 0 ? ' (payment being checked)' : '')]);
        const rejectedLate = (lateLinesOf(order.rentalRef).find(l => l.lateReject && !l.latePendingRef) || {}).lateReject;
        if (rejectedLate)
            receiptLines.push(['Late fee payment rejected', rejectedLate]);
    }
    if (order.status === 'Rejected')
        receiptLines.push(['Reason for rejection', order.reason || 'No reason was given. Please contact the studio.']);
    return receiptLines;
}

/* One pop-up with the before or after photo of every item in the rental (each with its own "Open in new tab").
   kind is 'before' or 'after'. */
async function viewInspectionPhotos(lines, kind = 'before') {
    const pathOf = l => kind === 'after' ? l.afterPhotoPath : l.beforePhotoPath;
    const word = kind === 'after' ? 'After' : 'Before';
    const urls = await Promise.all(lines.map(async l => {
        const { data, error } = await sb.storage.from(PHOTO_BUCKET).createSignedUrl(pathOf(l), 600);
        if (error)
            console.error('Inspection photo', pathOf(l), error);
        return data && data.signedUrl ? data.signedUrl : null;
    }));
    if (!urls.some(Boolean))
        return toast('The photos could not be opened. Please try again or contact the studio.');
    const many = lines.length > 1;
    const items = lines.map((l, i) => {
        const u = urls[i] ? esc(urls[i]) : '';
        return `<div class="before-photo-item">
          ${many ? `<h3>${esc(l.item)}</h3>` : ''}
          ${u ? `<img class="idfull" src="${u}" alt="${word} photo: ${esc(l.item)}" decoding="async">
                 <a class="btn sm line" href="${u}" target="_blank" rel="noopener">Open in new tab</a>`
              : `<p class="mut">This photo could not be loaded.</p>`}
        </div>`;
    }).join('');
    showDialog(`
    <h2>${many ? `${word} photos` : `${word} photo`}</h2>
    ${items}
    <div class="acts"><button type="button" class="btn gold" data-close>Close</button></div>`);
}

async function showRentalDetails(rentalRef) {
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

    // Condition notes (plain text rows), one "View before photos" button for all items, and and one "View after photo" button, both opening the same pop-up (outside rentals only)
    const conditionLines = [];
    if (isOutsideRental) {
        const beforePhotos = order.lines.filter(l => l.beforePhotoPath);
        if (beforePhotos.length)
            extraActions.push({
                label: beforePhotos.length > 1 ? 'View before photos' : 'View before photo',
                className: 'line',
                onClick: () => viewInspectionPhotos(beforePhotos, 'before')
            });
        const many = order.lines.length > 1;
        for (const line of order.lines) {
            const tag = many ? ` (${line.item})` : '';
            if (line.returnedAt) {
                conditionLines.push([`Return condition${tag}`, line.returnCondition || 'Not recorded']);
                if (line.returnDescription)
                    conditionLines.push([`Notes${tag}`, line.returnDescription]);
            }
        }
        const afterPhotos = order.lines.filter(l => l.afterPhotoPath);
        if (afterPhotos.length)
            extraActions.push({
                label: afterPhotos.length > 1 ? 'View after photos' : 'View after photo',
                className: 'line',
                onClick: () => viewInspectionPhotos(afterPhotos, 'after')
            });
    }

    // damage fee (outside rentals): shown next to the late fee, as its own line
    const damages = damageOf(order.rentalRef);
    const damageLines = [];
    if (isOutsideRental && damages.length) {
        const total = damageTotal(order.rentalRef);
        damageLines.push(['Damage fee', total > 0 ? `${peso(total)} (${damageOwed(order.rentalRef) > 0 ? 'unpaid' : damageWaiting(order.rentalRef) > 0 ? 'payment being checked' : 'paid'})` : 'Waived, nothing to pay']);
        if (total > 0 && costs.lateFee > 0)
            damageLines.push(['Late fee + damage fee', peso(costs.lateFee + total)]);
    }

    const allLines = [
        ...buildRentalReceiptLines(order, costs),
        ...conditionLines,
        ...damageLines
    ];

    // Damage fee section: the amount, the reason, and the before / after photos side by side
    let damageHtml = '';
    if (isOutsideRental && damages.length) {
        const signed = async path => {
            if (!path)
                return null;
            const { data } = await sb.storage.from(PHOTO_BUCKET).createSignedUrl(path, 600);
            return data && data.signedUrl ? data.signedUrl : null;
        };
        const fig = (url, cap) => url
            ? `<figure><a href="${esc(url)}" target="_blank" rel="noopener" title="Open full size"><img src="${esc(url)}" alt="${esc(cap)}" loading="lazy" decoding="async"></a><figcaption>${esc(cap)}</figcaption></figure>`
            : `<figure><div class="dc-nophoto">No photo</div><figcaption>${esc(cap)}</figcaption></figure>`;
        const cards = await Promise.all(damages.map(async d => {
            const [before, after] = await Promise.all([signed(d.beforePhotoPath), signed(d.afterPhotoPath)]);
            const label = { Unpaid: 'Unpaid', Pending: 'Payment being checked', Paid: 'Paid', Waived: 'Waived' }[d.status] || d.status;
            const cls = { Unpaid: 'balancedue', Pending: 'pending', Paid: 'paid', Waived: '' }[d.status] || '';
            return `<div class="dc-item">
              <div class="row"><b>${esc(d.item)} x${d.qty}</b><span class="b ${cls}">${esc(label)}</span></div>
              <p style="margin:6px 0 0"><b>${d.amount > 0 ? peso(d.amount) : 'No charge'}</b> <span class="mut">Condition: ${esc(d.condition)}</span></p>
              ${d.reason ? `<p style="margin:4px 0 0">${esc(d.reason)}</p>` : ''}
              <div class="dc-photos">${fig(before, 'Before')}${fig(after, 'After')}</div>
            </div>`;
        }));
        const owed = damageOwed(order.rentalRef);
        damageHtml = `<div class="dmg-box"><h3>Damage fee</h3>
          <p class="mut" style="margin:0">${owed > 0 ? 'Staff recorded a damage fee after your return. Compare the photos below. You can pay now with GCash, or pay later at the studio or here.'
              : 'Staff recorded the condition of your equipment when it came back.'}</p>
          ${cards.join('')}</div>`;
    }

    // Proof of handover: the photo staff attached when the equipment was given to the customer (separate from the before photos)
    let proofHtml = '';
    if (isOutsideRental) {
        const proofPath = (order.lines.find(l => l.handoverPhotoPath) || {}).handoverPhotoPath;
        if (proofPath) {
            const { data } = await sb.storage.from(PHOTO_BUCKET).createSignedUrl(proofPath, 600);
            const url = data && data.signedUrl ? data.signedUrl : null;
            const issuedAt = order.lines[0].issuedAt ? fmtDT(order.lines[0].issuedAt) : '';
            proofHtml = `<div class="handover-proof">
              <h3>Proof of handover</h3>
              <p class="mut">${issuedAt ? `Your equipment was handed over on ${esc(issuedAt)}. ` : ''}Tap the photo to open it full size.</p>
              ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener"><img src="${esc(url)}" alt="Proof of handover" loading="lazy" decoding="async"></a>`
                    : '<p class="mut">The photo could not be loaded. Please try again or contact the studio.</p>'}
            </div>`;
        }
        else if (['Active', 'Returned'].includes(order.rawStatus)) {
            proofHtml = '<div class="handover-proof"><h3>Proof of handover</h3><p class="mut">No handover photo was recorded for this rental.</p></div>';
        }
    }

    showSuccess({
        title: 'Rental receipt',
        label: 'Reference code',
        ref: order.ref,
        icon: 'receipt',
        status: `${badge(order.status)} ${isOutsideRental ? '<span class="b out">Outside</span>' : '<span class="b addon">Add-on</span>'}`,
        lines: allLines,
        doneLabel: 'Close',
        extraActions,
        extraHtml: damageHtml + proofHtml,
        shot: 'It is your official receipt. Show it to our staff when you collect or use the equipment so we can verify your rental.',
        note: isOutsideRental
            ? 'Each hour beyond 8 hours adds one-eighth of the item price. Returning late adds the same charge for every hour late.'
            : ''
    });
}

/* ---- Pay the damage fee: NOW with GCash (staff verify it) or LATER (nothing is sent; the fee stays unpaid) ---- */
function startDamagePay(rentalRef) {
    const order = rentalOrders().find(o => o.rentalRef === rentalRef);
    const owed = damageOwed(rentalRef), list = damageOf(rentalRef).filter(d => d.status === 'Unpaid' && d.amount > 0);
    if (!order || owed <= 0)
        return toast('There is no damage fee to pay on this rental.');
    if (okDlg.open)
        okDlg.close();
    showDialog(`
    <h2>Pay your damage fee</h2>
    <p class="mut">${esc(order.ref)}: ${list.map(d => `${esc(d.item)} x${d.qty} (${peso(d.amount)})`).join(', ')}</p>
    <div class="dr-sum"><div class="tot-line"><b>Damage fee to pay</b><b>${peso(owed)}</b></div></div>
    <div class="dmg-pay">
    <div class="dmg-choices" role="radiogroup" aria-label="When do you want to pay?">
      <label class="dmg-choice"><input type="radio" name="dm-when" value="now" checked><span><b>Pay now with GCash</b><small>Staff check your payment, then the fee shows as paid.</small></span></label>
      <label class="dmg-choice"><input type="radio" name="dm-when" value="later"><span><b>Pay later</b><small>Nothing is sent now. Pay in cash at the studio, or come back here and pay with GCash. The fee stays unpaid until then.</small></span></label>
    </div>
    <div id="dm-gc" class="dmg-gc">
      <div class="gq">
        <img id="dm-qr" alt="GCash QR code to scan" hidden>
        <p class="mut" id="dm-qn">Scan this QR code with GCash and pay <b>${peso(owed)}</b>. Then attach the screenshot and enter the reference number from your GCash receipt.</p>
      </div>
      ${gcashProofHtml('dm')}
      <label for="dm-g">GCash reference number <span class="req" aria-hidden="true">*</span></label>
      <input id="dm-g" data-gcash-ref placeholder="13-digit reference" inputmode="numeric" required aria-required="true">
    </div>
    <div class="alert" id="dm-e" role="alert" hidden></div>
    <div class="acts">
      <button class="btn line" data-close>Close</button>
      <button class="btn gold" id="dm-go">Send GCash payment</button>
    </div>
    </div>`);
    const qr = $('#dm-qr');
    qr.onload = () => {
        qr.hidden = false;
    };
    qr.onerror = () => {
        qr.hidden = true;
        $('#dm-qn').innerHTML = `Pay <b>${peso(owed)}</b> using the studio's GCash account, then attach the screenshot and enter the reference number from your receipt. Ask staff if you need the account details.`;
    };
    qr.src = gcashQrUrl();
    const proof = initGcashProof('dm', { ref: '#dm-g' });
    const rules = () => [
        ['#dm-ss', () => check.file(proof.file(), 'Attach a screenshot of your GCash payment.')],
        ['#dm-g', () => check.gcashRef($('#dm-g').value)]
    ];
    liveCheck(rules());
    const err = t => {
        const box = $('#dm-e');
        box.textContent = t;
        box.hidden = !t;
    };
    const go = $('#dm-go'), later = () => dlg.querySelector('[name="dm-when"]:checked').value === 'later';
    dlg.querySelectorAll('[name="dm-when"]').forEach(r => r.addEventListener('change', () => {
        $('#dm-gc').hidden = later();
        go.textContent = later() ? 'Pay later' : 'Send GCash payment';
        err('');
    }));
    go.addEventListener('click', async () => {
        err('');
        if (later()) {
            dlg.close();
            return toast('No problem. Your damage fee stays unpaid. Pay in cash at the studio, or pay here with GCash anytime.');
        }
        if (!applyChecks(rules().map(([t, rule]) => [t, rule()])))
            return;
        const gcash = $('#dm-g').value.replace(/\s/g, '');
        const yes = await askConfirm({
            title: 'Send your GCash payment?',
            message: `You paid ${peso(owed)} by GCash for the damage fee of ${order.ref}. Staff will check the reference number ${gcash} and the screenshot.`,
            ok: 'Yes, send payment',
            cancel: 'Not now'
        });
        if (!yes)
            return;
        btnBusy(go, 'Sending…');
        const up = await uploadGcashProof(proof.file(), gcash);
        if (up.error) {
            btnReset(go);
            return err('Could not upload your GCash screenshot: ' + up.error.message);
        }
        const { error } = await sb.rpc('customer_pay_damage', { p_rental_ref: rentalRef, p_gcash_reference: gcash });
        if (error) {
            btnReset(go);
            return err(/schema cache|could not find/i.test(error.message || '') ? 'Paying online is not available yet. Please pay at the studio.' : error.message);   // for example the GCash reference was already used
        }
        await btnSuccess(go, 'Sent', { keep: true });
        dlg.close();
        await loadMyRentals();
        await loadDamageBlock();   // the notice now says the payment is waiting for staff
        toast('Payment sent. Staff will check it and mark your damage fee as paid.');
    });
}

/* ---- Pay a late fee that was left unpaid at the return: GCash now (staff verify it). Paying in cash at the studio needs no step here. ---- */
function startLatePay(rentalRef) {
    const order = rentalOrders().find(o => o.rentalRef === rentalRef);
    const owed = lateOwed(rentalRef), list = lateLinesOf(rentalRef).filter(l => !l.latePendingRef);
    if (!order || owed <= 0)
        return toast('There is no late fee to pay on this rental.');
    if (okDlg.open)
        okDlg.close();
    const rejected = (list.find(l => l.lateReject) || {}).lateReject;
    showDialog(`
    <h2>Pay your late fee</h2>
    <p class="mut">${esc(order.ref)}: ${list.map(l => `${esc(l.item)} x${l.qty} (${peso(l.late)})`).join(', ')}</p>
    <div class="dr-sum"><div class="tot-line"><b>Late fee to pay</b><b>${peso(owed)}</b></div></div>
    ${rejected ? `<div class="alert warn" role="note">Your last GCash payment was rejected: ${esc(rejected)}</div>` : ''}
    <div class="dmg-pay">
    <div id="lt-gc" class="dmg-gc">
      <div class="gq">
        <img id="lt-qr" alt="GCash QR code to scan" hidden>
        <p class="mut" id="lt-qn">Scan this QR code with GCash and pay <b>${peso(owed)}</b>. Then attach the screenshot and enter the reference number from your GCash receipt. Prefer cash? Pay at the studio instead.</p>
      </div>
      ${gcashProofHtml('lt')}
      <label for="lt-g">GCash reference number <span class="req" aria-hidden="true">*</span></label>
      <input id="lt-g" data-gcash-ref placeholder="13-digit reference" inputmode="numeric" required aria-required="true">
    </div>
    <div class="alert" id="lt-e" role="alert" hidden></div>
    <div class="acts">
      <button class="btn line" data-close>Close</button>
      <button class="btn gold" id="lt-go">Send GCash payment</button>
    </div>
    </div>`);
    const qr = $('#lt-qr');
    qr.onload = () => {
        qr.hidden = false;
    };
    qr.onerror = () => {
        qr.hidden = true;
        $('#lt-qn').innerHTML = `Pay <b>${peso(owed)}</b> using the studio's GCash account, then attach the screenshot and enter the reference number from your receipt. Ask staff if you need the account details.`;
    };
    qr.src = gcashQrUrl();
    const proof = initGcashProof('lt', { ref: '#lt-g' });
    const rules = () => [
        ['#lt-ss', () => check.file(proof.file(), 'Attach a screenshot of your GCash payment.')],
        ['#lt-g', () => check.gcashRef($('#lt-g').value)]
    ];
    liveCheck(rules());
    const err = t => {
        const box = $('#lt-e');
        box.textContent = t;
        box.hidden = !t;
    };
    const go = $('#lt-go');
    go.addEventListener('click', async () => {
        err('');
        if (!applyChecks(rules().map(([t, rule]) => [t, rule()])))
            return;
        const gcash = $('#lt-g').value.replace(/\s/g, '');
        const yes = await askConfirm({
            title: 'Send your GCash payment?',
            message: `You paid ${peso(owed)} by GCash for the late fee of ${order.ref}. Staff will check the reference number ${gcash} and the screenshot.`,
            ok: 'Yes, send payment',
            cancel: 'Not now'
        });
        if (!yes)
            return;
        btnBusy(go, 'Sending…');
        const up = await uploadGcashProof(proof.file(), gcash);
        if (up.error) {
            btnReset(go);
            return err('Could not upload your GCash screenshot: ' + up.error.message);
        }
        const { error } = await sb.rpc('customer_pay_late_fee', { p_rental_ref: rentalRef, p_gcash_reference: gcash });
        if (error) {
            btnReset(go);
            return err(/schema cache|could not find/i.test(error.message || '') ? 'Paying online is not available yet. Please pay at the studio.' : error.message);   // for example the GCash reference was already used
        }
        await btnSuccess(go, 'Sent', { keep: true });
        dlg.close();
        await loadMyRentals();
        toast('Payment sent. Staff will check it and mark your late fee as paid.');
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
    onPayDamage(ref => (damageOwed(ref) > 0 ? startDamagePay(ref) : startLatePay(ref)));   // the Pay now button in the "booking paused" notice opens the GCash dialog of the fee that is still unpaid
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
