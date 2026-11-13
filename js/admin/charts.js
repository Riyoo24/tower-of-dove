/* =====================================================================
   admin/charts.js - small chart builders for the Reports analytics (plain HTML + CSS, no library)
   Each one returns an HTML string. Every bar and cell has a title (tooltip) and the numbers are also in the CSV export.
   ===================================================================== */

import { esc } from '../shared/utils.js';

/* vertical bars. items = [{ label, v, tip }]. fmt formats the top-of-axis number. */
export function vbars(items, fmt = String) {
    const max = Math.max(0, ...items.map(i => i.v));
    if (!max)
        return '<p class="mut">Nothing in this period.</p>';
    const step = Math.ceil(items.length / 6);
    return `<div class="vbars" role="img" aria-label="Bar chart, highest bar ${esc(fmt(max))}">
      <div class="vb-y"><span>${esc(fmt(max))}</span><span>0</span></div>
      <div class="vb-plot">${items.map(i => `<div class="vb" title="${esc(i.tip)}"><i style="height:${Math.max(1, i.v / max * 100)}%"></i></div>`).join('')}</div>
      <div></div>
      <div class="vb-x">${items.map((i, k) => `<span>${k % step === 0 ? esc(i.label) : ''}</span>`).join('')}</div>
    </div>`;
}

/* horizontal bars, same look as the Reports bars. rows = [label, shownValue, number] */
export function hbars(rows) {
    const m = Math.max(...rows.map(r => r[2]), 1);
    return rows.map(r => `<div class="hb"><div class="row" style="background:none;height:auto;margin:0"><span>${esc(r[0])}</span><b>${esc(r[1])}</b></div><div><i style="width:${Math.round(r[2] / m * 100)}%"></i></div></div>`).join('')
        || '<p class="mut">Nothing in this period.</p>';
}

/* weekday x hour heat map. cols = ['10 AM', ...], rows = [{ label, cells: [number] }]. Darker = busier. */
export function heatmap(cols, rows, unit = 'booked hours') {
    const max = Math.max(1, ...rows.flatMap(r => r.cells));
    return `<div class="tw"><div class="heat" style="--cols:${cols.length}" role="table" aria-label="Busy times by weekday and hour">
      <span></span>${cols.map(c => `<b class="heat-h">${esc(c)}</b>`).join('')}
      ${rows.map(r => `<b class="heat-d">${esc(r.label)}</b>${r.cells.map((v, i) => `<span class="heat-c" style="--p:${Math.round(v / max * 100)}%" title="${esc(r.label + ' ' + cols[i] + ': ' + v + ' ' + unit)}">${v || ''}</span>`).join('')}`).join('')}
    </div></div>`;
}
