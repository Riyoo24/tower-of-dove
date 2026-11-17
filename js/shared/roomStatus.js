/* =====================================================================
   shared/roomStatus.js - live "Available today" badge on the room cards
   Used by the home page room cards (home/render.js) and the Book a studio cards (customer/book.js).
   ===================================================================== */

import { firstBookableDate, isPastSlot, loadBusy, takenSlots } from './availability.js';
import { $$, SLOTS, manilaDay } from './utils.js';

/* Live badge on each room card: how many start times are still open on the first bookable day.
   Runs after the cards are drawn (one small request per room); a failed request just shows "Open". */
export async function showRoomStatus() {
    const date = firstBookableDate(), when = date === manilaDay(0) ? 'today' : 'tomorrow';
    await Promise.all($$('[data-room-status]').map(async el => {
        const i = +el.dataset.roomStatus;
        let cls = '', text = 'Open';
        try {
            await loadBusy(i, date, date);
            const taken = takenSlots(i, date);
            const n = SLOTS.filter((_, k) => !taken.has(k) && !isPastSlot(date, k)).length;
            [cls, text] = n === 0 ? ['bad', `Fully booked ${when}`]
                : n <= 3 ? ['warn', `${n} slot${n > 1 ? 's' : ''} left ${when}`]
                    : ['ok', `Available ${when}`];
        } catch (e) {
            /* keep the plain "Open" badge */
        }
        el.className = 'hx-b ' + cls;
        el.innerHTML = `<i></i>${text}`;
    }));
}