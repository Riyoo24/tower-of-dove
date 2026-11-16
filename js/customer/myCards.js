/* =====================================================================
   customer/myCards.js - small pieces shared by the "My bookings" and "My rental" card layouts
   (date block, status pill, filter tabs). No data loading here: the two tabs pass in what to draw.
   Styles: css/mycards.css
   ===================================================================== */

import { esc } from '../shared/utils.js';

const MANILA = 'Asia/Manila';
const PARTS = new Intl.DateTimeFormat('en-US', { timeZone: MANILA, weekday: 'short', day: '2-digit', month: 'short' });

/* "2026-11-21" (a date) or a timestamp -> { dow: 'SAT', day: '21', mon: 'NOV' } in Manila time */
export function dateParts(input) {
    const when = /^\d{4}-\d{2}-\d{2}$/.test(input) ? new Date(`${input}T12:00:00+08:00`) : new Date(input);
    if (Number.isNaN(when.getTime()))
        return { dow: '', day: '', mon: '' };
    const p = Object.fromEntries(PARTS.formatToParts(when).map(x => [x.type, x.value]));
    return { dow: p.weekday.toUpperCase(), day: p.day, mon: p.month.toUpperCase() };
}

/* today in Manila as "YYYY-MM-DD" */
export const todayManila = () => new Date().toLocaleDateString('en-CA', { timeZone: MANILA });

/* "Fri, Nov 20, 2:00 PM" for a moment in time */
export const whenLabel = ms => new Date(ms).toLocaleString('en-US', {
    timeZone: MANILA,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
});

/* The small calendar tile at the left of a row (big = the larger one inside the hero card). */
export const dateTile = (parts, big = false) => `<div class="mc-date${big ? ' big' : ''}" aria-hidden="true">
    <div class="mc-dow">${esc(parts.dow)}</div><div class="mc-day">${esc(parts.day)}</div><div class="mc-mon">${esc(parts.mon)}</div></div>`;

/* tone: ok (green), warn (amber), bad (red), live (blue), mute (grey) */
export const pill = (label, tone = 'mute') => `<span class="mc-pill ${tone}">${esc(label)}</span>`;

export const chip = text => `<span class="mc-chip">${text}</span>`;

const DOTS = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>';

/* The round "..." button of a row. attr is the data attribute the tab's click handler listens for (data-menu or data-rmenu). */
export const moreButton = (attr, ref) =>
    `<button type="button" class="mc-ghost mc-more menu-btn" ${attr}="${esc(ref)}" aria-haspopup="menu" aria-expanded="false" aria-label="More actions for ${esc(ref)}">${DOTS}</button>`;

export const ARROW = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

/* The filter tabs shown at the right of the page header. tabs = [{ id, label, n }] */
export const tabsHtml = (label, tabs, current) => tabs.map(t => {
    const on = t.id === current;
    return `<button type="button" class="mc-tab" role="tab" id="tab-${esc(t.id)}" data-tab="${esc(t.id)}" aria-selected="${on}" tabindex="${on ? 0 : -1}">${esc(t.label)} <span class="mc-n">${t.n}</span></button>`;
}).join('');

/* Draws the tabs into box and keeps the choice. Click and the arrow keys switch tab; onPick(id) redraws the page. */
export function drawTabs(box, label, tabs, current) {
    box.setAttribute('role', 'tablist');
    box.setAttribute('aria-label', label);
    box.innerHTML = tabsHtml(label, tabs, current);
}

export function wireTabs(box, onPick) {
    box.addEventListener('click', e => {
        const t = e.target.closest('[data-tab]');
        if (t)
            onPick(t.dataset.tab, false);
    });
    box.addEventListener('keydown', e => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')
            return;
        const all = [...box.querySelectorAll('[data-tab]')], i = all.indexOf(document.activeElement);
        if (i < 0)
            return;
        e.preventDefault();
        onPick(all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length].dataset.tab, true);
    });
}

/* The tab to show: the one the customer picked, otherwise the first of order that has something in it. */
export function currentTab(picked, counts, order) {
    if (picked && order.includes(picked))
        return picked;
    return order.find(id => counts[id] > 0) || order[0];
}

/* put the keyboard focus back on the selected tab after the page was redrawn */
export const focusTab = box => {
    const on = box.querySelector('[aria-selected="true"]');
    if (on)
        on.focus();
};
