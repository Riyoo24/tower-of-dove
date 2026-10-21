/* =====================================================================
   shared/cards.js - picture blocks for studio and equipment cards
   Used by the home page and the customer page.
   ===================================================================== */

import { esc } from './utils.js';

/* ---- moved from home.js / customer.js (identical in both) ---- */
export const IMAGE_ICON =
  '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/>' +
  '<circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-8 8"/></svg>';

export const studioThumb = s => s.img
  ? `<div class="ph has"><img src="${esc(s.img)}" alt="Studio ${esc(s.id)}" loading="lazy"></div>`
  : `<div class="ph" style="background:linear-gradient(135deg,${s.c1},${s.c2})">${s.id}</div>`;

export const equipmentImage = e => e.img
  ? `<div class="eqimg has"><img src="${esc(e.img)}" alt="${esc(e.name)}"></div>`
  : `<div class="eqimg" role="img" aria-label="No image yet">${IMAGE_ICON}</div>`;
