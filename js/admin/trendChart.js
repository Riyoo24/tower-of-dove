/* =====================================================================
   admin/trendChart.js - the stock-style bookings chart on the Overview tab
   ---------------------------------------------------------------------
   Called by renderOverview() (admin/overview.js). Draws a line + area chart of bookings per day
   (cancelled and rejected ones are left out, same as the old bars) into #bars, with:
   - a big number and a up/down change against the day before, like a stock quote,
   - a crosshair that follows the mouse or finger (and the arrow keys) and updates the number,
   - 7D / 30D / 3M tabs, all read from the bookings already loaded (BK),
   - a small summary row (total, busiest day, trend). The line is always the brand red.
   Pointing at a day only previews it; when the mouse leaves, the chart goes back to today. Click (or tap, or use the arrow keys)
   to keep a day chosen (click it again or press Escape to let go). The owner's "Open report" link then opens Reports comparing
   the chosen day with the day before it (reports.js, setReportCompare).
   Styles: css/admin.css (the ".tc" block). Colours follow the site variables.
   ===================================================================== */

import { BK } from './data.js';
import { OWNER, dOf } from './helpers.js';
import { $, TODAY, dayOffset, pl, shortDate, sum } from '../shared/utils.js';

const RANGES = { 7: 'last 7 days', 30: 'last 30 days', 90: 'last 3 months' };
const PAD = { l: 8, r: 26, t: 8, b: 22 };
const longDay = iso => new Date(iso + 'T00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

let range = 7, days = [], vals = [], sel = 0, pinned = null;   // pinned = the day kept by a click (index), null = follow the pointer
let sig = '', drawnW = 0, play = true, wired = false;

/* Fritsch-Carlson smoothing: a curve that never overshoots the real values (a dip below 0 would be wrong for counts) */
function smooth(xs, ys) {
    const n = xs.length, m = [], t = [];
    for (let i = 0; i < n - 1; i++)
        m[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
    t[0] = m[0];
    t[n - 1] = m[n - 2];
    for (let i = 1; i < n - 1; i++)
        t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
        if (m[i] === 0) {
            t[i] = t[i + 1] = 0;
            continue;
        }
        const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
        if (s > 9) {
            const k = 3 / Math.sqrt(s);
            t[i] = k * a * m[i];
            t[i + 1] = k * b * m[i];
        }
    }
    let d = `M${xs[0]},${ys[0]}`;
    for (let i = 0; i < n - 1; i++) {
        const dx = (xs[i + 1] - xs[i]) / 3;
        d += `C${xs[i] + dx},${ys[i] + t[i] * dx} ${xs[i + 1] - dx},${ys[i + 1] - t[i + 1] * dx} ${xs[i + 1]},${ys[i + 1]}`;
    }
    return d;
}

function geo() {
    const el = $('#bars'), W = el.clientWidth, H = el.clientHeight, n = vals.length;
    const max = Math.max(...vals, 1);
    const step = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].find(s => Math.ceil((max + .01) / s) <= 4) || 1000;
    const ymax = Math.max(2, Math.ceil((max + .01) / step) * step);
    return {
        W, H, n, ymax, step,
        x: i => PAD.l + i * (W - PAD.l - PAD.r) / (n - 1),
        y: v => PAD.t + (1 - v / ymax) * (H - PAD.t - PAD.b)
    };
}

function draw() {
    const el = $('#bars'), g = geo(), { W, H, n, ymax, step, x, y } = g;
    if (!W || !H || n < 2)
        return;   // the tab is hidden (width 0): the ResizeObserver draws it when it opens
    const xs = vals.map((_, i) => x(i)), ys = vals.map(y), line = smooth(xs, ys);
    const avg = sum(vals) / n;
    let grid = '';
    for (let v = 0; v <= ymax; v += step)
        grid += `<line class="tc-grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(v)}" y2="${y(v)}"/><text class="tc-ax" x="${W - PAD.r + 8}" y="${y(v) + 4}">${v}</text>`;
    const every = Math.ceil(n / (W < 520 ? 4 : 7));
    let xl = '';
    for (let i = n - 1; i >= 0; i -= every)
        xl += `<text class="tc-ax" x="${x(i)}" y="${H - 5}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}">${shortDate(days[i])}</text>`;
    const pts = n <= 7 ? vals.map((v, i) => `<circle class="tc-pt" cx="${x(i)}" cy="${y(v)}" r="3"/>`).join('') : '';
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true">
        <defs><linearGradient id="tcg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--tc);stop-opacity:.3"/><stop offset="1" style="stop-color:var(--tc);stop-opacity:0"/></linearGradient></defs>
        ${grid}${xl}
        <line class="tc-avg" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(avg)}" y2="${y(avg)}"/>
        <text class="tc-ax tc-avgl" x="${PAD.l + 2}" y="${y(avg) - 5}">avg ${avg.toFixed(1)}</text>
        <path d="${line}L${xs[n - 1]},${y(0)}L${xs[0]},${y(0)}Z" fill="url(#tcg)"/>
        <path class="tc-line${play ? ' draw' : ''}" pathLength="1" d="${line}"/>
        ${pts}
        <line class="tc-cl" id="tc-cl" y1="${PAD.t}" y2="${H - PAD.b}"/>
        <circle class="tc-pulse" id="tc-pu" r="9"/><circle class="tc-dot" id="tc-dot" r="5"/></svg>
        <div class="tc-chip" id="tc-chip"></div>`;
    drawnW = W;
    play = false;
    place(sel);
}

/* move the crosshair to day i and update the big number and the change under it */
function place(i) {
    if (!vals.length)
        return;
    sel = i;
    const n = vals.length, v = vals[i];
    const svg = $('#bars svg');
    if (svg) {
        const g = geo(), px = g.x(i), py = g.y(v);
        $('#tc-cl').classList.toggle('pin', i === pinned);
        $('#tc-cl').setAttribute('x1', px);
        $('#tc-cl').setAttribute('x2', px);
        for (const id of ['tc-pu', 'tc-dot']) {
            $('#' + id).setAttribute('cx', px);
            $('#' + id).setAttribute('cy', py);
        }
        $('#tc-pu').style.display = i === n - 1 ? '' : 'none';
        const chip = $('#tc-chip');
        chip.textContent = longDay(days[i]);
        const w = chip.offsetWidth / 2;
        chip.style.left = Math.min(Math.max(px, w + 2), g.W - w - 2) + 'px';
    }
    $('#tc-v').innerHTML = `${v}<small>${v === 1 ? 'booking' : 'bookings'} ${days[i] === TODAY ? 'today' : 'on ' + shortDate(days[i])}</small>`;
    /* the owner's link opens Reports comparing this day with the day before it (also for the first day of the range) */
    const prev = dayOffset(i - range);
    const dl = $('#tc-d'), open = OWNER ? `<button type="button" class="tc-open" data-go="rc:${prev},${days[i]}" title="Compare ${shortDate(prev)} with ${shortDate(days[i])}">Open report</button>` : '';
    if (i === 0) {
        dl.className = 'tc-d';
        dl.innerHTML = `<span>First day in this range</span>${open}`;
    } else {
        const p = vals[i - 1], d = v - p;
        const pct = p > 0 ? ` (${d > 0 ? '+' : ''}${Math.round(d / p * 100)}%)` : '';
        dl.className = 'tc-d';
        dl.innerHTML = (d === 0 ? `<span>Same as ${shortDate(days[i - 1])}</span>`
            : `<b>${d > 0 ? '\u25B2 +' : '\u25BC '}${d}${pct}</b><span>vs ${shortDate(days[i - 1])}</span>`) + open;
    }
}

/* total, busiest day, and whether the second half of the range was busier than the first */
function summary() {
    const n = vals.length, tot = sum(vals), mx = Math.max(...vals), mi = vals.lastIndexOf(mx);
    const h = Math.floor(n / 2), a = sum(vals.slice(0, h)), b = sum(vals.slice(n - h));
    $('#tc-s1').textContent = pl(tot, 'booking');
    $('#tc-s2').textContent = mx ? `${shortDate(days[mi])} (${mx})` : 'None';
    $('#tc-s3').textContent = a > 0 ? `${b >= a ? '\u25B2 +' : '\u25BC \u2212'}${Math.round(Math.abs(b - a) / a * 100)}%` : b > 0 ? `\u25B2 +${b}` : 'No change';
}

function wire() {
    wired = true;
    const el = $('#bars');
    const at = e => {
        const g = geo(), r = el.getBoundingClientRect();
        return Math.max(0, Math.min(g.n - 1, Math.round((e.clientX - r.left - PAD.l) / ((g.W - PAD.l - PAD.r) / (g.n - 1)))));
    };
    const rest = () => place(pinned ?? vals.length - 1);
    el.addEventListener('pointermove', e => place(at(e)));
    el.addEventListener('pointerdown', e => place(at(e)));
    el.addEventListener('pointerleave', e => {
        if (e.pointerType === 'mouse')
            rest();   // only a preview: back to the clicked day, or to today
    });
    el.addEventListener('pointerup', e => {
        const i = at(e);
        pinned = pinned === i ? null : i;   // a click or tap keeps the day; the same day again lets go
        place(i);
    });
    el.addEventListener('keydown', e => {
        const n = vals.length;
        let i = sel;
        if (e.key === 'ArrowLeft')
            i--;
        else if (e.key === 'ArrowRight')
            i++;
        else if (e.key === 'Home')
            i = 0;
        else if (e.key === 'End')
            i = n - 1;
        else if (e.key === 'Escape') {
            pinned = null;
            e.preventDefault();
            return rest();
        } else
            return;
        e.preventDefault();
        pinned = Math.max(0, Math.min(n - 1, i));   // the arrow keys keep the day they land on
        place(pinned);
    });
    document.querySelectorAll('#tc .tc-tabs button').forEach(b => b.addEventListener('click', () => {
        range = +b.dataset.r;
        sig = '';
        play = true;
        document.querySelectorAll('#tc .tc-tabs button').forEach(x => x.setAttribute('aria-pressed', x === b));
        renderTrend();
    }));
    /* the Overview may be hidden when the data arrives (width 0), and the width changes with the window and the sidebar */
    if (window.ResizeObserver)
        new ResizeObserver(() => {
            if (vals.length && el.clientWidth && el.clientWidth !== drawnW)
                draw();
        }).observe(el);
}

export function renderTrend() {
    if (!wired)
        wire();
    days = Array.from({ length: range }, (_, i) => dayOffset(i - (range - 1)));
    const by = {};
    BK.forEach(b => {
        if (!['Cancelled', 'Rejected'].includes(b.status)) {
            const d = dOf(b.start_at);
            by[d] = (by[d] || 0) + 1;
        }
    });
    vals = days.map(d => by[d] || 0);
    const s = range + '|' + TODAY + '|' + vals.join(',');
    const same = s === sig;
    sig = s;
    if (!same) {
        sel = vals.length - 1;
        pinned = null;
    }
    $('#tc-t').textContent = 'Bookings over the ' + RANGES[range];
    summary();
    /* a silent refresh with the same numbers: leave the chart (and where the pointer is) alone */
    if (same && drawnW && drawnW === $('#bars').clientWidth && $('#bars svg')) {
        place(sel);
        return;
    }
    draw();
}