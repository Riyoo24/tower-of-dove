/* =====================================================================
   customer/myCards.js - small pieces shared by the "My bookings" and "My rental" card layouts
   (date block, status pill, filter tabs). No data loading here: the two tabs pass in what to draw.
   Styles: css/mycards.css

   Tab-switch motion (added here so both pages get it from drawTabs):
     - the red pill slides from the old tab to the new one (the tab buttons are updated in place, not rebuilt)
     - the list under the tabs slides + fades in, row by row, towards the direction of the new tab
   It uses the Web Animations API on the elements themselves, so it does NOT depend on the timed / one-shot
   CSS classes (sk-play, sk-done ...) and plays on every click, no matter how long the page has been open.
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

/* ---------------------------------------------------------------------
   Tab-switch motion
   --------------------------------------------------------------------- */

const MOTION_CSS = `
.mc-tabs .mc-slider{position:absolute;left:0;top:0;z-index:0;box-sizing:border-box;pointer-events:none;opacity:0;will-change:transform,width}
.mc-tabs .mc-slider.on{opacity:1}
.mc-tabs.mc-measure .mc-tab{transition:none !important}
.mc-tabs.mc-slid .mc-tab{position:relative;z-index:1;transition:color .25s ease !important;box-shadow:none !important;filter:none !important;text-shadow:none !important}
.mc-tabs.mc-slid .mc-tab::before,.mc-tabs.mc-slid .mc-tab::after{content:none !important;display:none !important}
.mc-tabs.mc-slid .mc-tab[aria-selected="true"]{background:transparent !important;border-color:transparent !important}
.mc-tabs.mc-slid .mc-tab:not([aria-selected="true"]){background:transparent !important;border-color:transparent !important}
.mc-switching{overflow-x:clip}
.mc-switching > *,.mc-switching .mc-col > *,.mc-switching .mc-row,.mc-switching .mc-hero{animation:none !important}
@media (prefers-reduced-motion:reduce){.mc-tabs .mc-slider{transition:none !important}}
`;

const SLIDE_TRANSITION = 'transform .42s cubic-bezier(.34,1.3,.5,1), width .42s cubic-bezier(.4,0,.2,1), height .3s ease';

let stylesAdded = false;
function ensureStyles() {
    if (stylesAdded)
        return;
    stylesAdded = true;
    const style = document.createElement('style');
    style.id = 'mc-motion-css';
    style.textContent = MOTION_CSS;
    document.head.appendChild(style);   // added last, so it wins over the older stylesheets
}

const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

/* Puts the sliding pill under the selected tab. It copies the look of the selected tab (colour, glow, radius),
   so the theme's styling stays in css/mycards.css. The first placement jumps there; later ones glide. */
function placeSlider(box) {
    const slider = box.querySelector(':scope > .mc-slider');
    const sel = box.querySelector(':scope > .mc-tab[aria-selected="true"]');
    if (!slider || !sel || !sel.offsetWidth)
        return;   // not on screen yet: the ResizeObserver places it when the page is shown
    if (getComputedStyle(box).position === 'static')
        box.style.position = 'relative';

    // measure the selected tab's own look (with transitions off and the override removed), in one synchronous step
    box.classList.remove('mc-slid');
    box.classList.add('mc-measure');
    const cs = getComputedStyle(sel);
    slider.style.backgroundColor = cs.backgroundColor;
    slider.style.backgroundImage = cs.backgroundImage;
    slider.style.boxShadow = cs.boxShadow;
    slider.style.filter = cs.filter;
    slider.style.borderRadius = cs.borderRadius;
    slider.style.border = `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`;
    box.classList.remove('mc-measure');
    box.classList.add('mc-slid');

    const first = slider.dataset.placed !== '1';
    if (first)
        slider.style.transition = 'none';
    slider.style.width = `${sel.offsetWidth}px`;
    slider.style.height = `${sel.offsetHeight}px`;
    slider.style.transform = `translate(${sel.offsetLeft}px, ${sel.offsetTop}px)`;
    if (first) {
        void slider.offsetWidth;   // apply the first position without animating
        slider.style.transition = reducedMotion() ? 'none' : SLIDE_TRANSITION;
        slider.dataset.placed = '1';
        slider.classList.add('on');
    }
}

/* ---- the list under the tabs ---- */

const panelOf = box => {
    const page = box.closest('.pg');
    return page ? page.querySelector('.mc-wrap > div') : null;   // #mybk or #myrent
};

const watchers = new WeakMap();

function watcherOf(panel) {
    let w = watchers.get(panel);
    if (!w) {
        w = { armedAt: 0, dir: 1, anims: [], token: 0, mo: null };
        // the page writes the new list into the panel (innerHTML) after a tab switch: animate it the moment it appears
        w.mo = new MutationObserver(() => {
            if (w.armedAt && Date.now() - w.armedAt < 1000) {
                w.armedAt = 0;
                playSwitch(panel, w);
            }
        });
        w.mo.observe(panel, { childList: true });
        watchers.set(panel, w);
    }
    return w;
}

function playSwitch(panel, w) {
    if (reducedMotion() || !panel.animate || !panel.offsetParent)
        return;
    w.anims.forEach(a => a.cancel());
    const token = ++w.token;
    panel.classList.add('sk-done', 'mc-switching');   // sk-done switches the old one-time CSS fade off for this list
    const col = panel.querySelector('.mc-col');
    const items = [...(col ? col.children : panel.children)].slice(0, 14);
    const shift = 28 * w.dir;
    const anims = items.map((el, i) => el.animate(
        [
            { opacity: 0, transform: `translate3d(${shift}px, 10px, 0) scale(.985)` },
            { opacity: 1, transform: 'translate3d(0, 0, 0) scale(1)' }
        ],
        { duration: 460, delay: Math.min(i, 8) * 45, easing: 'cubic-bezier(.2,.75,.25,1)', fill: 'backwards' }
    ));
    // the whole panel also fades, so a redraw in the middle of the motion never leaves a blank gap
    anims.push(panel.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' }));
    w.anims = anims;
    Promise.allSettled(anims.map(a => a.finished)).then(() => {
        if (w.token === token)
            panel.classList.remove('mc-switching');
    });
}

/* A different tab became selected: animate the list as soon as the new rows are written. */
function armSwitch(box, dir) {
    const panel = panelOf(box);
    if (!panel)
        return;
    const w = watcherOf(panel);
    w.dir = dir;
    // when the page already wrote the list in this same step, the observer has not been told yet: take that note now
    if (w.mo.takeRecords().length)
        playSwitch(panel, w);
    else
        w.armedAt = Date.now();
}

/* The filter tabs shown at the right of the page header. tabs = [{ id, label, n }] */
const tabInner = t => `${esc(t.label)} <span class="mc-n">${t.n}</span>`;

export const tabsHtml = (label, tabs, current) => tabs.map(t => {
    const on = t.id === current;
    return `<button type="button" class="mc-tab" role="tab" id="tab-${esc(t.id)}" data-tab="${esc(t.id)}" aria-selected="${on}" tabindex="${on ? 0 : -1}">${tabInner(t)}</button>`;
}).join('');

/* Draws the tabs into box and keeps the choice. Click and the arrow keys switch tab; onPick(id) redraws the page.
   When the same tabs are already there they are updated in place (so the pill can slide and focus is kept). */
export function drawTabs(box, label, tabs, current) {
    ensureStyles();
    box.setAttribute('role', 'tablist');
    box.setAttribute('aria-label', label);

    const existing = [...box.querySelectorAll(':scope > [data-tab]')];
    const same = existing.length === tabs.length && existing.every((b, i) => b.dataset.tab === tabs[i].id);
    const previous = box.__mcCurrent;

    if (same) {
        tabs.forEach((t, i) => {
            const on = t.id === current, b = existing[i];
            b.innerHTML = tabInner(t);
            b.setAttribute('aria-selected', String(on));
            b.tabIndex = on ? 0 : -1;
        });
    }
    else {
        box.classList.remove('mc-slid', 'mc-measure');
        box.innerHTML = `<span class="mc-slider" aria-hidden="true"></span>${tabsHtml(label, tabs, current)}`;
    }
    box.__mcCurrent = current;

    placeSlider(box);
    if ('ResizeObserver' in window && !box.__mcResize) {
        box.__mcResize = new ResizeObserver(() => placeSlider(box));
        box.__mcResize.observe(box);   // also places the pill when the page is shown for the first time
    }

    if (same && previous && previous !== current) {
        const order = tabs.map(t => t.id);
        armSwitch(box, order.indexOf(current) >= order.indexOf(previous) ? 1 : -1);
    }
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