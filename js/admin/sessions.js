/* =====================================================================
   admin/sessions.js - Studio sessions tab (sessions in progress)

   ===================================================================== */

import { BK } from './data.js';
import { btn, dOf, tOf } from './helpers.js';
import { $, TODAY, badge, esc } from '../shared/utils.js';

/* ============================ 4. SESSIONS ============================ */

export function renderSessions() {
  const live = BK.filter(b => b.status === 'In Progress');
  const soon = BK.filter(b => b.status === 'Approved' && dOf(b.start_at) === TODAY).sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
  const now = Date.now();
  const liveHtml = live.map(b => {
    const s = new Date(b.start_at).getTime(), e = new Date(b.end_at).getTime(), left = e - now;
    const pct = Math.min(100, Math.max(0, Math.round((now - s) / (e - s) * 100)));
    const lt = left > 0 ? `${Math.floor(left / 36e5)}h ${Math.floor(left / 6e4) % 60}m left` : `Over time by ${Math.ceil(-left / 6e4)} min`;
    return `<div class="card"><div class="row"><h3><i class="lamp live"></i>${esc(b.studio_name)}</h3><span class="b active">Active</span></div>
      <p style="margin:8px 0">${esc(b.customer_name)}</p><p class="mut">${tOf(b.start_at)} to ${tOf(b.end_at)}</p>
      <div class="hb"><b>${lt}</b><div><i style="width:${pct}%"></i></div></div>${btn('bk-done', b.booking_ref, 'Mark completed', 1)}</div>`;
  }).join('');
  const soonHtml = soon.map(b => `<div class="card"><div class="row"><h3>${esc(b.studio_name)}</h3>${badge('Confirmed')}</div>
      <p style="margin:8px 0">${esc(b.customer_name)}</p><p class="mut">${tOf(b.start_at)} to ${tOf(b.end_at)}, today</p>${btn('bk-go', b.booking_ref, 'Start session')}</div>`).join('');
  $('#asess').innerHTML = `<div class="grid ge">${liveHtml || '<div class="card"><p class="mut">No sessions in progress.</p></div>'}</div>` +
    (soonHtml ? `<h2 style="margin:24px 0 4px">Confirmed for today</h2><p class="mut" style="margin:0 0 12px">A confirmed session starts by itself when its time begins. You can also start it earlier with Start session.</p><div class="grid ge">${soonHtml}</div>` : '');
}
