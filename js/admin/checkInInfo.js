/* =====================================================================
   admin/checkInInfo.js - read-only helpers for the check-in record (when the customer arrived)
   The data comes from staff_check_in_times() (87_booking_check_in.sql) and is held in CHK (data.js).
   The buttons and the owner's undo live in checkIn.js.
   ===================================================================== */

import { CHK, CHK_OK } from './data.js';
import { btn, tExact } from './helpers.js';
import { esc } from '../shared/utils.js';

export const checkInOf = ref => CHK.find(c => c.booking_ref === ref) || null;

/* true once 87_booking_check_in.sql has been run: until then no Check in buttons are shown */
export const checkInReady = () => CHK_OK;

/* true when this booking must be checked in before its session can be started (and its balance collected): the customer
   has not arrived yet. Always false until 87_booking_check_in.sql has been run, so a site without it works as before. */
export const needsCheckIn = ref => CHK_OK && !checkInOf(ref);

/* "12:07 PM, 7 min late" / "10 min early" / "on time" (a difference under 2 minutes counts as on time) */
export function arrivalText(b) {
    const c = checkInOf(b.booking_ref);
    if (!c)
        return '';
    const diff = Math.round((new Date(c.checked_in_at) - new Date(b.start_at)) / 6e4);
    const when = diff >= 2 ? `${diff} min late` : diff <= -2 ? `${-diff} min early` : 'on time';
    return `${tExact(c.checked_in_at)}, ${when}`;
}

/* The line on a Sessions card: "Checked in  12:07 PM, 7 min late", or "Not checked in" (with a Check in button when asked).
   Empty until the migration is installed, so nothing changes for a site that has not run it yet. */
export function arrivalLine(b, withButton) {
    if (!CHK_OK)
        return '';
    const c = checkInOf(b.booking_ref);
    if (c)
        return `<p style="margin:6px 0 0"><span class="b verified">Checked in</span> <span class="mut" title="${c.by_name ? 'Checked in by ' + esc(c.by_name) : ''}">${esc(arrivalText(b))}</span></p>`;
    return `<p style="margin:6px 0 0"><span class="b pending">Not checked in</span>${withButton ? ' ' + btn('bk-checkin', b.booking_ref, 'Check in') : ''}</p>`;
}
