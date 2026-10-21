/* =====================================================================
   home/render.js - studio and equipment cards on the landing page
   Data comes from shared/catalog.js (Supabase tables studio and v_equipment_stock).
   ===================================================================== */

import { equipmentImage, studioThumb } from '../shared/cards.js';
import { EQUIPMENT, STUDIOS, isClosed } from '../shared/catalog.js';
import { $, badge, esc, peso } from '../shared/utils.js';

/* ============================ RENDERING ============================ */

export function renderStudioOptions() {
  $('#qs').innerHTML = STUDIOS
    .map((s, i) => `<option value="${i}">Studio ${s.id}, ${peso(s.rate)}/hr</option>`)
    .join('');
}

export function renderStudios() {
  $('#studio-grid').innerHTML = STUDIOS.map((s, i) => {
    const closed = isClosed(s);
    return `
      <div class="card">
        ${studioThumb(s)}
        <div class="row"><h3>Studio ${s.id}</h3>${badge(s.status)}</div>
        <p class="mut">${esc(s.desc)}</p>
        <div class="row" style="margin-top:12px">
          <span><b>${peso(s.rate)}</b> <span class="mut">per hour</span></span>
          <button class="btn gold" data-book-studio="${i}" ${closed ? 'disabled' : ''}>${closed ? 'Closed' : 'Book now'}</button>
        </div>
      </div>`;
  }).join('');
}

export function renderEquipment() {
  $('#equipment-grid').innerHTML = EQUIPMENT.map((e, i) => {
    const lines = [];
    if (e.addon)   lines.push(`<div><span class="b addon">Add-on</span> ${peso(e.addonPrice)} ${e.drum ? 'per rental' : 'per session'}</div>`);
    if (e.outside) lines.push(`<div><span class="b out">Outside</span> ${peso(e.outsidePrice)} per 8 hours (1/8 per extra hour)</div>`);

    const sub = e.drum
      ? `${e.drum.kit}, ${e.drum.vip ? 'VIP' : 'Basic'} set-up. 8-hour base rental, no service.`
      : `${e.stock} available`;

    return `
      <div class="card">
        ${equipmentImage(e)}
        <p class="cat">${esc(e.category || '')}</p>
        <h3>${esc(e.name)}</h3>
        ${e.desc ? `<p class="mut" style="margin-top:4px">${esc(e.desc)}</p>` : ''}
        <p class="mut">${esc(sub)}</p>
        <div class="price-lines">${lines.join('')}</div>
        <button class="btn gold full" data-rent-item="${i}">Rent</button>
      </div>`;
  }).join('');
}
