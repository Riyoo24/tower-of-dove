/* =====================================================================
   admin/helpers.js - setup and helpers for the dashboard
   Who is logged in (OWNER?), number/date formatting, table and button builders,
   run() for Supabase calls, the shared dialog and the data-act click dispatcher (ACT).
   ===================================================================== */

import { sb } from '../config/supabaseClient.js';
import { getUser } from '../shared/session.js';
import { $, esc, manilaParts, peso, toast } from '../shared/utils.js';

/* ============================ 1. SETUP & HELPERS ============================ */

export const who = getUser();

export const OWNER = !!who && who.role === 'owner';

export const num = n => Number(n) || 0;

export const money = n => peso(Math.round(num(n) * 100) / 100);

const P = ts => manilaParts(ts);

export const dOf = ts => P(ts).date;

export const tlabel = h => (h % 12 || 12) + ':00 ' + (h < 12 ? 'AM' : 'PM');

export const tOf = ts => tlabel(P(ts).hour);

export const stampLabel = ts => new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export const dayDiff = (a, b) => Math.round((new Date(a + 'T00:00') - new Date(b + 'T00:00')) / 864e5);

// database status -> label shown on screen
export const bkStatus = s => ({ 'Approved': 'Confirmed', 'In Progress': 'Active' }[s] || s);

export const rnStatus = s => ({ 'Active': 'In Use', 'Approved': 'Verified' }[s] || s);   // a rental that staff verified shows as Verified

export const tbl = (head, rows) =>
  `<table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>` +
  (rows.length ? rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')
               : `<tr><td colspan="${head.length}" class="mut">Nothing to show.</td></tr>`) + '</tbody></table>';

export const tb = (id, head, rows) => { $('#' + id).innerHTML = tbl(head, rows); };

export const dbtn = (act, id, text) => `<button class="btn sm bad" data-act="${act}" data-id="${esc(id)}">${text}</button>`;

export const btn = (act, id, text, line) => `<button class="btn sm ${line ? 'line' : ''}" data-act="${act}" data-id="${esc(id)}">${text}</button>`;

export const tabsHtml = (list, cur, key) => `<div class="tabs">${list.map(x => `<button data-${key}="${x}" class="${x === cur ? 'on' : ''}">${x}</button>`).join('')}</div>`;

export const KPI = (l, v, color, sub) => `<div class="card kpi"><span class="mut">${l}</span><div class="num" ${color ? `style="color:${color}"` : ''}>${v}</div>${sub ? `<span class="mut">${sub}</span>` : ''}</div>`;

export const hbs = (id, rows) => {
  const m = Math.max(...rows.map(r => r[2]), 1);
  $('#' + id).innerHTML = rows.map(r => `<div class="hb"><div class="row" style="background:none;height:auto;margin:0"><span>${esc(r[0])}</span><b>${r[1]}</b></div><div><i style="width:${Math.round(r[2] / m * 100)}%"></i></div></div>`).join('') || '<p class="mut">Nothing in this period.</p>';
};

export const setOpts = (sel, html) => {
  const cur = sel.value; sel.innerHTML = html;
  if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
};

/* run a Supabase call; show the error as a message and return null if it failed */
export async function run(p) {
  const r = await p;
  if (r.error) { toast(r.error.message); console.error(r.error); return null; }
  return r;
}

export async function uploadPublic(bucket, file) {
  const ext = ((file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '')) || 'jpg';
  const path = `${crypto.randomUUID()}.${ext}`;
  const up = await sb.storage.from(bucket).upload(path, file, { contentType: file.type });
  if (up.error) throw new Error(up.error.message);
  return sb.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

export const PHICON = '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-8 8"/></svg>';

/* shared dialog */
export const dlg = $('#rdlg');

export function showDlg(html) { dlg.innerHTML = `<div class="in">${html}</div>`; dlg.showModal(); }

dlg.addEventListener('click', e => { if (e.target === dlg || e.target.closest('[data-close]')) dlg.close(); });

$('#eqdlg').addEventListener('click', e => { if (e.target.id === 'eqdlg') $('#eqdlg').close(); });

/* every button with data-act runs ACT[name](id) */
export const ACT = {};

document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b || !ACT[b.dataset.act] || b.dataset.busy) return;
  b.dataset.busy = '1';
  Promise.resolve(ACT[b.dataset.act](b.dataset.id, b)).catch(err => { console.error(err); toast(err.message); }).finally(() => { delete b.dataset.busy; });
});
