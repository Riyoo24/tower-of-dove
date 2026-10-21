/* =====================================================================
   admin/payments.js - Payments tab
   DB: table payment (verify / reject).
   ===================================================================== */

import { state } from './state.js';
import { closeOverlays, findBk, pendingAddons, verifiedMsg } from './bookings.js';
import { PAY, RL, refresh } from './data.js';
import { ACT, btn, money, run, tabsHtml, tbl } from './helpers.js';
import { sb } from '../config/supabaseClient.js';
import { $, badge, esc, toast } from '../shared/utils.js';

let payKind = '', paySrc = '', payMeth = '';

/* where a payment came from: the source of its booking or rental (Online or Onsite) */
const paySource = p => p.kind === 'Booking' ? (findBk(p.reference) || {}).source : (RL.find(l => l.rental_ref === p.reference) || {}).source;

export function renderPayments() {
  const rows = PAY.filter(p => (state.payF === 'All' || p.status === state.payF) && (!payKind || p.kind === payKind)
    && (!paySrc || paySource(p) === paySrc) && (!payMeth || p.method === payMeth));
  const sel = (id, label, opts, cur) => `<select id="${id}" aria-label="${label}" style="max-width:200px">${opts.map(([v, t]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${t}</option>`).join('')}</select>`;
  $('#apy').innerHTML = '<div class="row" style="justify-content:flex-start;gap:10px;flex-wrap:wrap;margin-bottom:12px">' +
    sel('pay-kind', 'Payments for', [['', 'Bookings and rentals'], ['Booking', 'Bookings'], ['Rental', 'Rentals']], payKind) +
    sel('pay-src', 'Where it was made', [['', 'Online and onsite'], ['Online', 'Online'], ['Onsite', 'Onsite']], paySrc) +
    sel('pay-meth', 'Payment method', [['', 'GCash and cash'], ['GCash', 'GCash'], ['Cash', 'Cash']], payMeth) + '</div>' +
    tabsHtml(['All', 'Pending', 'Verified', 'Rejected'], state.payF, 'pf') + '<div class="tw">' + tbl(
    ['Reference', 'Customer', 'Amount', 'Method', 'Payment reference', 'Status', 'Actions'],
    rows.map(p => [esc(p.reference) + ` <span class="mut">${p.kind}</span>`, esc(p.customer_name), money(p.amount), esc(p.method),
      p.method === 'GCash' ? esc(p.gcash_reference || '') : 'Pay at studio', badge(p.status),
      p.status === 'Pending' ? btn('pay-verify', p.payment_id, 'Verify') : btn('pay-verify', p.payment_id, 'Details', 1)])) + '</div>';
}

$('#apy').addEventListener('change', e => {
  if (e.target.id === 'pay-kind') payKind = e.target.value;
  else if (e.target.id === 'pay-src') paySrc = e.target.value;
  else if (e.target.id === 'pay-meth') payMeth = e.target.value;
  else return;
  renderPayments();
});

$('#apy').addEventListener('click', e => { const t = e.target.closest('[data-pf]'); if (t) { state.payF = t.dataset.pf; renderPayments(); } });

const setPay = async (id, status) => {
  const p = PAY.find(x => x.payment_id === +id), ref = p && p.kind === 'Booking' ? p.reference : null, had = !!ref && pendingAddons(ref);
  if (!(await run(sb.from('payment').update({ status }).eq('payment_id', +id)))) return;
  await refresh();
  closeOverlays();
  toast(status === 'Verified' && ref ? verifiedMsg(ref, had) : 'Payment ' + status.toLowerCase() + '.');
};

ACT['pay-ok'] = id => setPay(id, 'Verified');

ACT['pay-no'] = id => setPay(id, 'Rejected');
