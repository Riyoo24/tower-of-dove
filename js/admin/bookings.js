/* =====================================================================
   admin/bookings.js - Bookings tab
   Search / filter, confirm, start, complete, cancel.
   DB: table booking (status updates).
   ===================================================================== */

import { state } from './state.js';
import { BK, EXT, PAY, RL, refresh } from './data.js';
import {
    ACT,
    CONFIRM,
    OWNER,
    askConfirm,
    bkStatus,
    btn,
    dOf,
    dlg,
    emptyState,
    isFull,
    money,
    notifyVerified,
    num,
    payLabel,
    payWord,
    run,
    showDlg,
    stampLabel,
    tOf,
    tabsHtml,
    tbl,
    tblGrouped
} from './helpers.js';
import { arrivalText, checkInOf, checkInReady, needsCheckIn } from './checkInInfo.js';
import { loadGcashShots, payBlock, vdr } from './verify.js';
import { bookingTrail } from './trail.js';
import { focusRows, rowMark } from './jump.js';
import { repFlag } from './reputation.js';
import { openActionMenu } from '../shared/actionMenu.js';
import { holdCountdown } from '../shared/holdTimer.js';
import { SUPABASE_ANON_KEY, SUPABASE_URL, sb } from '../config/supabaseClient.js';
import { $, badge, esc, longDate, pl, shortDate, toast } from '../shared/utils.js';
import { btnBusy, btnReset, btnSuccess } from '../shared/btnState.js';

/* Row order in the Bookings table: Pending bookings first, then the other open ones, the soonest session on top inside each;
   finished ones (Completed, Cancelled, Rejected) after them, the most recent first. */
const bkOrder = (a, b) => {
    const ca = isClosedBk(a), cb = isClosedBk(b);
    if (ca !== cb)
        return ca ? 1 : -1;
    if (!ca && (a.status === 'Pending') !== (b.status === 'Pending'))
        return a.status === 'Pending' ? -1 : 1;   // Pending bookings stay at the top
    const diff = new Date(a.start_at) - new Date(b.start_at);
    return ca ? -diff : diff;
};

const BK_TABS = ['All', 'Pending', 'Confirmed', 'Active', 'Completed', 'Cancelled', 'Rejected'];

export const findBk = ref => BK.find(b => b.booking_ref === ref);

/* the customer's extension request for this booking that still waits for its down payment to be verified */
export const pendingExt = ref => EXT.find(x => x.booking_ref === ref && x.status === 'Pending');

/* The choices of a booking's Actions menu. The primary action (Verify, Start session, Mark completed) comes first. */
function bkMenuItems(b) {
    const id = b.booking_ref, item = (act, label, danger, itemId = id) => ({ act, id: itemId, label, danger });
    if (b.status === 'Pending')
        return [item('bk-verify', 'Verify')];   // opens the Verify drawer in the Payments tab
    const px = pendingExt(id),
        ext = px ? item('ext-verify', 'Verify extension', false, px.extension_id) : item('bk-ext', 'Extend');   // a customer's extension request comes first
    /* Check in: when the customer arrived (a record only). The owner can undo a mistake. */
    const open = checkInReady() && ['Approved', 'In Progress'].includes(b.status),
        ci = open && !checkInOf(id) ? [item('bk-checkin', 'Check in')] : [],
        undo = open && checkInOf(id) && OWNER ? [item('bk-uncheckin', 'Undo check-in')] : [];
    if (b.status === 'Approved')
        // Start session / Collect balance & start is offered only after the customer has checked in
        return [...ci, ...(needsCheckIn(id) ? [] : [item('bk-go', startLabel(b))]), ext, item('bk-det', 'Details'), ...undo, item('bk-cx', 'Cancel booking', true)];
    if (b.status === 'In Progress')
        return [item('bk-done', doneLabel(b)), ext, ...ci, item('bk-det', 'Details'), ...undo];
    return [item('bk-det', 'Details')];
}

const bkActions = b => `<button type="button" class="btn sm line menu-btn" data-bkmenu="${esc(b.booking_ref)}" aria-haspopup="menu" aria-expanded="false">Actions <span aria-hidden="true">&#9662;</span></button>`;

document.addEventListener('click', e => {
    const menuButton = e.target.closest('[data-bkmenu]');
    const b = menuButton && findBk(menuButton.dataset.bkmenu);
    if (b)
        openActionMenu(menuButton, bkMenuItems(b));
});

/* One-line text: long names are cut with "..." (CSS .cut) and the full text shows on hover */
const cut = t => `<span class="cut" title="${esc(t)}">${esc(t)}</span>`;

export function renderBookings() {
    const q = ($('#bk-q').value || '').toLowerCase(),
        sid = $('#bk-s').value,
        d = $('#bk-d').value,
        src = $('#bk-src').value;
    const rows = BK.filter(b =>
        (state.bkF === 'All' || bkStatus(b.status) === state.bkF) &&
        (!q || `${b.booking_ref} ${b.customer_name} ${b.customer_number || ''}`.toLowerCase().includes(q)) &&
        (!sid || String(b.studio_id) === sid)
        && (!d || dOf(b.start_at) === d)
        && (!src || b.source === src))
        .sort(bkOrder);
    const ci = checkInReady();   // the Arrived column needs 87_booking_check_in.sql
    const head = ['Reference', 'Customer', 'Studio', 'Date', 'Time', 'Duration', ...(ci ? ['Arrived'] : []), 'Status', 'Payment', 'Actions'];
    const cells = b => [
        `<span ${rowMark(b.booking_ref)}>${esc(b.booking_ref)}</span>`,
        cut(b.customer_name) + repFlag(b.customer_id, 'booking') + (b.is_guest ? ' <span class="mut">(guest)</span>' : ''),
        cut(b.studio_name),
        shortDate(dOf(b.start_at)),
        tOf(b.start_at),
        pl(Math.round(num(b.hours)), 'hr'),
        ...(ci ? [arrivedCell(b)] : []),
        badge(bkStatus(b.status)),
        payCell(b),
        bkActions(b)
    ];
      // nothing to show: say why, and offer the next step
    const filtered = state.bkF !== 'All' || !!(q || sid || d || src);
    const empty = filtered
        ? emptyState({
            title: d && !q && !sid && !src && state.bkF === 'All' ? `No bookings on ${shortDate(d)}` : 'No bookings match these filters',
            hint: 'Try a different search, date or status.',
            action: btn('bk-clear', '', 'Clear filters', 1) + (d ? ' <a class="btn sm gold" href="#a-onb">Record an onsite booking</a>' : '')
        })
        : emptyState({
            title: 'No bookings yet',
            hint: 'Online bookings appear here as customers book. Walk-ins can be recorded at the counter.',
            action: '<a class="btn sm gold" href="#a-onb">Record an onsite booking</a>'
        });
    let table;
    if (state.bkF === 'All') {
        // Like the customer's My bookings: open bookings first, Completed / Cancelled / Rejected tucked into a closed "Past and closed" group.
        // Searching or picking a date opens it, so a result is never hidden.
        const open = rows.filter(b => !isClosedBk(b)), past = rows.filter(isClosedBk);
        table = tblGrouped(head, [
            { title: 'Active and upcoming', rows: open.map(cells) },
            {
                title: 'Past and closed',
                toggle: 'bk',
                collapsed: !state.pastOpen.bk && !q && !d,
                rows: past.map(cells),
                dimmed: i => ['Cancelled', 'Rejected'].includes(bkStatus(past[i].status))
            }
        ], 'bk-tbl', empty);
    } else
        table = tbl(head, rows.map(cells), 'bk-tbl', empty);   // a status tab is picked on purpose: show all of its rows
    $('#abk').innerHTML = tabsHtml(BK_TABS, state.bkF, 'bf') + table;
}

/* a booking that is over: Completed, Cancelled or Rejected */
const isClosedBk = b => ['Completed', 'Cancelled', 'Rejected'].includes(b.status);

$('#abk').addEventListener('click', e => {
    if (e.target.closest('[data-toggle="bk"]')) {
        state.pastOpen.bk = !state.pastOpen.bk;
        return renderBookings();
    }
    const t = e.target.closest('[data-bf]');
    if (t) {
        state.bkF = t.dataset.bf;
        renderBookings();
    }
});

['#bk-q', '#bk-s', '#bk-d', '#bk-src'].forEach(s => $(s).addEventListener('input', renderBookings));

/* Used by the Overview cards: show the Bookings tab with this status tab and optional date,
   clearing the search box, studio and source filters so the list matches the card's number.
   openPast = also open the "Past and closed" group (the Total bookings card counts every booking). */
export function setBookingFilter(status, date, openPast) {
    ACT['bk-clear'] = () => setBookingFilter('All');   // "Clear filters" in the empty state
    state.bkF = BK_TABS.includes(status) ? status : 'All';
    if (openPast)
        state.pastOpen.bk = true;
    $('#bk-q').value = '';
    $('#bk-s').value = '';
    $('#bk-src').value = '';
    $('#bk-d').value = date || '';
    renderBookings();
}

/* Used by the links in the Payments tab: show the Bookings tab with this booking highlighted.
   Search, studio, date and source filters are cleared and the status tab is set to All, so the row is never hidden. */
export function revealBooking(ref) {
    const b = findBk(ref);
    state.bkF = 'All';
    ['#bk-q', '#bk-s', '#bk-d', '#bk-src'].forEach(s => { $(s).value = ''; });
    if (b && isClosedBk(b))
        state.pastOpen.bk = true;
    renderBookings();
    focusRows('a-book', '#abk', ref);
}

/* the small dialog and the Verify drawer both close after an action */
export const closeOverlays = () => {
    if (dlg.open && !dlg.dataset.locked)
        dlg.close();
    if (vdr.open)
        vdr.close();
};

export const afterAction = async msg => {
    await refresh();
    closeOverlays();
    if (msg)
        toast(msg);
};

const setBooking = (b, status, extra) => run(sb.from('booking').update({
    status,
    ...(extra || {})
}).eq('booking_id', b.booking_id));

/* Verifying a booking payment also approves its add-on equipment (done by the database).
   These two helpers only choose the message shown afterwards. */
export const pendingAddons = ref => RL.some(l => l.booking_ref === ref && l.rental_type === 'Add-on' && l.status === 'Pending');

export const verifiedMsg = (ref, had) => !had ? `${ref} confirmed. Payment verified.`
    : pendingAddons(ref) ? `${ref} confirmed. Some add-on equipment is still pending (not enough stock). Check the Rentals tab.`
        : `${ref} confirmed. Add-on equipment approved too.`;

const bkWho = b => `${b.booking_ref} (${b.customer_name}, ${b.studio_name}, ${shortDate(dOf(b.start_at))} ${tOf(b.start_at)})`;

CONFIRM['bk-ok'] = ref => {
    const b = findBk(ref);
    return {
        title: b.payment_id ? 'Verify this payment?' : 'Confirm this booking?',
        message: `${bkWho(b)} will be marked as confirmed. Only continue if you checked the payment.`,
        ok: b.payment_id ? 'Yes, verify payment' : 'Yes, confirm booking'
    };
};
/* the reason picked in the Verify window (required; "Other" needs a message). The customer sees it. */
function bkReason() {
    const sel = $('#v-reason');
    if (!sel)
        return null;
    const text = sel.value === 'Other' ? ($('#v-other').value || '').trim() : sel.value;
    return text.length >= 3 ? text : null;
}

CONFIRM['bk-no'] = ref => {
    const why = bkReason();
    if (!why)
        throw new Error('Describe the reason for rejecting this booking. The customer will see it.');
    return {
        title: 'Reject this booking?',
        message: `${bkWho(findBk(ref))} will be rejected and the time slot is released. The customer will see this reason: "${why}"`,
        ok: 'Yes, reject',
        danger: true
    };
};
/* what the customer already paid with GCash for add-on equipment added later (each order is paid separately) */
export const addonPaidOf = ref => {
    const paid = {};
    RL.filter(l => l.booking_ref === ref && l.rental_type === 'Add-on' && !['Rejected', 'Cancelled'].includes(l.status))
        .forEach(l => {
            paid[l.rental_ref] = num(l.down_payment) + num(l.balance_paid_amount);   // paid online + balance staff collected
        });
    return Object.values(paid).reduce((n, v) => n + v, 0);
};
export const balanceOf = b => {
    // the database works out the exact balance (v_booking_summary.balance_due, 32_balance_collection.sql);
    // the formula below is only the fallback while that file has not been run yet
    if (b.balance_due !== undefined && b.balance_due !== null)
        return num(b.balance_due);
    const ad = RL.filter(l => l.booking_ref === b.booking_ref && l.rental_type === 'Add-on' && !['Rejected', 'Cancelled'].includes(l.status));
    if (num(b.down_payment) <= 0) {
        // booking paid in full when it was made: only add-ons added later with their own down payment can leave a balance
        const own = {};
        ad.filter(l => num(l.down_payment) > 0).forEach(l => {
            own[l.rental_ref] = (own[l.rental_ref] || 0) + num(l.unit_price_at_request) * l.quantity;
        });
        return Object.keys(own).reduce((n, ref) => {
            const l0 = ad.find(l => l.rental_ref === ref);
            return n + Math.max(0, own[ref] - num(l0.down_payment) - num(l0.balance_paid_amount));
        }, 0);
    }
    return Math.max(0, num(b.total_amount) + ad.reduce((n, l) => n + num(l.unit_price_at_request) * l.quantity, 0) - num(b.down_payment) - addonPaidOf(b.booking_ref) - num(b.balance_paid_amount));
};

/* a confirmed booking whose customer still owes the balance: Start session opens the balance window first */
export const owesBalance = b => b.status === 'Approved' && balanceOf(b) > 0.005;   // also a fully paid booking whose later add-on still has a balance
export const startLabel = b => owesBalance(b) ? 'Collect balance & start' : 'Start session';

/* an Active session that still owes a balance (e.g. the extra hours of an extension) is NOT completed by itself (86_block_autocomplete_with_balance.sql):
   Mark completed collects the balance first (balance.js) */
export const owesOnComplete = b => !!b && b.status === 'In Progress' && balanceOf(b) > 0.005;
export const doneLabel = b => owesOnComplete(b) ? 'Collect balance & complete' : 'Mark completed';

/* Arrived column: the time the customer checked in, with early / late under it; a dash when not (yet) checked in */
const arrivedCell = b => {
    if (!checkInOf(b.booking_ref))
        return '<span class="mut">-</span>';
    const [at, when] = arrivalText(b).split(', ');
    return `${esc(at)}<br><span class="mut">${esc(when)}</span>`;
};

/* Payment column: the payment status plus what is still to collect / that it became a full payment */
export const payCell = b => {
    const stat = b.payment_status || 'Pending';
    if (stat !== 'Verified')
        return badge(stat);   // Pending / Rejected stay as they are
    // verified: either something is still to collect at the studio ("Balance PHP x") or it is paid in full ("Fully Paid")
    const left = ['Approved', 'In Progress'].includes(b.status) && balanceOf(b) > 0.005;   // includes the balance of add-ons added later
    return left ? `<span class="b balancedue">Balance ${money(balanceOf(b))}</span>` : badge('Fully Paid');
};

/* Start session (CONFIRM / ACT 'bk-go') lives in balance.js: it collects and verifies the remaining balance first. */
CONFIRM['bk-done'] = ref => ({
    title: 'Mark this session as completed?',
    message: `${bkWho(findBk(ref))} will be marked Completed.`,
    ok: 'Yes, mark completed'
});
CONFIRM['bk-cx'] = ref => ({
    title: 'Cancel this booking?',
    message: `${bkWho(findBk(ref))} will be cancelled and the time slot is released. This can't be undone.`,
    ok: 'Yes, cancel booking',
    cancel: 'No, keep it',
    danger: true
});

ACT['bk-ok'] = async ref => {
    const b = findBk(ref), had = pendingAddons(ref);
    const r = b.payment_id ? await run(sb.from('payment').update({ status: 'Verified' }).eq('payment_id', b.payment_id)) : await setBooking(b, 'Approved');
    if (r) {
        if (b.payment_id)
            notifyVerified(b.payment_id);   // email the customer (does not wait)
        await refresh();
        closeOverlays();
        toast(verifiedMsg(ref, had));
    }
};

ACT['bk-no'] = async ref => {
    const why = bkReason();
    if (!why)
        return toast('Describe the reason for rejecting this booking.');
    if (await run(sb.rpc('staff_reject_booking', {
        p_booking_ref: ref,
        p_reason: why
    })))
        afterAction(`${ref} rejected. The customer can see the reason.`);
};

ACT['bk-done'] = async ref => {
    if (await setBooking(findBk(ref), 'Completed'))
        afterAction(`${ref} marked completed.`);
};

ACT['bk-cx'] = async ref => {
    if (await run(sb.rpc('cancel_booking', { p_booking_ref: ref })))
        afterAction(`${ref} cancelled.`);
};

/* ---- Extend a Confirmed or Active booking (the Studio sessions tab uses this same button) ----
   The database checks the schedule after the current end time (next booking, someone holding the slot,
   studio closed or 10:00 PM closing) and says how many extra hours are free. Cost = hourly rate x extra hours,
   added to the bill. The customer's booking page shows the new end time and total on its own. */
const hrs = h => `${h} hour${h > 1 ? 's' : ''}`;

/* While the Extend window is open the extra hours are HELD on the server (2 minutes, renewed every minute).
   Customers see them as "Held by Staff" and other staff cannot extend the same slot. The hold is released
   when the window closes, the extension is saved, or the page is left. */
let extToken = null;

window.addEventListener('pagehide', () => {
    if (!extToken)
        return;
    try {
        fetch(SUPABASE_URL + '/rest/v1/rpc/release_hold', {
            method: 'POST',
            keepalive: true,
            headers: {
                'Content-Type': 'application/json',
                apikey: SUPABASE_ANON_KEY,
                Authorization: 'Bearer ' + SUPABASE_ANON_KEY
            },
            body: JSON.stringify({ p_token: extToken })
        });
    } catch (e) {
        /* ignore */
    }
});

ACT['bk-ext'] = async ref => {
    const b = findBk(ref), token = 'x' + crypto.randomUUID();
    showDlg(`<h2 style="margin:0 0 8px">Extend ${esc(ref)}</h2><p class="mut">Checking the schedule for ${esc(b.studio_name)}...</p>`);
    const r = await run(sb.rpc('staff_extension_info', {
        p_booking_ref: ref,
        p_token: token
    }));
    const info = r && (Array.isArray(r.data) ? r.data[0] : r.data);
    if (!info) {
        dlg.close();
        return;
    }
    const rate = num(info.hourly_rate),
        end = new Date(info.current_end_at).getTime(),
        lo = info.min_hours,
        hi = info.max_hours,
        addonHi = info.addon_max_hours == null ? info.max_hours : info.addon_max_hours;   // extra hours the add-on equipment is free for (file 55)
    const summary = `<dl class="dl"><dt>Customer</dt><dd>${esc(b.customer_name)}</dd><dt>Studio</dt><dd>${esc(b.studio_name)}</dd>
    <dt>Current session</dt><dd>${tOf(b.start_at)} to ${tOf(end)} (${pl(Math.round((end - new Date(b.start_at)) / 36e5), 'hr')})</dd><dt>Rate</dt><dd>${money(rate)} per hour</dd></dl>`;

    if (hi < lo) {
        // blocked: show why
        showDlg(`<h2 style="margin:0 0 8px">Extend ${esc(ref)}</h2>${summary}
      <div class="alert" role="alert"><b>${esc(info.message || 'Cannot extend this session.')}</b></div>
      <div class="acts"><button type="button" class="btn line" data-close>Close</button></div>`);
        return;
    }

    const opts = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
    showDlg(`<div class="row" style="margin-bottom:8px"><h2 style="margin:0">Extend ${esc(ref)}</h2><span class="mut" id="hold-left" hidden></span></div>${summary}
    ${info.message ? `<div class="alert" style="background:var(--warn-bg);color:var(--warn)">${esc(info.message)}</div>` : ''}
    <div class="alert" id="ex-addon" role="status" style="background:var(--warn-bg);color:var(--warn)" hidden></div>
    <label for="ex-h">Extra time</label>
    <select id="ex-h">${opts.map(h => `<option value="${h}">+${hrs(h)} (${money(rate * h)})</option>`).join('')}</select>
    <dl class="dl" style="margin-top:10px"><dt>New end time</dt><dd id="ex-end"></dd><dt>Extra cost</dt><dd id="ex-cost"></dd><dt>New studio total</dt><dd id="ex-tot"></dd></dl>
    <p class="mut" id="ex-hold" style="margin:6px 0">Holding the time...</p>
    <div class="alert" id="ex-e" role="alert" hidden></div>
    <div class="acts"><button type="button" class="btn line" data-close>Cancel</button><button type="button" class="btn gold" id="ex-go" disabled>Extend session</button></div>`);

    const sel = $('#ex-h'), err = m => {
        $('#ex-e').textContent = m;
        $('#ex-e').hidden = !m;
    };
    let chain = Promise.resolve(), holding = false, done = false;
    const queue = fn => {
        const p = chain.then(fn);
        chain = p.catch(() => {
        });
        return p;
    };   // hold calls run one after another

    /* hold (or renew, or move) the selected hours */
    const hold = () => queue(async () => {
        if (done)
            return;
        const h = +sel.value;
        const { error } = await sb.rpc('staff_hold_extension', {
            p_booking_ref: ref,
            p_extra_hours: h,
            p_token: token
        });
        if (done)
            return;
        holding = !error;
        $('#ex-go').disabled = !holding || $('#ex-go').classList.contains('is-busy');
        if (error) {
            err(error.message);
            $('#ex-hold').textContent = 'The time is not held.';
            return;
        }
        err('');
        $('#ex-hold').innerHTML = `<b>Held by Staff:</b> ${tOf(end)} to ${tOf(end + h * 36e5)} is reserved for you while this window is open. Customers and other staff see it as held.`;
    });

    const preview = () => {
        const h = +sel.value, box = $('#ex-addon');
        box.hidden = !(h > addonHi);
        if (!box.hidden)
            box.innerHTML = `<b>The add-on equipment of this booking is not free for the extra time.</b> ${esc(info.addon_message || '')} The session can still be extended, but the add-on will <b>not</b> be included in the extra hours. You will be asked to confirm.`;
        $('#ex-end').textContent = tOf(end + h * 36e5);
        $('#ex-cost').textContent = money(rate * h);
        $('#ex-tot').textContent = money(num(b.total_amount) + rate * h);
    };

    extToken = token;
    const timer = setInterval(hold, 60000);
    // same 2-minute idle rule as the customer booking form
    const stopIdle = holdCountdown(dlg, {
        label: $('#hold-left'),
        onExpire: () => {
            dlg.close();
            toast('Extend window closed after 2 minutes of inactivity. The held hours were released.');
        }
    });
    dlg.addEventListener('close', () => {
        // any way of closing the window frees the hold
        done = true;
        clearInterval(timer);
        stopIdle();
        extToken = null;
        queue(async () => {
            try {
                await sb.rpc('release_hold', { p_token: token });
            } catch (e) {
                /* ignore */
            }
        });
    }, { once: true });

    sel.addEventListener('change', () => {
        preview();
        $('#ex-go').disabled = true;
        hold();
    });
    preview();
    hold();

    $('#ex-go').addEventListener('click', async () => {
        const h = +sel.value;
        err('');
        // the equipment added to this booking is not free for the extra hours: extend the booking only, without the add-on
        const noAddon = h > addonHi;
        if (noAddon) {
            const okAddon = await askConfirm({
                title: 'Extend without the add-on?',
                message: `The equipment added to ${ref} is not available for the extra time. If you continue, only the studio session is extended, until ${tOf(end + h * 36e5)}. The add-on is NOT recorded for the extra hours and must be returned when the current time ends (${tOf(end)}).`,
                ok: 'Yes, extend without add-on'
            });
            if (!okAddon)
                return;
        }
        const yes = await askConfirm({
            title: 'Extend this session?',
            message: `${ref} (${b.customer_name}, ${b.studio_name}) will be extended by ${hrs(h)}, until ${tOf(end + h * 36e5)}. ${money(rate * h)} is added to the bill.`,
            ok: 'Yes, extend session'
        });
        if (!yes)
            return;
        const exGo = $('#ex-go');
        btnBusy(exGo, 'Extending…');
        const { data, error } = await sb.rpc('staff_extend_booking', {
            p_booking_ref: ref,
            p_extra_hours: h,
            p_token: token,
            p_without_addons: noAddon
        });
        if (error) {
            btnReset(exGo, false);   // hold() below enables it again when the hours are still held
            err(error.message);
            hold();
            return;
        }   // for example the hold expired and someone booked the hour
        await btnSuccess(exGo, 'Extended', { keep: true });
        const row = Array.isArray(data) ? data[0] : data;
        await refresh();
        closeOverlays();
        toast(`${ref} extended by ${hrs(h)} until ${tOf(row.new_end_at)}. ${money(row.extra_cost)} added to the bill. Collect it from the customer.${row.addon_dropped ? ` The add-on was not extended: collect the equipment back at ${tOf(end)}.` : ''}`);
    });
};

/* Booking details (Bookings tab). Same sections as the Verify drawer in Payments: the payment itself (method, GCash reference and
   screenshot, balance collected, status), then the History dropdown (bookingTrail) built from the dates the database keeps. */
ACT['bk-det'] = ref => {
    const b = findBk(ref);
    const ad = RL.filter(l => l.booking_ref === ref && l.rental_type === 'Add-on' && !['Rejected', 'Cancelled'].includes(l.status));
    const pay = PAY.find(p => p.reference === ref && p.kind !== 'Extension');
    const exts = EXT.filter(x => x.booking_ref === ref && x.status !== 'Rejected');
    const col = num(b.balance_paid_amount),            // balance collected by staff (the payment then became a full payment)
        down = num(b.down_payment),
        full = col > 0 ? false : isFull(pay ? pay.payment_option : b.payment_option),
        adTotal = ad.reduce((n, l) => n + num(l.unit_price_at_request) * l.quantity, 0),
        grand = num(b.total_amount) + adTotal,
        addPaid = addonPaidOf(ref),
        balance = balanceOf(b);
    const amount = `<div class="dr-sum"><div><span>Studio</span><span>${money(b.total_amount)}</span></div>${adTotal ? `<div><span>Add-on equipment</span><span>${money(adTotal)}</span></div>` : ''}<div class="tot-line"><b>Booking total</b><b>${money(grand)}</b></div>
    ${down > 0 ? `<div><span>${payLabel(full ? 'full' : 'down')}</span><span>${money(down)}</span></div>${addPaid > 0 ? `<div><span>Equipment added later, paid</span><span>${money(addPaid)}</span></div>` : ''}${col > 0 ? `<div><span>Balance collected${b.balance_paid_method ? ' (' + esc(b.balance_paid_method) + ')' : ''}</span><span>${money(col)}</span></div>` : ''}<div><span>Balance to collect at the studio</span>${balance > 0.005 ? `<b style="color:var(--warn)">${money(balance)}</b>` : '<b>Paid in full</b>'}</div>`
        : balance > 0.005 ? `${addPaid > 0 ? `<div><span>Equipment added later, paid</span><span>${money(addPaid)}</span></div>` : ''}<div><span>Add-on balance to collect</span><b style="color:var(--warn)">${money(balance)}</b></div>`
        : pay ? `<div><span>Amount to pay</span><b>${money(pay.amount)}</b></div>` : ''}</div>`;
    showDlg(`<div class="dr" style="padding:0">
    <div class="row"><div><p class="mut" style="margin:0">Booking details</p><h2 style="margin:0">${esc(b.booking_ref)}</h2></div><button type="button" class="btn sm line" data-close aria-label="Close">Close</button></div>
    <div><span class="mut">Booking</span> ${badge(bkStatus(b.status))} ${pay ? `<span class="mut">Payment</span> ${badge(pay.status)}` : ''}</div>
    <h3>Customer</h3><dl class="dl"><dt>Name</dt><dd>${esc(b.customer_name)}${b.is_guest ? ' <span class="mut">(guest)</span>' : ''}</dd><dt>Phone</dt><dd>${esc(b.customer_number || 'Not on file')}</dd></dl>
    <h3>Booking</h3><dl class="dl"><dt>Studio</dt><dd>${esc(b.studio_name)}</dd><dt>Date</dt><dd>${longDate(dOf(b.start_at))}</dd>
    <dt>Time</dt><dd>${tOf(b.start_at)} to ${tOf(b.end_at)} (${pl(Math.round(num(b.hours)), 'hr')})</dd>
    ${checkInReady() ? `<dt>Arrived</dt><dd>${checkInOf(ref) ? `${esc(arrivalText(b))}${checkInOf(ref).by_name ? ` <span class="mut">(checked in by ${esc(checkInOf(ref).by_name)})</span>` : ''}` : '<span class="mut">Not checked in</span>'}</dd>` : ''}
    ${ad.length ? `<dt>Add-ons</dt><dd>${ad.map(l => esc(l.equipment_name) + ' x' + l.quantity + ' (' + money(num(l.unit_price_at_request) * l.quantity) + ')').join('<br>')}</dd>` : ''}
    ${exts.map(x => `<dt>Extension</dt><dd>+${pl(x.extra_hours, 'hr')} (${money(x.extra_cost)}), ${payWord(x.payment_option)} ${money(x.down_payment)} ${badge(x.status === 'Approved' ? 'Verified' : 'Pending')}${x.status === 'Approved' ? ' <span class="mut">included in the total</span>' : ' <span class="mut">not in the total yet</span>'}</dd>`).join('')}
    <dt>Source</dt><dd>${esc(b.source)}</dd></dl>
    <h3>Amount</h3>${amount}
    <h3>${down > 0 ? (col > 0 ? 'Fully paid' : full ? 'Full payment' : 'Down payment') : 'Payment'}</h3>${payBlock(pay, down > 0 ? down : grand)}
    ${b.status === 'Rejected' ? `<h3>Reason for rejection</h3><div class="alert">${esc(b.rejected_reason || 'No reason was recorded.')}</div>` : ''}
    ${bookingTrail(b, pay)}
    <div class="acts"><button class="btn line" data-close>Close</button></div></div>`);
    loadGcashShots(dlg);
};

