/* =====================================================================
   shared/mobileUx.js - phone-only helpers for the customer pages
   ---------------------------------------------------------------------
   1. Bottom tab bar (Home / Book / Rent / Bookings / Rentals): the main
      places are one thumb-tap away. The links use data-route, so the
      click handler in layout.js navigates; setActiveNav() highlights them.
   2. Tables get data-label on every cell, so on a phone each row can be
      shown as a card (labels come from the column headings).
   3. While a text field is focused (on-screen keyboard open) the bottom
      bars hide, so they never sit on top of the keyboard.
   4. Scrollable pill tabs scroll the tapped one into view.
   Call initMobileUx({ icon }) once, after the top bar is injected.
   ===================================================================== */

const TABS = [
    ['home', 'Home', 'home'],
    ['book', 'Book', 'cal'],
    ['rent', 'Rent', 'music'],
    ['mybook', 'Bookings', 'list'],
    ['myrent', 'Rentals', 'box']
];

/* fields that open the on-screen keyboard */
const TEXTY = 'input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=file]):not([type=range]):not([type=color]), textarea';

export function initMobileUx({ icon }) {
    if (document.getElementById('mtabs'))
        return;

    /* ---------- 1. bottom tab bar ---------- */
    document.body.insertAdjacentHTML('beforeend', `
    <nav class="mtabs" id="mtabs" aria-label="Quick navigation">
      <ul>${TABS.map(([key, text, ic]) => `
        <li data-side="${key}"><a href="#" data-route="${key}">${icon(ic)}<span>${text}</span></a></li>`).join('')}
      </ul>
    </nav>`);

    /* ---------- 2. data-label on table cells (card layout on phones) ---------- */
    const page = document.querySelector('main.page');
    let queued = false;
    const labelTables = () => {
        queued = false;
        if (!page)
            return;
        page.querySelectorAll('.tw table:not([data-cards])').forEach(table => {
            // My bookings / My rentals keep the real table on phones (same scrolling table as the admin/staff pages)
            if (table.closest('#mybk, #myrent, #gr-res'))
                return;
            const head = table.tHead && table.tHead.rows[0];
            if (!head)
                return;
            const names = [...head.cells].map(th => th.textContent.trim());
            table.dataset.cards = '';
            [...table.tBodies].forEach(body => [...body.rows].forEach(tr => {
                if (tr.classList.contains('grp-row') || tr.classList.contains('why-row'))
                    return;
                let col = 0;
                [...tr.cells].forEach(td => {
                    if (td.colSpan === 1 && names[col])
                        td.dataset.label = names[col];
                    col += td.colSpan;
                });
            }));
        });
    };
    if (page) {
        // the pages redraw their tables with innerHTML, so label whatever shows up (childList only: our own attribute writes do not loop)
        new MutationObserver(() => {
            if (queued)
                return;
            queued = true;
            requestAnimationFrame(labelTables);
        }).observe(page, { childList: true, subtree: true });
        labelTables();
    }

    /* ---------- 3. on-screen keyboard: hide the bottom bars ---------- */
    const body = document.body;
    document.addEventListener('focusin', e => {
        if (e.target.matches && e.target.matches(TEXTY))
            body.classList.add('kb-open');
    });
    document.addEventListener('focusout', () => {
        setTimeout(() => {
            const a = document.activeElement;
            if (!(a && a.matches && a.matches(TEXTY)))
                body.classList.remove('kb-open');
        }, 60);
    });

    /* ---------- 4. pill tabs: bring the tapped one into view ---------- */
    document.addEventListener('click', e => {
        const b = e.target.closest('.tabs button');
        if (!b || !b.scrollIntoView)
            return;
        const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
        requestAnimationFrame(() => b.scrollIntoView({ inline: 'center', block: 'nearest', behavior: reduce ? 'auto' : 'smooth' }));
    });
}
