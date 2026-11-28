/* =====================================================================
   pager.js - "Rows per page" and Previous / Next for the long list tables.
   ---------------------------------------------------------------------
   Works on the tables that the pages already draw: nothing about how a table is built has to change.
   After a list is drawn into one of the boxes below, this file hides the rows that are not on the current page
   and puts a small bar under the table:  Rows per page [10 v]   1-10 of 37   [Previous] Page 1 of 4 [Next]

   - Which tables: the boxes listed in PAGED (admin: Bookings, Rentals, Payments, Customers). To page another table,
     add the id of the box that holds it. The customer's My bookings / My rental lists are cards, not tables, so they
     are not paged.
   - A "row" is one record. A note line or an indented add-on line that belongs to a record always stays with it,
     and a group heading (Active and upcoming, Past and closed) is shown only while one of its rows is on the page.
   - Tables with 10 rows or fewer get no bar.
   - The chosen number of rows is remembered in this browser. The page number is kept when a list redraws (an action
     or the 30-second refresh) and goes back to page 1 when staff change a filter, search or tab.
   - Printing shows every row.
   ===================================================================== */

/* ids of the boxes that hold a table to page */
const PAGED = ['#abk', '#arn', '#apy', '#acu'];
const SIZES = [10, 25, 50, 100];
const STORE = 'tod.rows-per-page';

let size = (() => {
    try {
        const n = +localStorage.getItem(STORE);
        return SIZES.includes(n) ? n : SIZES[0];
    } catch (e) {
        return SIZES[0];
    }
})();
const pages = new Map();   // box id -> current page (1 = first)

const css = document.createElement('style');
css.textContent = `
tr.pg-hide { display: none !important; }
.pager { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; margin: 10px 2px 2px; font-size: 13px; color: var(--mut); }
.pager .pg-size { display: flex; align-items: center; gap: 8px; }
.pager select { width: auto; min-width: 72px; padding: 6px 28px 6px 10px; }
.pager .pg-nav { display: flex; align-items: center; gap: 10px; }
.pager .pg-pos { white-space: nowrap; }
@media (max-width: 560px) { .pager { justify-content: center; } }
@media print { tr.pg-hide { display: table-row !important; } .pager { display: none !important; } }
`;
document.head.appendChild(css);

/* split a table body into records: { rows: [the record's own row + the note / add-on lines under it] } and group headings */
function readTable(table) {
    const body = table.tBodies[0], items = [];
    if (!body)
        return items;
    for (const tr of body.rows) {
        const c = tr.classList;
        if (c.contains('grp-row'))
            items.push({ group: true, rows: [tr], records: [] });
        else if ((c.contains('why-row') || c.contains('sub-row')) && items.length && !items[items.length - 1].group)
            items[items.length - 1].rows.push(tr);
        else if (c.contains('empty-row') || (tr.cells.length === 1 && tr.cells[0].colSpan > 1 && tr.cells[0].classList.contains('mut')))
            continue;   // the "nothing to show" line
        else
            items.push({ group: false, rows: [tr] });
    }
    return items;
}

function apply(table, box) {
    const items = readTable(table);
    const records = items.filter(i => !i.group);
    let bar = table._pgBar;
    items.forEach(i => i.rows.forEach(r => (r._pg = true)));

    if (records.length <= SIZES[0]) {
        items.forEach(i => i.rows.forEach(r => r.classList.remove('pg-hide')));
        if (bar)
            bar.hidden = true;
        return;
    }

    const pageCount = Math.max(1, Math.ceil(records.length / size));
    const key = box.id;
    const page = Math.min(Math.max(1, pages.get(key) || 1), pageCount);
    pages.set(key, page);
    const from = (page - 1) * size, to = Math.min(from + size, records.length);

    // records first, then the group headings (a heading is shown while any record under it is on this page, or it has none)
    let n = 0, group = null;
    const groupShown = new Map();
    for (const i of items) {
        if (i.group) {
            group = i;
            groupShown.set(i, false);
            continue;
        }
        const on = n >= from && n < to;
        i.rows.forEach(r => r.classList.toggle('pg-hide', !on));
        if (on && group)
            groupShown.set(group, true);
        if (group)
            group.records.push(i);
        n++;
    }
    for (const [g, shown] of groupShown)
        g.rows[0].classList.toggle('pg-hide', !shown && g.records.length > 0);

    if (!bar) {
        bar = document.createElement('div');
        bar.className = 'pager';
        bar.setAttribute('role', 'navigation');
        bar.setAttribute('aria-label', 'Table pages');
        bar.innerHTML = `<label class="pg-size">Rows per page
                <select data-pg-size aria-label="Rows per page">${SIZES.map(s => `<option value="${s}">${s}</option>`).join('')}</select></label>
            <span class="pg-range" aria-live="polite"></span>
            <span class="pg-nav">
                <button type="button" class="btn sm line" data-pg="prev">Previous</button>
                <span class="pg-pos"></span>
                <button type="button" class="btn sm line" data-pg="next">Next</button>
            </span>`;
        bar._table = table;
        bar._box = box;
        table._pgBar = bar;
        const anchor = table.closest('.tw') || table;
        anchor.insertAdjacentElement('afterend', bar);
    }
    bar.hidden = false;
    bar.querySelector('[data-pg-size]').value = String(size);
    bar.querySelector('.pg-range').textContent = `${from + 1}-${to} of ${records.length}`;
    bar.querySelector('.pg-pos').textContent = `Page ${page} of ${pageCount}`;
    bar.querySelector('[data-pg="prev"]').disabled = page <= 1;
    bar.querySelector('[data-pg="next"]').disabled = page >= pageCount;
}

function scan() {
    for (const sel of PAGED) {
        const box = document.querySelector(sel);
        if (!box)
            continue;
        for (const table of box.querySelectorAll('table')) {
            const rows = table.tBodies[0] ? [...table.tBodies[0].rows] : [];
            if (!table._pg || rows.some(r => !r._pg)) {
                table._pg = true;
                apply(table, box);
            }
        }
    }
}

/* Make the page that holds this row the current one (used when a link or the search box jumps to a record that is on
   another page). Does nothing when the row is already shown or its table is not paged. */
export function showRow(tr) {
    const table = tr && tr.closest('table'), bar = table && table._pgBar;
    if (!bar || !tr.classList.contains('pg-hide'))
        return;
    const at = readTable(table).filter(i => !i.group).findIndex(i => i.rows.includes(tr));
    if (at < 0)
        return;
    pages.set(bar._box.id, Math.floor(at / size) + 1);
    apply(table, bar._box);
}

let queued = false;
function schedule() {
    if (queued)
        return;
    queued = true;
    requestAnimationFrame(() => {
        queued = false;
        scan();
    });
}

// Previous / Next and the rows-per-page choice
document.addEventListener('click', e => {
    const b = e.target.closest('.pager [data-pg]');
    if (b) {
        const bar = b.closest('.pager');
        pages.set(bar._box.id, (pages.get(bar._box.id) || 1) + (b.dataset.pg === 'next' ? 1 : -1));
        apply(bar._table, bar._box);
        const top = (bar._table.closest('.tw') || bar._table).getBoundingClientRect().top;
        if (top < 0)
            bar._table.scrollIntoView({ block: 'start' });
        return;
    }
    // a different status tab or filter button: start again from page 1
    if (e.target.closest('.tabs button, [data-bf], [data-rf]'))
        pages.clear();
});

document.addEventListener('change', e => {
    const s = e.target.closest('.pager [data-pg-size]');
    if (s) {
        size = SIZES.includes(+s.value) ? +s.value : SIZES[0];
        try {
            localStorage.setItem(STORE, String(size));
        } catch (err) {
            /* not saved: the choice still works until the page is reloaded */
        }
        pages.clear();
        document.querySelectorAll('.pager').forEach(p => p._table && p._box && apply(p._table, p._box));
        return;
    }
    if (!e.target.closest('table'))
        pages.clear();   // a filter or search changed: start again from page 1 (a field inside a table row does not count)
});
document.addEventListener('input', e => {
    if (!e.target.closest('.pager'))
        pages.clear();
});

new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
schedule();