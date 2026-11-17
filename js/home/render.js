/* =====================================================================
   home/render.js - studio and equipment cards on the landing page
   Data comes from shared/catalog.js (Supabase tables studio and v_equipment_stock).
   ===================================================================== */

import { equipmentImage, studioThumb } from '../shared/cards.js';
import { EQUIPMENT, STUDIOS, isClosed } from '../shared/catalog.js';
import { cachedAvailLine, fillAvailLines } from '../shared/liveAvail.js';
import { flipCard, specsButton } from '../shared/roomFlip.js';
import { showRoomStatus } from '../shared/roomStatus.js';
import { $, badge, esc, peso, specsOf } from '../shared/utils.js';

/* ============================ RENDERING ============================ */

export function renderStudioOptions() {
    // "All studios" checks every studio at the chosen time (home/availability.js); it is the default pick
    $('#qs').innerHTML = '<option value="all" selected>All studios</option>' + STUDIOS
        .map((s, i) => `<option value="${i}">Studio ${s.id}, ${peso(s.rate)}/hr</option>`)
        .join('');
}

export function renderStudios() {
    $('#studio-grid').innerHTML = STUDIOS.map((s, i) => {
        const closed = isClosed(s);
        const key = 'h' + i;
        const { tagline, items, notes } = specsOf(s.desc, s.specs);
        // the front shows only the short description and one "See room specs" button; the full gear list is on the back
        const specs = (tagline ? `<p class="rm-tag">${esc(tagline)}</p>` : '') + (items.length ? specsButton(key) : '');
        const front = `
        ${studioThumb(s)}
        <div class="rm-head"><h3>Studio ${esc(s.id)}</h3>${closed ? badge(s.status) : `<span class="hx-b" data-room-status="${i}"><i></i>Checking...</span>`}</div>
        <div class="rm-body">${specs}</div>
        ${cachedAvailLine(i)}
        <div class="row hx-foot">
          <span><b>${peso(s.rate)}</b> <span class="mut">/ hour</span></span>
          <button class="btn gold" data-book-studio="${i}" ${closed ? 'disabled' : ''}>${closed ? 'Closed' : 'Book now'}</button>
        </div>`;
        return `
      <div class="card hx-room">
        ${flipCard(key, s, items, notes, front)}
      </div>`;
    }).join('');
    showRoomStatus();
    fillAvailLines($('#studio-grid'));
}

export function renderEquipment() {
    $('#equipment-grid').innerHTML = EQUIPMENT.map((e, i) => {
        const lines = [];
        if (e.addon)
            lines.push(`<div><span class="b addon">Add-on</span> ${peso(e.addonPrice)} per session</div>`);
        if (e.outside)
            lines.push(`<div><span class="b out">Outside</span> ${peso(e.outsidePrice)} per 8 hours (1/8 per extra hour)</div>`);

        return `
      <div class="card">
        ${equipmentImage(e)}
        <p class="cat">${esc(e.category || '')}</p>
        <h3>${esc(e.name)}</h3>
        ${e.desc ? `<p class="mut" style="margin-top:4px">${esc(e.desc)}</p>` : ''}
        <p class="mut">${e.stock} available</p>
        <div class="price-lines">${lines.join('')}</div>
        <button class="btn gold full" data-rent-item="${i}">Rent</button>
      </div>`;
    }).join('');
    limitEquipmentRows();
}

/* Home page shows only the first two rows of equipment cards; "View more equipment" goes to Rent Equipment.
   The column count changes with screen width, so the cut-off is recalculated on resize. */
const HOME_EQUIPMENT_ROWS = 2;

export function limitEquipmentRows() {
    const grid = $('#equipment-grid'), more = $('#equipment-more');
    if (!grid) return;
    // Home is hidden while another tab is open: a hidden grid has no columns to count, so wait until it is shown
    // (the ResizeObserver below calls this again the moment it appears)
    if (!grid.clientWidth) return;
    const cards = [...grid.children];
    cards.forEach(c => { c.hidden = false; });
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length || 1;
    const max = cols * HOME_EQUIPMENT_ROWS;
    cards.forEach((c, i) => { c.hidden = i >= max; });
    if (more) {
        more.hidden = cards.length <= max;
        const left = cards.length - max, note = $('#equipment-more-note');
        if (note && left > 0) note.textContent = `+${left} more item${left === 1 ? '' : 's'} available to rent`;
    }
}

/* Recount the columns when the grid becomes visible or changes width: opening Home after a refresh on another tab,
   a window resize, a phone turning around. */
const equipmentGrid = $('#equipment-grid');
if (equipmentGrid && 'ResizeObserver' in window) {
    let lastWidth = 0;
    new ResizeObserver(() => {
        const width = equipmentGrid.clientWidth;
        if (width !== lastWidth) {
            lastWidth = width;
            limitEquipmentRows();
        }
    }).observe(equipmentGrid);
}

let resizeTimer;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(limitEquipmentRows, 120);
});