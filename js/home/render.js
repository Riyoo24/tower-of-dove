/* =====================================================================
   home/render.js - studio and equipment cards on the landing page
   Data comes from shared/catalog.js (Supabase tables studio and v_equipment_stock).
   ===================================================================== */

import { equipmentImage, studioThumb } from '../shared/cards.js';
import { firstBookableDate, isPastSlot, loadBusy, takenSlots } from '../shared/availability.js';
import { EQUIPMENT, STUDIOS, isClosed } from '../shared/catalog.js';
import { cachedAvailLine, fillAvailLines } from '../shared/liveAvail.js';
import { $, $$, SLOTS, badge, descHTML, esc, manilaDay, peso } from '../shared/utils.js';

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
        return `
      <div class="card hx-room">
        ${studioThumb(s)}
        <div class="row"><h3>Studio ${s.id}</h3>${closed ? badge(s.status) : `<span class="hx-b" data-room-status="${i}"><i></i>Checking...</span>`}</div>
        ${descHTML(s.desc)}
        ${cachedAvailLine(i)}
        <div class="row hx-foot">
          <span><b>${peso(s.rate)}</b> <span class="mut">/ hour</span></span>
          <button class="btn gold" data-book-studio="${i}" ${closed ? 'disabled' : ''}>${closed ? 'Closed' : 'Book now'}</button>
        </div>
      </div>`;
    }).join('');
    showRoomStatus();
    fillAvailLines($('#studio-grid'));
}

/* Live badge on each room card: how many start times are still open on the first bookable day.
   Runs after the cards are drawn (one small request per room); a failed request just shows "Open". */
async function showRoomStatus() {
    const date = firstBookableDate(), when = date === manilaDay(0) ? 'today' : 'tomorrow';
    await Promise.all($$('[data-room-status]').map(async el => {
        const i = +el.dataset.roomStatus;
        let cls = '', text = 'Open';
        try {
            await loadBusy(i, date, date);
            const taken = takenSlots(i, date);
            const n = SLOTS.filter((_, k) => !taken.has(k) && !isPastSlot(date, k)).length;
            [cls, text] = n === 0 ? ['bad', `Fully booked ${when}`]
                : n <= 3 ? ['warn', `${n} slot${n > 1 ? 's' : ''} left ${when}`]
                    : ['ok', `Available ${when}`];
        } catch (e) {
            /* keep the plain "Open" badge */
        }
        el.className = 'hx-b ' + cls;
        el.innerHTML = `<i></i>${text}`;
    }));
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

let resizeTimer;
window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(limitEquipmentRows, 120);
});
