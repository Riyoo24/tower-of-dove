/* =====================================================================
   admin/sessions.js - Studio sessions tab (sessions in progress)
   Card layout (css/sessions.css): studio + status pill, customer, time, tags, time line with its bar, then buttons.
   Every state keeps the same field order. Colour and the status text change together, so state never relies on colour alone.

   ===================================================================== */

import { BK, STU } from './data.js';
import { balanceOf, doneLabel, findBk, pendingExt, startLabel } from './bookings.js';
import { arrivalText, checkInOf, checkInReady } from './checkInInfo.js';
import { releaseMenuItems, releaseOf } from './noShow.js';
import { openActionMenu } from '../shared/actionMenu.js';
import { repFlag } from './reputation.js';
import { dOf, money, tOf } from './helpers.js';
import { shortDate } from '../shared/utils.js';
import { $, TODAY, esc } from '../shared/utils.js';

/* ============================ 4. SESSIONS ============================ */

/* Every studio gets a card: "On session" (live session), "Ending soon", "Over time", "Confirmed, due now" / "Ready to start",
   "Upcoming", "Available", or its own status (Maintenance / Unavailable) when it is not taking bookings. */

/* a running session that still owes a balance (extra hours added by an extension) will not complete by itself */
const owes = b => balanceOf(b) > 0.005;

/* how long before the end time staff are told that a session is about to end */
export const ENDING_SOON = 5 * 60 * 1000;

/* a booking this close to its start shows as "Upcoming" on a free studio */
const UPCOMING = 30 * 60 * 1000;

/* the no-show release timer turns red in its last 5 minutes */
const RELEASE_SOON = 5 * 60 * 1000;

const mins = ms => Math.max(1, Math.ceil(ms / 6e4));
const hm = ms => {
    const m = Math.round(ms / 6e4), h = Math.floor(m / 60);
    return h ? (m % 60 ? `${h}h ${m % 60}m` : `${h}h`) : `${m} min`;
};
const clock = ts => new Date(ts).toLocaleTimeString('en-US', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit' });
const pctOf = (a, b, now) => b > a ? Math.min(100, Math.max(0, Math.round((now - a) / (b - a) * 100))) : 0;

/* one card, every state. o: studio, tone (ok warn bad info live mut), pulse, pill, cust, flag (html), when, tags [[text, tone]], note,
   status, statusTone, sub, pct, stripe, times [start, end], primary / secondary {act, id, label} or {href, label}, menuId */
const PILL = { 'On session': 'onsession', 'Ending soon': 'duetoday', 'Over time': 'overdue', 'Confirmed, due now': 'confirmed', 'Releasing soon': 'confirmed', 'Ready to start': 'confirmed', 'Upcoming': '', 'Available': 'available' };
const RUNNING = ['On session', 'Ending soon', 'Over time'];   // lamp: red = a session is running, green = nothing running, grey = not taking bookings

function card(o) {
    const pillCls = o.pill in PILL ? PILL[o.pill] : o.pill.toLowerCase().replace(/ /g, '');   // Maintenance / Unavailable use the site badge of the same name
    const lamp = RUNNING.includes(o.pill) ? 'run' : o.tone === 'mut' ? 'off' : 'free';
    const tags = (o.tags || []).filter(Boolean);
    const action = (a, cls) => a.href
        ? `<a class="btn ss-btn ${cls}" href="${esc(a.href)}">${esc(a.label)}</a>`
        : `<button type="button" class="btn ss-btn ${cls}" data-act="${esc(a.act)}" data-id="${esc(a.id)}">${esc(a.label)}</button>`;
    const hasFooter = o.primary || o.secondary || o.menuId;
    return `<article class="card ss-card" aria-label="${esc(o.studio)}: ${esc(o.pill)}">
      <div class="ss-head"><div class="ss-title"><i class="ss-lamp ${lamp}${o.pulse ? ' pulse' : ''}" aria-hidden="true"></i><h3>${esc(o.studio)}</h3></div><span class="b ${pillCls}">${esc(o.pill)}</span></div>
      <div class="ss-who"><div class="ss-cust${o.cust ? '' : ' none'}"><span>${esc(o.cust || 'No customer')}</span>${o.flag || ''}</div><span class="ss-when">${esc(o.when)}</span></div>
      ${tags.length ? `<div class="ss-tags">${tags.map(t => `<span class="b ss-tag ${t[1]}">${esc(t[0])}</span>`).join('')}</div>` : ''}
      ${o.note ? `<p class="ss-note">${esc(o.note)}</p>` : ''}
      <div class="ss-time"><div class="ss-line"><b class="ss-status${o.statusTone ? ' ss-s-' + o.statusTone : ''}">${esc(o.status)}</b><span class="ss-sub">${esc(o.sub || '')}</span></div>
        <div class="ss-bar${o.stripe ? ' stripe' : ''}" aria-hidden="true"><i style="width:${o.pct || 0}%"></i></div>
        ${o.times ? `<div class="ss-ends"><span>${esc(o.times[0])}</span><span>${esc(o.times[1])}</span></div>` : ''}</div>
      ${hasFooter ? `<div class="ss-foot">${o.primary ? action(o.primary, '') : ''}${o.secondary ? action(o.secondary, 'line') : ''}${o.menuId ? `<button type="button" class="btn ss-btn line ss-menu" data-sessmenu="${esc(o.menuId)}" aria-haspopup="menu" aria-expanded="false" aria-label="More actions for ${esc(o.studio)}"><span class="ss-menu-t">Actions</span><span class="ss-caret" aria-hidden="true">&#9662;</span><svg class="ss-dots" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg></button>` : ''}</div>` : ''}
    </article>`;
}

/* "Checked in 12:58 PM, 2 min early" (green) or "Not checked in" (grey). Nothing until 87_booking_check_in.sql has been run. */
const arrivalChip = b => !checkInReady() ? null
    : checkInOf(b.booking_ref) ? [`Checked in ${arrivalText(b)}`, 'verified'] : ['Not checked in', ''];
const balanceChip = (b, word = 'Balance') => owes(b) ? [`${word} ${money(balanceOf(b))}`, 'balancedue'] : null;

/* The Actions menu of a due card: the main step first, then Hold / Release now (see noShow.js) */
function dueMenuItems(b) {
    const id = b.booking_ref, waiting = checkInReady() && !checkInOf(id);   // true: waiting for the customer to arrive
    return [waiting ? { act: 'bk-checkin', id, label: 'Check in' } : { act: 'bk-go', id, label: startLabel(b) }, ...releaseMenuItems(b)];
}

document.addEventListener('click', e => {
    const menuButton = e.target.closest('[data-sessmenu]');
    const b = menuButton && findBk(menuButton.dataset.sessmenu);
    if (b)
        openActionMenu(menuButton, dueMenuItems(b));
});

/* A running session: time left is the headline, the bar is how much of the booked time has passed. */
function liveCard(b, now) {
    const s = new Date(b.start_at).getTime(), e = new Date(b.end_at).getTime(), left = e - now;
    const over = left <= 0, soon = !over && left <= ENDING_SOON, pct = over ? 100 : pctOf(s, e, now);
    const ext = pendingExt(b.booking_ref), due = owes(b);
    const tone = over ? 'bad' : soon ? 'warn' : 'live';
    let note = '';
    if (ext)
        note = 'The customer sent an extension payment. Verify it to add the hours.';
    else if (over && due)
        note = 'The session stays open until the balance is paid.';
    else if (soon)
        note = due ? `Ends at ${tOf(b.end_at)}. A balance is owed, so the session stays open until it is paid.` : `Ends at ${tOf(b.end_at)}. It completes by itself.`;
    return card({
        studio: b.studio_name, tone, pulse: tone === 'live', pill: over ? 'Over time' : soon ? 'Ending soon' : 'On session',
        cust: b.customer_name, flag: repFlag(b.customer_id, 'booking'), when: `${tOf(b.start_at)} to ${tOf(b.end_at)}`,
        tags: [arrivalChip(b), ext ? ['Extension waiting', 'pending'] : null, balanceChip(b, 'Balance due')],
        note, status: over ? `Over time by ${mins(-left)} min` : left >= 36e5 ? `${hm(left)} left` : `${mins(left)} min left`,
        statusTone: over ? 'bad' : '',
        sub: over ? (due ? `Balance due ${money(balanceOf(b))}` : 'Completing shortly') : `${pct}% of ${hm(e - s)} used`,
        pct, stripe: over, times: [tOf(b.start_at), tOf(b.end_at)],
        primary: { act: 'bk-done', id: b.booking_ref, label: doneLabel(b) },
        secondary: ext ? { act: 'ext-verify', id: ext.extension_id, label: 'Verify extension' } : { act: 'bk-ext', id: b.booking_ref, label: 'Extend' }
    });
}

/* A confirmed booking whose time has come and has not started yet. One Actions menu holds every choice:
   Check in first (or Start session / Collect balance once the customer has arrived), then Hold and Release now
   while a balance is due. After check-in the release countdown is gone. */
function dueCard(b, st, now) {
    const id = b.booking_ref, here = checkInReady() && !!checkInOf(id), waiting = checkInReady() && !here;
    const r = waiting ? releaseOf(id) : null;
    const left = r ? new Date(r.release_at).getTime() - now : 0, soon = !!r && left <= RELEASE_SOON;
    const base = { studio: st.name, cust: b.customer_name, flag: repFlag(b.customer_id, 'booking'), when: `${tOf(b.start_at)} to ${tOf(b.end_at)}, today`, menuId: id };
    if (here)
        return card({
            ...base, tone: 'ok', pill: 'Ready to start', tags: [arrivalChip(b), balanceChip(b)], status: 'Customer is here',
            sub: owes(b) ? 'Balance is collected first' : 'Start the session when ready', pct: 0,
            primary: { act: 'bk-go', id, label: startLabel(b) }
        });
    const held = r && r.hold_count > 0 ? [r.hold_count > 1 ? `Held ${r.hold_count} times` : 'Held once', ''] : null;
    return card({
        ...base, tone: soon ? 'bad' : 'warn', pill: soon ? 'Releasing soon' : 'Confirmed, due now', tags: [arrivalChip(b), held, balanceChip(b)],
        note: soon ? 'Hold adds more time. Release now frees the slot for other clients.' : '',
        status: r ? (left <= 0 ? 'Releasing now' : `Releases in ${mins(left)} min`) : 'Due now', statusTone: soon ? 'bad' : 'warn',
        sub: r ? `No-show release at ${clock(r.release_at)}` : `Start time was ${tOf(b.start_at)}`,
        pct: r ? pctOf(new Date(b.start_at).getTime(), new Date(r.release_at).getTime(), now) : 0,
        primary: waiting ? { act: 'bk-checkin', id, label: 'Check in' } : { act: 'bk-go', id, label: startLabel(b) }
    });
}

/* A studio with no session: Upcoming (next booking within 30 minutes), Available, or its own status when it is offline. */
function freeCard(st, now) {
    const next = BK.filter(b => b.studio_id === st.studio_id && b.status === 'Approved' && new Date(b.start_at) > now)
        .sort((a, b) => new Date(a.start_at) - new Date(b.start_at))[0];
    if (st.status !== 'Available')
        return card({ studio: st.name, tone: 'mut', pill: st.status, when: 'Not taking bookings', status: 'Not available' });
    const gap = next ? new Date(next.start_at).getTime() - now : 0;
    const when = next ? `Next: ${dOf(next.start_at) === TODAY ? '' : shortDate(dOf(next.start_at)) + ', '}${tOf(next.start_at)} to ${tOf(next.end_at)}` : 'No upcoming bookings';
    const onsite = { href: '#a-onb', label: 'New onsite booking' };
    if (next && gap <= UPCOMING)
        return card({
            studio: st.name, tone: 'info', pill: 'Upcoming', cust: next.customer_name, flag: repFlag(next.customer_id, 'booking'), when,
            tags: [arrivalChip(next), balanceChip(next)], status: `Starts in ${mins(gap)} min`, sub: `At ${tOf(next.start_at)}`,
            pct: Math.round((UPCOMING - gap) / UPCOMING * 100),
            // early-bird customer: check in before the start time (a record only; the session still starts at its time)
            primary: checkInReady() && !checkInOf(next.booking_ref) ? { act: 'bk-checkin', id: next.booking_ref, label: 'Check in' } : null
        });
    return card({
        studio: st.name, tone: 'ok', pill: 'Available', cust: next ? next.customer_name : '', when, status: 'No session in progress',
        sub: next && dOf(next.start_at) === TODAY ? `Free for ${hm(gap)}` : 'Free for the rest of today', secondary: onsite
    });
}

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
    // the cards redraw every 15 seconds: keep them as they are while an Actions menu is open, so it does not vanish
    if (document.querySelector('.actmenu:not([hidden])'))
        return;
    const dueFor = st => BK.filter(b => b.studio_id === st.studio_id && b.status === 'Approved'
        && new Date(b.start_at) <= now && new Date(b.end_at) > now)
        .sort((a, b) => new Date(a.start_at) - new Date(b.start_at))[0];
    const cards = STU.map(st => {
        const b = live.find(x => x.studio_id === st.studio_id);
        if (b)
            return liveCard(b, now);
        const due = st.status === 'Available' && dueFor(st);
        return due ? dueCard(due, st, now) : freeCard(st, now);
    }).join('') + live.filter(b => !STU.some(st => st.studio_id === b.studio_id)).map(b => liveCard(b, now)).join('');
    $('#asess').innerHTML = `<div class="ss-grid">${cards || '<div class="card"><p class="mut">No studios yet.</p></div>'}</div>`;
}