/* =====================================================================
   shared/eqBrowse.js - the "Browse equipment" window, one layout for customers AND staff
   Customer booking form (customer/bookingForm.js) and staff onsite rental (admin/onsite.js) both draw their window
   with browseHtml(), so they always look and behave the same: title, note about the numbers, search box,
   category tabs, "Frequently added with" suggestions, equipment cards with a + / - stepper, and the sticky
   "Added" list with the Done button. Each page only supplies the data and the wording.
   No database changes.
   ===================================================================== */

import { equipmentImage } from './cards.js';
import { bindToolbar, suggestFor, suggestionsHtml, toolbarHtml } from './eqFilter.js';
import { selectionHtml } from './eqModal.js';
import { esc } from './utils.js';

/* "2 free for these hours, 1 still selectable" (the same sentence on every card) */
export const stockLine = (stock, known, left, forWhat = 'these hours', extra = '') =>
    `${stock} ${known ? `free for ${forWhat}` : 'in stock now'}, ${left} still selectable${extra}`;

/* The line that explains what the numbers mean. state: 'error' | 'hours' | 'today' */
export function noteHtml(state, { forWhat = 'these hours', hidden = 0, tail = '' } = {}) {
    if (state === 'error')
        return `<p class="bad-text" style="margin-top:4px" role="status">We couldn't check availability for ${esc(forWhat)} just now, so the numbers are today's stock. ${esc(tail)}</p>`;
    if (state === 'hours')
        return `<p class="mut" style="margin-top:4px" role="status">Numbers are for ${esc(forWhat)} only. ${hidden > 0 ? `${hidden} item${hidden === 1 ? ' is' : 's are'} fully reserved for those hours and not listed. ` : ''}${esc(tail)}</p>`;
    return `<p class="mut" style="margin-top:4px" role="status">The numbers are today's stock.</p>`;
}

/* c = { id, name, category, desc, img, price, unit, stockText, qty, max, inLabel } (price already formatted) */
export function cardHtml(c) {
    return `<div class="eqcard${c.qty > 0 ? ' sel' : ''}">
      ${equipmentImage({ img: c.img, name: c.name })}
      ${c.qty > 0 ? `<span class="eq-in">${esc(c.inLabel)} x${c.qty}</span>` : ''}
      <p class="cat">${esc(c.category || '')}</p>
      <h3>${esc(c.name)}</h3>
      ${c.desc ? `<p>${esc(c.desc)}</p>` : '<p class="mut">No description yet.</p>'}
      <p class="mut" style="margin-top:6px">${esc(c.stockText)}</p>
      <div class="row" style="margin-top:8px">
        <b>${esc(c.price)} <span class="mut" style="font-weight:400">${esc(c.unit)}</span></b>
        <div class="qtyl"><span>Qty</span>
          <div class="qstep" role="group" aria-label="Quantity of ${esc(c.name)}">
            <button type="button" class="qbtn" data-qstep="-1" data-id="${c.id}" aria-label="Remove one ${esc(c.name)}" ${c.qty <= 0 ? 'disabled' : ''}>&minus;</button>
            <output class="qval" aria-live="polite">${c.qty}</output>
            <button type="button" class="qbtn" data-qstep="1" data-id="${c.id}" aria-label="Add one ${esc(c.name)}" ${c.qty >= c.max ? 'disabled' : ''}>+</button>
          </div>
        </div>
      </div>
    </div>`;
}

/* "Frequently added with ...": `studio` is { id, desc } or null; items are { id, name, category, desc, price (formatted) };
   `pool` = what could still be added, `chosen` = what is already in the rental. Nothing is shown while searching. */
export function suggestionBlock({ studio, chosen, pool, query, unit }) {
    if (query.trim() || (!studio && !chosen.length))
        return '';
    const seeds = [studio && `Studio ${studio.id} ${studio.desc || ''}`, ...chosen.map(e => `${e.name} ${e.category || ''} ${e.desc || ''}`)];
    const items = suggestFor(seeds, pool, { chosen, max: 4 });
    const title = chosen.length
        ? `Frequently added with ${chosen.length === 1 ? chosen[0].name : 'your items'}`
        : `Frequently added with Studio ${studio.id}`;
    return suggestionsHtml(title, items, { attr: 'data-sadd', price: e => `${e.price} ${unit}` });
}

/* o = { title, intro, note, query, cats, cat, cards, sugg, selRows, selTitle }
   The window's own click handlers (supplied by each page) listen for: [data-close], [data-cat], [data-qstep],
   [data-sadd] (a suggestion's + Add) and [data-sel-rm] (Remove in the Added list). */
export function browseHtml(o) {
    const n = o.selRows.length;
    return `<div class="in">
    <div class="row"><h2 style="margin:0">${esc(o.title)}</h2><button type="button" class="btn sm line" data-close>Close</button></div>
    <p class="mut" style="margin-top:4px">${esc(o.intro)} Use + and &minus; to choose how many of each item you want.</p>
    ${o.note}
    ${toolbarHtml('eqd', { q: o.query, stockToggle: false })}
    <div class="tabs" style="margin-top:10px">${o.cats.map(c => `<button type="button" data-cat="${esc(c)}" class="${c === o.cat ? 'on' : ''}">${esc(c)}</button>`).join('')}</div>
    <div id="eqd-sugg">${o.sugg}</div>
    <div class="eqgrid">${o.cards.map(cardHtml).join('') || `<p class="mut">${o.query.trim() ? `Nothing matches "${esc(o.query.trim())}".` : 'Nothing available in this category.'}</p>`}</div>
    <div class="eq-bar">${selectionHtml(o.selRows, o.selTitle)}
      <div class="acts"><span class="mut" id="eqd-n" style="margin-right:auto">${n ? `${n} item${n === 1 ? '' : 's'} selected` : 'Nothing selected yet'}</span><button type="button" class="btn gold" data-close>Done</button></div></div>
  </div>`;
}

/* Puts the window's HTML in the <dialog> and connects the search box. The cursor stays in the search box
   when the window is redrawn (a quantity change, the 30-second refresh). onSearch(text) redraws with the new text. */
export function paintBrowse(dlg, html, onSearch) {
    const ae = document.activeElement, typing = ae && ae.id === 'eqd-q' && dlg.contains(ae);
    const caret = typing ? [ae.selectionStart, ae.selectionEnd] : null;
    dlg.innerHTML = html;
    bindToolbar(dlg, 'eqd', ({ q }) => onSearch(q));
    if (caret) {
        const box = dlg.querySelector('#eqd-q');
        box.focus();
        box.setSelectionRange(caret[0], caret[1]);
    }
}
