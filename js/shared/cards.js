/* =====================================================================
   shared/cards.js - picture blocks for studio and equipment cards
   Used by the home page and the customer page.
   ===================================================================== */

import { IMAGE_TRANSFORMS } from '../config/paths.js';
import { esc } from './utils.js';

/* ---- moved from home.js / customer.js (identical in both) ---- */
export const IMAGE_ICON =
    '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/>' +
    '<circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-8 8"/></svg>';

/* srcset for a photo stored in the Supabase "studio-images" bucket (only when IMAGE_TRANSFORMS is true in config/paths.js).
   Any other link (a pasted web address) is returned as it is, because it cannot be resized. */
const OBJECT_PATH = '/storage/v1/object/public/';
const RENDER_PATH = '/storage/v1/render/image/public/';

export function photoSrcset(url, widths = [320, 480, 720, 1080]) {
    if (!IMAGE_TRANSFORMS || typeof url !== 'string' || !url.includes(OBJECT_PATH))
        return '';
    const base = url.split('?')[0].replace(OBJECT_PATH, RENDER_PATH);
    return widths.map(w => `${base}?width=${w}&quality=75 ${w}w`).join(', ');
}

/* <img> with its size reserved (width, height and the aspect-ratio rule in css/mobile.css), lazy loading and srcset when available. */
export function photo(url, alt, { width, height, sizes = '(max-width: 600px) 92vw, 320px', eager = false, cls = '' } = {}) {
    const set = photoSrcset(url);
    return `<img${cls ? ` class="${cls}"` : ''} src="${esc(url)}"${set ? ` srcset="${esc(set)}" sizes="${esc(sizes)}"` : ''} alt="${esc(alt)}" width="${width}" height="${height}" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async">`;
}

export const studioThumb = s => s.img
    ? `<div class="ph has">${photo(s.img, 'Studio ' + s.id, { width: 320, height: 104 })}</div>`
    : `<div class="ph" style="background:linear-gradient(135deg,${s.c1},${s.c2})">${s.id}</div>`;

export const equipmentImage = e => e.img
    ? `<div class="eqimg has">${photo(e.img, e.name, { width: 320, height: 120 })}</div>`
    : `<div class="eqimg" role="img" aria-label="No image yet">${IMAGE_ICON}</div>`;
