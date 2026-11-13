/* =====================================================================
   shared/liveAvail.js - the live availability line on studio cards
   "Next free: today 4 PM · 3 hours left" (or the next free day when today is full).
   Reads the same busy-hours tables as the calendar (shared/availability.js), so it always agrees with it.
   Used by the Home cards (home/render.js) and the Book a studio cards (customer/book.js).
   ===================================================================== */

import { STUDIOS, isClosed } from './catalog.js';
import { firstBookableDate, isPastSlot, lastBookableDate, loadBusy, takenSlots } from './availability.js';
import { SLOTS, manilaDay } from './utils.js';

const TTL = 30 * 1000;              // results are reused for 30 seconds, so redrawing the cards does not hit the database
const cache = new Map();            // studio index -> { t, res }

const nextDay = ds => {
    const d = new Date(ds + 'T00:00');
    d.setDate(d.getDate() + 1);
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const freeSlots = (si, ds) => SLOTS.map((_, i) => i).filter(i => !takenSlots(si, ds).has(i) && !isPastSlot(ds, i));

const shortTime = i => SLOTS[i].replace(':00', '');   // "4:00 PM" -> "4 PM"

const shortDay = ds => new Date(ds + 'T00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

/* What is open for one studio: { date, when, left, next: { date, slot } | null }
   date/when = the first bookable day (today, or tomorrow once today is over); left = free hours on that day. */
export async function studioAvailability(si, force = false) {
    const hit = cache.get(si);
    if (!force && hit && Date.now() - hit.t < TTL)
        return hit.res;

    const date = firstBookableDate(), last = lastBookableDate();
    const when = date === manilaDay(0) ? 'today' : 'tomorrow';
    await loadBusy(si, date, date);
    let free = freeSlots(si, date);
    const res = { date, when, left: free.length, next: free.length ? { date, slot: free[0] } : null };

    if (!free.length) {
        // nothing left on the first day: look through the 4-week booking window for the next free hour
        await loadBusy(si, date, last);
        for (let ds = nextDay(date); ds <= last; ds = nextDay(ds)) {
            free = freeSlots(si, ds);
            if (free.length) {
                res.next = { date: ds, slot: free[0] };
                break;
            }
        }
    }
    cache.set(si, { t: Date.now(), res });
    return res;
}

/* The line's markup (class for the colour + text). */
export function availLineHtml(res) {
    if (!res)
        return '<span class="al-dot"></span><span>Checking availability&hellip;</span>';
    const hours = n => `${n} hour${n === 1 ? '' : 's'}`;
    if (res.next && res.next.date === res.date) {
        const cls = res.left <= 3 ? 'warn' : 'ok';
        return `<span class="al-dot ${cls}"></span><span><b>Next free: ${res.when} ${shortTime(res.next.slot)}</b> &middot; ${hours(res.left)} left ${res.when}</span>`;
    }
    if (res.next)
        return `<span class="al-dot bad"></span><span><b>Fully booked ${res.when}.</b> Next free: ${shortDay(res.next.date)} ${shortTime(res.next.slot)}</span>`;
    return '<span class="al-dot bad"></span><span><b>Fully booked for the next 4 weeks</b></span>';
}

/* Markup for a card drawn right now: uses the last result if there is one, so redraws do not flicker. */
export const cachedAvailLine = si => {
    const hit = cache.get(si);
    return isClosed(STUDIOS[si]) ? '' : `<p class="avail-line" data-avail-line="${si}">${availLineHtml(hit && hit.res)}</p>`;
};

/* Fill every [data-avail-line] under root (one small request per studio, only when the result is older than 30 s). */
export async function fillAvailLines(root = document) {
    await Promise.all([...root.querySelectorAll('[data-avail-line]')].map(async el => {
        try {
            el.innerHTML = availLineHtml(await studioAvailability(+el.dataset.availLine));
        } catch (e) {
            el.hidden = true;   // could not load: show nothing rather than a wrong line
        }
    }));
}
