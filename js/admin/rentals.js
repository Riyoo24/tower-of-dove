/* =====================================================================
   admin/rentals.js - Rentals tab
   DB: rental tables (approve, issue, return, reject), signed ID image links.
   ===================================================================== */

import { afterAction, balanceOf, closeOverlays, findBk, startLabel } from './bookings.js';
import { PAY, RL, refresh } from './data.js';
import { state } from './state.js';
import { ACT, CONFIRM, dOf, dayDiff, money, num, rnStatus, run, tOf, tbl, tblGrouped } from './helpers.js';
import { dueToday } from './overview.js';
import { openActionMenu } from '../shared/actionMenu.js';
import { sb } from '../config/supabaseClient.js';
import { loadCatalog } from '../shared/catalog.js';
import { $, badge, esc, pl, shortDate, sum, toast } from '../shared/utils.js';

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
const rnBadge = g => {
    const s = groupStatus(g);
    if (s !== 'Verified')
        return badge(s);
    const bal = rentalBalance(g);
    return bal > 0.005 ? `<span class="b balancedue">Balance ${money(bal)}</span>` : badge('Fully Paid');
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

/* The choices of a rental's Actions menu. The primary action (Verify, Issue, Process return) comes first. */
function rnMenuItems(g) {
    const item = (act, label) => ({ act, id: g.ref, label });
    if (needsVerify(g))
        return [item('rn-verify', 'Verify')];            // opens the Verify window in the Payments tab
    if (g.status === 'Approved')
        return [item('rn-issue', issueLabel(g)), item('rn-det', 'Details')];
    if (g.status === 'Active')
        return [item('rn-ret', 'Process return'), item('rn-det', 'Details')];
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

export function renderRentals() {
    const gs = groups();
    const list = gs.filter(g => gMatch(g, rf) && (!rsrc || g.source === rsrc)).sort(rnOrder);
    if (rf === 'Overdue')
        list.sort((a, b) => Math.max(...b.lines.map(overdueHours)) - Math.max(...a.lines.map(overdueHours)));
    const cnt = f => f === 'Overdue' ? ' (' + gs.filter(g => gMatch(g, 'Overdue')).length + ')' : f === 'Pending' ? ' (' + gs.filter(g => g.status === 'Pending').length + ')' : '';
    const head = ['Order', 'Customer', 'Items', 'Rent type', 'Status', 'Actions'];
    const cells = g => [
        esc(g.type === 'Add-on' ? (g.booking || g.ref) : g.ref),   // plain text, like the Bookings and Payments tables (open it from Actions)
        esc(g.customer),
        g.lines.length === 1 ? esc(g.lines[0].equipment_name) + ' x' + g.lines[0].quantity : g.lines.length + ' items',
        TYB[g.type],
        rnBadge(g),
        rnActions(g)
    ];
    let table;
    if (rf === 'All') {
        // Like the customer's My rental: open orders first, Returned / Rejected / Cancelled tucked into a closed "Past and closed" group
        const open = list.filter(g => !isClosedRn(g)), past = list.filter(isClosedRn);
        table = tblGrouped(head, [
            { title: 'In use and upcoming', rows: open.map(cells) },
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
const isClosedRn = g => ['Returned', 'Rejected', 'Cancelled'].includes(g.status);

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
    message: `${rnWho(ref)} will be marked as Verified.`,
    ok: 'Yes, approve'
});
/* Issue equipment (CONFIRM / ACT 'rn-issue') lives in balance.js: it collects and verifies the remaining balance first. */
CONFIRM['rn-ret'] = ref => ({
    title: 'Process the return?',
    message: `All equipment in ${rnWho(ref)} will be marked as returned and put back in stock. Any late fee is worked out now.`,
    ok: 'Yes, process return'
});
CONFIRM['rn-retline'] = id => {
    const [ref, eid] = id.split(':'), l = RL.find(x => x.rental_ref === ref && x.equipment_id === +eid);
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

ACT['rn-ret'] = async ref => {
    if (!(await run(sb.rpc('staff_return_rental', {
        p_rental_ref: ref,
        p_equipment_id: null
    }))))
        return;
    await loadCatalog();
    await refresh();
    closeOverlays();
    toast(returnedMsg(ref, null, ref));
};

ACT['rn-retline'] = async id => {
    const [ref, eid] = id.split(':');
    if (!(await run(sb.rpc('staff_return_rental', {
        p_rental_ref: ref,
        p_equipment_id: +eid
    }))))
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
export async function loadRentalId(ref, boxId = 'rn-id') {
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
            : `<a href="${s.signedUrl}" target="_blank" rel="noopener" title="Open full size"><img class="idimg" src="${s.signedUrl}" alt="Customer ID photo"></a><p class="mut">Click the photo to open it full size.</p>`);
}
