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
import { renderMyRentals } from './myRentals.js';
import { fmtDT, renderAttachOptions } from './rent.js';
import { BOOKINGS } from '../shared/availability.js';
import { STUDIOS } from '../shared/catalog.js';
import { COLS, LIMIT, run } from '../shared/query.js';
import { claimableGuestBookings, forgetGuestBookings, guestBookings } from '../shared/guestStore.js';
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

let bookingLoads = 0;   // > 0 while My bookings is being reloaded (the lists are empty for a moment)

export async function loadMyBookings() {
    bookingLoads++;
    try {
        await loadMyBookingsNow();
    } finally {
        bookingLoads--;
    }
}

async function loadMyBookingsNow() {
    BOOKINGS.length = 0;
    if (isMember()) {
        await claimGuestBookings();
        // newest 300 only, then back into date order for the screens
        const res = await run(sb, 'v_booking_summary', COLS.v_booking_summary, q => q.order('start_at', { ascending: false }).limit(LIMIT.mine));
        const error = res.error, data = res.data ? res.data.reverse() : res.data;
        if (error) {
            console.error(error);
            toast('Could not load your bookings.');
        }
        (data || []).forEach(r => {
            const p = manilaParts(r.start_at);
            BOOKINGS.push({
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
            });
        });
    } else {
        guestBookings().forEach(b => BOOKINGS.push({
            ...b,
            status: 'Pending',
            payment: 'Pending',
            mine: true
        }));
    }
    await loadMyExtensions();
    await loadReleases();   // release time of confirmed bookings with a balance, and which cancelled ones were no-shows (customer/noShow.js)
    renderMyBookings();
    renderAttachOptions();
}

/* Extension requests of the signed-in customer (needs 23_extension_payment.sql; without it the list stays empty). */
async function loadMyExtensions() {
    state.EXT = {};
    if (!isMember())
        return;
    const { data, error } = await run(sb, 'v_booking_extension', COLS.v_booking_extension, q => q.order('created_at', { ascending: false }).limit(LIMIT.mine));
    if (error) {
        console.warn('Extension requests not loaded (run 23_extension_payment.sql):', error.message);
        return;
    }
    (data || []).forEach(x => {
        (state.EXT[x.booking_ref] = state.EXT[x.booking_ref] || []).push({
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
}

/* Damage fees recorded for the customer's returned outside rentals (needs 58_damage_charges.sql; without it the list stays empty). */
async function loadMyDamage() {
    state.DAMAGE = {};
    if (!isMember())
        return;
    const { data, error } = await run(sb, 'v_damage_charge', COLS.v_damage_charge, q => q.order('created_at', { ascending: false }).limit(LIMIT.mine));
    if (error) {
        console.warn('Damage fees not loaded (run 58_damage_charges.sql):', error.message);
        return;
    }
    (data || []).forEach(d => {
        (state.DAMAGE[d.rental_ref] = state.DAMAGE[d.rental_ref] || []).push({
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
}

export async function loadMyRentals() {
    state.RENTALS = [];
    state.ADDONS = {};
    state.ADDPAID = {};   // booking reference -> { rental reference: amount paid for that add-on order }
    if (isMember()) {
        const { data, error } = await run(sb, 'v_rental_lines', COLS.v_rental_lines, q => q.order('created_at', { ascending: false }).limit(LIMIT.mine));
        if (error)
            console.error(error);
        (data || []).forEach(r => {
            const addon = r.rental_type === 'Add-on',
                bk = addon ? BOOKINGS.find(b => b.ref === r.booking_ref) : null;
            if (addon && r.booking_ref && !['Rejected', 'Cancelled'].includes(r.status)) {
                (state.ADDONS[r.booking_ref] = state.ADDONS[r.booking_ref] || []).push({
                    name: r.equipment_name,
                    qty: r.quantity,
                    price: Number(r.unit_price_at_request) || 0
                });
                // add-on equipment added later is paid with its own GCash payment (50% or full)
                if (Number(r.down_payment) > 0)
                    (state.ADDPAID[r.booking_ref] = state.ADDPAID[r.booking_ref] || {})[r.rental_ref] = Number(r.down_payment) + (Number(r.balance_paid_amount) || 0);   // paid online + balance collected at the studio
            }
            state.RENTALS.push({
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
                returnedAt: r.line_returned_at,
                status: RN_STATUS[r.status] || r.status,
                created: r.created_at,
                reason: r.rejected_reason || '',
                // Inspection documentation (outside rentals only)
                issuedAt        : r.issued_at          || null,
                issuedAt        : r.issued_at          || null,
                handoverPhotoPath: r.handover_photo_path || null,
                beforePhotoPath : r.before_photo_path  || null,
                returnCondition : r.return_condition   || null,
                returnDescription: r.return_description || null,
                afterPhotoPath  : r.after_photo_path   || null
            });
        });
    }
    await loadMyDamage();
    await loadSwapOffers();   // replacement items staff offered (customer/swapChoice.js)
    renderMyRentals();
    if (!bookingLoads)
        notifyStatusChanges();   // pop-up when staff verified, approved or rejected something (customer/alerts.js)
}