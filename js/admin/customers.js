/* =====================================================================
   admin/customers.js - Customers tab
   DB: table customer (enable / disable).
   ===================================================================== */

import { afterAction } from './bookings.js';
import { BK, CUS, RL } from './data.js';
import { ACT, OWNER, bkStatus, btn, dOf, dbtn, money, num, run, showDlg, tb, tbl } from './helpers.js';
import { dueB, lineStatus } from './rentals.js';
import { sb } from '../config/supabaseClient.js';
import { $, badge, esc, shortDate, toast } from '../shared/utils.js';

/* ============================ 8. CUSTOMERS ============================ */

export function renderCustomers() {
  const q = ($('#cu-q').value || '').toLowerCase(), type = $('#cu-type').value;
  tb('acu', ['Name', 'Phone', 'Account', 'Bookings', 'Rentals', 'Total spent', 'Status', ''],
    CUS.filter(c => (!type || c.account_type === type) && (!q || `${c.customer_name} ${c.number}`.toLowerCase().includes(q)))
       .map(c => {
         const off = c.status === 'Inactive', reg = c.account_type === 'Registered', hist = num(c.bookings) + num(c.rentals);
         // registered accounts are disabled (or enabled again); a guest with no records can be removed
         const owner = !OWNER ? '' : reg ? (off ? btn('cu-on', c.customer_id, 'Enable', 1) : dbtn('cu-off', c.customer_id, 'Disable'))
                                          : (hist === 0 ? dbtn('cu-del', c.customer_id, 'Remove') : '');
         return [esc(c.customer_name), esc(c.number || ''), c.account_type, String(c.bookings), String(c.rentals), money(c.total_spent),
           off ? '<span class="b rejected">Disabled</span>' : esc(c.status || 'Active'), btn('cu-hist', c.customer_id, 'History', 1) + owner];
       }));
}

$('#cu-q').addEventListener('input', renderCustomers);

$('#cu-type').addEventListener('change', renderCustomers);

ACT['cu-off'] = id => {
  const c = CUS.find(x => x.customer_id === +id);
  showDlg(`<h2 style="margin:0 0 8px">Disable ${esc(c.customer_name)}?</h2>
    <p class="mut">They can no longer log in or make bookings and rentals. Their bookings, payments and history stay on record, and you can enable the account again at any time.</p>
    <div class="acts"><button class="btn line" data-close>Cancel</button>${dbtn('cu-off-go', c.customer_id, 'Disable account')}</div>`);
};

ACT['cu-off-go'] = async id => {
  const c = CUS.find(x => x.customer_id === +id);
  if (await run(sb.from('customer').update({ status: 'Inactive' }).eq('customer_id', +id))) afterAction(`${c.customer_name}'s account was disabled.`);
};

ACT['cu-on'] = async id => {
  const c = CUS.find(x => x.customer_id === +id);
  if (await run(sb.from('customer').update({ status: 'Active' }).eq('customer_id', +id))) afterAction(`${c.customer_name}'s account is enabled again.`);
};

ACT['cu-del'] = id => {
  const c = CUS.find(x => x.customer_id === +id);
  showDlg(`<h2 style="margin:0 0 8px">Remove ${esc(c.customer_name)}?</h2>
    <p class="mut">This guest has no bookings or rentals, so the record is deleted. This can't be undone.</p>
    <div class="acts"><button class="btn line" data-close>Cancel</button>${dbtn('cu-del-go', c.customer_id, 'Remove record')}</div>`);
};

ACT['cu-del-go'] = async id => {
  const c = CUS.find(x => x.customer_id === +id);
  const r = await sb.from('customer').delete().eq('customer_id', +id);
  if (r.error) return toast(r.error.code === '23503' ? `${c.customer_name} has records on file, so it can't be removed.` : r.error.message);
  afterAction(`${c.customer_name} was removed.`);
};

ACT['cu-hist'] = id => {
  const c = CUS.find(x => x.customer_id === +id);
  const bks = BK.filter(b => b.customer_id === c.customer_id), lines = RL.filter(l => l.customer_id === c.customer_id);
  showDlg(`<div class="row"><h2 style="margin:0">${esc(c.customer_name)}</h2><span class="mut">${c.account_type}</span></div>
    <p class="mut" style="margin:4px 0 12px">${esc(c.number || '')}. Total spent (verified payments): <b>${money(c.total_spent)}</b></p>
    <h3 style="font-size:14px">Studio bookings</h3><div class="tw">${tbl(['Booking', 'Studio', 'Date', 'Hours', 'Amount', 'Status'], bks.map(b => [b.booking_ref, esc(b.studio_name), shortDate(dOf(b.start_at)), String(Math.round(num(b.hours))), money(b.total_amount), badge(bkStatus(b.status))]))}</div>
    <h3 style="font-size:14px;margin-top:14px">Equipment rented</h3><p class="mut" style="margin:0 0 6px">Past rentals are listed with how they ended: returned on time, returned late, or overdue now.</p><div class="tw">${tbl(['Order', 'Equipment', 'Qty', 'Date', 'Status', 'Return'], lines.map(l => [l.rental_ref, esc(l.equipment_name), String(l.quantity), shortDate(dOf(l.created_at)), badge(lineStatus(l)), dueB(l)]))}</div>
    <div class="acts"><button class="btn line" data-close>Close</button></div>`);
};
