/* =====================================================================
   home/render.js - the studio dropdown and the equipment cards on the landing page
   (the room section is drawn by home/carousel.js)
   Data comes from shared/catalog.js (Supabase tables studio and v_equipment_stock).
   ===================================================================== */

import { equipmentImage } from '../shared/cards.js';
import { EQUIPMENT, STUDIOS } from '../shared/catalog.js';
import { $, esc, peso } from '../shared/utils.js';

/* ============================ RENDERING ============================ */

export function renderStudioOptions() {
    // "All studios" checks every studio at the chosen time (home/availability.js); it is the default pick
    $('#qs').innerHTML = '<option value="all" selected>All studios</option>' + STUDIOS
        .map((s, i) => `<option value="${i}">Studio ${s.id}, ${peso(s.rate)}/hr</option>`)
        .join('');
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