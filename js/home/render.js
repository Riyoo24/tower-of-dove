/* =====================================================================
   home/render.js - studio and equipment cards on the landing page
   Data comes from shared/catalog.js (Supabase tables studio and v_equipment_stock).
   ===================================================================== */

import { equipmentImage, studioThumb } from '../shared/cards.js';
import { firstBookableDate, isPastSlot, loadBusy, takenSlots } from '../shared/availability.js';
import { EQUIPMENT, STUDIOS, isClosed } from '../shared/catalog.js';
import { cachedAvailLine, fillAvailLines } from '../shared/liveAvail.js';
import { $, $$, SLOTS, badge, esc, manilaDay, peso, specsOf } from '../shared/utils.js';

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
        const { tagline, items, notes } = specsOf(s.desc, s.specs);
        const SHOW = 2, extra = items.length - SHOW;
        const li = t => `<li><i aria-hidden="true"></i><span>${esc(t)}</span></li>`;
        const specs = (tagline ? `<p class="rm-tag${items.length ? ' one' : ''}">${esc(tagline)}</p>` : '') +
            (items.length
                ? `<ul class="rm-specs">${items.slice(0, SHOW).map(li).join('')}</ul>` +
                    (extra > 0 || notes.length ? `<button type="button" class="rm-more" data-room-specs="${i}" aria-expanded="false">${extra > 0 ? `+${extra} more &middot; see all gear` : 'See details'}</button>` : '')
                : '');
        const panel = items.length && (extra > 0 || notes.length)
            ? `<div class="rm-panel" data-room-panel="${i}" hidden>
          <div class="rm-ph"><h3>Studio ${esc(s.id)} &middot; In the room</h3><button type="button" class="rm-x" data-room-specs="${i}" aria-label="Close">&times;</button></div>
          <ul class="rm-specs all">${items.map(li).join('')}</ul>
          ${notes.length ? `<p class="rm-note">${notes.map(esc).join('<br>')}</p>` : ''}
        </div>`
            : '';
        return `
      <div class="card hx-room">
        ${studioThumb(s)}
        <div class="rm-head"><h3>Studio ${esc(s.id)}</h3>${closed ? badge(s.status) : `<span class="hx-b" data-room-status="${i}"><i></i>Checking...</span>`}</div>
        <div class="rm-body">${specs}</div>
        ${cachedAvailLine(i)}
        <div class="row hx-foot">
          <span><b>${peso(s.rate)}</b> <span class="mut">/ hour</span></span>
          <button class="btn gold" data-book-studio="${i}" ${closed ? 'disabled' : ''}>${closed ? 'Closed' : 'Book now'}</button>
        </div>
        ${panel}
      </div>`;
    }).join('');
    showRoomStatus();
    fillAvailLines($('#studio-grid'));
}

/* "see all gear" opens the full list over the card (the card keeps its height); the x button, Escape or a click elsewhere closes it */
function closeRoomPanels(except) {
    $$('[data-room-panel]').forEach(p => {
        if (p === except)
            return;
        p.hidden = true;
        const b = document.querySelector(`.rm-more[data-room-specs="${p.dataset.roomPanel}"]`);
        if (b)
            b.setAttribute('aria-expanded', 'false');
    });
}

document.addEventListener('click', e => {
    const b = e.target.closest('[data-room-specs]');
    if (!b) {
        if (!e.target.closest('[data-room-panel]'))
            closeRoomPanels();
        return;
    }
    const panel = document.querySelector(`[data-room-panel="${b.dataset.roomSpecs}"]`);
    if (!panel)
        return;
    const open = panel.hidden;
    closeRoomPanels(open ? panel : null);
    panel.hidden = !open;
    const opener = document.querySelector(`.rm-more[data-room-specs="${b.dataset.roomSpecs}"]`);
    if (opener)
        opener.setAttribute('aria-expanded', String(open));
    if (open)
        panel.querySelector('.rm-x').focus();
    else if (opener)
        opener.focus();
});

document.addEventListener('keydown', e => {
    if (e.key === 'Escape')
        closeRoomPanels();
});

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