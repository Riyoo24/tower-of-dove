/* =====================================================================
   admin/jump.js - clickable references that jump between tabs
   A reference (TOD-8B4A475B ...) in the Payments table opens the Bookings / Rentals tab. The target row is scrolled into view and highlighted for a few seconds.
   Each tab module exports its own reveal function (it resets that tab's filters so the row is never hidden);
   this file only builds the link, switches the tab and highlights the row.
   ===================================================================== */

import { $, esc, reducedMotion } from '../shared/utils.js';

/* the link: a real <a href="#tab"> (keyboard, right-click friendly); the click is handled by the tab modules */
export const refLink = (kind, ref, title) =>
    `<a href="#${kind === 'booking' ? 'a-book' : 'a-rent'}" class="reflink" data-jump="${kind}" data-ref="${esc(ref)}" title="${esc(title)}">${esc(ref)}</a>`;

/* marks a row so it can be found again: put this inside the first cell of the row */
export const rowMark = ref => `data-rowref="${esc(ref)}"`;

/* show the tab, then scroll to and highlight every row of `root` marked with this reference */
export function focusRows(tabId, root, ref) {
    if (location.hash.slice(1) !== tabId)
        location.hash = tabId;
    const go = (tries = 0) => {
        const rows = [...$(root).querySelectorAll('[data-rowref]')]
            .filter(el => el.dataset.rowref === ref).map(el => el.closest('tr')).filter(Boolean);
        // the tab becomes visible on the next hashchange; wait until the row can be measured
        if (!rows.length || !rows[0].offsetParent) {
            if (tries < 20)
                setTimeout(() => go(tries + 1), 50);
            return;
        }
        $(root).querySelectorAll('tr.row-flash').forEach(r => r.classList.remove('row-flash'));
        rows[0].scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
        rows.forEach(r => {
            void r.offsetWidth;   // restart the animation when the same row is picked twice
            r.classList.add('row-flash');
            setTimeout(() => r.classList.remove('row-flash'), 4200);
        });
    };
    setTimeout(go, 80);   // after showTab() (hashchange) has scrolled the page to the top
}
