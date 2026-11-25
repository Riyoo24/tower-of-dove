/* =====================================================================
   admin/revenueChart.js - the "Revenue trend" chart on Reports > Analytics
   ---------------------------------------------------------------------
   Same look and behaviour as the bookings chart on the Overview (admin/trendChart.js): a smooth line with a soft area,
   a dashed average line, and a crosshair that follows the mouse or finger (or the arrow keys). It shares that chart's
   smoothing and its styles (the ".tc" block in css/admin.css).
   At rest the big number is the revenue of the whole period. Pointing at a day (or week) shows that bar's revenue and
   how it changed from the one before. Click or tap keeps it chosen; click it again or press Escape to let go.
   buildAnalytics() (admin/analytics.js) writes the card, reports.js calls mountRevenueChart(data) once it is on screen.
   ===================================================================== */

import { money } from './helpers.js';
import { smooth } from './trendChart.js';
import { sum } from '../shared/utils.js';

const PAD = { l: 8, r: 48, t: 8, b: 22 };   // the right side holds the peso labels
const peso = v => v >= 1000 ? '\u20B1' + String(Math.round(v / 100) / 10).replace(/\.0$/, '') + 'k' : '\u20B1' + v;

let watcher = null;   // one ResizeObserver; the card is drawn again each time the report changes

/* items = [{ v, label, name }], unit = 'day' | 'week' */
export function mountRevenueChart({ items, unit }) {
    const root = document.getElementById('rv');
    if (watcher)
        watcher.disconnect();
    if (!root)
        return;
    const plot = root.querySelector('.tc-plot'), valEl = root.querySelector('.tc-val'), dEl = root.querySelector('.tc-d');
    const vals = items.map(i => i.v), n = vals.length, total = sum(vals);
    const h = Math.floor(n / 2), first = sum(vals.slice(0, h)), last = sum(vals.slice(n - h));
    const best = vals.lastIndexOf(Math.max(...vals));
    let sel = null, pinned = null, drawnW = 0, play = true;   // play: the line draws itself in once, like the Overview chart

    /* summary row */
    const stats = root.querySelectorAll('.tc-stats b');
    stats[0].textContent = money(total / n);
    stats[1].textContent = `${items[best].label} (${money(vals[best])})`;
    stats[2].textContent = `${vals.filter(v => v > 0).length} of ${n}`;

    const geo = () => {
        const W = plot.clientWidth, H = plot.clientHeight, max = Math.max(...vals, 1);
        const raw = max / 4, pow = Math.pow(10, Math.floor(Math.log10(raw)));
        const step = [1, 2, 5, 10].map(m => m * pow).find(s => s >= raw);
        const ymax = Math.ceil(max / step) * step;
        return { W, H, step, ymax, x: i => PAD.l + i * (W - PAD.l - PAD.r) / (n - 1), y: v => PAD.t + (1 - v / ymax) * (H - PAD.t - PAD.b) };
    };

    function draw() {
        const g = geo(), { W, H, step, ymax, x, y } = g;
        if (!W || !H)
            return;   // hidden tab: the observer draws it when it opens
        const xs = vals.map((_, i) => x(i)), ys = vals.map(y), line = smooth(xs, ys), avg = total / n;
        let grid = '';
        for (let v = 0; v <= ymax; v += step)
            grid += `<line class="tc-grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(v)}" y2="${y(v)}"/><text class="tc-ax" x="${W - PAD.r + 8}" y="${y(v) + 4}">${peso(v)}</text>`;
        const every = Math.ceil(n / (W < 520 ? 4 : 7));
        let xl = '';
        for (let i = n - 1; i >= 0; i -= every)
            xl += `<text class="tc-ax" x="${x(i)}" y="${H - 5}" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}">${items[i].label}</text>`;
        const pts = n <= 7 ? vals.map((v, i) => `<circle class="tc-pt" cx="${x(i)}" cy="${y(v)}" r="3"/>`).join('') : '';
        plot.innerHTML = `<svg viewBox="0 0 ${W} ${H}" aria-hidden="true">
        <defs><linearGradient id="rvg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--tc);stop-opacity:.3"/><stop offset="1" style="stop-color:var(--tc);stop-opacity:0"/></linearGradient></defs>
        ${grid}${xl}
        <line class="tc-avg" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(avg)}" y2="${y(avg)}"/>
        <text class="tc-ax tc-avgl" x="${PAD.l + 2}" y="${y(avg) - 5}">avg ${peso(Math.round(avg))}</text>
        <path d="${line}L${xs[n - 1]},${y(0)}L${xs[0]},${y(0)}Z" fill="url(#rvg)"/>
        <path class="tc-line${play ? ' draw' : ''}" pathLength="1" d="${line}"/>
        ${pts}
        <line class="tc-cl" y1="${PAD.t}" y2="${H - PAD.b}" style="display:none"/>
        <circle class="tc-dot" r="5" style="display:none"/></svg>
        <div class="tc-chip" style="display:none"></div>`;
        drawnW = W;
        play = false;   // a resize or a hover must not replay it
        show(sel);
    }

    /* i = a day or week, or null for the whole period */
    function show(i) {
        sel = i;
        const cl = plot.querySelector('.tc-cl'), dot = plot.querySelector('.tc-dot'), chip = plot.querySelector('.tc-chip');
        const unitName = unit === 'week' ? 'week' : 'day';
        if (i === null) {
            if (cl) {
                cl.style.display = dot.style.display = chip.style.display = 'none';
            }
            valEl.innerHTML = `${money(total)}<small>in this period</small>`;
            dEl.innerHTML = first > 0
                ? `<b>${last >= first ? '\u25B2 +' : '\u25BC \u2212'}${Math.round(Math.abs(last - first) / first * 100)}%</b><span>second half vs first half</span>`
                : last > 0 ? `<b>\u25B2 +${money(last)}</b><span>second half vs first half</span>` : '<span>No change</span>';
            return;
        }
        const v = vals[i];
        valEl.innerHTML = `${money(v)}<small>${unitName === 'week' ? 'week of ' : 'on '}${items[i].label}</small>`;
        if (i === 0)
            dEl.innerHTML = `<span>First ${unitName} in this period</span>`;
        else {
            const p = vals[i - 1], d = v - p;
            const pct = p > 0 ? ` (${d > 0 ? '+' : ''}${Math.round(d / p * 100)}%)` : '';
            dEl.innerHTML = d === 0 ? `<span>Same as ${items[i - 1].label}</span>`
                : `<b>${d > 0 ? '\u25B2 +' : '\u25BC \u2212'}${money(Math.abs(d))}${pct}</b><span>vs ${items[i - 1].label}</span>`;
        }
        if (!cl)
            return;
        const g = geo(), px = g.x(i), py = g.y(v);
        cl.classList.toggle('pin', i === pinned);
        cl.setAttribute('x1', px);
        cl.setAttribute('x2', px);
        dot.setAttribute('cx', px);
        dot.setAttribute('cy', py);
        cl.style.display = dot.style.display = chip.style.display = '';
        chip.textContent = items[i].name;
        const w = chip.offsetWidth / 2;
        chip.style.left = Math.min(Math.max(px, w + 2), g.W - w - 2) + 'px';
    }

    const at = e => {
        const g = geo(), r = plot.getBoundingClientRect();
        return Math.max(0, Math.min(n - 1, Math.round((e.clientX - r.left - PAD.l) / ((g.W - PAD.l - PAD.r) / (n - 1)))));
    };
    const rest = () => show(pinned);
    plot.addEventListener('pointermove', e => show(at(e)));
    plot.addEventListener('pointerdown', e => show(at(e)));
    plot.addEventListener('pointerleave', e => {
        if (e.pointerType === 'mouse')
            rest();   // only a preview: back to the kept day, or to the whole period
    });
    plot.addEventListener('pointerup', e => {
        const i = at(e);
        pinned = pinned === i ? null : i;
        show(i);
    });
    plot.addEventListener('keydown', e => {
        let i = sel === null ? n - 1 : sel;
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
        pinned = Math.max(0, Math.min(n - 1, i));
        show(pinned);
    });

    if (window.ResizeObserver) {
        watcher = new ResizeObserver(() => {
            if (plot.clientWidth && plot.clientWidth !== drawnW)
                draw();
        });
        watcher.observe(plot);
    }
    draw();
}