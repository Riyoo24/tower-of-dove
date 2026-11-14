/* =====================================================================
   admin/equipCalendar.js - the "Equipment" side of the Calendar tab (owner and staff)
   One question: "Is it free, and if not, who has it?"
   Day view  : a grid, one row per item and one cell per open hour (10 AM to 10 PM), like the room calendar:
                 blank = every unit is free, a number = that many are still free, Full = none left,
                 Over = more is reserved than the studio owns (needs fixing).
                 Click a cell to see who has the item in that hour.
   Week view : the same grid with one cell per item and day. A cell shows the tightest hour of that day, in words
                 (blank = free all day, "2 left", "None left", "Over"). Click a day to open its hourly grid.
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

/* units taken between two moments, how many of them wait for approval, and whether one is late */
function loadOf(uses, from, to) {
    let n = 0, pend = 0, late = false;
    uses.forEach(u => {
        if (u.s < to && u.e > from) {
            const q = num(u.l.quantity);
            n += q;
            if (u.l.status === 'Pending')
                pend += q;
            if (u.late)
                late = true;
        }
    });
    return { n, pend, late };
}

const kindOf = (n, total) => !n ? 'free' : n > total ? 'bad' : n >= total ? 'full' : 'some';

/* ---------- the view ---------- */

const catNames = () => [...new Set(STK.map(c => c.category_name).filter(Boolean))].sort((a, b) => a.localeCompare(b));
const bySort = (a, b) => (num(a.sort_order) - num(b.sort_order)) || String(a.name).localeCompare(String(b.name));

export const equipLegend = `<div class="cal-legend" aria-label="Colour key">
  <span><i class="ec-k-free"></i>All free</span><span><i class="ec-k-some"></i>Some left</span><span><i class="ec-k-full"></i>None left</span><span><i class="ec-k-bad"></i>Over-reserved or late</span></div>`;

function tools(cat, view) {
    const names = catNames();
    return `<div class="ec-tools no-print">
      <p class="mut ec-help">${view === 'day'
        ? 'Blank means every unit is free. A number is how many are still free. Click an hour to see who has it.'
        : 'Each cell shows the tightest hour of that day. Blank means free all day. Click a day to see the hours.'}</p>
      ${names.length > 1 ? `<select data-eq-cat-sel aria-label="Show equipment from"><option value="All"${cat === 'All' ? ' selected' : ''}>All equipment</option>${names.map(n => `<option value="${esc(n)}"${cat === n ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>` : ''}
    </div>`;
}

function cellHtml(c, total, from, to, x, now, label) {
    const free = total - x.n, kind = kindOf(x.n, total);
    const text = kind === 'some' ? String(free) : kind === 'full' ? 'Full' : kind === 'bad' ? 'Over' : '';
    const tip = `${c.name}, ${label}: ${kind === 'bad' ? `over-reserved by ${x.n - total}` : free === total ? `all ${total} free` : `${free} of ${total} free`}${x.pend ? `, ${x.pend} waiting for approval` : ''}${x.late ? ', one is late and still out' : ''}`;
    return `<button type="button" class="ec-c ec-k-${kind}${x.late ? ' ec-late' : ''}${now ? ' now' : ''}" data-eid="${esc(c.equipment_id)}" data-from="${from}" data-to="${to}" title="${esc(tip)}" aria-label="${esc(tip)}">${text}</button>`;
}

/* view = 'day' | 'week', day = ISO date, dates = the 7 ISO days of the week, today = today's ISO date, cat = category name or 'All' */
export function equipView({ view, day, dates, cat, today }) {
    if (!STK.length)
        return '<div class="card"><p class="mut">No equipment yet. Add items in Equipment Management.</p></div>';
    const uses = usesByItem();
    const nowH = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'Asia/Manila' }).format(new Date())) % 24;
    const items = STK.filter(c => cat === 'All' || c.category_name === cat).slice().sort(bySort);
    if (view === 'week')
        return weekView(items, uses, dates, cat, today);
    const base = dayStart(day), isToday = day === today;
    const head = `<div class="ec-h ec-corner"></div>${HOURS.map(h => `<div class="ec-h${isToday && h === nowH ? ' now' : ''}">${hourLabel(h)}</div>`).join('')}`;
    const body = items.map(c => {
        const total = num(c.total_quantity), u = uses.get(String(c.equipment_id)) || [];
        return `<div class="ec-n"><b>${esc(c.name)}</b><span>${total} in total</span></div>`
            + HOURS.map(h => cellHtml(c, total, base + h * H, base + (h + 1) * H, loadOf(u, base + h * H, base + (h + 1) * H), isToday && h === nowH, hourLabel(h))).join('');
    }).join('');
    return tools(cat, 'day')
        + (items.length ? `<div class="tw cal-scroll"><div class="ec-grid" style="--c:${HOURS.length};--w:46px">${head}${body}</div></div>`
            : '<div class="card"><p class="mut">No equipment in this category.</p></div>')
        + outList(base, base + D, cat, 'Out of the studio on this day', 'Outside rentals that are out, or due back, on this day. Late ones come first.');
}

/* week: one cell per item and day = the tightest hour of that day, in words */
function weekView(items, uses, dates, cat, today) {
    const head = `<div class="ec-h ec-corner"></div>${dates.map(d => `<button type="button" class="ec-h ec-hd${d === today ? ' now' : ''}" data-day="${d}" aria-label="${esc('Open ' + longDate(d))}"><b>${esc(new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }))}</b><small>${esc(shortDate(d))}</small></button>`).join('')}`;
    const body = items.map(c => {
        const total = num(c.total_quantity), u = uses.get(String(c.equipment_id)) || [];
        const cells = dates.map(d => {
            const b = dayStart(d);
            let x = { n: 0, pend: 0, late: false };
            HOURS.forEach(h => {
                const y = loadOf(u, b + h * H, b + (h + 1) * H);
                if (y.n > x.n || (y.n === x.n && y.late))
                    x = y;
            });
            const kind = kindOf(x.n, total), free = total - x.n;
            const text = kind === 'some' ? `${free} left` : kind === 'full' ? 'None left' : kind === 'bad' ? 'Over' : '';
            const tip = `${c.name}, ${shortDate(d)}: ${kind === 'free' ? `all ${total} free all day` : kind === 'bad' ? `over-reserved by ${x.n - total} at the busiest hour` : `at the busiest hour ${free} of ${total} free`}${x.pend ? `, ${x.pend} waiting for approval` : ''}${x.late ? ', one is late and still out' : ''}`;
            return `<button type="button" class="ec-c ec-k-${kind}${x.late ? ' ec-late' : ''}${d === today ? ' now' : ''}" data-day="${d}" title="${esc(tip)}" aria-label="${esc(tip + '. Open the day')}">${text}</button>`;
        }).join('');
        return `<div class="ec-n"><b>${esc(c.name)}</b><span>${total} in total</span></div>${cells}`;
    }).join('');
    const wk0 = dayStart(dates[0]);
    return tools(cat, 'week')
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

/* ---------- windows ---------- */

const when = u => `${esc(shortDate(dOf(iso(u.s))))}, ${esc(tOf(iso(u.s)))} to ${esc(shortDate(dOf(iso(u.eTrue))))}, ${esc(tOf(iso(u.eTrue)))}`;
const whoRef = l => l.rental_type === 'Add-on' && l.booking_ref ? l.booking_ref : l.rental_ref;
const kindLabel = l => l.rental_type === 'Add-on' ? 'with a studio booking' : 'outside rental';

/* a cell of the grid: who has this item in that hour */
export function openEquipCell(eid, from, to) {
    const c = STK.find(x => String(x.equipment_id) === String(eid));
    if (!c)
        return;
    from = Number(from);
    to = Number(to);
    const hit = (usesByItem().get(String(eid)) || []).filter(u => u.s < to && u.e > from);
    const x = loadOf(hit, from, to), t = num(c.total_quantity);
    showDlg(`<h2>${esc(c.name)}</h2>
      <p class="mut" style="margin:4px 0 10px">${esc(shortDate(dOf(iso(from))))}, ${esc(tOf(iso(from)))} to ${esc(tOf(iso(to)))}: ${Math.max(0, t - x.n)} of ${t} free.</p>
      ${hit.length ? hit.map(u => `<dl class="dl" style="margin:0 0 12px">
        <dt>Customer</dt><dd>${esc(u.l.customer_name || 'Customer')}</dd>
        <dt>Reference</dt><dd>${esc(whoRef(u.l))} (${esc(kindLabel(u.l))})</dd>
        <dt>Quantity</dt><dd>${esc(String(u.l.quantity))}</dd>
        <dt>When</dt><dd>${when(u)}${u.late ? ' <b>(late, still out)</b>' : ''}</dd>
        <dt>Status</dt><dd>${esc(u.l.status)}</dd></dl>`).join('') : '<p class="mut">Nobody has this item in this hour.</p>'}
      <div class="acts"><button class="btn line" data-close>Close</button><button class="btn gold" id="ec-open">Open Rentals</button></div>`);
    $('#ec-open').onclick = () => {
        $('#rdlg').close();
        location.hash = 'a-rent';
    };
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
      <div class="acts"><button class="btn line" data-close>Close</button><button class="btn gold" id="ec-open">Open Rentals</button></div>`);
    $('#ec-open').onclick = () => {
        $('#rdlg').close();
        location.hash = 'a-rent';
    };
}