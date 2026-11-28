/* =====================================================================
   home/carousel.js - "Our rooms" on the landing page: one room at a time
   DB: studio + studio_photo through shared/catalog.js (STUDIOS), and the live hour grid through
   shared/availability.js (rpc get_busy_slots). Rooms that are Available are shown, and rooms under
   Maintenance too (with a badge and a disabled Book button), in the order set in Admin > Studio management.
   Prev / next arrows and the Left / Right keys change the room. Everything the owner types is escaped.
   ===================================================================== */

import { firstBookableDate, isPastSlot, loadBusy, takenSlots } from '../shared/availability.js';
import { STUDIOS, isClosed } from '../shared/catalog.js';
import { openImageViewer } from '../shared/imageViewer.js';
import { goBook } from '../shared/navigation.js';
import { $, SLOTS, esc, manilaDay, peso, specsOf } from '../shared/utils.js';

const USR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-3.5 3-5.5 7-5.5s7 2 7 5.5M16 4.5a3.5 3.5 0 010 7M22 20c0-2.5-1.5-4.2-4-5"/></svg>';
const PIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 21s-7-6.2-7-11a7 7 0 0114 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>';

/* Opening hours come from the bookable start times (utils SLOTS): the first start time to one hour after the last one */
const hourOf = t => {
    const m = /^(\d+):\d+ (AM|PM)$/.exec(t);
    return (+m[1] % 12) + (m[2] === 'PM' ? 12 : 0);
};
const hr12 = h => `${h % 12 || 12} ${h < 12 || h === 24 ? 'AM' : 'PM'}`;
const short = t => t.replace(':00 ', ' ');   // 10:00 AM -> 10 AM
const OPEN = {
    from: hr12(hourOf(SLOTS[0])),
    to: hr12(hourOf(SLOTS[SLOTS.length - 1]) + 1),
    last: short(SLOTS[SLOTS.length - 1])
};

let rooms = [];   // [{ s: STUDIOS entry, i: its index in STUDIOS }]: booking and availability address a room by that index
let cur = 0, slot = null, date = '', when = '';

const plural = (n, w) => `${n} ${w}${+n === 1 ? '' : 's'}`;

/* ---- the photo gallery ---- */
function gallery(s) {
    const ph = s.photos, n = ph.length;
    if (!n)   // no photo yet: the coloured tile with the room letter
        return `<div class="rs-gal n0"><div class="rs-ph main tile" style="background:linear-gradient(135deg,${s.c1},${s.c2})" role="img" aria-label="${esc(s.name)}, no photo yet"><span class="rs-letter" aria-hidden="true">${esc(s.id)}</span></div></div>`;
    const cell = (k, main) => `<button type="button" class="rs-ph pic${main ? ' main' : ''}" data-photo="${k}" aria-label="Open photo ${k + 1} of ${n}"><img src="${esc(ph[k])}" alt="${esc(s.name)}, photo ${k + 1}" width="${main ? 800 : 400}" height="${main ? 520 : 250}" ${k ? 'loading="lazy"' : 'fetchpriority="high"'} decoding="async"></button>`;
    const cells = ph.slice(0, 4).map((_, k) => cell(k, k === 0));
    if (n > 4)
        cells.push(`<button type="button" class="rs-ph more" data-photo="0">View all ${n} photos</button>`);
    return `<div class="rs-gal n${Math.min(n, 5)}">${cells.join('')}</div>`;
}

/* ---- the top part: title, meta and gallery ---- */
function drawTop() {
    const { s } = rooms[cur], off = isClosed(s), n = rooms.length;
    const meta = [
        s.capacity ? `<span>${USR}Fits up to ${plural(s.capacity, 'player')}</span>` : '',
        s.sqm ? `<span>${esc(s.sqm)} sqm</span>` : '',
        s.location ? `<span>${PIN}${esc(s.location)}</span>` : ''
    ].filter(Boolean);
    $('#rs-detail').innerHTML = `
    <div class="rs-top">
      <div>
        <h2 class="rs-title">${esc(s.name)}${s.desc ? ` &middot; ${esc(s.desc)}` : ''}${off ? ' <span class="rs-off">Maintenance</span>' : ''}</h2>
        ${meta.length ? `<p class="rs-meta">${meta.join('')}</p>` : ''}
      </div>
      ${n > 1 ? `<div class="sc-arrows rs-arrows"><button type="button" id="rs-prev" aria-label="Previous studio">&#8249;</button><span class="rs-count" aria-hidden="true">${cur + 1} / ${n}</span><button type="button" id="rs-next" aria-label="Next studio">&#8250;</button></div>` : ''}
    </div>
    ${gallery(s)}`;
}

const bookLabel = () => slot ? `Book ${esc(short(slot))} &rarr;` : 'Book this room';

/* ---- the details under the fold: about, gear, facts and the booking panel ---- */
function drawMore() {
    const { s } = rooms[cur], off = isClosed(s);
    const { items, notes } = specsOf('', s.specs);
    const facts = [
        s.capacity ? ['Capacity', `Up to ${plural(s.capacity, 'player')}`] : null,
        s.sqm ? ['Room size', `${esc(s.sqm)} sqm`] : null,
        s.location ? ['Location', esc(s.location)] : null,
        ['Open', `${OPEN.from} &ndash; ${OPEN.to}`]
    ].filter(Boolean);
    const blocks = [
        s.about ? `<div><h3>About this room</h3><p style="white-space:pre-line">${esc(s.about)}</p></div>` : '',
        items.length || notes.length ? `<div><h3>Included gear</h3>${items.length ? `<ul class="rs-gear">${items.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}${notes.length ? `<p class="rs-note" style="margin-top:10px">${notes.map(esc).join('<br>')}</p>` : ''}</div>` : ''
    ].join('');
    $('#rs-more').innerHTML = `
    <div class="rs-body">
      <div class="card rs-info">
        ${blocks}
        <div class="rs-specs">${facts.map(([k, v]) => `<div><small>${k}</small><b>${v}</b></div>`).join('')}</div>
      </div>
      <aside class="card rs-book" aria-label="Book ${esc(s.name)}">
        <span class="rs-eyebrow">${when} &middot; ${esc(s.name)}</span>
        <p class="rs-price"><b>${peso(s.rate)}</b> <span>/ hour</span></p>
        ${off ? '<p class="rs-free bad"><i></i>Closed for maintenance</p>'
        : '<div id="rs-hours" aria-busy="true"><p class="rs-note">Checking the hours&hellip;</p></div>'}
        <button type="button" class="btn gold lg full" id="rs-book" data-rs-book ${off ? 'disabled' : ''}>${off ? 'Unavailable' : bookLabel()}</button>
        <p class="rs-note">Open daily ${OPEN.from} to ${OPEN.to} &middot; last start ${OPEN.last}</p>
      </aside>
    </div>`;
}

/* ---- the live hour grid (real availability: free hours are the ones nobody has booked or is holding, and that are still ahead) ---- */
async function loadHours() {
    const at = cur, { s, i } = rooms[at];
    if (isClosed(s))
        return;
    const box = $('#rs-hours');
    let ok = true;
    try {
        ok = (await loadBusy(i, date, date)) !== false;
    } catch (e) {
        ok = false;
    }
    if (at !== cur || !box.isConnected)
        return;   // the visitor moved to another room while this one was loading
    box.removeAttribute('aria-busy');
    if (!ok) {
        box.innerHTML = '<p class="rs-note">Could not check the hours right now.</p><button type="button" class="btn line sm" data-rs-retry>Try again</button>';
        return;
    }
    const taken = takenSlots(i, date);
    const state = SLOTS.map((t, k) => [t, !taken.has(k) && !isPastSlot(date, k)]);
    const free = state.filter(([, f]) => f).length;
    if (slot && !state.some(([t, f]) => t === slot && f))
        slot = null;
    $('#rs-book').innerHTML = bookLabel();
    box.innerHTML = `<div class="rs-hh"><span>Hours ${when.toLowerCase()}</span>${free ? `<b class="rs-free"><i></i>${free} free</b>` : '<b class="rs-free bad"><i></i>Fully booked</b>'}</div>
      <div class="hr-grid">${state.map(([t, f]) => f
        ? `<button type="button" class="hr free rs-hr${t === slot ? ' on' : ''}" data-t="${esc(t)}" aria-pressed="${t === slot}">${esc(short(t))}</button>`
        : `<span class="hr taken" title="Taken">${esc(short(t))}<span class="sr">, taken</span></span>`).join('')}</div>
      <ul class="hr-key" aria-hidden="true"><li><i class="k-free"></i>Free</li><li><i class="k-sel"></i>Selected</li></ul>`;
}

function draw() {
    drawTop();
    drawMore();
    loadHours();
}

function go(d, focusId) {
    if (rooms.length < 2)
        return;
    cur = (cur + d + rooms.length) % rooms.length;
    slot = null;
    draw();
    $('#rs-live').textContent = `${rooms[cur].s.name}, ${cur + 1} of ${rooms.length}`;
    $(focusId || (d > 0 ? '#rs-next' : '#rs-prev'))?.focus({ preventScroll: true });
}

function selectSlot(t) {
    slot = slot === t ? null : t;
    document.querySelectorAll('#rs-more .rs-hr').forEach(b => {
        const on = b.dataset.t === slot;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
    });
    $('#rs-book').innerHTML = bookLabel();
}

function onClick(e) {
    const t = e.target;
    if (t.closest('#rs-next'))
        return go(1, '#rs-next');
    if (t.closest('#rs-prev'))
        return go(-1, '#rs-prev');
    const ph = t.closest('[data-photo]');
    if (ph) {
        const { s } = rooms[cur];
        return openImageViewer({ url: s.photos[+ph.dataset.photo], title: s.name, gallery: s.photos, index: +ph.dataset.photo });
    }
    const hr = t.closest('.rs-hr');
    if (hr)
        return selectSlot(hr.dataset.t);
    if (t.closest('[data-rs-retry]')) {
        $('#rs-hours').innerHTML = '<p class="rs-note">Checking the hours&hellip;</p>';
        return loadHours();
    }
    if (t.closest('[data-rs-book]') && !t.closest('[disabled]')) {
        // the real booking flow opens with this room (and the hour, when one was picked) already chosen
        const { i } = rooms[cur];
        return slot ? goBook(i, date, slot) : goBook(i);
    }
}

export function initCarousel() {
    const sec = $('#rooms'), more = $('#rs-more');
    if (!sec || !more)
        return;
    // rooms the owner switched off (Unavailable) are not shown; the index into STUDIOS is kept for booking
    rooms = STUDIOS.map((s, i) => ({ s, i })).filter(({ s }) => s.status !== 'Unavailable');
    date = firstBookableDate();
    when = date === manilaDay(0) ? 'Today' : 'Tomorrow';
    if (!rooms.length) {
        $('#rs-detail').innerHTML = '<div class="card"><h3>No rooms are open for booking right now</h3><p class="mut">Please check back soon, or contact the studio.</p></div>';
        more.hidden = true;
        return;
    }
    cur = 0;
    slot = null;
    draw();
    sec.addEventListener('click', onClick);
    more.addEventListener('click', onClick);
    [sec, more].forEach(box => box.addEventListener('keydown', e => {
        if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.altKey || e.ctrlKey || e.metaKey || e.target.closest('input, select, textarea'))
            return;
        e.preventDefault();
        go(e.key === 'ArrowRight' ? 1 : -1);
    }));
}