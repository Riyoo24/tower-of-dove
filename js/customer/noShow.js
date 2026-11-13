/* =====================================================================
   customer/noShow.js - no-show release, customer side (needs 78_no_show_release.sql)
   A confirmed booking with a balance still to pay at the studio is held for a grace period after its start time
   (default 15 minutes). If the customer has not arrived and paid by then, the database cancels it and releases the
   slot and its add-ons. This file shows that rule to the customer:
     - the line added to the booking terms checkbox,
     - "Arrive by 3:00 PM / Balance due / Slot released at 3:15 PM" and, from the start time, "Slot held until 3:15 PM"
       with the "I'm running late" button (one time, +15 minutes, the session still ends on time),
     - for a cancelled no-show: what happened and a "Book again" button.
   Without the migration nothing is shown and the page works as before.
   RPC: no_show_grace_minutes, my_booking_release, customer_running_late
   ===================================================================== */

import { sb } from '../config/supabaseClient.js';
import { isMember } from '../shared/session.js';
import { esc, peso } from '../shared/utils.js';

/* minutes after the start time (read from the database; 15 until it answers) */
export let GRACE = 15;

export const RELEASE = {};   // booking reference -> { releaseAt, lateUsed, noShow }

export async function loadGrace() {
    try {
        const { data, error } = await sb.rpc('no_show_grace_minutes');
        if (!error && Number(data) > 0)
            GRACE = Number(data);
    } catch (e) {
        /* migration not run: keep 15 */
    }
}

export async function loadReleases() {
    Object.keys(RELEASE).forEach(k => delete RELEASE[k]);
    if (!isMember())
        return;
    try {
        const { data, error } = await sb.rpc('my_booking_release');
        if (error || !data)
            return;
        data.forEach(r => {
            RELEASE[r.booking_ref] = { releaseAt: r.release_at, lateUsed: !!r.late_used, noShow: !!r.no_show };
            if (Number(r.grace_minutes) > 0)
                GRACE = Number(r.grace_minutes);
        });
    } catch (e) {
        /* migration not run */
    }
}

export const clock = ts => new Date(ts).toLocaleTimeString('en-US', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' });

/* the sentence added to the terms checkbox of a 50% down payment */
export const noShowTerms = () => ` If I have not arrived or contacted the studio within <b>${GRACE} minutes</b> of my start time, the booking is cancelled, the slot is released and my down payment is forfeited.`;

/* the same rule as a plain sentence, for receipts */
export const noShowSentence = () => `If you have not arrived and paid the balance within ${GRACE} minutes of your start time, the booking is cancelled and the slot is released.`;

const HOUR = 36e5;

/* The note under a booking row in My bookings. b = a BOOKINGS entry. Empty when nothing applies. */
export function releaseNote(b, now = Date.now()) {
    const rel = RELEASE[b.ref];
    if (!rel)
        return '';
    if (rel.noShow && b.status === 'Cancelled')
        return `<b>Cancelled: no-show.</b> You had not arrived and paid the balance within ${GRACE} minutes of your start time, so the slot was released. `
            + `${b.down > 0 ? `Your payment of ${peso(b.down)} is non-refundable. ` : ''}`
            + `<button type="button" class="btn sm gold" data-rebook="${esc(b.ref)}">Book again</button>`;
    if (b.status !== 'Confirmed' || !rel.releaseAt || !(b.balanceDue > 0.005))
        return '';
    const start = new Date(b.startAt).getTime(), release = new Date(rel.releaseAt).getTime();
    const bal = `Balance <b>${peso(b.balanceDue)}</b> due at the studio`;
    const late = !rel.lateUsed && release > now && now >= start - 2 * HOUR
        ? ` <button type="button" class="btn sm line" data-late="${esc(b.ref)}">I'm running late</button>` : '';
    if (release <= now)
        return `<b>Your slot is being released.</b> ${bal}. Please call the studio if you are on your way.`;
    if (now < start)
        return `<b>Arrive by ${clock(start)}</b> &middot; ${bal} &middot; Slot released at ${clock(release)} if you have not arrived and paid.${late}`;
    return `<b>Slot held until ${clock(release)}.</b> ${bal}.${rel.lateUsed ? ' You already used your extra 15 minutes.' : ''}${late}`;
}

/* "I'm running late": one extra 15 minutes. Resolves to the new release time, or throws the database's message. */
export async function runningLate(ref) {
    const { data, error } = await sb.rpc('customer_running_late', { p_booking_ref: ref });
    if (error)
        throw new Error(error.message);
    return data;
}
