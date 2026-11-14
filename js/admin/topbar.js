/* =====================================================================
   admin/topbar.js - the small controls next to the search box
     - "Updated 12s ago" + refresh button (uses LOADED_AT from data.js, set on every successful load)
     - "+ New" menu: Onsite booking / Onsite rental, one click from any tab
   ===================================================================== */

import { LOADED_AT, refresh } from './data.js';
import { $, everyVisible } from '../shared/utils.js';

/* ---- last updated ---- */
const box = $('#gu'), txt = $('#gu-t'), btn = $('#gu-r');

if (box && txt && btn) {
    const paint = () => {
        if (!LOADED_AT) {
            txt.textContent = 'Loading…';
            box.classList.remove('stale');
            return;
        }
        const s = Math.max(0, Math.round((Date.now() - LOADED_AT) / 1000));
        txt.textContent = s < 10 ? 'Updated just now'
            : s < 60 ? `Updated ${s}s ago`
                : s < 3600 ? `Updated ${Math.floor(s / 60)} min ago`
                    : `Updated ${Math.floor(s / 3600)} h ago`;
        box.classList.toggle('stale', s > 90);   // the dashboard reloads every 30 s: this long means something is wrong
        box.title = 'Last loaded at ' + new Date(LOADED_AT).toLocaleTimeString('en-US', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit', second: '2-digit' });
    };

    btn.addEventListener('click', async () => {
        if (btn.disabled)
            return;
        btn.disabled = true;
        box.classList.add('busy');
        const t0 = Date.now();
        try {
            await refresh(true);   // same quiet reload as the 30-second timer, so open forms are not reset
        } finally {
            setTimeout(() => {   // keep the spinner visible long enough to be noticed
                btn.disabled = false;
                box.classList.remove('busy');
                paint();
            }, Math.max(0, 500 - (Date.now() - t0)));
        }
    });

    paint();
    everyVisible(paint, 1000);
}

