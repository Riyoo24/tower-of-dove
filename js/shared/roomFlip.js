/* =====================================================================
   shared/roomFlip.js - room cards that flip to show all the room specs
   Used by the home page room cards (home/render.js) and the Book a studio
   cards (customer/book.js).
   The front of a card shows only the short description and a "See room specs"
   button. The button turns the card over to the back, which lists every spec.
   ===================================================================== */

import { esc } from './utils.js';

/* cards that are showing their back, by key: 'h0' = home card 0, 'b0' = Book a studio card 0.
   Kept here so a card stays turned over when the page redraws its cards (e.g. after a date click). */
const open = new Set();

/* the button on the front of a card */
export function specsButton(key) {
    return `<button type="button" class="rm-more" data-flip="${key}" aria-expanded="${open.has(key)}">`
        + '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path d="M2.5 5.5h10M10 3l2.5 2.5L10 8M13.5 10.5h-10M6 8l-2.5 2.5L6 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        + 'See room specs</button>';
}

/* The two faces of a card. frontHtml is everything that sits on the front (photo, name, price, button...).
   With no gear items there is nothing to turn over, so the card has no back. */
export function flipCard(key, s, items, notes, frontHtml) {
    const has = items.length > 0, on = has && open.has(key);
    const back = has
        ? `<div class="rm-panel fl-back"${on ? '' : ' inert'}>
        <div class="rm-ph"><h3>Studio ${esc(s.id)} &middot; Room specs</h3><button type="button" class="rm-x" data-flip="${key}" aria-label="Back to the room card">&times;</button></div>
        <ul class="rm-specs all">${items.map(t => `<li><i aria-hidden="true"></i><span>${esc(t)}</span></li>`).join('')}</ul>
        ${notes.length ? `<p class="rm-note">${notes.map(esc).join('<br>')}</p>` : ''}
      </div>`
        : '';
    return `<div class="fl${on ? ' flipped' : ''}" data-fk="${key}">
      <div class="fl-in">
        <div class="fl-front"${on ? ' inert' : ''}>${frontHtml}</div>
        ${back}
      </div>
    </div>`;
}

/* turn one card over or back; focus follows so keyboard users land on the visible face */
function setFlip(key, on, moveFocus = true) {
    on ? open.add(key) : open.delete(key);
    const fl = document.querySelector(`.fl[data-fk="${key}"]`);
    if (!fl)
        return;
    const back = fl.querySelector('.fl-back'), front = fl.querySelector('.fl-front');
    if (!back)
        return;
    fl.classList.toggle('flipped', on);
    front.toggleAttribute('inert', on);
    back.toggleAttribute('inert', !on);
    fl.querySelectorAll('.rm-more').forEach(b => b.setAttribute('aria-expanded', String(on)));
    if (moveFocus)
        (on ? back.querySelector('.rm-x') : front.querySelector('.rm-more'))?.focus({ preventScroll: true });
}

function closeAll(except) {
    [...open].forEach(k => {
        if (k !== except)
            setFlip(k, false, false);
    });
}

/* the button or the x turns a card; a click anywhere else, or Escape, turns every open card back */
document.addEventListener('click', e => {
    const b = e.target.closest('[data-flip]');
    if (b) {
        const key = b.dataset.flip;
        closeAll(key);
        setFlip(key, !open.has(key));
        return;
    }
    if (!e.target.closest('.fl.flipped'))
        closeAll();
});

document.addEventListener('keydown', e => {
    if (e.key === 'Escape')
        closeAll();
});