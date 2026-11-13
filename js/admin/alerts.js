/* =====================================================================
   admin/alerts.js - pop-up alerts for new work, on every dashboard page
   updateNavBadges() (overview.js) calls notifyBadgeCounts() with the sidebar counts.
   A pop-up shows only when a count goes UP; the first call just sets the starting point,
   so opening the dashboard never floods the admin. Several new items arrive as one pop-up.
   Payments stay until dismissed; the others fade after 8 seconds. Nothing is stored or sent anywhere.
   checkTimeAlerts() (bottom of this file) adds the clock-based pop-ups: a booking or rental that reached its start time,
   a rental that is due back or overdue, a studio session with 5 minutes left or over time, a session extension request,
   a booking cancelled or rescheduled, equipment stock running low, an item that is still out (or due back within 30 minutes) while the next rental needs it (handoff.js), and the connection to the database being lost. These stay until dismissed and are shown once per booking / rental / end time.
   ===================================================================== */

import { BK, DMG, EXT, OFR, RL, STK, refresh } from './data.js';
import { followUpOffer, offerAnswerText } from './swapOffer.js';
import { dmgOf, dmgStatus } from './damage.js';
import { balanceOf } from './bookings.js';
import { dOf, money, tOf } from './helpers.js';
import { overdueHours } from './rentals.js';
import { handoffDetail, handoffHeadline, handoffRisks, openHandoffDialog } from './handoff.js';
import { ENDING_SOON } from './sessions.js';
import { esc, reducedMotion, shortDate } from '../shared/utils.js';

const KINDS = {
    pcnt: { tab: 'a-pay', one: 'New payment waiting', many: n => `${n} new payments waiting`, sub: 'Verify the GCash payment so the customer is confirmed.', cta: 'View payments', sticky: true },
    bcnt: { tab: 'a-book', one: 'New booking', many: n => `${n} new bookings`, sub: 'Pending approval.', cta: 'View bookings' },
    rcnt: { tab: 'a-rent', one: 'New rental request', many: n => `${n} new rental requests`, sub: 'Needs a review or action.', cta: 'View rentals' }
};
const last = {};
let box, baseTitle = document.title;

function container() {
    if (!box) {
        box = document.createElement('div');
        box.className = 'adm-toasts';
        box.setAttribute('role', 'status');
        box.setAttribute('aria-live', 'polite');
        document.body.appendChild(box);
    }
    return box;
}

function dismiss(el) {
    if (!el.isConnected)
        return;
    el.classList.add('out');
    setTimeout(() => el.remove(), reducedMotion() ? 0 : 250);
}

function show(id, gained) {
    const k = KINDS[id];
    const old = container().querySelector(`[data-k="${id}"]`);
    if (old) {   // keep one pop-up per kind and add to its number
        gained += +old.dataset.n;
        old.remove();
    }
    const el = document.createElement('div');
    el.className = 'adm-toast' + (k.sticky ? ' pay' : '');
    el.dataset.k = id;
    el.dataset.n = gained;
    el.innerHTML = `<b>${esc(gained > 1 ? k.many(gained) : k.one)}</b><span>${esc(k.sub)}</span>
      <div class="adm-toast-row"><button type="button" class="btn sm gold" data-go>${esc(k.cta)}</button><button type="button" class="adm-toast-x" data-x>Dismiss</button></div>`;
    el.addEventListener('click', e => {
        if (e.target.closest('[data-go]'))
            location.hash = k.tab;
        if (e.target.closest('[data-go],[data-x]'))
            dismiss(el);
    });
    container().appendChild(el);
    while (box.children.length > 8)
        box.firstElementChild.remove();
    if (!k.sticky)
        setTimeout(() => dismiss(el), 8000);
}

/* first load: one summary of everything already waiting, e.g. "2 payments and 1 booking waiting".
   "View" opens the most urgent tab (payments first). */
const NOUN = { pcnt: ['payment', 'payments'], bcnt: ['booking', 'bookings'], rcnt: ['rental request', 'rental requests'] };

function showSummary(counts) {
    const ids = ['pcnt', 'bcnt', 'rcnt'].filter(id => counts[id] > 0);
    if (!ids.length)
        return;
    const parts = ids.map(id => `${counts[id]} ${NOUN[id][counts[id] === 1 ? 0 : 1]}`);
    const text = parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1] : parts[0];
    const k = KINDS[ids[0]];
    const el = document.createElement('div');
    el.className = 'adm-toast' + (ids[0] === 'pcnt' ? ' pay' : '');
    el.innerHTML = `<b>${esc('Waiting for you: ' + text)}</b><span>Received while you were away.</span>
      <div class="adm-toast-row"><button type="button" class="btn sm gold" data-go>${esc(k.cta)}</button><button type="button" class="adm-toast-x" data-x>Dismiss</button></div>`;
    el.addEventListener('click', e => {
        if (e.target.closest('[data-go]'))
            location.hash = k.tab;
        if (e.target.closest('[data-go],[data-x]'))
            dismiss(el);
    });
    container().appendChild(el);
    setTimeout(() => dismiss(el), 12000);
}

/* counts = { pcnt: 2, bcnt: 1, rcnt: 0 } */
export function notifyBadgeCounts(counts) {
    const first = !Object.keys(last).length;
    let total = 0;
    Object.entries(counts).forEach(([id, n]) => {
        total += n;
        if (!first && KINDS[id] && n > (last[id] ?? 0))
            show(id, n - (last[id] ?? 0));
        last[id] = n;
    });
    if (first)
        showSummary(counts);
    document.title = total ? `(${total}) ${baseTitle}` : baseTitle;   // visible on another browser tab too
}


/* ============ Clock-based pop-ups: start time reached, session about to end ============ */

const TIMED = {
    bstart: { tab: 'a-sess', one: 'Booking time has come', many: n => `${n} bookings reached their start time`, sub: 'Start the session when the band arrives.', cta: 'View sessions', cls: ' pay' },
    rstart: { tab: 'a-rent', one: 'Rental pick-up time has come', many: n => `${n} rentals reached their pick-up time`, sub: 'Issue the equipment to the customer.', cta: 'View rentals', cls: ' pay' },
    rreturn: { tab: 'a-rent', one: 'Equipment is due back', many: n => `${n} rentals are due back`, sub: 'Return time has come. Check the gear in when it arrives.', cta: 'View rentals', cls: ' pay' },
    rover: { tab: 'a-rent', one: 'Rental overdue', many: n => `${n} rentals are overdue`, sub: 'Past the return time. A late fee applies.', cta: 'View rentals', cls: '' },
    sover: { tab: 'a-sess', one: 'Session is over time', many: n => `${n} sessions are over time`, sub: 'The end time has passed. Wrap up now (collect any balance first), or extend the session.', cta: 'View sessions', cls: '' },
    extreq: { tab: 'a-sess', one: 'Session extension requested', many: n => `${n} session extensions requested`, sub: 'The band is waiting. Verify the extension.', cta: 'Verify extension', cls: ' pay' },
    bcancel: { tab: 'a-book', one: 'Booking cancelled', many: n => `${n} bookings cancelled`, sub: 'The slot is free again. Adjust your preparation if needed.', cta: 'View bookings', cls: '' },
    bresched: { tab: 'a-book', one: 'Booking rescheduled', many: n => `${n} bookings rescheduled`, sub: 'The session moved to a new time.', cta: 'View bookings', cls: ' pay' },
    stocklow: { tab: 'a-eqp', one: 'Equipment stock is low', many: n => `${n} equipment items are low`, sub: 'Update the stock before customers order it as an add-on.', cta: 'View equipment', cls: ' pay' },
    stockout: { tab: 'a-eqp', one: 'Equipment is out of stock', many: n => `${n} equipment items are out of stock`, sub: 'Add stock, or reject add-on requests for it.', cta: 'View equipment', cls: '' },
    dmgfee: { tab: 'a-pay', one: 'Damage fee not paid yet', many: n => `${n} damage fees not paid yet`, sub: 'The customer owes it. Open Payments and press Collect when they pay.', cta: 'View payments', cls: ' pay' },
    latefee: { tab: 'a-pay', one: 'Late fee not paid yet', many: n => `${n} late fees not paid yet`, sub: 'The customer owes it. Open Payments and press Collect when they pay.', cta: 'View payments', cls: ' pay' },
    swapans: { tab: 'a-rent', one: 'Replacement item: customer answered', many: n => `${n} replacement offers were answered`, sub: 'Check the rental. If the customer declined or did not answer, swap the item or offer others.', cta: 'View rentals', cls: ' pay' },
    send: { tab: 'a-sess', one: 'Session ends in 5 minutes', many: n => `${n} sessions end within 5 minutes`, sub: 'Tell the band, or extend the session.', cta: 'View sessions', cls: '' }
};
/* a rental that is already in use or over (issued, returned, rejected, cancelled): nothing is left to do about its replacement offer */
const rentalOver = ref => {
    const ls = RL.filter(l => l.rental_ref === ref);
    return ls.length > 0 && (['Active', 'Returned', 'Rejected', 'Cancelled'].includes(ls[0].status) || ls.every(l => l.line_returned_at));
};

/* A declined / unanswered offer only needs the pop-up while staff have not acted yet: once they sent a new offer or swapped
   the item, followUpOffer() is no longer this offer. An offer the customer accepted never needs staff. */
const answerOffers = new Map();   // pop-up line text -> the offer behind it
const staffDone = o => ['Declined', 'Expired'].includes(o.status)
    && (followUpOffer(o.rental_detail_id) || {}).offer_id !== o.offer_id;

/* drop the lines of the open "customer answered" pop-up whose rental has finished; close it when none is left */
function pruneSwapAnswers() {
    const el = container().querySelector('[data-k="swapans"]');
    if (!el || !el.dataset.refs)
        return;
    const items = JSON.parse(el.dataset.items), refs = JSON.parse(el.dataset.refs);
    const keep = refs.map((r, i) => i).filter(i => !rentalOver(refs[i]) && !(answerOffers.has(items[i]) && staffDone(answerOffers.get(items[i]))));
    if (keep.length === items.length)
        return;
    el.remove();
    if (keep.length)
        showTimed('swapans', keep.map(i => items[i]), keep.map(i => refs[i]));
}

const seen = new Set();   // keys already announced, so the same booking / rental / end time never pops up twice

/* "Customer answered" replacement offers and "item may not be back in time" alerts are remembered in this browser, so reloading
   the dashboard (or coming back later) does not announce the same thing again. Only the ids are stored. */
const SWAP_SEEN = 'tod_admin_swapans_seen';
try {
    JSON.parse(localStorage.getItem(SWAP_SEEN) || '[]').forEach(k => seen.add(k));
} catch (e) { /* storage blocked: it then only lasts until the page is reloaded */ }
function rememberSwapKey(key) {
    try {
        const list = JSON.parse(localStorage.getItem(SWAP_SEEN) || '[]');
        list.push(key);
        localStorage.setItem(SWAP_SEEN, JSON.stringify(list.slice(-300)));
    } catch (e) { /* ignore */ }
}

/* one pop-up per kind; new items are added to the one that is still open. items = ['Studio A, Juan, 8:00 PM', ...] */
function showTimed(id, items, refs) {
    const k = TIMED[id];
    const old = container().querySelector(`[data-k="${id}"]`);
    if (old) {
        if (refs)
            refs = JSON.parse(old.dataset.refs || '[]').concat(refs);
        items = JSON.parse(old.dataset.items).concat(items);
        old.remove();
    }
    const shown = items.slice(0, 3).map(t => `<span>${esc(t)}</span>`).join('') + (items.length > 3 ? `<span>and ${items.length - 3} more</span>` : '');
    const el = document.createElement('div');
    el.className = 'adm-toast' + k.cls;
    el.dataset.k = id;
    el.dataset.items = JSON.stringify(items);
    if (refs)
        el.dataset.refs = JSON.stringify(refs);   // the rental behind each line, so a line can go away when that rental is finished
    el.innerHTML = `<b>${esc(items.length > 1 ? k.many(items.length) : k.one)}</b>${shown}<span>${esc(k.sub)}</span>
      <div class="adm-toast-row"><button type="button" class="btn sm gold" data-go>${esc(k.cta)}</button><button type="button" class="adm-toast-x" data-x>Dismiss</button></div>`;
    el.addEventListener('click', e => {
        if (e.target.closest('[data-go]'))
            location.hash = k.tab;
        if (e.target.closest('[data-go],[data-x]'))
            dismiss(el);
    });
    container().appendChild(el);
    while (box.children.length > 8)
        box.firstElementChild.remove();   // no auto-dismiss: staff must see these
}


/* ---- bookings cancelled or moved, and equipment stock running low: compared with the previous check ----
   The first check only saves the starting point, so opening the dashboard does not announce old changes.
   (A cancel or reschedule made by staff on this dashboard is announced too.) */
let prevBK = null, prevStock = null;
const OPEN = ['Pending', 'Approved'];

function changedBookings(add) {
    const snap = new Map(BK.map(b => [b.booking_ref, { s: b.status, a: b.start_at, e: b.end_at }]));
    if (prevBK) {
        BK.forEach(b => {
            const p = prevBK.get(b.booking_ref);
            if (!p || !OPEN.includes(p.s))
                return;
            const who = `${b.studio_name}, ${b.customer_name}`, when = `${shortDate(dOf(b.start_at))}, ${tOf(b.start_at)}`;
            if (b.status === 'Cancelled')
                add('bcancel', `c:${b.booking_ref}`, `${who} (was ${shortDate(dOf(p.a))}, ${tOf(p.a)})`);
            else if (OPEN.includes(b.status) && (p.a !== b.start_at || p.e !== b.end_at))
                add('bresched', `m:${b.booking_ref}:${b.start_at}`, `${who}: now ${when}`);
        });
    }
    prevBK = snap;
}

/* 0 = fine, 1 = low (also "In Use": every unit is rented out right now but they come back), 2 = out of stock (no unit can be
   rented at all: every unit is out of service or removed). Items staff switched off (Unavailable) are ignored. */
const stockLevel = c => c.stock_status === 'Unavailable' ? 0
    : c.stock_status === 'Out of Stock' ? 2
        : c.stock_status === 'Low' || c.stock_status === 'In Use' ? 1 : 0;

function stockChanges(add) {
    const snap = new Map(STK.map(c => [c.equipment_id, stockLevel(c)]));
    if (prevStock) {
        STK.forEach(c => {
            const lv = stockLevel(c), was = prevStock.get(c.equipment_id) ?? 0;
            // announce when it gets worse; it can announce again after the stock recovered and dropped again
            if (lv > was)
                add(lv === 2 ? 'stockout' : 'stocklow', `s${lv}:${c.equipment_id}:${Date.now()}`, `${c.name} (${Math.max(0, Number(c.available))} left)`);
        });
    }
    prevStock = snap;
}

/* ---- an item that is still out (or due back within 30 minutes) while the next customer needs it ----
   One pop-up lists every such pair. Each line has its own "Swap or contact customer" button. A pair is announced once per stage
   ("due back soon", then "overdue"); a line goes away by itself when the item is returned or the next rental is swapped. */
const hoLive = new Map();   // pair key -> the risk shown in the pop-up

function renderHandoff() {
    container().querySelector('[data-k="handoff"]')?.remove();
    const list = [...hoLive.values()];
    if (!list.length)
        return;
    const late = list.some(r => r.stage === 'late');
    const el = document.createElement('div');
    el.className = 'adm-toast' + (late ? '' : ' pay');
    el.dataset.k = 'handoff';
    el.innerHTML = `<b>${esc(late ? 'Overdue: an item is needed by the next customer' : 'An item is due back just before the next customer needs it')}</b>`
        + list.slice(0, 3).map(r => `<div class="ho-item"><span><b>${handoffHeadline(r)}</b></span><span>${esc(handoffDetail(r))}</span>
          <button type="button" class="btn sm gold" data-ho="${esc(r.key)}">Swap or contact customer</button></div>`).join('')
        + (list.length > 3 ? `<span>and ${list.length - 3} more</span>` : '')
        + '<div class="adm-toast-row"><span></span><button type="button" class="adm-toast-x" data-x>Dismiss</button></div>';
    el.addEventListener('click', e => {
        const go = e.target.closest('[data-ho]');
        if (go && hoLive.has(go.dataset.ho))
            openHandoffDialog(hoLive.get(go.dataset.ho));
        if (e.target.closest('[data-x]')) {
            hoLive.clear();
            dismiss(el);
        }
    });
    container().appendChild(el);
    while (box.children.length > 8)
        box.firstElementChild.remove();
}

function handoffAlerts() {
    const cur = new Map(handoffRisks().map(r => [r.key, r]));
    let changed = false;
    [...hoLive.keys()].forEach(k => {
        if (!cur.has(k)) {   // returned, swapped or cancelled
            hoLive.delete(k);
            changed = true;
        }
    });
    cur.forEach((r, k) => {
        const stageKey = `ho:${k}:${r.stage}`;
        if (!seen.has(stageKey)) {
            seen.add(stageKey);
            rememberSwapKey(stageKey);
            hoLive.set(k, r);
            changed = true;
        } else if (hoLive.has(k)) {
            const was = hoLive.get(k);
            changed = changed || was.stage !== r.stage || was.dueAt !== r.dueAt;
            hoLive.set(k, r);
        }
    });
    if (changed)
        renderHandoff();
}

/* ---- connection: shown when the 30-second refresh cannot reach the database, removed when it works again ---- */
let connEl = null;

export function notifyConnection(ok) {
    if (ok) {
        if (!connEl)
            return;
        dismiss(connEl);
        connEl = null;
        const el = document.createElement('div');
        el.className = 'adm-toast pay';
        el.innerHTML = '<b>Back online</b><span>The dashboard is up to date again.</span>';
        container().appendChild(el);
        setTimeout(() => dismiss(el), 4000);
        return;
    }
    if (connEl && connEl.isConnected)
        return;
    connEl = document.createElement('div');
    connEl.className = 'adm-toast';
    connEl.innerHTML = `<b>Connection problem</b><span>You are seeing the last data that loaded. New bookings and payments may be missing. Retrying every 30 seconds.</span>
      <div class="adm-toast-row"><button type="button" class="btn sm gold" data-retry>Retry now</button><button type="button" class="adm-toast-x" data-x>Dismiss</button></div>`;
    connEl.addEventListener('click', e => {
        if (e.target.closest('[data-retry]'))
            refresh(true);
        if (e.target.closest('[data-x]'))
            dismiss(connEl);
    });
    container().appendChild(connEl);
}

window.addEventListener('offline', () => notifyConnection(false));
window.addEventListener('online', () => refresh(true));   // a successful load removes the pop-up

/* Called every 15 seconds (index.js) and after each redraw. Looks at the loaded bookings and rental lines. */
export function checkTimeAlerts() {
    const now = Date.now();
    const fresh = { bstart: [], rstart: [], rreturn: [], rover: [], send: [], sover: [], extreq: [], bcancel: [], bresched: [], stocklow: [], stockout: [], dmgfee: [], latefee: [], swapans: [] };
    const add = (id, key, text) => {
        if (seen.has(key))
            return;
        seen.add(key);
        if (id === 'swapans')
            rememberSwapKey(key);
        fresh[id].push(text);
    };
    BK.forEach(b => {
        const start = new Date(b.start_at).getTime(), end = new Date(b.end_at).getTime();
        const who = `${b.studio_name}, ${b.customer_name}`;
        if (b.status === 'Approved' && start <= now && end > now) {
            // staff cannot start the session before the balance is collected, so say so right in the pop-up
            const owed = balanceOf(b);
            add('bstart', `b:${b.booking_ref}:${b.start_at}`, `${who} (${tOf(b.start_at)})${owed > 0.005 ? `, balance due ${money(owed)}` : ''}`);
        }
        // the end time is part of the key: if the session is extended, it warns again before the new end time
        if (b.status === 'In Progress' && end > now && end - now <= ENDING_SOON)
            add('send', `e:${b.booking_ref}:${b.end_at}`, `${who} (ends ${tOf(b.end_at)})`);
        if (b.status === 'In Progress' && end <= now)
            add('sover', `o:${b.booking_ref}:${b.end_at}`, `${who} (ended ${tOf(b.end_at)})${balanceOf(b) > 0.005 ? `, balance due ${money(balanceOf(b))}` : ''}`);   // a session with a balance does not complete by itself (file 86)
    });
    // a customer asked to extend a session
    EXT.filter(x => x.status === 'Pending').forEach(x => {
        const b = BK.find(y => y.booking_ref === x.booking_ref);
        add('extreq', `x:${x.extension_id}`, `${b ? b.studio_name + ', ' + b.customer_name : x.booking_ref} (+${x.extra_hours} h)`);
    });
    // damage fees the customer still owes (recorded at a return, not paid yet): announced once each, until dismissed
    [...new Set(DMG.filter(d => Number(d.amount) > 0).map(d => d.rental_ref))].filter(ref => dmgStatus(ref) === 'Unpaid').forEach(ref => {
        const list = dmgOf(ref).filter(d => Number(d.amount) > 0 && d.status === 'Unpaid'), owed = list.reduce((n, d) => n + Number(d.amount), 0);
        add('dmgfee', `u:${ref}:${owed}`, `${(list[0] || {}).customer_name || ref} (${ref}), ${money(owed)}`);
    });
    // late fees left unpaid at the return (83_late_fee_collection.sql): announced once each, until dismissed. A GCash payment the customer sent is counted by the Payments badge.
    [...new Set(RL.filter(l => l.late_fee_deferred && !l.late_fee_paid_at && !l.late_fee_pending_reference && Number(l.late_fee) > 0).map(l => l.rental_ref))].forEach(ref => {
        const list = RL.filter(l => l.rental_ref === ref && l.late_fee_deferred && !l.late_fee_paid_at && !l.late_fee_pending_reference && Number(l.late_fee) > 0);
        const owed = list.reduce((n, l) => n + Number(l.late_fee), 0);
        add('latefee', `l:${ref}:${owed}`, `${(list[0] || {}).customer_name || ref} (${ref}), ${money(owed)}`);
    });
    // replacement offers the customer answered (chose, declined) or that ended without an answer: announced once each (remembered across reloads), until dismissed
    const swapRefs = [];
    OFR.filter(o => ['Swapped', 'Declined', 'Expired'].includes(o.status) && o.resolved_at && now - new Date(o.resolved_at).getTime() < 24 * 36e5 && !rentalOver(o.rental_ref) && !staffDone(o))
        .forEach(o => {
            const n = fresh.swapans.length, text = offerAnswerText(o);
            answerOffers.set(text, o);
            add('swapans', `so:${o.offer_id}:${o.status}`, text);
            if (fresh.swapans.length > n)
                swapRefs.push(o.rental_ref);
        });
    pruneSwapAnswers();
    handoffAlerts();
    changedBookings(add);
    stockChanges(add);
    const rentals = new Set();   // an order has several lines: announce it once
    RL.forEach(l => {
        // outside rentals only: add-ons ride on their booking's session
        if (l.rental_type === 'Outside' && l.status === 'Approved' && l.pickup_date && new Date(l.pickup_date).getTime() <= now && !rentals.has(l.rental_ref)) {
            rentals.add(l.rental_ref);
            add('rstart', `r:${l.rental_ref}:${l.pickup_date}`, `${l.customer_name} (${l.rental_ref})`);
        }
        // in use and not returned: first "due back" when the return time comes, then "overdue" once the first hour is late
        if (l.rental_type === 'Outside' && l.status === 'Active' && !l.line_returned_at && l.due_at && new Date(l.due_at).getTime() <= now && !rentals.has('x' + l.rental_ref)) {
            const late = overdueHours(l) > 0;
            rentals.add('x' + l.rental_ref);
            add(late ? 'rover' : 'rreturn', `${late ? 'o' : 'd'}:${l.rental_ref}:${l.due_at}`,
                `${l.customer_name} (${l.rental_ref})${late ? `, ${overdueHours(l)} h late` : `, due ${tOf(l.due_at)}`}`);
        }
    });
    Object.entries(fresh).forEach(([id, items]) => {
        if (items.length)
            showTimed(id, items, id === 'swapans' ? swapRefs : undefined);
    });
}
