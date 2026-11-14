/* =====================================================================
   admin/calendar.js - Calendar tab (owner and staff): two functions on one page.
   Rooms     : every studio on one grid.
     Day view  : hours down the side, one column per studio, a block for each booking. Free time is the empty space.
     Week view : one row per studio, one column per day, each cell a strip of the 12 open hours (free hours stay blank).
     Click a block for its details, or a day in the week view to open that day.
   Equipment : which items are still free (day: each hour, week: each day), and the outside rentals that are out.
     The equipment side is drawn by equipCalendar.js; this file keeps the toolbar, Day / Week and the clicks for both.
   ===================================================================== */

import { BK, STU } from './data.js';
import { equipLegend, equipView, openEquipCell, openRental } from './equipCalendar.js';
import { bkStatus, money, num, showDlg } from './helpers.js';
import { spanOf } from './analytics.js';
import { startBooking } from './onsite.js';
import { printSection } from './export.js';
import { $, TODAY, badge, esc, longDate, manilaParts, shortDate } from '../shared/utils.js';

const OPEN = 10, CLOSE = 22, ROW = 52;   // first hour, closing hour, pixels per hour in the day view
const HOURS = Array.from({ length: CLOSE - OPEN }, (_, i) => OPEN + i);
const SHOWN = ['Pending', 'Approved', 'In Progress', 'Completed'];   // cancelled and rejected bookings free the room
const KIND = { 'Pending': 'pend', 'Approved': 'conf', 'In Progress': 'live', 'Completed': 'done' };

let view = 'day', day = TODAY, mode = 'rooms', eqCat = 'All';   // mode: 'rooms' | 'equipment'
let pick = null, eqPick = null, ghost = null;   // a click or drag in progress: room hours / equipment cells / the dashed preview block

const oneDay = () => view === 'day';   // Day and Week work the same way in Rooms and in Equipment

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
    const span = oneDay() ? longDate(day) : `${shortDate(mondayOf(day))} to ${shortDate(addDays(mondayOf(day), 6))}`;
    return `<div class="cal-bar no-print">
      <div class="cal-nav">
        <button class="btn sm line" data-cal="prev" aria-label="Previous ${oneDay() ? 'day' : 'week'}">&#8249;</button>
        <button class="btn sm line" data-cal="today">Today</button>
        <button class="btn sm line" data-cal="next" aria-label="Next ${oneDay() ? 'day' : 'week'}">&#8250;</button>
        <input type="date" id="cal-date" value="${day}" aria-label="Jump to date">
      </div>
      <div class="tabs" style="margin:0" aria-label="Calendar type"><button data-cal-mode="rooms" class="${mode === 'rooms' ? 'on' : ''}">Rooms</button><button data-cal-mode="equipment" class="${mode === 'equipment' ? 'on' : ''}">Equipment</button></div>
      <div class="tabs" style="margin:0"><button data-cal-view="day" class="${view === 'day' ? 'on' : ''}">Day</button><button data-cal-view="week" class="${view === 'week' ? 'on' : ''}">Week</button></div>
      <button class="btn sm line" data-cal="print" title="Opens the print window. Choose Save as PDF as the printer.">Print / PDF</button>
    </div>
    <div class="row cal-title" style="justify-content:flex-start;gap:14px"><h2>${esc(span)}</h2>${mode === 'rooms' ? legend : equipLegend}</div>`;
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
        return `<div class="cal-col${off ? ' off' : ''}" data-sid="${esc(s.studio_id)}">
          <div class="cal-colh"><b>${esc(s.name)}</b><span>${off ? esc(s.status) : `${used} of ${HOURS.length} h booked`}</span></div>
          <div class="cal-plot${off ? '' : ' can-book'}" style="height:${HOURS.length * ROW}px">${blocks}${nowTop !== null ? `<i class="cal-now" style="top:${nowTop}px"></i>` : ''}</div></div>`;
    }).join('');
    return `<p class="mut no-print" style="margin:0 0 8px">Tip: click or drag across an empty time to start an onsite booking.</p>
      <div class="tw cal-scroll"><div class="cal-day" style="--n:${STU.length};--row:${ROW}px">
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
    if (!host || pick || eqPick)   // a drag is in progress: the 15 second refresh must not wipe it
        return;
    const list = mode === 'rooms' ? spans() : [];
    host.innerHTML = `<div class="print-head rp-head" aria-hidden="true"><b>Tower of Dove Music Studio</b><span>Calendar, ${mode === 'rooms' ? 'rooms' : 'equipment'} &middot; ${esc(oneDay() ? longDate(day) : 'week of ' + shortDate(mondayOf(day)))}</span></div>`
        + toolbar() + (mode === 'equipment'
            ? equipView({ view, day, dates: Array.from({ length: 7 }, (_, i) => addDays(mondayOf(day), i)), cat: eqCat, today: TODAY })
            : view === 'day' ? dayView(list) : weekView(list));
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
    if (t.dataset.eid)
        return openEquipCell(t.dataset.eid, t.dataset.from, t.dataset.to);
    if (t.dataset.rn)
        return openRental(t.dataset.rn);
    if (t.dataset.calMode) {
        mode = t.dataset.calMode;
    } else if (t.dataset.day) {
        day = t.dataset.day;
        view = 'day';
    } else if (t.dataset.calView)
        view = t.dataset.calView;
    else if (t.dataset.cal === 'today')
        day = TODAY;
    else if (t.dataset.cal === 'prev')
        day = addDays(day, oneDay() ? -1 : -7);
    else if (t.dataset.cal === 'next')
        day = addDays(day, oneDay() ? 1 : 7);
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
    } else if (e.target.dataset.eqCatSel !== undefined) {
        eqCat = e.target.value;
        renderCalendar();
    }
});

/* ← → move the day (or week) while the grid has focus on the page, not in a form field */
document.addEventListener('keydown', e => {
    if (location.hash !== '#a-cal' || e.target.closest('input, select, textarea, dialog') || e.altKey || e.ctrlKey || e.metaKey)
        return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        day = addDays(day, (e.key === 'ArrowLeft' ? -1 : 1) * (oneDay() ? 1 : 7));
        renderCalendar();
    }
});

/* ---------- click or drag a free stretch to start an onsite booking (rooms) or pick hours (equipment) ---------- */

const BOOK_CLOSE = 21;   // same rule as the Onsite booking form: nothing more can be booked for today from 9 PM
function blockedHour(d, h) {
    if (d < TODAY)
        return true;
    if (d > TODAY)
        return false;
    const p = manilaParts(new Date()), m = p.hour * 60 + p.minute;
    return m >= BOOK_CLOSE * 60 || h * 60 < m;
}

/* hours of a studio that already have a booking on that day */
function usedHours(studioId, d) {
    const used = new Set();
    spans().filter(x => x.b.studio_id === studioId && x.day === d).forEach(x => {
        for (let h = x.hour; h < x.hour + x.min / 60 + x.len; h++)
            used.add(h);
    });
    return used;
}

const studioOf = plot => STU.find(s => String(s.studio_id) === plot.closest('.cal-col').dataset.sid);
const hourAt = (plot, e) => OPEN + Math.max(0, Math.min(HOURS.length - 1, Math.floor((e.clientY - plot.getBoundingClientRect().top) / ROW)));
const hideGhost = () => {
    if (ghost)
        ghost.remove();
    ghost = null;
};

function showGhost(plot, lo, hi, text) {
    if (!ghost || ghost.parentNode !== plot) {
        hideGhost();
        ghost = document.createElement('i');
        ghost.className = 'cal-ghost';
        plot.appendChild(ghost);
    }
    ghost.style.top = (lo - OPEN) * ROW + 1 + 'px';
    ghost.style.height = (hi - lo + 1) * ROW - 3 + 'px';
    ghost.textContent = text;
}

const pickText = () => `${hourLabel(pick.lo)} to ${hourLabel(pick.hi + 1)} (${pick.hi - pick.lo + 1} h)`;
let hoverAt = '';

$('#a-cal').addEventListener('pointerdown', e => {
    if (e.button !== 0)
        return;
    if (mode === 'equipment' && view === 'day' && e.pointerType !== 'touch') {
        const c = e.target.closest('.ec-c[data-eid]');
        if (c && !c.disabled)
            eqPick = { eid: c.dataset.eid, a: c, b: c, id: e.pointerId, moved: false };
        return;
    }
    const plot = e.target.closest('.cal-plot.can-book');
    if (mode !== 'rooms' || view !== 'day' || !plot || e.target !== plot)   // a booking block keeps its own click
        return;
    const s = studioOf(plot), used = usedHours(s.studio_id, day), h = hourAt(plot, e);
    if (used.has(h) || blockedHour(day, h))
        return;
    pick = { plot, s, used, anchor: h, lo: h, hi: h, id: e.pointerId, touch: e.pointerType === 'touch', x: e.clientX, y: e.clientY };
    if (!pick.touch && plot.setPointerCapture)
        plot.setPointerCapture(e.pointerId);
    showGhost(plot, h, h, pickText());
});

$('#a-cal').addEventListener('pointermove', e => {
    if (eqPick && e.pointerId === eqPick.id) {
        const el = document.elementFromPoint(e.clientX, e.clientY), c = el && el.closest('.ec-c[data-eid]');
        if (c && !c.disabled && c.dataset.eid === eqPick.eid && c !== eqPick.b) {
            eqPick.b = c;
            eqPick.moved = true;
            const row = [...$('#a-cal').querySelectorAll('.ec-c[data-eid]')].filter(x => x.dataset.eid === eqPick.eid);
            const i = row.indexOf(eqPick.a), j = row.indexOf(c);
            row.forEach((x, k) => x.classList.toggle('ec-pick', k >= Math.min(i, j) && k <= Math.max(i, j)));
        }
        return;
    }
    if (pick) {
        if (pick.touch || e.pointerId !== pick.id)
            return;
        const h = hourAt(pick.plot, e), busy = i => pick.used.has(i) || blockedHour(day, i);
        pick.lo = pick.hi = pick.anchor;
        if (h > pick.anchor) {
            for (let i = pick.anchor + 1; i <= h && !busy(i); i++)
                pick.hi = i;
        } else {
            for (let i = pick.anchor - 1; i >= h && !busy(i); i--)
                pick.lo = i;
        }
        showGhost(pick.plot, pick.lo, pick.hi, pickText());
        return;
    }
    /* no button held: show where a click would book */
    const plot = mode === 'rooms' && view === 'day' && e.pointerType === 'mouse' ? e.target.closest('.cal-plot.can-book') : null;
    if (!plot || e.target !== plot) {
        hoverAt = '';
        return hideGhost();
    }
    const s = studioOf(plot), h = hourAt(plot, e), key = s.studio_id + '|' + h + '|' + day;
    if (key === hoverAt)
        return;
    hoverAt = key;
    if (usedHours(s.studio_id, day).has(h) || blockedHour(day, h))
        return hideGhost();
    showGhost(plot, h, h, '+ Book ' + hourLabel(h));
});

$('#a-cal').addEventListener('pointerleave', () => {
    hoverAt = '';
    if (!pick)
        hideGhost();
});

$('#a-cal').addEventListener('pointerup', e => {
    if (eqPick && e.pointerId === eqPick.id) {
        const p = eqPick;
        eqPick = null;
        $('#a-cal').querySelectorAll('.ec-pick').forEach(c => c.classList.remove('ec-pick'));
        if (p.moved && p.a !== p.b)   // dragged over several hours: open the window for the whole stretch
            openEquipCell(p.eid, Math.min(+p.a.dataset.from, +p.b.dataset.from), Math.max(+p.a.dataset.to, +p.b.dataset.to), true);
        return;
    }
    if (!pick || e.pointerId !== pick.id)
        return;
    const p = pick;
    pick = null;
    hideGhost();
    if (p.touch && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10)   // a finger that moved was scrolling
        return;
    startBooking({ studioId: p.s.studio_id, studioName: p.s.name, date: day, hour: p.lo, hours: p.hi - p.lo + 1 });
});

function cancelPick() {
    pick = null;
    eqPick = null;
    hideGhost();
    $('#a-cal').querySelectorAll('.ec-pick').forEach(c => c.classList.remove('ec-pick'));
}
$('#a-cal').addEventListener('pointercancel', cancelPick);
document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && (pick || eqPick))
        cancelPick();
});
document.addEventListener('pointerup', () => {   // let go outside the calendar: drop the half-made selection
    if (pick || eqPick)
        cancelPick();
});