/* =====================================================================
   admin/equipCalendar.js - the "Equipment" side of the Calendar tab (owner and staff)
   One question: "Is it free, and if not, who has it?"
   Two views, picked with the "Show" box above the grid (the choice is kept by calendar.js):
     Availability (default): colour = how many units are still free.
                 blank = every unit is free, a number = that many are still free, Full = none left,
                 Over = more is reserved than the studio owns (needs fixing).
     Status      : colour = the stage of the rental that holds the item. Free hours stay blank.
                 Pending (waiting for approval), Verified (approved, not issued yet), In use (issued), Late (still out past its return time).
                 The number in a cell is how many units are held. When several rentals hold the item in the same hour,
                 the cell takes the most urgent stage (Late, then In use, then Verified, then Pending); the tooltip lists them all.
   Day view  : a grid, one row per item and one cell per open hour (10 AM to 10 PM), like the room calendar.
                 Click a cell to see who has the item in that hour.
   Week view : the same grid with one cell per item and day. A cell shows the tightest hour of that day, in words
                 (Availability: blank = free all day, "2 left", "None left", "Over"; Status: the most urgent stage of the day).
                 Click a day to open its hourly grid.
   Click or drag across free hours of an item to start an outside rental, or an add-on for a booking that is running then
   (the Onsite rental form opens with the item and hours filled in).
   Under both: "Out of the studio", the outside rentals that are out in the period shown, late ones first.
   Nothing here talks to the database: it is worked out from the rental lines (RL), bookings (BK) and stock (STK)
   the dashboard has already loaded, the same way handoff.js does it.
     - add-on line        : holds the item while its booking runs (booking start to end)
     - outside rental line: holds the item from pick-up to return (or due) time; one still out after its due time
                            is counted up to "now" and marked late
     - returned, rejected and cancelled lines hold nothing
   Requests that are still pending are counted as taken (so staff do not promise the same item twice).
   calendar.js owns the toolbar, the date buttons and the clicks; this file returns HTML and opens two windows.
   ===================================================================== */

import { BK, RL, STK } from './data.js';
import { startRental } from './onsite.js';
import { revealRental } from './rentals.js';
import { dOf, num, showDlg, tOf } from './helpers.js';
import { $, esc, longDate, shortDate } from '../shared/utils.js';

const OPEN = 10, CLOSE = 22;                         // same open hours as the room calendar
const HOURS = Array.from({ length: CLOSE - OPEN }, (_, i) => OPEN + i);
const H = 36e5, D = 864e5;
const DEAD = ['Rejected', 'Cancelled', 'Returned'];  // lines that hold no stock

const hourLabel = h => (h % 12 || 12) + (h < 12 ? ' AM' : ' PM');
const ms = v => {
    const n = v ? new Date(v).getTime() : NaN;
    return Number.isFinite(n) ? n : null;
};
/* start of a Manila calendar day (UTC+8, no daylight saving) */
const dayStart = iso => new Date(iso + 'T00:00:00+08:00').getTime();
const iso = t => new Date(t).toISOString();

/* ---------- who holds which item, and when ---------- */

/* one line -> { s, e, eTrue, late } in milliseconds, or null when the line holds nothing */
function lineSpan(l, now) {
    if (l.line_returned_at || DEAD.includes(l.status))
        return null;
    if (l.rental_type === 'Add-on') {
        const b = BK.find(x => x.booking_ref === l.booking_ref);
        if (!b || ['Cancelled', 'Rejected'].includes(b.status))
            return null;
        const s = ms(b.start_at), e = ms(b.end_at);
        return s == null || e == null ? null : { s, e, eTrue: e, late: false };
    }
    const s = ms(l.pickup_date);
    let e = ms(l.return_date) ?? ms(l.due_at);
    if (e == null && s != null && num(l.rental_hours) > 0)
        e = s + num(l.rental_hours) * H;
    if (s == null || e == null)
        return null;
    const late = l.status === 'Active' && e < now;
    return { s, e: late ? now : e, eTrue: e, late };
}

/* every holding line, grouped by equipment id */
function usesByItem() {
    const now = Date.now(), by = new Map();
    RL.forEach(l => {
        const sp = lineSpan(l, now);
        if (!sp)
            return;
        const k = String(l.equipment_id);
        if (!by.has(k))
            by.set(k, []);
        by.get(k).push({ l, ...sp });
    });
    return by;
}

/* The stage of a holding line, as a number (a bigger number is more urgent):
   1 = Pending (waiting for approval), 2 = Verified (approved, not issued yet), 3 = In use (issued), 4 = Late (still out past its return time) */
const rankOf = u => u.late ? 4 : u.l.status === 'Active' ? 3 : u.l.status === 'Approved' ? 2 : 1;
const RANK = ['', 'pend', 'conf', 'live', 'late'];            // the class name part of each stage
const ST_WORD = ['', 'Pending', 'Verified', 'In use', 'Late']; // shown in the week view
const ST_NAME = ['', 'pending', 'verified', 'in use', 'late'];  // used in tooltips

/* units taken between two moments, how many of them wait for approval, whether one is late,
   the most urgent stage (top) and how many units are in each stage (by[1..4]) */
function loadOf(uses, from, to) {
    let n = 0, pend = 0, late = false, top = 0;
    const by = [0, 0, 0, 0, 0];
    uses.forEach(u => {
        if (u.s < to && u.e > from) {
            const q = num(u.l.quantity), r = rankOf(u);
            n += q;
            by[r] += q;
            if (u.l.status === 'Pending')
                pend += q;
            if (u.late)
                late = true;
            if (r > top)
                top = r;
        }
    });
    return { n, pend, late, top, by };
}

const emptyLoad = () => ({ n: 0, pend: 0, late: false, top: 0, by: [0, 0, 0, 0, 0] });
const statusTip = x => x.by.map((q, i) => q ? `${q} ${ST_NAME[i]}` : '').filter(Boolean).join(', ');

const kindOf = (n, total) => !n ? 'free' : n > total ? 'bad' : n >= total ? 'full' : 'some';

/* ---------- the view ---------- */

const catNames = () => [...new Set(STK.map(c => c.category_name).filter(Boolean))].sort((a, b) => a.localeCompare(b));
const bySort = (a, b) => (num(a.sort_order) - num(b.sort_order)) || String(a.name).localeCompare(String(b.name));

/* the colour key under the title: it follows the "Show" box (show = 'avail' | 'status') */
export const equipLegend = (show = 'avail') => show === 'status'
    ? `<div class="cal-legend" aria-label="Colour key">
  <span><i class="k-pend"></i>Pending</span><span><i class="k-conf"></i>Verified</span><span><i class="k-live"></i>In use</span><span><i class="ec-k-bad"></i>Late</span><span><i class="k-free"></i>Not held</span></div>`
    : `<div class="cal-legend" aria-label="Colour key">
  <span><i class="ec-k-free"></i>All free</span><span><i class="ec-k-some"></i>Some left</span><span><i class="ec-k-full"></i>None left</span><span><i class="ec-k-bad"></i>Over-reserved or late</span></div>`;

function tools(cat, view, show) {
    const names = catNames();
    const help = show === 'status'
        ? (view === 'day'
            ? 'The colour is the stage of the rental that holds the item, and the number is how many units are held. Blank means nobody has it. Click an hour to see who. Drag across free hours to rent the item out.'
            : 'Each cell shows the most urgent stage of that day. Blank means nobody has it. Click a day to see the hours.')
        : (view === 'day'
            ? 'Blank means every unit is free. A number is how many are still free. Click an hour to see who has it. Drag across free hours to rent the item out.'
            : 'Each cell shows the tightest hour of that day. Blank means free all day. Click a day to see the hours.');
    return `<div class="ec-tools no-print">
      <p class="mut ec-help">${help}</p>
      <select data-eq-show-sel aria-label="Show on the grid"><option value="avail"${show === 'avail' ? ' selected' : ''}>Show: Availability</option><option value="status"${show === 'status' ? ' selected' : ''}>Show: Status</option></select>
      ${names.length > 1 ? `<select data-eq-cat-sel aria-label="Show equipment from"><option value="All"${cat === 'All' ? ' selected' : ''}>All equipment</option>${names.map(n => `<option value="${esc(n)}"${cat === n ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>` : ''}
    </div>`;
}

/* nowPos = where the red "now" line sits inside this cell, 0 to 1 of its width (null when the current time is not in it);
   span = how many hour columns the cell covers (hours held by the same customer are joined into one cell) */
function cellHtml(c, total, from, to, x, nowPos, label, span = 1, show = 'avail') {
    const free = total - x.n, kind = kindOf(x.n, total), now0 = Date.now(), past = to <= now0 || (from < now0 && !x.n);   // over, or started and empty (nothing to rent in the past); a rental still running stays clickable so it can be opened
    const st = show === 'status';
    const text = st ? (x.n ? String(x.n) : '') : (kind === 'some' ? String(free) : kind === 'full' ? 'Full' : kind === 'bad' ? 'Over' : '');
    const tip = st
        ? `${c.name}, ${label}: ${x.n ? statusTip(x) : 'nobody has it'}${x.n > total ? `, over-reserved by ${x.n - total}` : ''}`
        : `${c.name}, ${label}: ${kind === 'bad' ? `over-reserved by ${x.n - total}` : free === total ? `all ${total} free` : `${free} of ${total} free`}${x.pend ? `, ${x.pend} waiting for approval` : ''}${x.late ? ', one is late and still out' : ''}`;
    const cls = st ? (x.n ? ` ec-s-${RANK[x.top]}` : ' ec-k-free') : ` ec-k-${kind}${x.late ? ' ec-late' : ''}`;
    return `<button type="button" class="ec-c${cls}${nowPos != null ? ' now' : ''}${past ? ' ec-past' : ''}"${past ? ' disabled' : ''}${nowPos != null || span > 1 ? ` style="${span > 1 ? `grid-column:span ${span};` : ''}${nowPos != null ? `--m:${(nowPos * 100).toFixed(1)}%` : ''}"` : ''} data-eid="${esc(c.equipment_id)}" data-from="${from}" data-to="${to}" title="${esc(tip)}" aria-label="${esc(tip)}">${text}</button>`;
}

/* view = 'day' | 'week', day = ISO date, dates = the 7 ISO days of the week, today = today's ISO date, cat = category name or 'All',
   show = 'avail' | 'status' */
export function equipView({ view, day, dates, cat, today, show = 'avail' }) {
    if (!STK.length)
        return '<div class="card"><p class="mut">No equipment yet. Add items in Equipment Management.</p></div>';
    const uses = usesByItem();
    const nowH = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'Asia/Manila' }).format(new Date())) % 24;
    const nowM = Number(new Intl.DateTimeFormat('en-US', { minute: 'numeric', timeZone: 'Asia/Manila' }).format(new Date()));
    const items = STK.filter(c => cat === 'All' || c.category_name === cat).slice().sort(bySort);
    if (view === 'week')
        return weekView(items, uses, dates, cat, today, show);
    const base = dayStart(day), isToday = day === today;
    const head = `<div class="ec-h ec-corner"></div>${HOURS.map(h => `<div class="ec-h${isToday && h === nowH ? ' now' : ''}"${isToday && h === nowH ? ` style="--m:${(nowM / 60 * 100).toFixed(1)}%"` : ''}>${hourLabel(h)}</div>`).join('')}`;
    const body = items.map(c => {
        const total = num(c.total_quantity), u = uses.get(String(c.equipment_id)) || [];
        /* who holds the item in each hour; neighbouring hours held by the same people are joined into one cell */
        const slots = HOURS.map(h => {
            const from = base + h * H, to = from + H;
            const key = u.filter(v => v.s < to && v.e > from).map(v => `${whoRef(v.l)}|${v.l.quantity}|${v.l.status}`).sort().join(',');
            return { h, from, to, key, x: loadOf(u, from, to) };
        });
        let cells = '';
        for (let i = 0; i < slots.length;) {
            let j = i + 1;
            if (slots[i].key)
                while (j < slots.length && slots[j].key === slots[i].key)
                    j++;
            const first = slots[i], last = slots[j - 1], span = j - i;
            const nowAt = isToday ? slots.slice(i, j).findIndex(s => s.h === nowH) : -1;
            const label = span > 1 ? `${hourLabel(first.h)} to ${hourLabel((last.h + 1) % 24)}` : hourLabel(first.h);
            cells += cellHtml(c, total, first.from, last.to, loadOf(u, first.from, last.to), nowAt >= 0 ? (nowAt + nowM / 60) / span : null, label, span, show);
            i = j;
        }
        return `<div class="ec-n"><b>${esc(c.name)}</b><span>${total} in total</span></div>${cells}`;
    }).join('');
    return tools(cat, 'day', show)
        + (items.length ? `<div class="tw cal-scroll"><div class="ec-grid" style="--c:${HOURS.length};--w:46px">${head}${body}</div></div>`
            : '<div class="card"><p class="mut">No equipment in this category.</p></div>')
        + outList(base, base + D, cat, 'Out of the studio on this day', 'Outside rentals that are out, or due back, on this day. Late ones come first.');
}

/* week: one cell per item and day = the tightest hour of that day (Availability) or the most urgent stage of that day (Status), in words */
function weekView(items, uses, dates, cat, today, show) {
    const st = show === 'status';
    const head = `<div class="ec-h ec-corner"></div>${dates.map(d => `<button type="button" class="ec-h ec-hd${d === today ? ' now' : ''}" data-day="${d}" aria-label="${esc('Open ' + longDate(d))}"><b>${esc(new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }))}</b><small>${esc(shortDate(d))}</small></button>`).join('')}`;
    const body = items.map(c => {
        const total = num(c.total_quantity), u = uses.get(String(c.equipment_id)) || [];
        const cells = dates.map(d => {
            const b = dayStart(d);
            let x = emptyLoad();
            HOURS.forEach(h => {
                const y = loadOf(u, b + h * H, b + (h + 1) * H);
                const better = st
                    ? (y.top > x.top || (y.top === x.top && y.n > x.n))
                    : (y.n > x.n || (y.n === x.n && y.late));
                if (better)
                    x = y;
            });
            const kind = kindOf(x.n, total), free = total - x.n;
            let text, tip, cls;
            if (st) {
                text = x.n ? ST_WORD[x.top] : '';
                tip = `${c.name}, ${shortDate(d)}: ${x.n ? statusTip(x) + ' at the busiest hour' : 'nobody has it all day'}`;
                cls = x.n ? ` ec-s-${RANK[x.top]}` : ' ec-k-free';
            } else {
                text = kind === 'some' ? `${free} left` : kind === 'full' ? 'None left' : kind === 'bad' ? 'Over' : '';
                tip = `${c.name}, ${shortDate(d)}: ${kind === 'free' ? `all ${total} free all day` : kind === 'bad' ? `over-reserved by ${x.n - total} at the busiest hour` : `at the busiest hour ${free} of ${total} free`}${x.pend ? `, ${x.pend} waiting for approval` : ''}${x.late ? ', one is late and still out' : ''}`;
                cls = ` ec-k-${kind}${x.late ? ' ec-late' : ''}`;
            }
            return `<button type="button" class="ec-c${cls}${d === today ? ' now' : ''}${d < today ? ' ec-past' : ''}"${d < today ? ' disabled' : ''} data-day="${d}" title="${esc(tip)}" aria-label="${esc(tip + '. Open the day')}">${text}</button>`;
        }).join('');
        return `<div class="ec-n"><b>${esc(c.name)}</b><span>${total} in total</span></div>${cells}`;
    }).join('');
    const wk0 = dayStart(dates[0]);
    return tools(cat, 'week', show)
        + (items.length ? `<div class="tw cal-scroll"><div class="ec-grid" style="--c:7;--w:78px">${head}${body}</div></div>`
            : '<div class="card"><p class="mut">No equipment in this category.</p></div>')
        + outList(wk0, dayStart(dates[6]) + D, cat, 'Out of the studio this week', 'Outside rentals that are out, or due back, this week. Late ones come first.');
}

/* ---------- outside rentals that are out on the chosen day ---------- */

const tagOf = g => g.late ? ['Late', 'bad'] : g.live ? ['Out now', 'ok'] : g.pend ? ['Waiting for approval', 'warn'] : ['Reserved', 'info'];

function outList(d0, d1, cat, title, note) {
    const now = Date.now();
    const inCat = new Set(STK.filter(c => cat === 'All' || c.category_name === cat).map(c => String(c.equipment_id)));
    const groups = new Map();
    RL.forEach(l => {
        if (l.rental_type !== 'Outside' || !inCat.has(String(l.equipment_id)))
            return;
        const sp = lineSpan(l, now);
        if (!sp || sp.s >= d1 || sp.e <= d0)
            return;
        const g = groups.get(l.rental_ref) || { ref: l.rental_ref, who: l.customer_name, lines: [], s: Infinity, e: 0, late: false, live: false, pend: true };
        g.lines.push(l);
        g.s = Math.min(g.s, sp.s);
        g.e = Math.max(g.e, sp.eTrue);
        g.late = g.late || sp.late;
        g.live = g.live || l.status === 'Active';
        g.pend = g.pend && l.status === 'Pending';
        groups.set(l.rental_ref, g);
    });
    const list = [...groups.values()].sort((a, b) => (b.late - a.late) || (a.s - b.s));
    const rows = list.map(g => {
        const [tag, tone] = tagOf(g);
        const items = g.lines.slice(0, 3).map(l => `${l.equipment_name} x${l.quantity}`).join(', ') + (g.lines.length > 3 ? ` and ${g.lines.length - 3} more` : '');
        return `<button type="button" class="ec-or" data-rn="${esc(g.ref)}" aria-label="${esc(`${g.who || 'Customer'}, ${items}, ${tag}. Open the rental`)}">
          <span><b>${esc(g.who || 'Customer')}</b><small>${esc(g.ref)}</small></span>
          <span>${esc(items)}</span>
          <span class="ec-when">Back ${esc(shortDate(dOf(iso(g.e))))}, ${esc(tOf(iso(g.e)))}</span>
          <span class="ec-tag ec-t-${tone}">${esc(tag)}</span></button>`;
    }).join('');
    return `<h3 style="margin:22px 0 4px">${esc(title)}</h3>
      <p class="mut" style="margin:0 0 8px">${esc(note)}</p>`
        + (rows ? `<div class="ec-out">${rows}</div>` : '<div class="card"><p class="mut">No outside rentals in this period.</p></div>');
}

/* the tightest hour inside a stretch of time (a window can cover several hours) */
function peakOf(uses, from, to) {
    let best = emptyLoad();
    for (let t = from; t < to; t += H) {
        const y = loadOf(uses, t, Math.min(to, t + H));
        if (y.n > best.n || (y.n === best.n && y.late))
            best = y;
    }
    return best;
}

/* ---------- windows ---------- */

const when = u => `${esc(shortDate(dOf(iso(u.s))))}, ${esc(tOf(iso(u.s)))} to ${esc(shortDate(dOf(iso(u.eTrue))))}, ${esc(tOf(iso(u.eTrue)))}`;
const whoRef = l => l.rental_type === 'Add-on' && l.booking_ref ? l.booking_ref : l.rental_ref;
const kindLabel = l => l.rental_type === 'Add-on' ? 'with a studio booking' : 'outside rental';

/* a cell of the grid: who has this item in that hour */
/* dragged = the stretch was picked by dragging across hours; only then are the "rent it out" actions offered */
export function openEquipCell(eid, from, to, dragged = false) {
    const c = STK.find(x => String(x.equipment_id) === String(eid));
    if (!c)
        return;
    from = Number(from);
    to = Number(to);
    const all = usesByItem().get(String(eid)) || [];
    const hit = all.filter(u => u.s < to && u.e > from);
    const x = peakOf(all, from, to), t = num(c.total_quantity);
    const free = Math.max(0, t - x.n), live = c.stock_status !== 'Unavailable';
    /* start a rental from here: a new rental cannot begin in the past, so it starts at the next full hour inside the stretch,
       and only when at least one unit is free from then on and the item is offered that way */
    const rf = Math.max(from, Math.ceil(Date.now() / H) * H);
    const freeFrom = rf < to ? Math.max(0, t - peakOf(all, rf, to).n) : 0;
    const canOut = dragged && freeFrom > 0 && live && c.allow_outside;
    const addOns = dragged && live && c.allow_addon
        ? BK.filter(b => ['Approved', 'In Progress'].includes(b.status)).map(b => ({ b, s: ms(b.start_at), e: ms(b.end_at) }))
            .filter(y => y.s != null && y.e != null && y.s < to && y.e > from && y.e > Date.now() && t - peakOf(all, y.s, y.e).n > 0)
        : [];
    const range = `${hourLabel(new Date(rf + 288e5).getUTCHours())} to ${hourLabel(new Date(to + 288e5).getUTCHours())}`;
    const outLabel = to - rf > H ? `${hit.length ? 'New outside' : 'Outside'} rental, ${range}` : `${hit.length ? 'New outside' : 'Outside'} rental from ${hourLabel(new Date(rf + 288e5).getUTCHours())}`;
    const one = hit.length === 1 && hit[0].l.rental_ref ? hit[0].l.rental_ref : null;   // exactly one rental here: its button goes next to Close
    const start = addOns.length ? `<div class="ec-start no-print">
        <p class="mut">Add to a running booking</p>
        ${addOns.map((y, i) => `<button type="button" class="btn line" data-ec-add="${i}"><b>${esc(y.b.customer_name)}</b><span>${esc(y.b.studio_name)}, ${esc(tOf(y.b.start_at))} to ${esc(tOf(y.b.end_at))}</span></button>`).join('')}
      </div>` : '';
    showDlg(`<h2>${esc(c.name)}</h2>
      <p class="mut" style="margin:4px 0 10px">${esc(shortDate(dOf(iso(from))))}, ${esc(tOf(iso(from)))} to ${esc(tOf(iso(to)))}: ${free} of ${t} free.</p>
      ${hit.length ? hit.map(u => `<dl class="dl" style="margin:0 0 12px">
        <dt>Customer</dt><dd>${esc(u.l.customer_name || 'Customer')}</dd>
        <dt>Reference</dt><dd>${!one && u.l.rental_ref ? `<button type="button" class="lk" data-ec-rent="${esc(u.l.rental_ref)}" title="Open this rental">${esc(whoRef(u.l))}</button>` : esc(whoRef(u.l))} (${esc(kindLabel(u.l))})</dd>
        <dt>Quantity</dt><dd>${esc(String(u.l.quantity))}</dd>
        <dt>When</dt><dd>${when(u)}${u.late ? ' <b>(late, still out)</b>' : ''}</dd>
        <dt>Status</dt><dd>${esc(u.l.status)}</dd></dl>`).join('') : '<p class="mut">Nobody has this item in this hour.</p>'}
      ${start}
      <div class="acts"><button class="btn line" data-close>Close</button>${one ? `<button type="button" class="btn ${canOut ? 'line' : 'gold'}" data-ec-rent="${esc(one)}">Open this rental</button>` : ''}${canOut ? `<button type="button" class="btn gold" data-ec-out>${esc(outLabel)}</button>` : ''}</div>`);
    const dlg = $('#rdlg'), out = dlg.querySelector('[data-ec-out]');
    dlg.querySelectorAll('[data-ec-rent]').forEach(b => {   // the rental that holds the item: its record in the Rentals tab, row highlighted
        b.onclick = () => {
            dlg.close();
            location.hash = 'a-rent';
            revealRental(b.dataset.ecRent);
        };
    });
    if (out)
        out.onclick = () => {
            dlg.close();
            startRental({ mode: 'o', equipmentId: c.equipment_id, from: rf, to: to - rf > H ? to : null });
        };
    dlg.querySelectorAll('[data-ec-add]').forEach(b => {
        b.onclick = () => {
            dlg.close();
            startRental({ mode: 'a', equipmentId: c.equipment_id, bookingRef: addOns[+b.dataset.ecAdd].b.booking_ref });
        };
    });
}

/* a row of the list: one outside rental */
export function openRental(ref) {
    const lines = RL.filter(l => l.rental_ref === ref && l.rental_type === 'Outside');
    if (!lines.length)
        return;
    const now = Date.now(), l0 = lines[0];
    const sps = lines.map(l => lineSpan(l, now)).filter(Boolean);
    if (!sps.length)
        return;
    const s = Math.min(...sps.map(p => p.s)), e = Math.max(...sps.map(p => p.eTrue));
    const late = sps.some(p => p.late);
    showDlg(`<h2>${esc(l0.customer_name || 'Customer')}</h2>
      <dl class="dl" style="margin-top:10px">
        <dt>Rental</dt><dd>${esc(ref)}</dd>
        <dt>Pick-up</dt><dd>${esc(longDate(dOf(iso(s))))}, ${esc(tOf(iso(s)))}</dd>
        <dt>Due back</dt><dd>${esc(longDate(dOf(iso(e))))}, ${esc(tOf(iso(e)))}${late ? ' <b>(late, still out)</b>' : ''}</dd>
        ${lines.map(l => `<dt>${esc(l.equipment_name)}</dt><dd>x${esc(String(l.quantity))}, ${esc(l.status)}${l.line_returned_at ? ' (returned)' : ''}</dd>`).join('')}
      </dl>
      <div class="acts"><button class="btn line" data-close>Close</button><button class="btn gold" id="ec-open">Open this rental</button></div>`);
    $('#ec-open').onclick = () => {
        $('#rdlg').close();
        location.hash = 'a-rent';
        revealRental(ref);
    };
}