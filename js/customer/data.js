/* =====================================================================
   customer/data.js - loads the signed-in customer's data
   DB: customer (profile), bookings, add-ons and rentals of the logged-in user.
   Guests keep their booking references in localStorage; they are moved to the account on login.
   ===================================================================== */

import { notifyStatusChanges } from './alerts.js';
import { loadGrace, loadReleases } from './noShow.js';
import { loadSwapOffers } from './swapChoice.js';
import { state } from './state.js';
import { sb } from '../config/supabaseClient.js';
import { renderMyBookings } from './myBookings.js';
import { applyAccessMode, renderMyRentals } from './myRentals.js';
import { fmtDT, renderAttachOptions } from './rent.js';
import { BOOKINGS } from '../shared/availability.js';
import { STUDIOS } from '../shared/catalog.js';
import { COLS, LIMIT, run } from '../shared/query.js';
import { claimableGuestBookings, forgetGuestBookings, guestBookings, keepGuestBookings } from '../shared/guestStore.js';
import { isMember } from '../shared/session.js';
import { SLOTS, endTime, esc, manilaParts, shortDate, toast } from '../shared/utils.js';

async function loadProfile() {
    if (!isMember())
        return;
    const { data: auth } = await sb.auth.getUser();
    if (!auth || !auth.user)
        return;
    const { data } = await sb.from('customer').select('first_name, last_name, number').eq('auth_user_id', auth.user.id).maybeSingle();
    if (data)
        state.PROFILE = {
            first: data.first_name || '',
            last: data.last_name || '',
            number: data.number || ''
        };
}

loadGrace();   // the grace minutes shown in the booking terms (customer/noShow.js)

export const profileReady = loadProfile().catch(() => {
});

export const BK_STATUS = {
    'Approved': 'Confirmed',
    'In Progress': 'Active'
};   // database -> labels used on this page

export const RN_STATUS = { 'Active': 'In Use' };

const studioLetter = dbId => (STUDIOS.find(s => s.dbId === dbId) || {}).id;

const fmtD = ts => ts ? shortDate(manilaParts(ts).date) : '';

/* Guests have no account, so their booking references are remembered in this browser (js/shared/guestStore.js).
   Everything else for guests is the reference lookup. When a guest registers or logs in, those
   bookings are moved onto the account (supabase/30_claim_guest_bookings.sql). */
const claimTried = new Set();

/* Ask the customer whether the guest bookings made on this device go onto the account.
   Resolves 'yes', 'no', or null when the window is closed with Esc / a click outside (ask again next time). */
const gq = document.createElement('dialog');
gq.className = 'dlg confirm';
gq.setAttribute('role', 'alertdialog');
gq.setAttribute('aria-label', 'Add guest bookings to your account?');
document.body.appendChild(gq);

function askAddGuest(list) {
    const rows = list.map(b => `<li><b>${esc(b.ref)}</b>${b.studio ? `, Studio ${esc(b.studio)}` : ''}${b.date ? `, ${esc(shortDate(b.date))}` : ''}${b.start ? ` ${esc(b.start)}` : ''}</li>`).join('');
    return new Promise(resolve => {
        let answer = null;
        gq.innerHTML = `<div class="in"><h2 style="margin:0 0 8px">Add your guest ${list.length === 1 ? 'booking' : 'bookings'} to your account?</h2>
      <p class="mut">You booked as a guest on this device:</p><ul style="margin:8px 0 8px 18px">${rows}</ul>
      <p class="mut"><b>Yes</b> shows it under My Bookings and My Rental (with its add-on equipment). <b>No</b> keeps it out of your account; you can still look it up with its booking reference.</p>
      <div class="acts"><button type="button" class="btn line" data-gq="no">No, don't add</button><button type="button" class="btn gold" data-gq="yes">Yes, add to my account</button></div></div>`;
        gq.onclick = e => {
            const b = e.target.closest('[data-gq]');
            if (b) {
                answer = b.dataset.gq;
                gq.close();
            }
        };
        gq.onclose = () => resolve(answer);
        gq.showModal();
        gq.querySelector('[data-gq="no"]').focus();   // Enter never adds by accident
    });
}

let guestAsk = null;   // one question at a time (the list reloads every minute)

async function claimGuestBookings() {
    if (!isMember())
        return;
    const list = claimableGuestBookings().filter(b => !claimTried.has(b.ref));
    if (!list.length)
        return;
    if (!guestAsk)
        guestAsk = askAddGuest(list).finally(() => {
            guestAsk = null;
        });
    const answer = await guestAsk;
    if (answer === 'no') {
        forgetGuestBookings(list.map(b => b.ref));   // not saved to the account, and not asked again
        toast('Your guest ' + (list.length === 1 ? 'booking was' : 'bookings were') + ' not added to your account.');
        return;
    }
    if (answer !== 'yes')
        return;
    const items = list.map(b => ({
        ref: b.ref,
        phone: b.phone
    }));
    items.forEach(x => claimTried.add(x.ref));   // ask once per page load, a booking that does not match is not retried every minute
    const { data, error } = await sb.rpc('claim_guest_bookings', { p_items: items });
    if (error) {
        console.warn('Guest bookings not moved to the account (run 30_claim_guest_bookings.sql):', error.message);
        items.forEach(x => claimTried.delete(x.ref));
        return;
    }
    const claimed = Array.isArray(data) ? data : [];
    if (claimed.length) {
        forgetGuestBookings(claimed);
        toast(claimed.length === 1
            ? 'Your guest booking was added to your account.'
            : `${claimed.length} guest bookings were added to your account.`);
    }
}

/* Guests: the bookings saved on this device (reference + phone, js/shared/guestStore.js) are read back from the database,
   so My bookings and My rental show the same live details a signed-in customer sees (supabase/101_guest_device_bookings.sql).
   Returns { bookings, rentals } in the same shape as v_booking_summary / v_rental_lines, or null when the database cannot
   answer (offline, or 101 not run yet). Bookings and rentals load one after the other, so one answer is shared for 2 seconds. */
let guestMemo = null;

function guestSnapshot() {
    const items = claimableGuestBookings().map(b => ({ ref: b.ref, phone: b.phone }));
    const key = JSON.stringify(items);   // a booking added or removed on this device is never answered from the memo
    if (guestMemo && guestMemo.key === key && Date.now() - guestMemo.at < 2000)
        return guestMemo.promise;
    const promise = !items.length
        ? Promise.resolve({ bookings: [], rentals: [] })
        : sb.rpc('guest_device_bookings', { p_items: items }).then(({ data, error }) => {
            if (error || !data) {
                console.warn('Guest bookings not loaded (run 101_guest_device_bookings.sql):', error && error.message);
                return null;
            }
            const bookings = Array.isArray(data.bookings) ? data.bookings : [];
            const gone = Date.now() - 30 * 864e5;   // a finished booking leaves the device 30 days after it ended
            keepGuestBookings(bookings
                .filter(r => ['Pending', 'Approved', 'In Progress'].includes(r.status) || Date.parse(r.end_at) > gone)
                .map(r => r.booking_ref));
            return { bookings, rentals: Array.isArray(data.rentals) ? data.rentals : [] };
        }).catch(() => null);
    guestMemo = { key, at: Date.now(), promise };
    return promise;
}

/* One row of v_booking_summary (or of guest_device_bookings) as a BOOKINGS entry */
function bookingFromRow(r) {
    const p = manilaParts(r.start_at);
    return {
        ref: r.booking_ref,
        studio: studioLetter(r.studio_id),
        date: p.date,
        startAt: r.start_at,
        endAt: r.end_at,
        start: SLOTS[p.hour - 10],
        hours: Math.round(+r.hours),
        status: BK_STATUS[r.status] || r.status,
        payment: r.payment_status || 'Pending',
        mine: true,
        name: r.customer_name,
        method: r.payment_method,
        created: r.created_at,
        reason: r.rejected_reason || '',
        down: Number(r.down_payment) || 0,
        balanceDue: Number(r.balance_due) || 0,         // still to pay at the studio (the database works it out)
        atStudio: Number(r.balance_paid_amount) || 0,   // balance staff collected at the studio
        payOpt: Number(r.balance_paid_amount) > 0 ? 'down' : (r.payment_option || '')   // 'down' (50%) or 'full' (100%); the online payment stays a down payment once the balance was collected
    };
}

let rentalsLoaded = false;   // false until the first loadMyRentals() ends; My bookings waits for it so add-ons do not pop in a moment later
let bookingLoads = 0;   // > 0 while My bookings is being reloaded (the lists are empty for a moment)

/* Only one reload of My bookings runs at a time. loadMyBookings() is called from several places (page start, the
   minute timer, after booking / cancelling / swapping...). When two ran together both read the list, and both pushed
   into the same shared array, so every booking showed twice until the next refresh. A call that arrives while a load
   is running does not start another one: it waits for a fresh load that starts right after the running one. */
let bookingRun = null;
let bookingAgain = false;

export function loadMyBookings() {
    if (bookingRun) {
        bookingAgain = true;
        return bookingRun;
    }
    bookingRun = (async () => {
        try {
            do {
                bookingAgain = false;
                bookingLoads++;
                try {
                    await loadMyBookingsNow();
                } finally {
                    bookingLoads--;
                }
            } while (bookingAgain);
        } finally {
            bookingRun = null;
        }
    })();
    return bookingRun;
}

async function loadMyBookingsNow() {
    const next = [];   // built on the side and swapped into BOOKINGS in one step, so the list is never half filled or filled twice
    if (isMember()) {
        await claimGuestBookings();
        // newest 300 only, then back into date order for the screens
        const res = await run(sb, 'v_booking_summary', COLS.v_booking_summary, q => q.order('start_at', { ascending: false }).limit(LIMIT.mine));
        const error = res.error, data = res.data ? res.data.reverse() : res.data;
        if (error) {
            console.error(error);
            toast('Could not load your bookings.');
        }
        (data || []).forEach(r => next.push(bookingFromRow(r)));
    } else {
        const snap = await guestSnapshot();
        if (snap)
            snap.bookings.forEach(r => next.push(bookingFromRow(r)));
        else   // the database could not answer: show what this device saved when the booking was made
            guestBookings().filter(b => b.date && b.start).forEach(b => next.push({
                ...b,
                status: 'Pending',
                payment: 'Pending',
                mine: true
            }));
    }
    BOOKINGS.splice(0, BOOKINGS.length, ...next);
    if (!isMember())
        applyAccessMode(true);   // a saved booking replaces the "Find your booking" form (customer/myRentals.js)
    await loadMyExtensions();
    await loadReleases();   // release time of confirmed bookings with a balance, and which cancelled ones were no-shows (customer/noShow.js)
    if (rentalsLoaded)
        renderMyBookings();   // first load: loadMyRentals() draws it once the add-ons are known
    renderAttachOptions();
}

/* Extension requests of the signed-in customer (needs 23_extension_payment.sql; without it the list stays empty). */
async function loadMyExtensions() {
    if (!isMember()) {
        state.EXT = {};
        return;
    }
    const ext = {};
    const { data, error } = await run(sb, 'v_booking_extension', COLS.v_booking_extension, q => q.order('created_at', { ascending: false }).limit(LIMIT.mine));
    if (error) {
        console.warn('Extension requests not loaded (run 23_extension_payment.sql):', error.message);
        state.EXT = {};
        return;
    }
    (data || []).forEach(x => {
        (ext[x.booking_ref] = ext[x.booking_ref] || []).push({
            id: x.extension_id,
            hours: Number(x.extra_hours) || 0,
            cost: Number(x.extra_cost) || 0,
            down: Number(x.down_payment) || 0,
            opt: x.payment_option || 'down',        // 'down' (50%) or 'full' (100%)
            status: x.status,                       // Pending | Approved | Rejected
            payment: x.payment_status || 'Pending',
            reason: x.rejected_reason || '',
            newEnd: x.new_end_at,
            created: x.created_at
        });
    });
    state.EXT = ext;
}

/* Damage fees recorded for the customer's returned outside rentals (needs 58_damage_charges.sql; without it the list stays empty). */
async function loadMyDamage() {
    if (!isMember()) {
        state.DAMAGE = {};
        return;
    }
    const dmg = {};
    const { data, error } = await run(sb, 'v_damage_charge', COLS.v_damage_charge, q => q.order('created_at', { ascending: false }).limit(LIMIT.mine));
    if (error) {
        console.warn('Damage fees not loaded (run 58_damage_charges.sql):', error.message);
        state.DAMAGE = {};
        return;
    }
    (data || []).forEach(d => {
        (dmg[d.rental_ref] = dmg[d.rental_ref] || []).push({
            id: d.damage_charge_id,
            item: d.equipment_name,
            qty: d.quantity,
            condition: d.condition,
            reason: d.reason || '',
            notes: d.return_description || '',
            amount: Number(d.amount) || 0,
            status: d.status,                  // Unpaid | Pending (GCash sent, staff verify) | Paid | Waived
            method: d.paid_method || '',
            created: d.created_at,
            beforePhotoPath: d.before_photo_path || null,
            afterPhotoPath: d.after_photo_path || null
        });
    });
    state.DAMAGE = dmg;
}

/* Same rule as loadMyBookings(): one rentals reload at a time, otherwise two overlapping loads pushed into the same
   lists and add-ons / rentals appeared twice. */
let rentalRun = null;
let rentalAgain = false;

export function loadMyRentals() {
    if (rentalRun) {
        rentalAgain = true;
        return rentalRun;
    }
    rentalRun = (async () => {
        try {
            do {
                rentalAgain = false;
                await loadMyRentalsNow();
            } while (rentalAgain);
        } finally {
            rentalRun = null;
        }
    })();
    return rentalRun;
}

async function loadMyRentalsNow() {
    const rentals = [];
    const addons = {};
    const addPaid = {};   // booking reference -> { rental reference: amount paid for that add-on order }
    let rows = [];
    if (isMember()) {
        const { data, error } = await run(sb, 'v_rental_lines', COLS.v_rental_lines, q => q.order('created_at', { ascending: false }).limit(LIMIT.mine));
        if (error)
            console.error(error);
        rows = data || [];
    } else {
        const snap = await guestSnapshot();   // add-on equipment of the bookings saved on this device
        rows = snap ? snap.rentals : [];
    }
    rows.forEach(r => {
        const addon = r.rental_type === 'Add-on',
            bk = addon ? BOOKINGS.find(b => b.ref === r.booking_ref) : null;
        if (addon && r.booking_ref && !['Rejected', 'Cancelled'].includes(r.status)) {
            (addons[r.booking_ref] = addons[r.booking_ref] || []).push({
                name: r.equipment_name,
                qty: r.quantity,
                price: Number(r.unit_price_at_request) || 0
            });
            // add-on equipment added later is paid with its own GCash payment (50% or full)
            if (Number(r.down_payment) > 0)
                (addPaid[r.booking_ref] = addPaid[r.booking_ref] || {})[r.rental_ref] = Number(r.down_payment) + (Number(r.balance_paid_amount) || 0);   // paid online + balance collected at the studio
        }
        rentals.push({
            ref: addon ? r.booking_ref : r.rental_ref,
            item: r.equipment_name,
            qty: r.quantity,
            type: addon ? 'addon' : 'out',
            when: addon ? (bk ? `${shortDate(bk.date)}, ${bk.start}` : fmtD(r.due_at)) : fmtDT(r.pickup_date),
            ret: addon ? (bk ? `${shortDate(bk.date)}, ${endTime(bk.start, bk.hours)}` : fmtD(r.due_at)) : fmtDT(r.return_date),
            rentalRef: r.rental_ref,
            rentalDetailId: r.rental_detail_id,
            rawStatus: r.status,
            unit: Number(r.unit_price_at_request) || 0,
            hours: Number(r.rental_hours) || 0,
            pickup: r.pickup_date,
            due: r.due_at,
            returnAt: r.return_date,   // the return time the customer chose (the late fee only starts at due, after the full 8 hours)
            down: Number(r.down_payment) || 0,
            late: Number(r.late_fee) || 0,
            lateDeferred: !!r.late_fee_deferred,                 // staff chose "Not now" at the return
            latePaid: !!r.late_fee_paid_at,
            latePendingRef: r.late_fee_pending_reference || '',  // the customer sent GCash, staff are checking it
            lateReject: r.late_fee_reject_reason || '',
            atPickup: Number(r.balance_paid_amount) || 0,   // balance staff collected at pick-up
            owes: Number(r.balance_due) || 0,   // what is still to pay for this order (also equipment added during a session and paid after it)
            returnedAt: r.line_returned_at,
            status: RN_STATUS[r.status] || r.status,
            created: r.created_at,
            reason: r.rejected_reason || '',
            // Inspection documentation (outside rentals only)
            issuedAt        : r.issued_at          || null,
            handoverPhotoPath: r.handover_photo_path || null,
            beforePhotoPath : r.before_photo_path  || null,
            returnCondition : r.return_condition   || null,
            returnDescription: r.return_description || null,
            afterPhotoPath  : r.after_photo_path   || null
        });
    });
    state.RENTALS = rentals;
    state.ADDONS = addons;
    state.ADDPAID = addPaid;
    await loadMyDamage();
    await loadSwapOffers();   // replacement items staff offered (customer/swapChoice.js)
    rentalsLoaded = true;
    if (!isMember())
        applyAccessMode(true, true);   // no rentals yet: the guest sees the "Find your rental" form again
    renderMyRentals();
    renderMyBookings();   // add-ons are listed under their booking; the bookings were drawn before the rentals had loaded
    if (!bookingLoads)
        notifyStatusChanges();   // pop-up when staff verified, approved or rejected something (customer/alerts.js)
}