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
let timer = 0;   // auto-advance timer

const AUTO_MS = 12000;   // time each room stays on screen; the main photo's zoom (css .rs-ph.main img) lasts as long
const still = matchMedia('(prefers-reduced-motion: reduce)');
const mouse = matchMedia('(hover: hover) and (pointer: fine)');   // phones keep :hover stuck after a tap, so hover only counts with a real mouse

const plural = (n, w) => `${n} ${w}${+n === 1 ? '' : 's'}`;

/* ---- the photo gallery ---- */
function gallery(s) {
    const ph = s.photos, n = ph.length;
    if (!n)   // no photo yet: the coloured tile with the room letter
        return `<div class="rs-gal n0"><div class="rs-ph main tile" style="background:linear-gradient(135deg,${s.c1},${s.c2})" role="img" aria-label="${esc(s.name)}, no photo yet"><span class="rs-letter" aria-hidden="true">${esc(s.id)}</span></div></div>`;
    const cell = (k, main) => `<button type="button" class="rs-ph pic${main ? ' main' : ''}" data-photo="${k}" aria-label="Open photo ${k + 1} of ${n}"><img src="${esc(ph[k])}" alt="${esc(s.name)}, photo ${k + 1}" width="${main ? 800 : 400}" height="${main ? 520 : 250}" ${k ? 'fetchpriority="low"' : 'fetchpriority="high"'} decoding="async"></button>`;
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
        items.length || notes.length ? `<div><h3>Included gear</h3>${items.length ? `<ul class="rs-gear">${items.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}${notes.length ? `<ul class="rs-gearnote">${notes.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}</div>` : ''
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
        : isPastSlot(date, SLOTS.indexOf(t)) && !taken.has(SLOTS.indexOf(t))
            ? `<span class="hr taken past" title="Time has passed">${esc(short(t))}<span class="sr">, time has passed</span></span>`
            : `<span class="hr taken" title="Taken">${esc(short(t))}<span class="sr">, taken</span></span>`).join('')}</div>
      <ul class="hr-key" aria-hidden="true"><li><i class="k-free"></i>Free</li><li><i class="k-sel"></i>Selected</li></ul>`;
}

/* A photo tile shows a soft shimmer until its image has really arrived, then the photo fades in (and starts to zoom) */
function watchPhotos() {
    document.querySelectorAll('#rs-detail .rs-ph.pic').forEach(b => {
        const im = b.querySelector('img'), ready = () => b.classList.add('ready');
        if (!im || (im.complete && im.naturalWidth))
            return ready();
        im.addEventListener('load', ready, { once: true });
        im.addEventListener('error', ready, { once: true });
    });
}

function draw() {
    drawTop();
    watchPhotos();
    drawMore();
    loadHours();
}

let busy = false;   // true while one room fades out and the next fades in
const photoReady = new Map();   // photo url -> promise that settles once the browser has downloaded and decoded it
const photoDone = new Set();    // photo urls that are already downloaded
const wait = ms => new Promise(r => setTimeout(r, ms));

/* Download and decode a room's main photo ahead of time, so it is on screen together with the text and not after it */
function preload(room) {
    const url = room?.s.photos?.[0];
    if (!url)
        return Promise.resolve();
    if (!photoReady.has(url)) {
        const im = new Image();
        im.decoding = 'async';
        im.src = url;
        photoReady.set(url, (im.decode ? im.decode().catch(() => {}) : new Promise(r => { im.onload = im.onerror = r; })).then(() => photoDone.add(url)));
    }
    return photoReady.get(url);
}

const isReady = room => !room.s.photos?.[0] || photoDone.has(room.s.photos[0]);

/* Download the other rooms' photos one after another (the next room first), so they do not fight each other or the photo on screen */
async function warm() {
    for (let k = 1; k < rooms.length; k++)
        await preload(rooms[(cur + k) % rooms.length]);
}

/* Change room: the content fades out (180ms), then the next room's content fades in. The boxes never move.
   A visitor never waits long: if the next photo is not downloaded after 0.4s the room changes anyway and the photo fades in when it arrives.
   Automatic changes only start once the next photo is downloaded (see startAuto). */
function go(d, focusId, auto) {
    if (rooms.length < 2 || busy)
        return;
    const next = (cur + d + rooms.length) % rooms.length;
    const boxes = ['#rs-detail', '#rs-more'].map($).filter(Boolean);
    const change = () => {
        cur = next;
        slot = null;
        draw();
        if (auto)
            return;   // automatic change: no focus jump, no screen-reader announcement
        $('#rs-live').textContent = `${rooms[cur].s.name}, ${cur + 1} of ${rooms.length}`;
        $(focusId || (d > 0 ? '#rs-next' : '#rs-prev'))?.focus({ preventScroll: true });
    };
    if (!auto)
        startAuto();   // the visitor took control: restart the countdown
    if (still.matches)
        return preload(rooms[next]), change();   // reduced motion: swap at once
    busy = true;
    boxes.forEach(b => {
        b.classList.remove('rs-in');
        b.classList.add('rs-out');
    });
    Promise.all([wait(180), Promise.race([preload(rooms[next]), wait(400)])]).then(() => {
        change();
        boxes.forEach(b => b.classList.replace('rs-out', 'rs-in'));
        setTimeout(() => { busy = false; }, 300);
        setTimeout(() => boxes.forEach(b => b.classList.remove('rs-in')), 800);
    });
}

/* ---- auto-advance: skipped while the visitor is on this room (mouse over the gallery or the details / booking panel, focus or a picked hour in the panel),
   the tab is hidden, a photo viewer is open, or reduced motion is on ---- */
function startAuto() {
    clearInterval(timer);
    if (rooms.length < 2 || still.matches)
        return;
    let due = Date.now() + AUTO_MS;
    timer = setInterval(() => {
        if (Date.now() < due)
            return;
        if (document.hidden || slot || document.querySelector('dialog[open]') || (mouse.matches && ($('#rs-detail')?.matches(':hover') || $('#rs-more')?.matches(':hover'))) || $('#rs-more')?.matches(':focus-within')) {
            due = Date.now() + 3000;   // the visitor is busy here: look again in 3s
            return;
        }
        const next = rooms[(cur + 1) % rooms.length];
        if (!isReady(next)) {
            preload(next);   // wait (checked every 0.5s) until the next photo is downloaded, so the change is instant
            return;
        }
        due = Date.now() + AUTO_MS;
        go(1, null, true);
    }, 500);
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
    preload(rooms[0]).then(warm);   // once this room's photo is in, download the other rooms' main photos one by one
    startAuto();
    still.addEventListener?.('change', startAuto);
    sec.addEventListener('click', onClick);
    more.addEventListener('click', onClick);
    [sec, more].forEach(box => box.addEventListener('keydown', e => {
        if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.altKey || e.ctrlKey || e.metaKey || e.target.closest('input, select, textarea'))
            return;
        e.preventDefault();
        go(e.key === 'ArrowRight' ? 1 : -1);
    }));
}