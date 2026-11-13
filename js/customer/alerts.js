/* =====================================================================
   customer/alerts.js - pop-up when staff act on a customer's request
   Runs after every reload of "My bookings" / "My rentals" (page start, then every minute).
   It compares each request's status with the last one this browser saw for this account and
   pops up what changed: booking confirmed / rejected / cancelled, payment rejected, rental
   approved / rejected / issued, add-on equipment added later approved / rejected, session extension approved / rejected.
   The last-seen statuses are kept in localStorage (so a change made while the customer was away
   is announced on their next visit). The very first visit only saves the starting point.
   ===================================================================== */

import { BOOKINGS } from '../shared/availability.js';
import { state } from './state.js';
import { RELEASE, clock as relClock, GRACE } from './noShow.js';
import { getUser, isMember } from '../shared/session.js';
import { esc, everyVisible, peso, reducedMotion } from '../shared/utils.js';

let box;

const storeKey = () => 'tod_seen_' + ((getUser() || {}).username || (getUser() || {}).label || 'me');
const read = () => { try { return JSON.parse(localStorage.getItem(storeKey()) || 'null'); } catch (e) { return null; } };
const write = v => { try { localStorage.setItem(storeKey(), JSON.stringify(v)); } catch (e) { /* storage blocked */ } };

function container() {
    if (!box) {
        box = document.createElement('div');
        box.className = 'pop-toasts';
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

/* ms: how long it stays (0 = until dismissed); the default is the old rule (10 s good news, 15 s bad news) */
function show({ title, sub, tab, good, ms }) {
    const el = document.createElement('div');
    el.className = 'pop-toast ' + (good ? 'good' : 'bad');
    el.innerHTML = `<b>${esc(title)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}
      <div class="pop-toast-row"><button type="button" class="btn sm gold" data-go>View</button><button type="button" class="pop-toast-x" data-x>Dismiss</button></div>`;
    el.addEventListener('click', e => {
        if (e.target.closest('[data-go]'))
            location.hash = tab;
        if (e.target.closest('[data-go],[data-x]'))
            dismiss(el);
    });
    container().appendChild(el);
    while (box.children.length > 5)
        box.firstElementChild.remove();
    const stay = ms === undefined ? (good ? 10000 : 15000) : ms;   // bad news stays a little longer
    if (stay)
        setTimeout(() => dismiss(el), stay);
}

/* current status of everything this customer has asked for, keyed by what it is */
function snapshot() {
    const now = {};
    BOOKINGS.forEach(b => { if (b.mine) now['b:' + b.ref] = { s: b.status, p: b.payment, r: b.reason || '', c: b.created || '' }; });
    (state.RENTALS || []).forEach(r => {
        if (r.type === 'out')
            now['r:' + r.rentalRef] = { s: r.rawStatus, r: r.reason || '', c: r.created || '' };
        else if (r.down > 0)   // equipment added to a booking LATER has its own payment; the first add-ons ride on the booking's own pop-up
            now['a:' + r.rentalRef] = { s: r.rawStatus, r: r.reason || '', c: r.created || '', ref: r.ref };
    });
    // damage fees of returned outside rentals: one entry per rental (p: 'real' marks a status this browser really saw)
    Object.entries(state.DAMAGE || {}).forEach(([ref, list]) => {
        const pay = list.filter(d => d.amount > 0);
        const s = !pay.length ? 'Waived' : pay.some(d => d.status === 'Unpaid') ? 'Unpaid' : pay.some(d => d.status === 'Pending') ? 'Pending' : 'Paid';
        now['d:' + ref] = { s, p: 'real', r: '', c: list.map(d => d.created).sort()[0] || '', amt: pay.reduce((n, d) => n + d.amount, 0) };
    });
    // late fees left unpaid at the return (83_late_fee_collection.sql): one entry per rental
    [...new Set((state.RENTALS || []).filter(r => r.type === 'out' && r.lateDeferred && r.late > 0).map(r => r.rentalRef))].forEach(ref => {
        const ls = state.RENTALS.filter(r => r.type === 'out' && r.rentalRef === ref && r.lateDeferred && r.late > 0);
        const s = ls.every(r => r.latePaid) ? 'Paid' : ls.some(r => !r.latePaid && !r.latePendingRef) ? 'Unpaid' : 'Pending';
        now['l:' + ref] = { s, p: 'real', r: (ls.find(r => r.lateReject) || {}).lateReject || '', c: ls.map(r => r.returnedAt || r.created || '').filter(Boolean).sort()[0] || '', amt: ls.reduce((n, r) => n + r.late, 0) };
    });
    Object.entries(state.EXT || {}).forEach(([ref, list]) => list.forEach(x => { now['x:' + x.id] = { s: x.status, r: x.reason || '', ref, c: x.created || '' }; }));
    return now;
}

function describe(key, was, now) {
    const [kind, id] = [key[0], key.slice(2)];
    const why = now.r ? `Reason: ${now.r}` : 'Please contact the studio for details.';
    if (kind === 'b') {
        if (was.s !== now.s) {
            if (now.s === 'Confirmed')
                return { title: `Booking ${id} is confirmed`, sub: 'Your payment was verified. See you at the studio!', tab: 'my-bookings', good: true };
            if (now.s === 'Rejected')
                return { title: `Booking ${id} was rejected`, sub: why, tab: 'my-bookings' };
            if (now.s === 'Cancelled' && RELEASE[id] && RELEASE[id].noShow)
                return { title: `Booking ${id} was released (no-show)`, sub: `You had not arrived and paid the balance within ${GRACE} minutes of your start time, so the slot was released. Your payment is non-refundable. You can book again from My bookings.`, tab: 'my-bookings', ms: 0 };
            if (now.s === 'Cancelled')
                return { title: `Booking ${id} was cancelled`, sub: why, tab: 'my-bookings' };
        } else if (was.p !== now.p && now.p === 'Rejected') {
            return { title: `Payment for ${id} was rejected`, sub: 'Please check your GCash reference or contact the studio.', tab: 'my-bookings' };
        }
    } else if (kind === 'r' && was.s !== now.s) {
        if (now.s === 'Approved')
            return { title: `Rental ${id} was approved`, sub: 'Your equipment is ready for pick-up at the chosen time.', tab: 'my-rentals', good: true };
        if (now.s === 'Active')
            return { title: `Rental ${id} is now in use`, sub: 'The equipment has been handed over.', tab: 'my-rentals', good: true };
        if (now.s === 'Rejected')
            return { title: `Rental ${id} was rejected`, sub: why, tab: 'my-rentals' };
    } else if (kind === 'a' && was.s !== now.s) {
        if (now.s === 'Approved')
            return { title: `Add-on equipment for ${now.ref} approved`, sub: 'Your payment was verified. It will be ready when your session starts.', tab: 'my-rentals', good: true };
        if (now.s === 'Rejected')
            return { title: `Add-on equipment for ${now.ref} was rejected`, sub: why, tab: 'my-rentals' };
    } else if (kind === 'd') {
        const seen = was.p === 'real';   // a status the customer really saw before (not a guess for a brand new fee)
        if (now.s === 'Unpaid' && was.s !== 'Unpaid' && !(seen && was.s === 'Pending'))
            return { title: `Damage fee of ${peso(now.amt)} for rental ${id}`, sub: 'Staff recorded damage when your equipment came back. Open the rental to see the reason and the photos. You can pay now or pay later.', tab: 'my-rentals' };
        if (now.s === 'Unpaid' && seen && was.s === 'Pending')
            return { title: `Your damage fee payment for ${id} was not accepted`, sub: 'Please check the GCash reference or contact the studio. The fee is still unpaid.', tab: 'my-rentals' };
        if (now.s === 'Unpaid' && seen && was.s === 'Unpaid' && was.amt !== now.amt)
            return { title: `Damage fee for rental ${id} changed to ${peso(now.amt)}`, sub: 'Open the rental to see the details.', tab: 'my-rentals' };
        if (seen && now.s === 'Paid' && was.s !== 'Paid')
            return { title: `Damage fee for rental ${id} is paid`, sub: 'Thank you. Nothing more is due for this rental.', tab: 'my-rentals', good: true };
        if (seen && now.s === 'Waived' && was.s !== 'Waived')
            return { title: `Damage fee for rental ${id} was waived`, sub: 'There is nothing to pay.', tab: 'my-rentals', good: true };
    } else if (kind === 'l') {
        const seen = was.p === 'real';
        if (now.s === 'Unpaid' && was.s !== 'Unpaid' && !(seen && was.s === 'Pending'))
            return { title: `Late fee of ${peso(now.amt)} for rental ${id}`, sub: 'Your equipment came back late and the late fee was not paid yet. Open the rental to pay it with GCash, or pay at the studio. You cannot book or rent again until it is paid.', tab: 'my-rentals' };
        if (now.s === 'Unpaid' && seen && was.s === 'Pending')
            return { title: `Your late fee payment for ${id} was not accepted`, sub: now.r ? `Reason: ${now.r}` : 'Please check the GCash reference or contact the studio. The late fee is still unpaid.', tab: 'my-rentals' };
        if (seen && now.s === 'Paid' && was.s !== 'Paid')
            return { title: `Late fee for rental ${id} is paid`, sub: 'Thank you. Nothing more is due for this rental.', tab: 'my-rentals', good: true };
    } else if (kind === 'x' && was.s !== now.s) {
        if (now.s === 'Approved')
            return { title: `Session extension for ${now.ref} approved`, sub: 'Your session was extended.', tab: 'my-bookings', good: true };
        if (now.s === 'Rejected')
            return { title: `Session extension for ${now.ref} was rejected`, sub: why, tab: 'my-bookings' };
    }
    return null;
}

/* ============ Reminders that follow the clock (not a change staff made) ============
   Session starts within 30 minutes, session ends in 5 minutes, the 24-hour change/cancel cutoff,
   outside rentals due back soon or overdue (with the late fee so far). Each one shows once per
   booking / rental / time. Checked every 30 seconds while the page is open, and after every reload of the lists. */
const MIN = 60 * 1000, HOUR = 60 * MIN;
const announced = new Set();
let clock = null;

function once(key, msg) {
    if (announced.has(key))
        return;
    announced.add(key);
    show(msg);
}

const mins = ms => { const m = Math.max(1, Math.ceil(ms / MIN)); return `${m} minute${m === 1 ? '' : 's'}`; };

export function checkReminders() {
    if (!isMember())
        return;
    const now = Date.now();
    BOOKINGS.filter(b => b.mine && b.startAt && b.endAt).forEach(b => {
        const start = new Date(b.startAt).getTime(), end = new Date(b.endAt).getTime();
        const where = `Studio ${b.studio}, ${b.start}`;
        // 1. session reminders
        if (b.status === 'Confirmed' && start > now && start - now <= 30 * MIN)
            once(`s30:${b.ref}:${b.startAt}`, { title: `Your session starts in ${mins(start - now)}`, sub: `${where}. Please arrive a few minutes early.`, tab: 'my-bookings', good: true, ms: 30000 });
        if (b.status === 'Active' && end > now && end - now <= 5 * MIN)
            once(`e5:${b.ref}:${b.endAt}`, { title: `Your session ends in ${mins(end - now)}`, sub: 'Need more time? Extend it from My bookings. Equipment you added must be returned when time is up.', tab: 'my-bookings', ms: 0 });
        // 1b. no-show rule: 2 hours before (balance and release time), then a last warning shortly before the slot is released
        const rel = RELEASE[b.ref] && RELEASE[b.ref].releaseAt ? new Date(RELEASE[b.ref].releaseAt).getTime() : 0;
        if (b.status === 'Confirmed' && rel && b.balanceDue > 0.005) {
            if (start > now && start - now <= 2 * HOUR)
                once(`h2:${b.ref}:${b.startAt}`, { title: `Your session starts in ${mins(start - now)}`, sub: `${where}. Balance ${peso(b.balanceDue)} due at the studio. If you have not arrived and paid by ${relClock(rel)}, your slot is released.`, tab: 'my-bookings', good: true, ms: 30000 });
            if (rel > now && rel - now <= 5 * MIN && now >= start)
                once(`rw:${b.ref}:${rel}`, { title: `We will release your slot at ${relClock(rel)}`, sub: `Your balance of ${peso(b.balanceDue)} is not paid yet. Come to the studio, or tap I'm running late in My bookings, or call us.`, tab: 'my-bookings', ms: 0 });
        }
        // 2. the 24-hour cutoff for Reschedule and Cancel
        if (['Pending', 'Confirmed'].includes(b.status) && start > now) {
            const cutoff = start - 24 * HOUR;
            if (cutoff > now && cutoff - now <= HOUR)
                once(`co1:${b.ref}:${b.startAt}`, { title: `Changes to ${b.ref} close in ${mins(cutoff - now)}`, sub: 'After that you can no longer reschedule or cancel this booking.', tab: 'my-bookings', ms: 30000 });
            else if (cutoff <= now && now - cutoff <= 30 * MIN)
                once(`co0:${b.ref}:${b.startAt}`, { title: `Changes to ${b.ref} are now closed`, sub: 'Changes and cancellations close 24 hours before your session.', tab: 'my-bookings', ms: 20000 });
        }
    });
    // 2b. replacement items staff offered: ask once, then again when an hour is left (the deadline is in the key)
    (state.OFFERS || []).forEach(o => {
        const left = new Date(o.deadline).getTime() - now, tab = o.type === 'addon' ? 'my-bookings' : 'my-rentals';
        if (left <= 0)
            return;
        once(`so:${o.id}`, { title: `Choose a replacement for ${o.oldName}`, sub: `${o.ref}: the studio cannot give you this item. Pick an equivalent one, free of charge.`, tab, ms: 0 });
        if (left <= HOUR)
            once(`so1:${o.id}`, { title: `${mins(left)} left to choose your replacement`, sub: `${o.ref}: after that ${o.auto ? 'we will choose for you' : 'the studio will contact you'}.`, tab, ms: 0 });
    });
    // 3. outside rentals: due back soon, then overdue with the late fee so far
    const orders = new Map();
    (state.RENTALS || []).filter(r => r.type === 'out' && r.rawStatus === 'Active' && !r.returnedAt && r.due)
        .forEach(r => orders.set(r.rentalRef, (orders.get(r.rentalRef) || []).concat(r)));
    orders.forEach((lines, ref) => {
        const due = new Date(lines[0].due).getTime();
        if (due > now && due - now <= HOUR)
            once(`rd:${ref}:${lines[0].due}`, { title: `Rental ${ref} is due back in ${mins(due - now)}`, sub: 'Late fees are charged for every hour after the return time.', tab: 'my-rentals', ms: 30000 });
        else if (due <= now) {
            // same rule as the rental receipt: price per 8 hours, every started hour late counts
            const perHour = lines.reduce((n, l) => n + l.qty * l.unit / 8, 0);
            const fee = lines.reduce((n, l) => n + l.late, 0) + perHour * Math.ceil((now - due) / HOUR);
            once(`ro:${ref}:${lines[0].due}`, { title: `Rental ${ref} is overdue`, sub: `Please return it now. Late fee so far: ${peso(Math.round(fee))} (${peso(Math.round(perHour))} for each hour late).`, tab: 'my-rentals', ms: 0 });
        }
    });
}

export function notifyStatusChanges() {
    if (!isMember())
        return;   // guests have no account to compare against
    clock = clock || everyVisible(checkReminders, 30000);
    checkReminders();
    const now = snapshot(), saved = read();
    write({ t: Date.now(), items: now });
    if (!saved)
        return;   // first visit on this browser: nothing to compare with yet
    const before = saved.items || saved, seenAt = saved.t || Date.now();
    Object.keys(now).forEach(key => {
        let was = before[key];
        // A request made since the last check that staff already answered (for example an extension approved
        // within a minute of being sent) was never seen as "Pending": compare it with a pending start.
        if (!was && now[key].c && new Date(now[key].c).getTime() >= seenAt - 120000)
            was = { s: 'Pending', p: 'Pending', r: '' };
        const msg = was && describe(key, was, now[key]);
        if (msg)
            show(msg);
    });
}
