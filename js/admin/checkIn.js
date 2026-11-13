/* =====================================================================
   admin/checkIn.js - check-in of a booking: the time the customer arrived (87_booking_check_in.sql)
   Works for 50% down-payment bookings and fully paid ones alike. It is a record only: it does not start the session.
     - "Check in" (rpc staff_check_in): staff, once; stamps the server time and writes it to the booking's History.
       It also stops the no-show countdown, because a customer who has arrived is not a no-show.
     - "Undo check-in" (rpc staff_undo_check_in): owner only, a note is required (for a misclick).
   Walk-ins (onsite bookings that start now) are checked in by the database when they are created.
   ===================================================================== */

import { afterAction, findBk } from './bookings.js';
import { checkInOf } from './checkInInfo.js';
import { ACT, dlg, run, showDlg, tExact } from './helpers.js';
import { sb } from '../config/supabaseClient.js';
import { btnBusy, btnReset, btnSuccess } from '../shared/btnState.js';
import { $, esc, toast } from '../shared/utils.js';

ACT['bk-checkin'] = async ref => {
    const done = await run(sb.rpc('staff_check_in', { p_booking_ref: ref }));
    if (done)
        afterAction(`${ref} checked in at ${tExact(done.data)}.`);
};

ACT['bk-uncheckin'] = ref => {
    const b = findBk(ref), c = checkInOf(ref);
    if (!b || !c)
        return;
    showDlg(`<h2 style="margin:0 0 8px">Undo this check-in?</h2>
      <p class="mut">${esc(b.booking_ref)} (${esc(b.customer_name)}) was checked in at <b>${esc(tExact(c.checked_in_at))}</b>. Undoing it removes the arrival time.
      The undo is written to the booking's History.</p>
      <label for="uc-note" class="mut">Note (required)</label>
      <textarea id="uc-note" rows="2" maxlength="200" style="width:100%;resize:vertical" placeholder="For example: checked in by mistake"></textarea>
      <div class="acts"><button type="button" class="btn line" data-close>Cancel</button><button type="button" class="btn gold" id="uc-go">Undo check-in</button></div>`);
    const note = $('#uc-note'), go = $('#uc-go');
    note.focus();
    go.onclick = async () => {
        const text = note.value.trim();
        if (text.length < 3) {
            note.focus();
            return toast('Add a short note, for example: checked in by mistake.');
        }
        btnBusy(go, 'Saving…');
        const done = await run(sb.rpc('staff_undo_check_in', { p_booking_ref: ref, p_note: text }));
        if (!done) {
            btnReset(go);
            return;
        }
        await btnSuccess(go, 'Undone');
        dlg.close();
        afterAction(`The check-in of ${ref} was undone.`);
    };
};
