/* =====================================================================
   admin/globalSearch.js - global search box at the top of every dashboard tab
   Finds a customer, a booking or a rental by reference, name or phone number.
   It searches the data the dashboard has already loaded (BK, RL, CUS), so it needs no database change.
     Booking  -> Bookings tab, row highlighted (revealBooking)
     Rental   -> Rentals tab, row highlighted (revealRental)
     Customer -> the customer's History window (ACT['cu-hist'])
   Keys: "/" focuses the box, Up/Down move, Enter opens, Esc closes.
   ===================================================================== */

import { BK, CUS, RL } from './data.js';
import { ACT, bkStatus, dOf, rnStatus } from './helpers.js';
import { revealBooking } from './bookings.js';
import { revealRental } from './rentals.js';
import { $, esc, shortDate } from '../shared/utils.js';

const MIN = 2, PER_GROUP = 6;

const host = $('#gs'), input = $('#gs-q'), panel = $('#gs-panel'), clear = $('#gs-x');
if (host && input && panel) {
    let flat = [], active = -1;

    const low = s => String(s ?? '').toLowerCase();
    const digits = s => String(s ?? '').replace(/\D/g, '');

    /* every word typed must match (text, or digits of a phone number). Returns false, or a rank: lower = better. */
    function rank(q, refs, texts, phone) {
        const tokens = q.split(/\s+/).filter(Boolean);
        const hay = low([...refs, ...texts].join(' '));
        const ph = digits(phone);
        const ok = tokens.every(t => hay.includes(t) || (/^[\d+\-()]+$/.test(t) && digits(t).length >= 4 && ph.includes(digits(t))));
        if (!ok)
            return false;
        const refsLow = refs.map(low);
        if (refsLow.some(r => r === q))
            return 0;
        if (refsLow.some(r => r.startsWith(q)))
            return 1;
        if (refsLow.some(r => r.includes(q)))
            return 2;
        if (texts.some(t => low(t).startsWith(q)))
            return 3;
        return 4;
    }

    function search(raw) {
        const q = low(raw).trim();
        if (q.length < MIN)
            return null;
        const byRank = (a, b) => a.r - b.r || a.sort - b.sort;

        const bookings = [];
        BK.forEach(b => {
            const r = rank(q, [b.booking_ref], [b.customer_name, b.studio_name], b.customer_number);
            if (r !== false)
                bookings.push({
                    r, sort: -new Date(b.start_at), kind: 'booking', id: b.booking_ref,
                    title: b.booking_ref,
                    sub: `${b.customer_name} · ${b.studio_name} · ${shortDate(dOf(b.start_at))}`,
                    tag: bkStatus(b.status)
                });
        });

        /* a rental order has several lines: list each order once */
        const orders = new Map();
        RL.forEach(l => {
            const o = orders.get(l.rental_ref) || { l, items: [] };
            o.items.push(l.equipment_name);
            orders.set(l.rental_ref, o);
        });
        const rentals = [];
        orders.forEach(({ l, items }, ref) => {
            const refs = [ref, ...(l.booking_ref ? [l.booking_ref] : [])];
            const r = rank(q, refs, [l.customer_name, ...items], l.customer_number);
            if (r !== false)
                rentals.push({
                    r, sort: -new Date(l.created_at), kind: 'rental', id: ref,
                    title: ref,
                    sub: `${l.customer_name} · ${l.rental_type === 'Add-on' ? 'Add-on' + (l.booking_ref ? ' of ' + l.booking_ref : '') : 'Outside'} · ${items.slice(0, 2).join(', ')}${items.length > 2 ? ' +' + (items.length - 2) : ''}`,
                    tag: rnStatus(l.status)
                });
        });

        const customers = [];
        CUS.forEach(c => {
            const r = rank(q, [], [c.customer_name], c.number);
            if (r !== false)
                customers.push({
                    r, sort: -c.customer_id, kind: 'customer', id: String(c.customer_id),
                    title: c.customer_name,
                    sub: `${c.number || 'No phone'} · ${c.account_type} · ${Number(c.bookings) || 0} booking(s), ${Number(c.rentals) || 0} rental(s)`,
                    tag: c.status === 'Inactive' ? 'Disabled' : ''
                });
        });

        return [
            ['Bookings', bookings.sort(byRank)],
            ['Rentals', rentals.sort(byRank)],
            ['Customers', customers.sort(byRank)]
        ].map(([name, list]) => ({ name, total: list.length, list: list.slice(0, PER_GROUP) }));
    }
    let openTimer = 0;
    function draw() {
        const groups = search(input.value);
        clear.hidden = !input.value;
        flat = [];
        active = -1;
        if (!groups) {
            panel.hidden = true;
            input.setAttribute('aria-expanded', 'false');
            return;
        }
                if (panel.hidden) {   // the box is opening now: play the drop animation once
            panel.classList.add('gs-opening');
            clearTimeout(openTimer);
            openTimer = setTimeout(() => panel.classList.remove('gs-opening'), 500);
        }
        const any = groups.some(g => g.total);
        panel.innerHTML = any ? groups.filter(g => g.total).map(g => `<div class="gs-grp" role="presentation">${g.name}<span>${g.total > g.list.length ? `${g.list.length} of ${g.total}` : g.total}</span></div>`
            + g.list.map(x => {
                flat.push(x);
                const i = flat.length - 1;
                return `<div class="gs-it" role="option" id="gs-o${i}" data-i="${i}" aria-selected="false"><div class="gs-main"><b>${esc(x.title)}</b>${x.tag ? `<span class="gs-tag">${esc(x.tag)}</span>` : ''}</div><div class="gs-sub">${esc(x.sub)}</div></div>`;
            }).join('')).join('')
            : '<p class="gs-none">No booking, rental or customer matches that.</p>';
        panel.hidden = false;
        input.setAttribute('aria-expanded', 'true');
    }

    function mark(i) {
        panel.querySelectorAll('.gs-it').forEach(el => el.setAttribute('aria-selected', String(+el.dataset.i === i)));
        active = i;
        const el = panel.querySelector(`[data-i="${i}"]`);
        if (el) {
            el.scrollIntoView({ block: 'nearest' });
            input.setAttribute('aria-activedescendant', el.id);
        }
    }

    function close() {
        panel.hidden = true;
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
    }

    function open(x) {
        if (!x)
            return;
        close();
        input.value = '';
        clear.hidden = true;
        input.blur();
        if (x.kind === 'booking')
            revealBooking(x.id);
        else if (x.kind === 'rental')
            revealRental(x.id);
        else if (ACT['cu-hist'])
            ACT['cu-hist'](x.id);
    }

    input.addEventListener('input', draw);
    input.addEventListener('focus', draw);   // data may have refreshed since the last search

    input.addEventListener('keydown', e => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            if (!flat.length)
                return;
            e.preventDefault();
            const n = flat.length;
            mark(e.key === 'ArrowDown' ? (active + 1) % n : (active - 1 + n) % n);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            open(flat[active >= 0 ? active : 0]);   // Enter with nothing highlighted opens the best match
        } else if (e.key === 'Escape') {
            if (!panel.hidden)
                close();
            else
                input.blur();
        }
    });

    panel.addEventListener('mousedown', e => e.preventDefault());   // keep the focus in the box
    panel.addEventListener('click', e => {
        const it = e.target.closest('.gs-it');
        if (it)
            open(flat[+it.dataset.i]);
    });
    panel.addEventListener('mousemove', e => {
        const it = e.target.closest('.gs-it');
        if (it && +it.dataset.i !== active)
            mark(+it.dataset.i);
    });

    clear.addEventListener('click', () => {
        input.value = '';
        draw();
        input.focus();
    });

    document.addEventListener('click', e => {
        if (!host.contains(e.target))
            close();
    });

    /* "/" jumps to the search box (not while typing in a field or when a window is open) */
    document.addEventListener('keydown', e => {
        if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey)
            return;
        if (e.target.closest('input, select, textarea, [contenteditable], dialog[open]') || document.querySelector('dialog[open]'))
            return;
        e.preventDefault();
        input.focus();
        input.select();
    });
}