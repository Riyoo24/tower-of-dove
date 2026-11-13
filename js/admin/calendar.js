/* =====================================================================
   admin/calendar.js - Calendar tab (owner and staff): every room on one grid.
   Day view  : hours down the side, one column per studio, a block for each booking. Free time is the empty space.
   Week view : one row per studio, one column per day, each cell a strip of the 12 open hours (free hours stay blank).
   Click a block for its details, or a day in the week view to open that day.
   ===================================================================== */

import { BK, STU } from './data.js';
import { bkStatus, money, num, showDlg } from './helpers.js';
import { spanOf } from './analytics.js';
import { printSection } from './export.js';
import { $, TODAY, badge, esc, longDate, manilaParts, shortDate } from '../shared/utils.js';

const OPEN = 10, CLOSE = 22, ROW = 52;   // first hour, closing hour, pixels per hour in the day view
const HOURS = Array.from({ length: CLOSE - OPEN }, (_, i) => OPEN + i);
const SHOWN = ['Pending', 'Approved', 'In Progress', 'Completed'];   // cancelled and rejected bookings free the room
const KIND = { 'Pending': 'pend', 'Approved': 'conf', 'In Progress': 'live', 'Completed': 'done' };

let view = 'day', day = TODAY;

const addDays = (iso, n) => {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
};
const mondayOf = iso => addDays(iso, -((new Date(iso + 'T00:00:00Z').getUTCDay() + 6) % 7));
const hourLabel = h => (h % 12 || 12) + (h < 12 ? ' AM' : ' PM');
const timeRange = s => {
    const e = s.hour + s.len;
    return `${hourLabel(s.hour)} to ${hourLabel(e % 24)}`;
};

/* bookings that use a room, with their place in the day */
function spans() {
    return BK.filter(b => SHOWN.includes(b.status)).map(b => ({ b, ...spanOf(b) }));
}

/* free hours of a studio on one day */
function bookedHours(list, studioId, d) {
    const used = new Set();
    list.filter(s => s.b.studio_id === studioId && s.day === d).forEach(s => {
        for (let h = s.hour; h < s.hour + s.len; h++)
            if (h >= OPEN && h < CLOSE)
                used.add(h);
    });
    return used.size;
}

const legend = `<div class="cal-legend" aria-label="Colour key">
  <span><i class="k-pend"></i>Pending</span><span><i class="k-conf"></i>Confirmed</span><span><i class="k-live"></i>In session</span><span><i class="k-done"></i>Completed</span><span><i class="k-free"></i>Free</span></div>`;

function toolbar() {
    const span = view === 'day' ? longDate(day) : `${shortDate(mondayOf(day))} to ${shortDate(addDays(mondayOf(day), 6))}`;
    return `<div class="cal-bar no-print">
      <div class="cal-nav">
        <button class="btn sm line" data-cal="prev" aria-label="Previous ${view}">&#8249;</button>
        <button class="btn sm line" data-cal="today">Today</button>
        <button class="btn sm line" data-cal="next" aria-label="Next ${view}">&#8250;</button>
        <input type="date" id="cal-date" value="${day}" aria-label="Jump to date">
      </div>
      <div class="tabs" style="margin:0"><button data-cal-view="day" class="${view === 'day' ? 'on' : ''}">Day</button><button data-cal-view="week" class="${view === 'week' ? 'on' : ''}">Week</button></div>
      <button class="btn sm line" data-cal="print" title="Opens the print window. Choose Save as PDF as the printer.">Print / PDF</button>
    </div>
    <div class="row cal-title" style="justify-content:flex-start;gap:14px"><h2>${esc(span)}</h2>${legend}</div>`;
}

function dayView(list) {
    if (!STU.length)
        return '<div class="card"><p class="mut">No studios yet.</p></div>';
    const today = day === TODAY;
    const now = manilaParts(new Date());
    const nowTop = today && now.hour >= OPEN && now.hour < CLOSE ? (now.hour - OPEN + now.minute / 60) * ROW : null;
    const cols = STU.map(s => {
        const mine = list.filter(x => x.b.studio_id === s.studio_id && x.day === day);
        const used = bookedHours(list, s.studio_id, day);
        const off = s.status !== 'Available';
        const blocks = mine.map(x => {
            const top = Math.max(0, (x.hour + x.min / 60 - OPEN)) * ROW, h = Math.max(24, Math.min(x.len, CLOSE - x.hour) * ROW);
            return `<button type="button" class="cal-b k-${KIND[x.b.status]}" style="top:${top}px;height:${h - 2}px" data-ref="${esc(x.b.booking_ref)}" aria-label="${esc(x.b.customer_name)}, ${esc(timeRange(x))}, ${esc(bkStatus(x.b.status))}">
              <b>${esc(x.b.customer_name)}</b><span>${esc(timeRange(x))}</span>${x.len > 1 ? `<small>${esc(x.b.booking_ref)}</small>` : ''}</button>`;
        }).join('');
        return `<div class="cal-col${off ? ' off' : ''}">
          <div class="cal-colh"><b>${esc(s.name)}</b><span>${off ? esc(s.status) : `${used} of ${HOURS.length} h booked`}</span></div>
          <div class="cal-plot" style="height:${HOURS.length * ROW}px">${blocks}${nowTop !== null ? `<i class="cal-now" style="top:${nowTop}px"></i>` : ''}</div></div>`;
    }).join('');
    return `<div class="tw cal-scroll"><div class="cal-day" style="--n:${STU.length};--row:${ROW}px">
      <div class="cal-time"><div class="cal-colh" aria-hidden="true"><b>&nbsp;</b><span>&nbsp;</span></div><div class="cal-hours">${HOURS.map(h => `<span style="height:${ROW}px">${hourLabel(h)}</span>`).join('')}</div></div>
      ${cols}</div></div>`;
}

function weekView(list) {
    const mon = mondayOf(day), dates = Array.from({ length: 7 }, (_, i) => addDays(mon, i));
    const head = dates.map(d => `<button type="button" class="cal-wh${d === TODAY ? ' today' : ''}" data-day="${d}"><b>${new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })}</b><span>${shortDate(d)}</span></button>`).join('');
    const rows = STU.map(s => {
        const cells = dates.map(d => {
            const mine = list.filter(x => x.b.studio_id === s.studio_id && x.day === d);
            const strip = HOURS.map(h => {
                const hit = mine.find(x => h >= x.hour && h < x.hour + x.len);
                return `<i class="${hit ? 'k-' + KIND[hit.b.status] : 'k-free'}"></i>`;
            }).join('');
            const used = bookedHours(list, s.studio_id, d);
            const tip = `${s.name}, ${shortDate(d)}: ${used} of ${HOURS.length} hours booked, ${mine.length} booking${mine.length === 1 ? '' : 's'}`;
            return `<button type="button" class="cal-wc${d === TODAY ? ' today' : ''}" data-day="${d}" title="${esc(tip)}" aria-label="${esc(tip)}"><span class="cal-strip">${strip}</span><small>${used ? `${used} h` : 'Free'}</small></button>`;
        }).join('');
        return `<div class="cal-wn"><b>${esc(s.name)}</b>${s.status !== 'Available' ? badge(s.status) : ''}</div>${cells}`;
    }).join('');
    /* phone layout: days run down the page and the studios across, so a whole week fits without sideways scrolling */
    const mrows = dates.map(d => {
        const cells = STU.map(s => {
            const mine = list.filter(x => x.b.studio_id === s.studio_id && x.day === d);
            const strip = HOURS.map(h => {
                const hit = mine.find(x => h >= x.hour && h < x.hour + x.len);
                return `<i class="${hit ? 'k-' + KIND[hit.b.status] : 'k-free'}"></i>`;
            }).join('');
            const used = bookedHours(list, s.studio_id, d);
            const tip = `${s.name}, ${shortDate(d)}: ${used} of ${HOURS.length} hours booked`;
            return `<button type="button" class="cal-wc" data-day="${d}" aria-label="${esc(tip)}"><span class="cal-strip">${strip}</span><small>${used ? `${used} h` : 'Free'}</small></button>`;
        }).join('');
        return `<button type="button" class="cal-wh${d === TODAY ? ' today' : ''}" data-day="${d}"><b>${new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })}</b><span>${shortDate(d)}</span></button>${cells}`;
    }).join('');
    const mhead = `<span></span>${STU.map(s => `<b class="cal-mn">${esc(s.name.replace(/^Studio\s+/i, 'Studio '))}${s.status !== 'Available' ? `<small>${esc(s.status)}</small>` : ''}</b>`).join('')}`;
    return `<div class="tw cal-scroll cal-wide"><div class="cal-week"><div class="cal-wcorner"></div>${head}${rows}</div></div>
      <div class="cal-wm" style="--n:${STU.length}">${mhead}${mrows}</div>
      <p class="mut" style="margin-top:8px">Each cell shows the 12 open hours, 10 AM to 10 PM, left to right. Click a day to see who is booked.</p>`;
}

export function renderCalendar() {
    const host = $('#cal');
    if (!host)
        return;
    const list = spans();
    host.innerHTML = `<div class="print-head rp-head" aria-hidden="true"><b>Tower of Dove Music Studio</b><span>Room calendar &middot; ${esc(view === 'day' ? longDate(day) : 'week of ' + shortDate(mondayOf(day)))}</span></div>`
        + toolbar() + (view === 'day' ? dayView(list) : weekView(list));
}

/* a booking that is on the Studio Sessions tab: running now, or confirmed and its start time has come */
const inSessions = b => b.status === 'In Progress'
    || (b.status === 'Approved' && new Date(b.start_at) <= Date.now() && new Date(b.end_at) > Date.now());

function openBooking(ref) {
    const b = BK.find(x => x.booking_ref === ref);
    if (!b)
        return;
    const s = spanOf(b), live = inSessions(b);
    showDlg(`<h2>${esc(b.customer_name)}</h2>
      <dl class="dl" style="margin-top:10px">
        <dt>Reference</dt><dd>${esc(b.booking_ref)}</dd>
        <dt>Studio</dt><dd>${esc(b.studio_name)}</dd>
        <dt>Date</dt><dd>${esc(longDate(s.day))}</dd>
        <dt>Time</dt><dd>${esc(timeRange(s))} (${s.len} hour${s.len === 1 ? '' : 's'})</dd>
        <dt>Status</dt><dd>${badge(bkStatus(b.status))}</dd>
        <dt>Total</dt><dd>${money(b.total_amount)}</dd>
        ${num(b.balance_due) > 0 ? `<dt>Balance due</dt><dd>${money(b.balance_due)}</dd>` : ''}
        <dt>Booked</dt><dd>${esc(b.source === 'Onsite' ? 'At the studio' : 'Online')}</dd>
      </dl>
      <div class="acts"><button class="btn line" data-close>Close</button><button class="btn gold" id="cal-open">${live ? 'Open in Studio Sessions' : 'Open in Bookings'}</button></div>`);
    $('#cal-open').onclick = () => {
        $('#rdlg').close();
        location.hash = live ? 'a-sess' : 'a-book';
    };
}

$('#a-cal').addEventListener('click', e => {
    const t = e.target.closest('button');
    if (!t)
        return;
    if (t.dataset.ref)
        return openBooking(t.dataset.ref);
    if (t.dataset.day) {
        day = t.dataset.day;
        view = 'day';
    } else if (t.dataset.calView)
        view = t.dataset.calView;
    else if (t.dataset.cal === 'today')
        day = TODAY;
    else if (t.dataset.cal === 'prev')
        day = addDays(day, view === 'day' ? -1 : -7);
    else if (t.dataset.cal === 'next')
        day = addDays(day, view === 'day' ? 1 : 7);
    else if (t.dataset.cal === 'print')
        return printSection($('#a-cal'));
    else
        return;
    renderCalendar();
});

$('#a-cal').addEventListener('change', e => {
    if (e.target.id === 'cal-date' && e.target.value) {
        day = e.target.value;
        renderCalendar();
    }
});

/* ← → move the day (or week) while the grid has focus on the page, not in a form field */
document.addEventListener('keydown', e => {
    if (location.hash !== '#a-cal' || e.target.closest('input, select, textarea, dialog') || e.altKey || e.ctrlKey || e.metaKey)
        return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        day = addDays(day, (e.key === 'ArrowLeft' ? -1 : 1) * (view === 'day' ? 1 : 7));
        renderCalendar();
    }
});
