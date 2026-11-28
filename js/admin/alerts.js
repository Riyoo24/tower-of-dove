/* =====================================================================
   admin/alerts.js - the floating "Needs attention" card, on every dashboard page
   One card, fixed at the top right. Collapsed it is a bell tile with a count badge (the badge colour and the tile border follow
   the most urgent tier, and the tile pulses softly while something needs action now). Hover or keyboard focus widens it;
   a click or tap opens the panel, which lists every open item in four tiers: Act now, Coming up, Waiting for review, Can wait.
   The items are STATE: they are worked out again from the loaded bookings, rentals, fees and stock on every check, so they stay
   until the booking, rental or fee is resolved and a reload does not lose them. "Snooze" hides one item until "Bring back"
   (kept in this page only). The "seen" set only decides when to ANNOUNCE: a new item expands the card on its own for 8 seconds
   (it stays open while the mouse is over it) with View all / Dismiss; Dismiss never removes the item from the panel.
   updateNavBadges() (overview.js) calls notifyBadgeCounts() with the sidebar counts (new payments, bookings, rental requests);
   a count that goes UP is announced, and the first call announces one summary. The document title keeps the count.
   checkTimeAlerts() (bottom of this file) adds the clock-based items: a booking or rental that reached its start time,
   a rental that is due back or overdue, a studio session with 5 minutes left or over time, a session extension request,
   a booking cancelled or rescheduled, equipment stock running low, an item that is still out (or due back within 30 minutes)
   while the next rental needs it (handoff.js), unpaid damage and late fees, replacement offers the customer answered,
   and the connection to the database being lost. Each is announced once per booking / rental / end time.
   Cancelled / rescheduled bookings are changes noticed by this page (no timestamp exists in the data), so they last 24 hours
   in this page or until snoozed. Nothing is stored or sent anywhere except the ids of answered offers and handoff stages.
   ===================================================================== */

import { BK, DMG, EXT, OFR, RL, STK, refresh } from './data.js';
import { followUpOffer, offerAnswerText } from './swapOffer.js';
import { dmgOf, dmgStatus } from './damage.js';
import { balanceOf, revealBooking } from './bookings.js';
import { dOf, money, tOf } from './helpers.js';
import { overdueHours, revealRental } from './rentals.js';
import { revealPayment } from './payments.js';
import { handoffDetail, handoffHeadline, handoffRisks, openHandoffDialog } from './handoff.js';
import { ENDING_SOON } from './sessions.js';
import { esc, reducedMotion, shortDate } from '../shared/utils.js';

/* sidebar-count alerts. The panel shows one row per kind with the current count. tier 3 = waiting for review */
const KINDS = {
    pcnt: { tab: 'a-pay', tier: 3, one: 'New payment waiting', many: n => `${n} new payments waiting`, sub: 'Verify the GCash payment so the customer is confirmed.', cta: 'View payments' },
    bcnt: { tab: 'a-book', tier: 3, one: 'New booking', many: n => `${n} new bookings`, sub: 'Pending approval.', cta: 'View bookings' },
    rcnt: { tab: 'a-rent', tier: 3, one: 'New rental request', many: n => `${n} new rental requests`, sub: 'Needs a review or action.', cta: 'View rentals' }
};

/* clock / state alerts. tier: 1 Act now, 2 Coming up, 3 Waiting for review, 4 Can wait */
const TIMED = {
    bstart: { tier: 2, tab: 'a-sess', one: 'Booking time has come', many: n => `${n} bookings reached their start time`, sub: 'Start the session when the band arrives.', cta: 'View sessions' },
    rstart: { tier: 2, tab: 'a-rent', one: 'Rental pick-up time has come', many: n => `${n} rentals reached their pick-up time`, sub: 'Issue the equipment to the customer.', cta: 'View rentals' },
    rreturn: { tier: 2, tab: 'a-rent', one: 'Equipment is due back', many: n => `${n} rentals are due back`, sub: 'Return time has come. Check the gear in when it arrives.', cta: 'View rentals' },
    rover: { tier: 1, tab: 'a-rent', one: 'Rental overdue', many: n => `${n} rentals are overdue`, sub: 'Past the return time. A late fee applies.', cta: 'View rentals' },
    sover: { tier: 1, tab: 'a-sess', one: 'Session is over time', many: n => `${n} sessions are over time`, sub: 'The end time has passed. Wrap up now (collect any balance first), or extend the session.', cta: 'View sessions' },
    extreq: { tier: 1, tab: 'a-sess', one: 'Session extension requested', many: n => `${n} session extensions requested`, sub: 'The band is waiting. Verify the extension.', cta: 'Verify extension' },
    bcancel: { tier: 4, tab: 'a-book', one: 'Booking cancelled', many: n => `${n} bookings cancelled`, sub: 'The slot is free again. Adjust your preparation if needed.', cta: 'View bookings' },
    bresched: { tier: 4, tab: 'a-book', one: 'Booking rescheduled', many: n => `${n} bookings rescheduled`, sub: 'The session moved to a new time.', cta: 'View bookings' },
    stocklow: { tier: 4, tab: 'a-eqp', one: 'Equipment stock is low', many: n => `${n} equipment items are low`, sub: 'Update the stock before customers order it as an add-on.', cta: 'View equipment' },
    stockout: { tier: 4, tab: 'a-eqp', one: 'Equipment is out of stock', many: n => `${n} equipment items are out of stock`, sub: 'Add stock, or reject add-on requests for it.', cta: 'View equipment' },
    dmgfee: { tier: 4, tab: 'a-pay', one: 'Damage fee not paid yet', many: n => `${n} damage fees not paid yet`, sub: 'The customer owes it. Open Payments and press Collect when they pay.', cta: 'View payments' },
    latefee: { tier: 4, tab: 'a-pay', one: 'Late fee not paid yet', many: n => `${n} late fees not paid yet`, sub: 'The customer owes it. Open Payments and press Collect when they pay.', cta: 'View payments' },
    swapans: { tier: 3, tab: 'a-rent', one: 'Replacement item: customer answered', many: n => `${n} replacement offers were answered`, sub: 'Check the rental. If the customer declined or did not answer, swap the item or offer others.', cta: 'View rentals' },
    send: { tier: 2, tab: 'a-sess', one: 'Session ends in 5 minutes', many: n => `${n} sessions end within 5 minutes`, sub: 'Tell the band, or extend the session.', cta: 'View sessions' }
};

const TIERS = [
    { id: 1, name: 'Act now', desc: 'Time has run out or a customer is waiting.' },
    { id: 2, name: 'Coming up', desc: 'Starting, ending or due about now.' },
    { id: 3, name: 'Waiting for review', desc: 'New requests and payments to approve.' },
    { id: 4, name: 'Can wait', desc: 'Unpaid fees, stock and schedule changes.' }
];
const PILL = ['', 'b overdue', 'b pending', 'b confirmed', 'b'];
const MIN = 60000;
const CHEV = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
const BELL = '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9a6 6 0 0112 0c0 5 2 6 2 7H4c0-1 2-2 2-7zM10 20a2 2 0 004 0"/></svg>';

const last = {};            // sidebar counts at the previous call
const since = new Map();    // key -> when this page first saw an item that has no time of its own
const seen = new Set();     // keys already announced, so the same booking / rental / end time is never announced twice
const snoozed = new Set();  // keys the admin snoozed (this page only)
const fold = { 1: false, 2: false, 3: false, 4: true };
const baseTitle = document.title;
let counts = {}, all = [], view = new Map(), lastHtml = '';
let dock, card, trig, panel, body, peek, live, peekTimer, peekDue = false;

const firstSeen = (key, now) => {
    if (!since.has(key))
        since.set(key, now);
    return since.get(key);
};

/* ---------- the DOM: built once ---------- */
function ensure() {
    if (dock)
        return;
    dock = document.createElement('div');
    dock.className = 'na-dock no-print';
    dock.dataset.open = 'false';
    dock.innerHTML = `<div class="na-card" id="na-card" data-top="0">
        <button type="button" class="na-trig" id="na-trig" aria-expanded="false" aria-controls="na-panel">
          <span class="na-ico">${BELL}<span class="na-n" id="na-count">0</span></span>
          <span class="na-t"><b>Needs attention</b><span id="na-trig-sub"></span></span>
          ${CHEV}
        </button>
        <div class="na-peek" id="na-peek" role="group" aria-label="New alert" hidden></div>
      </div>
      <section class="na-panel card" id="na-panel" role="dialog" aria-labelledby="na-h" inert>
        <header class="na-head"><div><h3 id="na-h">Needs attention</h3><p class="mut" id="na-sub"></p></div><button type="button" class="na-x" id="na-close" aria-label="Close" title="Close"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></header>
        <div class="na-body" id="na-body"></div>
        <footer class="na-foot" id="na-foot" hidden><span id="na-snzn"></span><button type="button" id="na-unsnooze">Bring back</button></footer>
      </section>
      <div class="na-sr" id="na-live" role="status" aria-live="polite"></div>`;
    document.body.appendChild(dock);
    card = dock.querySelector('#na-card');
    trig = dock.querySelector('#na-trig');
    panel = dock.querySelector('#na-panel');
    body = dock.querySelector('#na-body');
    peek = dock.querySelector('#na-peek');
    live = dock.querySelector('#na-live');

    trig.addEventListener('click', () => setOpen(true));
    dock.querySelector('#na-close').addEventListener('click', () => setOpen(false));
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape' && dock.dataset.open === 'true')
            setOpen(false);
    });
    card.addEventListener('mouseleave', () => {
        if (peekDue)
            hidePeek();   // the 8 seconds ran out while the mouse was over the card
    });
    peek.addEventListener('click', e => {
        if (e.target.closest('[data-x]'))
            return hidePeek();
        if (e.target.closest('[data-open]')) {
            const key = peek.dataset.k;
            setOpen(true);
            if (key)
                setTimeout(() => flash(key), 60);
        }
    });
    body.addEventListener('click', e => {
        const f = e.target.closest('.na-th');   // the tier heading only (the tier section carries data-fold too)
        if (f) {
            fold[f.dataset.fold] = !fold[f.dataset.fold];
            return render();
        }
        const g = e.target.closest('[data-go]');
        if (g) {
            const it = view.get(g.dataset.go);
            if (!it)
                return;
            if (it.act) {
                setOpen(false);
                it.act();
            } else {
                setOpen(false);
                goTo(it);
            }
            return;
        }
        const s = e.target.closest('[data-snz]');
        if (s) {
            const row = s.closest('.na-row');
            snoozed.add(s.dataset.snz);
            if (row && !reducedMotion()) {
                row.classList.add('gone');
                setTimeout(render, 220);
            } else
                render();
        }
    });
    dock.querySelector('#na-unsnooze').addEventListener('click', () => {
        snoozed.clear();
        render();
    });
}

function setOpen(open) {
    ensure();
    dock.dataset.open = open;
    trig.setAttribute('aria-expanded', open);
    if (open) {
        panel.removeAttribute('inert');
        hidePeek();
        dock.querySelector('#na-close').focus({ preventScroll: true });
    } else {
        const had = panel.contains(document.activeElement);
        panel.setAttribute('inert', '');
        if (had)
            trig.focus();
    }
}

/* ---------- going to the item: open its tab and highlight the exact row ---------- */

/* Bookings, Rentals and Payments have a reveal function that clears the tab's filters and pages so the row is never hidden,
   then scrolls to the row and highlights it (jump.js). Session cards and equipment rows are found here. */
function goTo(it) {
    if (it.hl === 'booking')
        return revealBooking(it.ref);
    if (it.hl === 'rental')
        return revealRental(it.ref);
    if (it.hl === 'pay')
        return revealPayment(it.ref);
    location.hash = it.tab;
    if (!it.hl)
        return;
    const find = () => {
        if (it.hl === 'sess')
            return document.querySelector(`#a-sess [data-id="${CSS.escape(it.ref)}"]`)?.closest('.ss-card');
        return [...document.querySelectorAll('#aeq tr')].find(r => r.textContent.includes(it.ref));
    };
    const go = (tries = 0) => {
        const el = find();
        if (!el || !el.offsetParent) {   // the tab shows on the next hashchange
            if (tries < 20)
                setTimeout(() => go(tries + 1), 50);
            return;
        }
        document.querySelectorAll('.row-flash, .na-hl').forEach(x => x.classList.remove('row-flash', 'na-hl'));
        el.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
        const cls = el.tagName === 'TR' ? 'row-flash' : 'na-hl';
        void el.offsetWidth;
        el.classList.add(cls);
        setTimeout(() => el.classList.remove(cls), 4200);
    };
    setTimeout(go, 80);   // after showTab() has scrolled the page to the top
}

/* ---------- the items ---------- */
const span = m => m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} d`;

function chipText(it, now = Date.now()) {
    if (it.chip === 'late')
        return `${span(Math.max(1, Math.round((now - it.ts) / MIN)))} late`;
    if (it.ts - now > 30000)
        return `in ${span(Math.max(1, Math.round((it.ts - now) / MIN)))}`;
    const a = Math.round((now - it.ts) / MIN);
    return a < 1 ? 'just now' : `${span(a)} ago`;
}

/* a rental that is already in use or over (issued, returned, rejected, cancelled): nothing is left to do about its replacement offer */
const rentalOver = ref => {
    const ls = RL.filter(l => l.rental_ref === ref);
    return ls.length > 0 && (['Active', 'Returned', 'Rejected', 'Cancelled'].includes(ls[0].status) || ls.every(l => l.line_returned_at));
};

/* A declined / unanswered offer only needs attention while staff have not acted yet: once they sent a new offer or swapped
   the item, followUpOffer() is no longer this offer. An offer the customer accepted never needs staff. */
const staffDone = o => ['Declined', 'Expired'].includes(o.status)
    && (followUpOffer(o.rental_detail_id) || {}).offer_id !== o.offer_id;

const plain = html => new DOMParser().parseFromString(html, 'text/html').body.textContent;   // escaped html -> plain text

const ms = v => {
    const n = v ? new Date(v).getTime() : NaN;
    return Number.isFinite(n) ? n : null;
};

let connDown = false, connSince = 0;
let prevBK = null, prevStock = null;
const events = new Map();   // cancelled / rescheduled bookings noticed by this page: key -> item
const OPEN = ['Pending', 'Approved'];
const EVENT_LIFE = 24 * 36e5;

/* 0 = fine, 1 = low (also "In Use": every unit is rented out right now but they come back), 2 = out of stock (no unit can be
   rented at all: every unit is out of service or removed). Items staff switched off (Unavailable) are ignored. */
const stockLevel = c => c.stock_status === 'Unavailable' ? 0
    : c.stock_status === 'Out of Stock' ? 2
        : c.stock_status === 'Low' || c.stock_status === 'In Use' ? 1 : 0;

/* Every open item, worked out from what the dashboard has loaded. ann = the key that decides when to announce (null: never). */
function collect(now, ctx) {
    const out = [];
    const put = (kind, key, detail, ts, o = {}) => {
        const k = TIMED[kind];
        out.push({ kind, tier: k.tier, key, title: k.one, detail, tab: k.tab, cta: k.cta, ts, ann: key, ...o });
    };

    BK.forEach(b => {
        const start = new Date(b.start_at).getTime(), end = new Date(b.end_at).getTime();
        const who = `${b.studio_name}, ${b.customer_name}`;
        if (b.status === 'Approved' && start <= now && end > now) {
            // staff cannot start the session before the balance is collected, so say so right here
            const owed = balanceOf(b);
            put('bstart', `b:${b.booking_ref}:${b.start_at}`, `${who} (${tOf(b.start_at)})${owed > 0.005 ? `, balance due ${money(owed)}` : ''}`, start, { ref: b.booking_ref, hl: 'sess' });
        }
        // the end time is part of the key: if the session is extended, it warns again before the new end time
        if (b.status === 'In Progress' && end > now && end - now <= ENDING_SOON)
            put('send', `e:${b.booking_ref}:${b.end_at}`, `${who} (ends ${tOf(b.end_at)})`, end, { ref: b.booking_ref, hl: 'sess' });
        if (b.status === 'In Progress' && end <= now)
            put('sover', `o:${b.booking_ref}:${b.end_at}`, `${who} (ended ${tOf(b.end_at)})${balanceOf(b) > 0.005 ? `, balance due ${money(balanceOf(b))}` : ''}`, end, { chip: 'late', hint: TIMED.sover.sub, ref: b.booking_ref, hl: 'sess' });   // a session with a balance does not complete by itself (file 86)
    });

    // a customer asked to extend a session
    EXT.filter(x => x.status === 'Pending').forEach(x => {
        const b = BK.find(y => y.booking_ref === x.booking_ref);
        put('extreq', `x:${x.extension_id}`, `${b ? b.studio_name + ', ' + b.customer_name : x.booking_ref} (+${x.extra_hours} h)`, ms(x.created_at) ?? firstSeen(`x:${x.extension_id}`, now), { hint: TIMED.extreq.sub, ref: x.booking_ref, hl: 'sess' });
    });

    // damage fees the customer still owes (recorded at a return, not paid yet)
    [...new Set(DMG.filter(d => Number(d.amount) > 0).map(d => d.rental_ref))].filter(ref => dmgStatus(ref) === 'Unpaid').forEach(ref => {
        const list = dmgOf(ref).filter(d => Number(d.amount) > 0 && d.status === 'Unpaid'), owed = list.reduce((n, d) => n + Number(d.amount), 0);
        const key = `u:${ref}:${owed}`;
        put('dmgfee', key, `${(list[0] || {}).customer_name || ref} (${ref}), ${money(owed)}`, Math.min(...list.map(d => ms(d.created_at) ?? Infinity), firstSeen(key, now)), { ref, hl: 'pay' });
    });

    // late fees left unpaid at the return (83_late_fee_collection.sql). A GCash payment the customer sent is counted by the Payments badge.
    [...new Set(RL.filter(l => l.late_fee_deferred && !l.late_fee_paid_at && !l.late_fee_pending_reference && Number(l.late_fee) > 0).map(l => l.rental_ref))].forEach(ref => {
        const list = RL.filter(l => l.rental_ref === ref && l.late_fee_deferred && !l.late_fee_paid_at && !l.late_fee_pending_reference && Number(l.late_fee) > 0);
        const owed = list.reduce((n, l) => n + Number(l.late_fee), 0), key = `l:${ref}:${owed}`;
        put('latefee', key, `${(list[0] || {}).customer_name || ref} (${ref}), ${money(owed)}`, firstSeen(key, now), { ref, hl: 'pay' });
    });

    // replacement offers the customer answered (chose, declined) or that ended without an answer, until the rental is over or staff acted
    OFR.filter(o => ['Swapped', 'Declined', 'Expired'].includes(o.status) && o.resolved_at && now - new Date(o.resolved_at).getTime() < 24 * 36e5 && !rentalOver(o.rental_ref) && !staffDone(o))
        .forEach(o => put('swapans', `so:${o.offer_id}:${o.status}`, offerAnswerText(o), new Date(o.resolved_at).getTime(), { rem: true, ref: o.rental_ref, hl: 'rental' }));

    // an item that is still out (or due back within 30 minutes) while the next customer needs it
    handoffRisks(now).forEach(r => {
        const late = r.stage === 'late';
        out.push({
            kind: 'handoff', tier: late ? 1 : 2, key: `ho:${r.key}`, ann: `ho:${r.key}:${r.stage}`, rem: true,
            title: late ? 'Overdue: an item is needed by the next customer' : 'An item is due back just before the next customer needs it',
            detailHtml: `${handoffHeadline(r)} ${esc(handoffDetail(r))}`, detail: `${plain(handoffHeadline(r))} ${handoffDetail(r)}`,
            hint: late ? 'The next customer may have nothing to use. Swap the item or contact the customer.' : '',
            cta: 'Swap or contact customer', act: () => openHandoffDialog(r), ts: r.dueAt, chip: late ? 'late' : ''
        });
    });

    // stock running low / out
    STK.forEach(c => {
        const lv = stockLevel(c);
        if (!lv)
            return;
        const kind = lv === 2 ? 'stockout' : 'stocklow', key = `stk:${c.equipment_id}:${lv}`;
        put(kind, key, `${c.name} (${Math.max(0, Number(c.available))} left)`, firstSeen(key, now),
            { ref: c.name, hl: 'eqp', ann: ctx.stockWorse && ctx.stockWorse.has(String(c.equipment_id)) ? `s${lv}:${c.equipment_id}:${now}` : null });
    });

    // cancelled / rescheduled bookings noticed by this page
    events.forEach((e, k) => {
        if (now - e.ts > EVENT_LIFE)
            events.delete(k);
        else
            out.push(e);
    });

    // outside rentals only: add-ons ride on their booking's session
    const rentals = new Set();   // an order has several lines: list it once
    RL.forEach(l => {
        if (l.rental_type === 'Outside' && l.status === 'Approved' && l.pickup_date && new Date(l.pickup_date).getTime() <= now && !rentals.has(l.rental_ref)) {
            rentals.add(l.rental_ref);
            put('rstart', `r:${l.rental_ref}:${l.pickup_date}`, `${l.customer_name} (${l.rental_ref})`, new Date(l.pickup_date).getTime(), { ref: l.rental_ref, hl: 'rental' });
        }
        // in use and not returned: first "due back" when the return time comes, then "overdue" once the first hour is late
        if (l.rental_type === 'Outside' && l.status === 'Active' && !l.line_returned_at && l.due_at && new Date(l.due_at).getTime() <= now && !rentals.has('x' + l.rental_ref)) {
            const late = overdueHours(l) > 0, due = new Date(l.due_at).getTime();
            rentals.add('x' + l.rental_ref);
            put(late ? 'rover' : 'rreturn', `${late ? 'o' : 'd'}:${l.rental_ref}:${l.due_at}`,
                `${l.customer_name} (${l.rental_ref})${late ? `, ${overdueHours(l)} h late` : `, due ${tOf(l.due_at)}`}`, due,
                { ref: l.rental_ref, hl: 'rental', ...(late ? { chip: 'late', hint: TIMED.rover.sub } : {}) });
        }
    });

    // the sidebar counts: one row per kind with the current number
    Object.keys(KINDS).forEach(id => {
        const n = counts[id] || 0, k = KINDS[id];
        if (n > 0)
            out.push({ kind: id, tier: k.tier, key: `cnt:${id}`, ann: null, title: n > 1 ? k.many(n) : k.one, detail: k.sub, tab: k.tab, cta: k.cta, ts: firstSeen(`cnt:${id}`, now) });
        else
            since.delete(`cnt:${id}`);
    });

    if (connDown)
        out.push({
            kind: 'conn', tier: 1, key: 'conn', ann: `conn:${connSince}`, title: 'Connection problem', ts: connSince,
            detail: 'You are seeing the last data that loaded. New bookings and payments may be missing. Retrying every 30 seconds.',
            hint: 'Check the internet connection, or retry now.', cta: 'Retry now', act: () => refresh(true)
        });
    return out;
}

/* ---------- drawing ---------- */
function rowHtml(it, now) {
    return `<li class="na-row" data-k="${esc(it.key)}"><div class="na-r1"><b>${esc(it.title)}</b><span class="${PILL[it.tier]}">${esc(chipText(it, now))}</span></div>
      <p class="mut">${it.detailHtml || esc(it.detail)}</p>${it.tier === 1 && it.hint ? `<p class="na-hint">${esc(it.hint)}</p>` : ''}
      <div class="na-r3"><button type="button" class="btn sm ${it.tier < 3 ? 'gold' : 'line'}" data-go="${esc(it.key)}" data-f="go:${esc(it.key)}">${esc(it.cta)}</button>
      <button type="button" class="na-snz" data-snz="${esc(it.key)}" data-f="snz:${esc(it.key)}" aria-label="Snooze: ${esc(it.title)}">Snooze</button></div></li>`;
}

function render() {
    ensure();
    const now = Date.now();
    const shown = all.filter(i => !snoozed.has(i.key));
    view = new Map(all.map(i => [i.key, i]));
    let top = 0, html = '';
    TIERS.forEach(t => {
        const list = shown.filter(i => i.tier === t.id).sort((a, b) => a.ts - b.ts);
        if (!list.length)
            return;
        top = top || t.id;
        html += `<section class="na-tier t${t.id}" data-fold="${fold[t.id]}"><button type="button" class="na-th" data-fold="${t.id}" data-f="fold:${t.id}" aria-expanded="${!fold[t.id]}"><h3>${t.name}</h3><span class="b">${list.length}</span>${CHEV}</button>
          <p class="mut">${t.desc}</p><ul class="na-rows">${list.map(i => rowHtml(i, now)).join('')}</ul></section>`;
    });
    const total = shown.length, now1 = shown.filter(i => i.tier === 1).length, nSnz = all.length - total;
    if (!total)
        html = '<div class="na-clear"><b>All clear</b><p class="mut">Nothing needs you right now. New items show up here.</p></div>';

    card.dataset.top = top;
    dock.querySelector('#na-count').textContent = total > 99 ? '99+' : total;
    dock.querySelector('#na-trig-sub').textContent = total ? (now1 ? `${now1} ${now1 === 1 ? 'needs' : 'need'} action now` : 'Nothing urgent') : 'All clear';
    trig.setAttribute('aria-label', `Needs attention: ${total} ${total === 1 ? 'item' : 'items'}${now1 ? `, ${now1} to act on now` : ''}`);
    dock.querySelector('#na-sub').innerHTML = total ? `${total} ${total === 1 ? 'item' : 'items'}${now1 ? `, <b>${now1} to act on now</b>` : ''}` : 'Nothing waiting';
    dock.querySelector('#na-foot').hidden = !nSnz;
    dock.querySelector('#na-snzn').textContent = `${nSnz} snoozed`;

    if (html === lastHtml)
        return;
    lastHtml = html;
    // redraw without losing the scroll position or the focused button
    const a = document.activeElement, f = a && body.contains(a) ? a.dataset.f : null, st = body.scrollTop;
    body.innerHTML = html;
    body.scrollTop = st;
    if (f)
        [...body.querySelectorAll('[data-f]')].find(x => x.dataset.f === f)?.focus({ preventScroll: true });
}

function rowOf(key) {
    return [...body.querySelectorAll('.na-row')].find(r => r.dataset.k === key);
}

/* open the row's tier if folded, scroll to it and highlight it */
function flash(key) {
    const it = view.get(key);
    if (!it)
        return;
    if (fold[it.tier]) {
        fold[it.tier] = false;
        lastHtml = '';
        render();
    }
    const el = rowOf(key);
    if (!el)
        return;
    el.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
}

/* ---------- announcing a new item: the card expands on its own ---------- */
function hidePeek() {
    clearTimeout(peekTimer);
    peekDue = false;
    if (!peek)
        return;
    peek.hidden = true;
    peek.innerHTML = '';
    delete peek.dataset.k;
    delete peek.dataset.sticky;
    card.classList.remove('alert');
}

function showPeek(p) {
    ensure();
    peek.dataset.k = p.key || '';
    if (!p.key)
        delete peek.dataset.k;
    peek.innerHTML = `<div class="na-r1"><b>${esc(p.title)}</b><span class="${PILL[p.tier || 4]}">${esc(p.chip)}</span></div><p class="mut">${esc(p.detail)}</p>
      <div class="na-r3">${p.noView ? '<span></span>' : '<button type="button" class="btn sm gold" data-open>View all</button>'}<button type="button" class="na-snz" data-x>Dismiss</button></div>`;
    peek.hidden = false;
    peek.style.animation = 'none';
    void peek.offsetWidth;
    peek.style.animation = '';
    card.classList.add('alert');
    clearTimeout(peekTimer);
    peekDue = false;
    // an "Act now" item stays open until staff dismiss it, open it, or the underlying item is resolved
    if (p.tier === 1 && p.key && !p.noView) {
        peek.dataset.sticky = '1';
        return;
    }
    delete peek.dataset.sticky;
    peekTimer = setTimeout(() => {
        if (card.matches(':hover'))
            peekDue = true;   // stays open until the mouse leaves
        else
            hidePeek();
    }, p.ttl || 8000);
}

/* fresh = items not announced before. One card for the most urgent; "and N more" when several arrive together. */
function announce(fresh) {
    if (!fresh.length)
        return;
    fresh.sort((a, b) => a.tier - b.tier || a.ts - b.ts);
    const f = fresh[0], n = fresh.length, now = Date.now();
    const same = n > 1 && fresh.every(x => x.kind === f.kind) && (TIMED[f.kind] || KINDS[f.kind]);
    const p = {
        key: f.key, tier: f.tier, chip: chipText(f, now),
        title: same ? (TIMED[f.kind] || KINDS[f.kind]).many(n) : f.title,
        detail: f.detail + (n > 1 ? (same ? `, and ${n - 1} more` : ` (and ${n - 1} more new)`) : '')
    };
    live.textContent = `New: ${p.title}`;
    if (dock.dataset.open === 'true')
        setTimeout(() => flash(f.key), 40);   // the panel is open: highlight the new row instead
    else if (!(peek.dataset.sticky && !peek.hidden && p.tier > 1))
        showPeek(p);   // an open "Act now" card is not replaced by something less urgent
}

/* recompute everything, redraw, and announce what is new. ctx.gained = sidebar counts that went up; ctx.summary = first-load text */
function sync(ctx = {}) {
    ensure();
    const now = Date.now();
    all = collect(now, ctx);
    const fresh = [];
    all.forEach(it => {
        if (!it.ann || seen.has(it.ann))
            return;
        seen.add(it.ann);
        if (it.rem)
            rememberSwapKey(it.ann);   // "answered" offers and handoff stages are remembered across reloads
        fresh.push(it);
    });
    Object.entries(ctx.gained || {}).forEach(([id, n]) => {
        const it = all.find(i => i.key === `cnt:${id}`);
        if (it)
            fresh.push({ ...it, title: n > 1 ? KINDS[id].many(n) : KINDS[id].one, ts: now });
    });
    if (ctx.summary)
        fresh.push({ kind: 'summary', tier: 3, key: ctx.summary.key, title: ctx.summary.title, detail: 'Received while you were away.', ts: now });
    // a snoozed item that is gone (resolved) is forgotten
    snoozed.forEach(k => {
        if (!all.some(i => i.key === k))
            snoozed.delete(k);
    });
    render();
    if (peek.dataset.sticky && !all.some(i => i.key === peek.dataset.k && !snoozed.has(i.key)))
        hidePeek();   // the urgent item was resolved or snoozed
    announce(fresh.filter(i => !snoozed.has(i.key)));
}

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

/* ---------- sidebar counts ---------- */

/* first load: one summary of everything already waiting, e.g. "2 payments and 1 booking waiting".
   "View all" opens the panel. */
const NOUN = { pcnt: ['payment', 'payments'], bcnt: ['booking', 'bookings'], rcnt: ['rental request', 'rental requests'] };

function summaryOf(c) {
    const ids = ['pcnt', 'bcnt', 'rcnt'].filter(id => c[id] > 0);
    if (!ids.length)
        return null;
    const parts = ids.map(id => `${c[id]} ${NOUN[id][c[id] === 1 ? 0 : 1]}`);
    const text = parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1] : parts[0];
    return { key: `cnt:${ids[0]}`, title: 'Waiting for you: ' + text };
}

/* counts = { pcnt: 2, bcnt: 1, rcnt: 0 } */
export function notifyBadgeCounts(c) {
    const first = !Object.keys(last).length;
    let total = 0;
    const gained = {};
    Object.entries(c).forEach(([id, n]) => {
        total += n;
        if (!first && KINDS[id] && n > (last[id] ?? 0))
            gained[id] = n - (last[id] ?? 0);
        last[id] = n;
    });
    counts = { ...c };
    document.title = total ? `(${total}) ${baseTitle}` : baseTitle;   // visible on another browser tab too
    sync({ gained, summary: first ? summaryOf(c) : null });
}


/* ============ Clock-based and state-based items ============ */

/* ---- bookings cancelled or moved, and equipment stock running low: compared with the previous check ----
   The first check only saves the starting point, so opening the dashboard does not announce old changes.
   (A cancel or reschedule made by staff on this dashboard is announced too.) */
function changedBookings() {
    const snap = new Map(BK.map(b => [b.booking_ref, { s: b.status, a: b.start_at, e: b.end_at }]));
    if (prevBK) {
        const now = Date.now();
        BK.forEach(b => {
            const p = prevBK.get(b.booking_ref);
            if (!p || !OPEN.includes(p.s))
                return;
            const who = `${b.studio_name}, ${b.customer_name}`, when = `${shortDate(dOf(b.start_at))}, ${tOf(b.start_at)}`;
            const ev = (kind, key, detail) => events.set(key, { kind, tier: TIMED[kind].tier, key, ann: key, title: TIMED[kind].one, detail, tab: TIMED[kind].tab, cta: TIMED[kind].cta, ts: now, ref: b.booking_ref, hl: 'booking' });
            if (b.status === 'Cancelled')
                ev('bcancel', `c:${b.booking_ref}`, `${who} (was ${shortDate(dOf(p.a))}, ${tOf(p.a)})`);
            else if (OPEN.includes(b.status) && (p.a !== b.start_at || p.e !== b.end_at))
                ev('bresched', `m:${b.booking_ref}:${b.start_at}`, `${who}: now ${when}`);
        });
    }
    prevBK = snap;
}

function stockChanges() {
    const snap = new Map(STK.map(c => [c.equipment_id, stockLevel(c)]));
    const worse = new Set();
    if (prevStock)
        // announce when it gets worse; it can announce again after the stock recovered and dropped again
        STK.forEach(c => {
            if (stockLevel(c) > (prevStock.get(c.equipment_id) ?? 0))
                worse.add(String(c.equipment_id));
        });
    prevStock = snap;
    return worse;
}

/* ---- connection: shown when the 30-second refresh cannot reach the database, removed when it works again ---- */
export function notifyConnection(ok) {
    if (ok) {
        if (!connDown)
            return;
        connDown = false;
        sync();
        showPeek({ title: 'Back online', detail: 'The dashboard is up to date again.', tier: 4, chip: 'just now', ttl: 4000, noView: true });
        return;
    }
    if (connDown)
        return;
    connDown = true;
    connSince = Date.now();
    sync();
}

window.addEventListener('offline', () => notifyConnection(false));
window.addEventListener('online', () => refresh(true));   // a successful load removes the item

/* Called every 15 seconds (index.js) and after each redraw. Looks at the loaded bookings and rental lines. */
export function checkTimeAlerts() {
    changedBookings();
    sync({ stockWorse: stockChanges() });
}