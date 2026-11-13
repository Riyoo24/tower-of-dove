/* =====================================================================
   admin/sessions.js - Studio sessions tab (sessions in progress)

   ===================================================================== */

import { BK, STU } from './data.js';
import { balanceOf, doneLabel, pendingExt, startLabel } from './bookings.js';
import { arrivalLine, checkInOf, checkInReady } from './checkInInfo.js';
import { releaseBlock } from './noShow.js';
import { repFlag } from './reputation.js';
import { btn, dOf, money, num, tOf } from './helpers.js';
import { shortDate } from '../shared/utils.js';
import { $, TODAY, badge, esc } from '../shared/utils.js';

/* ============================ 4. SESSIONS ============================ */

/* Every studio gets a card: "On Session" (with the live session and its buttons), "Available",
   or its own status (Maintenance / Unavailable) when it is not taking bookings. */

/* a booking with a down payment: the balance is collected at the studio */
const balNote = b => balanceOf(b) > 0.005 ? `<p style="margin:6px 0 0"><span class="b balancedue">Balance due</span> <b>${money(balanceOf(b))}</b> <span class="mut">to collect before the session starts</span></p>` : '';

/* a running session that still owes a balance (extra hours added by an extension): it will not complete by itself */
const doneNote = b => balanceOf(b) > 0.005 ? `<p style="margin:6px 0 0"><span class="b balancedue">Balance due</span> <b>${money(balanceOf(b))}</b> <span class="mut">collect it to complete. The session stays open until it is paid.</span></p>` : '';

/* how long before the end time staff are told that a session is about to end */
export const ENDING_SOON = 5 * 60 * 1000;

export function renderSessions() {
    const live = BK.filter(b => b.status === 'In Progress');
    const now = Date.now();

    // sidebar badge: a confirmed booking whose time has come (needs "Start session"),
    // or a session that ends within 5 minutes (advance notice; pg_cron (file 49) completes it by itself at the end time, page open or not,
    // unless a balance is still owed: then it stays open until staff collect it, file 86)
    const needs = BK.filter(b => (b.status === 'Approved' && new Date(b.start_at) <= now && new Date(b.end_at) > now)
        || (b.status === 'In Progress' && new Date(b.end_at) - now <= ENDING_SOON)).length;
    const badgeEl = $('#scnt');
    if (badgeEl) {
        badgeEl.textContent = needs;
        badgeEl.hidden = !needs;
    }
    const liveCard = b => {
        const s = new Date(b.start_at).getTime(), e = new Date(b.end_at).getTime(), left = e - now;
        const pct = Math.min(100, Math.max(0, Math.round((now - s) / (e - s) * 100)));
        const lt = left > 0 ? `${Math.floor(left / 36e5)}h ${Math.floor(left / 6e4) % 60}m left` : `Over time by ${Math.ceil(-left / 6e4)} min`;
        const soon = left <= ENDING_SOON ? ` <span class="b duetoday">${left > 0 ? 'Ending soon' : 'Ended'}</span>` : '';
        return `<div class="card"><div class="row"><h3><i class="lamp live"></i>${esc(b.studio_name)}</h3>${badge('On Session')}</div>
      <p style="margin:8px 0">${esc(b.customer_name)}</p><p class="mut">${tOf(b.start_at)} to ${tOf(b.end_at)}</p>${arrivalLine(b, true)}${doneNote(b)}
      <div class="hb"><b>${lt}${soon}</b><div><i style="width:${pct}%"></i></div></div><div class="row" style="justify-content:flex-start;gap:8px;margin-top:10px">${btn('bk-done', b.booking_ref, doneLabel(b), 1)}${pendingExt(b.booking_ref) ? btn('ext-verify', pendingExt(b.booking_ref).extension_id, 'Verify extension') : btn('bk-ext', b.booking_ref, 'Extend', 1)}</div></div>`;
    };
    /* A confirmed booking whose time has come (and has not started yet, e.g. a balance is still due) */
    /* Before the customer has checked in: "Check in" first (with Hold / Release while a balance is due).
       After check-in the countdown and those two buttons are gone and "Collect balance & start" is offered. */
    const dueCard = b => {
        const gate = checkInReady() && !checkInOf(b.booking_ref);   // true: waiting for the customer to arrive
        const action = gate ? btn('bk-checkin', b.booking_ref, 'Check in') : btn('bk-go', b.booking_ref, startLabel(b));
        return `<div class="card"><div class="row"><h3>${esc(b.studio_name)}</h3>${badge('Confirmed')}</div>
      <p style="margin:8px 0">${esc(b.customer_name)}${repFlag(b.customer_id, 'booking')}</p><p class="mut">${tOf(b.start_at)} to ${tOf(b.end_at)}, today</p>${arrivalLine(b, false)}${balNote(b)}${releaseBlock(b, now)}<div style="margin-top:8px">${action}</div></div>`;
    };
    const dueFor = st => BK.filter(b => b.studio_id === st.studio_id && b.status === 'Approved'
        && new Date(b.start_at) <= now && new Date(b.end_at) > now)
        .sort((a, b) => new Date(a.start_at) - new Date(b.start_at))[0];
    const freeCard = st => {
        const next = BK.filter(b => b.studio_id === st.studio_id && b.status === 'Approved' && new Date(b.start_at) > now)
            .sort((a, b) => new Date(a.start_at) - new Date(b.start_at))[0];
        const open = st.status === 'Available';
        const when = next ? `Next: ${dOf(next.start_at) === TODAY ? '' : shortDate(dOf(next.start_at)) + ', '}${tOf(next.start_at)} to ${tOf(next.end_at)}` : 'No upcoming bookings';
        // same layout as an active session card, with empty values
        return `<div class="card"><div class="row"><h3><i class="lamp"></i>${esc(st.name)}</h3>${badge(st.status)}</div>
      <p style="margin:8px 0">${open && next ? esc(next.customer_name) : 'No customer'}</p><p class="mut">${open ? when : 'Not taking bookings'}</p>
      <div class="hb"><b>${open ? 'No session in progress' : 'Not available'}</b><div><i style="width:0%"></i></div></div></div>`;
    };
    const cards = STU.map(st => {
        const b = live.find(x => x.studio_id === st.studio_id);
        if (b)
            return liveCard(b);
        const due = st.status === 'Available' && dueFor(st);
        return due ? dueCard(due) : freeCard(st);
    }).join('') + live.filter(b => !STU.some(st => st.studio_id === b.studio_id)).map(liveCard).join('');
    $('#asess').innerHTML = `<div class="grid studio-row">${cards || '<div class="card"><p class="mut">No studios yet.</p></div>'}</div>`;
}
