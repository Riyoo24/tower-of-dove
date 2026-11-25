/* =====================================================================
   admin/mobileFilters.js - one "Filters" button instead of a stack of dropdowns (phones only)
   ---------------------------------------------------------------------
   On a phone the Bookings, Customers, Payments, Rentals, Equipment and Audit Log pages showed every filter at once.
   This adds a single "Filters" button to each filter bar. The dropdowns and date fields stay hidden until it is tapped,
   and the button shows how many filters are in use, so a hidden filter is never a surprise.

   It only adds a button and a class (.mf-open); css/adminMobile.css does the hiding, and only up to 820px wide.
   The filter fields themselves are not moved, so their own scripts (date picker, search, tabs) keep working.
   Some bars are drawn again every time the list refreshes (Payments, Rentals), so a MutationObserver puts the
   button back, and the open or closed choice is remembered.
   ===================================================================== */

/* row: the filter bar. keep: a field that stays visible (the search box). scope: where the filters live
   (default: the bar). slot: where the button goes (default: the bar, right after "keep"). on: counts pressed pills instead of fields. */
const BARS = [
    { row: '#a-book > .row', keep: '#bk-q' },
    { row: '#a-cust > .row', keep: '#cu-q' },
    { row: '#apy > .row:first-child' },
    { row: '#arn > .row:first-child' },
    { row: '#a-eqp > .row', on: '#eq-opts button[aria-pressed="true"]' },
    { row: '#a-audit .al-bar', scope: '.al-filters', slot: '.al-tools' }
];

const open = new Set();   // bars the person has opened, by selector, so a re-draw keeps them open
let queued = false;

const ICON = '<svg class="mf-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/></svg>';
const CHEV = '<svg class="mf-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';

/* how many filters are set: a dropdown not on its first option, a field with text, or a pressed pill */
function countOf(cfg, row) {
    if (cfg.on)
        return row.querySelectorAll(cfg.on).length;
    const box = cfg.scope ? row.querySelector(cfg.scope) : row;
    if (!box)
        return 0;
    let n = 0;
    box.querySelectorAll('select, input').forEach(el => {
        if (cfg.keep && el.matches(cfg.keep))
            return;
        if (el.tagName === 'SELECT' ? el.selectedIndex > 0 : el.value.trim() !== '')
            n++;
    });
    return n;
}

function sync() {
    queued = false;
    BARS.forEach(cfg => {
        const row = document.querySelector(cfg.row);
        if (!row)
            return;
        let btn = row.querySelector('.mf-btn');
        if (!btn) {
            btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn sm line mf-btn';
            btn.innerHTML = `${ICON}<span>Filters</span><span class="mf-n" hidden></span>${CHEV}`;
            btn.addEventListener('click', () => {
                const on = row.classList.toggle('mf-open');
                btn.setAttribute('aria-expanded', on);
                on ? open.add(cfg.row) : open.delete(cfg.row);
            });
            const keep = cfg.keep && row.querySelector(cfg.keep);
            const slot = cfg.slot && row.querySelector(cfg.slot);
            if (slot)
                slot.prepend(btn);
            else if (keep)
                keep.after(btn);
            else
                row.prepend(btn);
        }
        const isOpen = open.has(cfg.row);
        row.classList.toggle('mf-open', isOpen);
        if (btn.getAttribute('aria-expanded') !== String(isOpen))
            btn.setAttribute('aria-expanded', isOpen);
        /* only write when the number changed, so this does not trigger the observer in a loop */
        const n = countOf(cfg, row), badge = btn.querySelector('.mf-n');
        if (badge.textContent !== (n ? String(n) : '')) {
            badge.textContent = n ? n : '';
            badge.hidden = !n;
        }
    });
}

function later() {
    if (queued)
        return;
    queued = true;
    requestAnimationFrame(sync);
}

export function initMobileFilters() {
    const host = document.getElementById('admin');
    if (!host)
        return;
    new MutationObserver(later).observe(host, { childList: true, subtree: true });
    host.addEventListener('change', later);
    host.addEventListener('input', later);
    host.addEventListener('click', later);
    later();
}

initMobileFilters();