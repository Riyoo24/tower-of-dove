/* =====================================================================
   shared/emptyState.js - friendly "nothing here yet" blocks
   An icon, one short line and (when there is a next step) a button, instead of a plain sentence.
     emptyState({ icon: 'calendar', title: 'No bookings yet', text: '...', action: { label: 'Book a studio', href: '#book' } })
   action.href  a link on the same page (a tab such as #book, #rent)
   action.scrollTo  a selector to scroll to (for a button that only points at something on the page)
   compact: true  smaller version for narrow places such as the cart.
   ===================================================================== */

import { esc, reducedMotion } from './utils.js';

const PATHS = {
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    headphones: '<path d="M4 15v-3a8 8 0 0116 0v3"/><rect x="3" y="14" width="4" height="7" rx="1.5"/><rect x="17" y="14" width="4" height="7" rx="1.5"/>',
    cart: '<circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M3 4h2.5l2.2 11h10.6l2-8H6.2"/>'
};

const svg = name => `<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${PATHS[name] || PATHS.calendar}</svg>`;

export function emptyState({ icon = 'calendar', title, text = '', action = null, compact = false }) {
    let btn = '';
    if (action && action.href)
        btn = `<a class="btn gold${compact ? ' sm' : ''}" href="${esc(action.href)}">${esc(action.label)}</a>`;
    else if (action && action.scrollTo)
        btn = `<button type="button" class="btn gold${compact ? ' sm' : ''}" data-scroll-to="${esc(action.scrollTo)}">${esc(action.label)}</button>`;
    return `<div class="empty-state${compact ? ' compact' : ''}" role="status">
      <span class="empty-ic" aria-hidden="true">${svg(icon)}</span>
      <p class="empty-t">${esc(title)}</p>
      ${text ? `<p class="empty-x">${esc(text)}</p>` : ''}
      ${btn}
    </div>`;
}

/* one listener for every "scroll to" button (they are drawn again and again, so it sits on the document) */
document.addEventListener('click', e => {
    const b = e.target.closest('[data-scroll-to]');
    if (!b)
        return;
    const target = document.querySelector(b.getAttribute('data-scroll-to'));
    if (target)
        target.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
});
