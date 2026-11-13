/* =====================================================================
   shared/eqFilter.js - search, "In stock only" and "Frequently added with" suggestions
   Used by the Rent tab and by the booking form's "Browse equipment" window.
   No database changes: everything works on the equipment list already loaded (shared/catalog.js).
   ===================================================================== */

import { esc } from './utils.js';

/* ---- search: every word typed must appear in the name, category or description ---- */
const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');

export function matchesSearch(e, query) {
    const words = norm(query).split(/\s+/).filter(Boolean);
    if (!words.length)
        return true;
    const hay = norm(`${e.name} ${e.category || ''} ${e.desc || ''}`);
    return words.every(w => hay.includes(w));
}

/* The search box (and, when `stockToggle` is true, the "In stock only" switch).
   Ids are `${p}-q`, `${p}-clear` and `${p}-stock`; wire them with bindToolbar(). */
export function toolbarHtml(p, { q = '', inStock = false, stockToggle = true } = {}) {
    return `<div class="eq-tools">
      <div class="eq-search">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
        <input id="${p}-q" type="search" value="${esc(q)}" placeholder="Search equipment" aria-label="Search equipment" autocomplete="off" enterkeyhint="search">
        <button type="button" class="eq-clear" id="${p}-clear" aria-label="Clear search" ${q ? '' : 'hidden'}>&times;</button>
      </div>
      ${stockToggle ? `<label class="eq-toggle"><input type="checkbox" id="${p}-stock" ${inStock ? 'checked' : ''}><span class="eq-sw" aria-hidden="true"></span><span>In stock only</span></label>` : ''}
    </div>`;
}

/* Connects the toolbar drawn by toolbarHtml(); onChange({ q, inStock }) runs on every change. */
export function bindToolbar(root, p, onChange) {
    const q = root.querySelector(`#${p}-q`), clear = root.querySelector(`#${p}-clear`), stock = root.querySelector(`#${p}-stock`);
    if (!q)
        return;
    const fire = () => {
        clear.hidden = !q.value;
        onChange({ q: q.value, inStock: !!(stock && stock.checked) });
    };
    q.addEventListener('input', fire);
    q.addEventListener('keydown', e => {
        if (e.key === 'Escape' && q.value) {
            e.preventDefault();    // clears the text first; a second Escape closes a window
            e.stopPropagation();
            q.value = '';
            fire();
        }
    });
    clear.addEventListener('click', () => {
        q.value = '';
        fire();
        q.focus();
    });
    if (stock)
        stock.addEventListener('change', fire);
}

/* ---- "Frequently added with" ----
   Rules say: when the studio or an item already chosen looks like `when`, offer items that look like `offer`.
   They are matched against the name, category and description, so new equipment is picked up without code changes. */
const RULES = [
    { when: /drum/, offer: /cymbal|snare|hi-?hat|crash|ride|splash|stick|throne|drum pedal|drum/ },
    { when: /guitar/, offer: /amp|pedal|effect|tuner|capo|strap|cable/ },
    { when: /amplifier|\bamp\b/, offer: /guitar|pedal|effect|cable/ },
    { when: /full band|band room/, offer: /amp|mic|keyboard/ },
    { when: /keyboard|piano|synth|production/, offer: /stand|sustain|pedal|headphone|midi|interface|monitor/ },
    { when: /vocal|acoustic|booth|singer|podcast/, offer: /mic|stand|pop|headphone|reverb|effect/ },
    { when: /mic/, offer: /stand|pop|cable|headphone/ }
];

/* `seeds` are text blobs to read from (the studio's name and description, the names of items already chosen).
   `pool` are the items that could be offered right now; `taken` is a function id -> true when already chosen.
   Returns up to `max` items, best match first. Items from the same category as a chosen item rank after rule matches. */
export function suggestFor(seeds, pool, { taken = () => false, max = 4, chosen = [] } = {}) {
    const text = norm(seeds.filter(Boolean).join(' | '));
    if (!text.trim())
        return [];
    // earlier rules count for more, so the closest match to the room (a drum room -> cymbals) comes first
    const offers = RULES.map((r, i) => ({ re: r.offer, w: RULES.length - i + 1, on: r.when.test(text) })).filter(r => r.on);
    const cats = new Set(chosen.map(e => e.category).filter(Boolean));
    return pool
        .filter(e => !taken(e.id) && !chosen.some(c => c.id === e.id))
        .map(e => {
            const hay = norm(`${e.name} ${e.category || ''} ${e.desc || ''}`);
            const score = offers.reduce((n, o) => n + (o.re.test(hay) ? o.w : 0), 0) + (cats.has(e.category) ? 1 : 0);
            return { e, score };
        })
        .filter(x => x.score > 0)
        .sort((a, b) => b.score - a.score || a.e.name.localeCompare(b.e.name))
        .slice(0, max)
        .map(x => x.e);
}

/* The strip of suggestions. `attr` is the data attribute put on each Add button (e.g. 'data-sadd'). */
export function suggestionsHtml(title, items, { attr, price }) {
    if (!items.length)
        return '';
    return `<section class="eq-sugg" aria-label="${esc(title)}">
      <p class="eq-sugg-t">${esc(title)}</p>
      <div class="eq-sugg-row">${items.map(e => `<div class="eq-chip">
        <span class="eq-chip-n"><b>${esc(e.name)}</b><small>${esc(price(e))}</small></span>
        <button type="button" class="btn sm line" ${attr}="${e.id}" aria-label="Add ${esc(e.name)}">+ Add</button>
      </div>`).join('')}</div>
    </section>`;
}
