/* =====================================================================
   admin/noShow.js - no-show release of a confirmed booking that still owes a balance
   A confirmed booking whose balance is not paid is released by the database a few minutes after its start time
   (78_no_show_release.sql: grace period, default 15 minutes; its add-on equipment is released with it).
   This file adds, to the card of the Sessions tab:
     - the live countdown ("Releases in 12 min"),
     - "Customer called, hold 15 more min" (rpc staff_hold_booking: staff once, owner up to 3 times, a note is required),
     - "Release now (no-show)" (rpc staff_release_booking).
   Both actions are written to the booking's History (booking_event) and a release counts as a no-show of the customer.
   If 78_no_show_release.sql has not been run yet, REL is empty and nothing here is shown.
   ===================================================================== */

import { afterAction, findBk } from './bookings.js';
import { REL } from './data.js';
import { ACT, CONFIRM, OWNER, dOf, dbtn, btn, dlg, run, showDlg, tOf } from './helpers.js';
import { sb } from '../config/supabaseClient.js';
import { btnBusy, btnReset, btnSuccess } from '../shared/btnState.js';
import { $, esc, shortDate, toast } from '../shared/utils.js';

const HOLD_MIN = 15;
const MAX_HOLDS = () => OWNER ? 3 : 1;

const clock = ts => new Date(ts).toLocaleTimeString('en-US', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' });

export const releaseOf = ref => REL.find(r => r.booking_ref === ref) || null;

const who = b => `${b.booking_ref} (${b.customer_name}, ${b.studio_name}, ${shortDate(dOf(b.start_at))} ${tOf(b.start_at)})`;

/* The block shown on a Confirmed card whose time has come: countdown, then the hold / release buttons.
   Empty when the booking has no balance due (the database starts it by itself) or the migration is not installed. */
export function releaseBlock(b, now = Date.now()) {
    const r = releaseOf(b.booking_ref);
    if (!r)
        return '';
    const ms = new Date(r.release_at).getTime() - now;
    const mins = Math.ceil(ms / 6e4);
    const when = ms <= 0 ? 'Releasing now'
        : mins <= 1 ? 'Releases in less than a minute'
            : `Releases in ${mins} min`;
    const held = r.hold_count > 0 ? ` <span class="mut">Held${r.hold_note ? ': ' + esc(r.hold_note) : ''}</span>` : '';
    const canHold = r.hold_count < MAX_HOLDS() && ms > 0;
    const holdBtn = canHold
        ? btn('bk-hold', b.booking_ref, r.hold_count > 0 ? `Hold ${HOLD_MIN} more min (owner)` : `Customer called, hold ${HOLD_MIN} more min`, 1)
        : (r.hold_count >= MAX_HOLDS() ? '<span class="mut">Already held. Only the owner can hold it again.</span>' : '');
    return `<p style="margin:6px 0 0"><span class="b ${ms <= 5 * 6e4 ? 'rejected' : 'pending'}" title="Release time ${esc(clock(r.release_at))}">${when}</span>`
        + ` <span class="mut">at ${esc(clock(r.release_at))}, unless the balance is paid</span>${held}</p>`
        + `<div class="row" style="justify-content:flex-start;gap:8px;margin-top:8px;flex-wrap:wrap">${holdBtn}${dbtn('bk-release', b.booking_ref, 'Release now (no-show)')}</div>`;
}

/* ---- Release now ---- */
CONFIRM['bk-release'] = ref => ({
    title: 'Release this booking as a no-show?',
    message: `${who(findBk(ref))} will be cancelled and the time slot is free for other clients. Its add-on equipment is released too. `
        + 'The payments already made are kept (not refunded). This can\'t be undone.',
    ok: 'Yes, release it',
    cancel: 'No, keep waiting',
    danger: true
});

ACT['bk-release'] = async ref => {
    if (await run(sb.rpc('staff_release_booking', { p_booking_ref: ref })))
        afterAction(`${ref} released as a no-show. The slot and its add-ons are free again.`);
};

/* ---- Customer called: hold longer ---- */
ACT['bk-hold'] = ref => {
    const b = findBk(ref), r = releaseOf(ref);
    if (!b || !r)
        return;
    const next = new Date(new Date(r.release_at).getTime() + HOLD_MIN * 6e4);
    showDlg(`<h2 style="margin:0 0 8px">Hold this booking for ${HOLD_MIN} more minutes?</h2>
      <p class="mut">${esc(who(b))}. The release moves from <b>${esc(clock(r.release_at))}</b> to <b>${esc(clock(next))}</b>.
      The session still ends at its booked time. ${OWNER ? '' : 'Staff can hold a booking once.'}</p>
      <label for="hold-note" class="mut">Note (required, shown in the booking's History)</label>
      <textarea id="hold-note" rows="2" maxlength="200" style="width:100%;resize:vertical" placeholder="For example: customer called, 10 minutes away"></textarea>
      <div class="acts"><button type="button" class="btn line" data-close>Cancel</button><button type="button" class="btn gold" id="hold-go">Hold ${HOLD_MIN} minutes</button></div>`);
    const note = $('#hold-note'), go = $('#hold-go');
    note.focus();
    go.onclick = async () => {
        const text = note.value.trim();
        if (text.length < 3) {
            note.focus();
            return toast('Add a short note, for example: customer called, 10 minutes away.');
        }
        btnBusy(go, 'Saving…');
        const done = await run(sb.rpc('staff_hold_booking', { p_booking_ref: ref, p_minutes: HOLD_MIN, p_note: text }));
        if (!done) {
            btnReset(go);
            return;
        }
        await btnSuccess(go, 'Held');
        dlg.close();
        afterAction(`${ref} held until ${clock(done.data)}.`);
    };
};
