/* =====================================================================
   customer/book.js - "Book a studio" tab: studio picker and calendar
   DB: reads busy slots through shared/availability.js (rpc get_busy_slots).
   ===================================================================== */

import { state } from './state.js';
import { estimateTable } from '../shared/estimate.js';
import { openBook } from './bookingForm.js';
import { blockMessage, isBlocked } from './damageBlock.js';
import { firstBookableDate, isPastSlot, lastBookableDate, loadBusy, takenSlots } from '../shared/availability.js';
import { studioThumb } from '../shared/cards.js';
import { cachedAvailLine, fillAvailLines } from '../shared/liveAvail.js';
import { STUDIOS, isClosed } from '../shared/catalog.js';
import { $, SLOTS, badge, descHTML, esc, longDate, manilaDay, pad, peso, toast } from '../shared/utils.js';

/* A day is fully booked (red) only when it can still be booked and every hour that is left is taken.
   Past days are never red, and neither is a day with no hours left to book (like today after closing);
   on today, hours that have already passed are ignored, so today is red once all the remaining hours are booked. */
const dayIsFull = (studioIdx, ds) => {
    if (ds < manilaDay(0))
        return false;
    const taken = takenSlots(studioIdx, ds);
    const open = SLOTS.map((_, i) => i).filter(i => !isPastSlot(ds, i));
    return open.length > 0 && open.every(i => taken.has(i));
};

const nextDay = ds => {
    const d = new Date(ds + 'T00:00');
    d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/* Book Now on a fully booked day: select the next day that still has a free hour (the form is not opened). */
async function bookNow() {
    if (isBlocked())
        return toast(blockMessage());
    const si = state.selStudio, last = lastBookableDate();
    await loadBusy(si, state.selDate, last);   // the following days may be in another month, so load them first
    if (dayIsFull(si, state.selDate)) {
        let ds = nextDay(state.selDate);
        while (ds <= last && dayIsFull(si, ds))
            ds = nextDay(ds);
        if (ds > last)
            return toast('This studio is fully booked for the next 4 weeks. Please try another studio.');
        const wasToday = state.selDate === manilaDay(0);
        state.selDate = ds;
        state.calMonth = new Date(ds + 'T00:00');
        state.calMonth.setDate(1);
        await refreshBook();   // only select the next available day; the customer presses Book Now again to open the form
        return toast(`${wasToday ? 'Today is' : 'That day is'} fully booked. We selected ${longDate(ds)} for you.`);
    }
    return openBook();
}

/* ============================ 2. BOOK A STUDIO ============================ */

/* ---- quick date chips: Today / Tomorrow / This weekend / Next available ---- */
const addDays = (ds, n) => {
    const d = new Date(ds + 'T00:00');
    d.setDate(d.getDate() + n);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function quickDates() {
    const first = firstBookableDate(), last = lastBookableDate(), today = manilaDay(0);
    const dow = new Date(today + 'T00:00').getDay();                 // 0 Sunday .. 6 Saturday
    let weekend = dow === 0 || dow === 6 ? today : addDays(today, 6 - dow);
    if (weekend < first)
        weekend = addDays(weekend, dow === 0 ? 6 : 1);                // today's slots are over: take the next free weekend day
    return { today, tomorrow: addDays(today, 1), weekend, first, last };
}

function renderQuick() {
    const el = $('#bk-quick');
    if (!el)
        return;
    const q = quickDates();
    const chip = (key, label, ds) => {
        const ok = ds >= q.first && ds <= q.last;
        return `<button type="button" class="qchip${ok && ds === state.selDate ? ' on' : ''}" data-quick="${key}" ${ok ? '' : 'disabled'}>${label}</button>`;
    };
    el.innerHTML = `<span class="qlabel">Quick pick</span>`
        + chip('today', 'Today', q.today)
        + chip('tomorrow', 'Tomorrow', q.tomorrow)
        + chip('weekend', 'This weekend', q.weekend)
        + `<button type="button" class="qchip next" data-quick="next">Next available</button>`;
}

async function pickQuick(kind) {
    if (isBlocked())
        return toast(blockMessage());
    const q = quickDates(), si = state.selStudio;
    let ds = q[kind];
    if (kind === 'next') {
        await loadBusy(si, q.first, q.last);
        ds = q.first;
        while (ds <= q.last && dayIsFull(si, ds))
            ds = nextDay(ds);
        if (ds > q.last)
            return toast('This studio is fully booked for the next 4 weeks. Please try another studio.');
        toast(`Next available day: ${longDate(ds)}.`);
    }
    if (!ds || ds < q.first || ds > q.last)
        return;
    state.selDate = ds;
    state.calMonth = new Date(ds + 'T00:00');
    state.calMonth.setDate(1);
    await refreshBook();
}

let lastDay = null;      // the calendar day that was selected on the last draw
let lastPicked = null;   // the studio card that was selected on the last draw

function renderBook() {
    if (state.selDate < firstBookableDate())
        state.selDate = firstBookableDate();   // the page was left open past closing time
    // the red border "draws itself" only on the card that was just clicked, not every time the page redraws (e.g. a date click)
    const drawIdx = lastPicked !== null && lastPicked !== state.selStudio ? state.selStudio : -1;
    lastPicked = state.selStudio;
    $('#cs').innerHTML = STUDIOS.map((s, i) => `
    <div class="card pick ${i === state.selStudio ? 'sel' : ''}${i === drawIdx ? ' draw' : ''}" data-i="${i}">
      <svg class="pk-b" aria-hidden="true" focusable="false"><rect pathLength="1"></rect><rect class="m" pathLength="1"></rect></svg>
      ${studioThumb(s)}
      <div class="row"><h3>Studio ${s.id}</h3>${badge(s.status)}</div>
      ${descHTML(s.desc)}
      ${cachedAvailLine(i)}
      <p style="margin-top:6px"><b>${peso(s.rate)}</b> <span class="mut">per hour</span></p>
    </div>`).join('');

    fillAvailLines($('#cs'));

    const y = state.calMonth.getFullYear(), m = state.calMonth.getMonth();
    const firstWeekday = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    $('#cal-t').textContent = state.calMonth.toLocaleDateString('en-US', {
        month: 'long',
        year: 'numeric'
    }) + ', Studio '
        + STUDIOS[state.selStudio].id;

    let html = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => `<small class="mut">${d}</small>`).join('')
        + '<span></span>'.repeat(firstWeekday);
    for (let d = 1; d <= daysInMonth; d++) {
        const ds = `${y}-${pad(m + 1)}-${pad(d)}`;
        const n = takenSlots(state.selStudio, ds).size;
        // the selected day keeps its red (fully booked) or shaded (partly booked) background; 'sel' only adds the outline
        const cls = [dayIsFull(state.selStudio, ds) ? 'full' : n ? 'part' : '', ds === state.selDate ? 'sel' : ''].join(' ').trim();
        const isSel = ds === state.selDate;
        const draw = isSel && lastDay !== null && lastDay !== state.selDate ? ' draw' : '';   // the border draws itself only on a day that was just clicked
        const border = isSel ? '<svg class="pk-b" aria-hidden="true" focusable="false"><rect pathLength="1"></rect><rect class="m" pathLength="1"></rect></svg>' : '';
        html += `<button class="cd ${cls}${draw}" data-d="${ds}" ${ds < firstBookableDate() || ds > lastBookableDate() ? 'disabled' : ''}>${border}${d}<i>${n ? n + 'h' : ''}</i></button>`;
    }
    $('#cal').innerHTML = html;
    lastDay = state.selDate;

    // phone room switcher inside the calendar card (css/mobile.css shows it on phones only)
    const rooms = $('#cal-rooms');
    if (rooms) {
        rooms.style.setProperty('--n', STUDIOS.length || 4);
        rooms.innerHTML = STUDIOS.map((s, i) => `
      <button type="button" class="rm${i === state.selStudio ? ' on' : ''}${isClosed(s) ? ' closed' : ''}" data-room="${i}" aria-pressed="${i === state.selStudio}">
        <b>Studio ${esc(s.id)}</b><small>${isClosed(s) ? 'Closed' : esc(peso(s.rate)) + '/h'}</small>
      </button>`).join('');
    }
    renderQuick();

    const occupied = [...takenSlots(state.selStudio, state.selDate)].sort((a, b) => a - b);
    $('#cal-date').textContent = longDate(state.selDate);
    $('#dayocc').innerHTML = occupied.length
        ? `<p class="cal-sub">Occupied times</p><div class="occ-chips">${occupied.map(i => `<span>${SLOTS[i]}</span>`).join('')}</div>`
        : '<p class="cal-sub">No occupied times. The whole day is open.</p>';

    const est = $('#bk-est');
    if (est)
        est.innerHTML = estimateTable(STUDIOS[state.selStudio].rate);

    const closed = isClosed(STUDIOS[state.selStudio]);
    $('#bk-now').disabled = closed;

    // phone bar: the selected studio, its hourly price and the selected day
    const sel = STUDIOS[state.selStudio];
    $('#sb-studio').textContent = `Studio ${sel.id}`;
    $('#sb-sub').textContent = `${peso(sel.rate)} per hour \u00b7 ${longDate(state.selDate)}`;
    $('#bk-now-m').disabled = closed;
}

/* Load the month's taken hours from the database, then draw the calendar. */
export async function refreshBook() {
    const y = state.calMonth.getFullYear(), m = state.calMonth.getMonth();
    await loadBusy(state.selStudio, `${y}-${pad(m + 1)}-01`, `${y}-${pad(m + 1)}-${pad(new Date(y, m + 1, 0).getDate())}`);
    renderBook();
}

export function initBookTab() {
    $('#c-book').addEventListener('click', e => {
        const pick = e.target.closest('.pick'), day = e.target.closest('.cd'), room = e.target.closest('[data-room]');
        const quick = e.target.closest('[data-quick]');
        if (quick)
            return pickQuick(quick.dataset.quick);
        if (pick)
            state.selStudio = +pick.dataset.i;
        else if (room)
            state.selStudio = +room.dataset.room;   // same as tapping a room card, without scrolling back up
        else if (day)
            state.selDate = day.dataset.d;
        else if (e.target.closest('#cal-p'))
            state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() - 1, 1);
        else if (e.target.closest('#cal-n'))
            state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + 1, 1);
        else if (e.target.closest('#bk-now, #bk-now-m'))
            return bookNow();
        else
            return;
        (day ? renderBook : refreshBook)();
    });
}

/* ---- success pop-up: stays open until the customer presses Done (no timer) ---- */
export const okDlg = $('#okdlg');
