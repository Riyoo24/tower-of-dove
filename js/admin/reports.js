/* =====================================================================
   admin/reports.js - Reports tab (owner only)
   Period + type selector, income table, bars.
   ===================================================================== */

import { BK, CUS, REV, RL, STK, STU } from './data.js';
import { KPI, bkStatus, dOf, hbs, money, num, tb, tbl } from './helpers.js';
import { openLines } from './overview.js';
import { dueB, dueLabel, lateDays } from './rentals.js';
import { $, TODAY, badge, dayOffset, esc, pad, pl, shortDate, sum } from '../shared/utils.js';

/* ============================ 11. REPORTS ============================ */

let rp = 'Month', rt = 'Booking', cFrom = dayOffset(-30), cTo = TODAY, hc = null;

const RT = {
  Booking: 'Total bookings, how many are confirmed, pending, completed or cancelled, and bookings per studio.',
  Sales: 'Verified payments for studio bookings and equipment, split by studio and by equipment.',
  Rental: 'How often each item was rented and the income it earned (estimated from rental lines).',
  Customer: 'Customers who spent in this period and how much. Use View history for the details.',
  Inventory: 'Current stock for each item: available, in use and low stock. This is a snapshot, so the period filter does not apply.',
  Returns: 'Rentals returned on time or late, and equipment that is overdue right now.'
};

function rangeOf() {
  if (rp === 'Today') return [TODAY, TODAY];
  if (rp === 'Week') return [dayOffset(-6), TODAY];
  if (rp === 'Month') { const y = +TODAY.slice(0, 4), m = +TODAY.slice(5, 7); return [`${y}-${pad(m)}-01`, `${y}-${pad(m)}-${pad(new Date(y, m, 0).getDate())}`]; }
  return [cFrom <= cTo ? cFrom : cTo, cFrom <= cTo ? cTo : cFrom];
}

/* estimated income of one rental line: outside rentals = price x hours / 8 (8 hours minimum) */
function lineIncome(l) {
  const f = l.rental_type === 'Outside' ? Math.max(8, Math.ceil(num(l.rental_hours) || 8)) / 8 : 1;
  return num(l.unit_price_at_request) * l.quantity * f + num(l.late_fee);
}

export function renderReports() {
  const [lo, hi] = rangeOf(), inR = d => d >= lo && d <= hi, inv = rt === 'Inventory';
  const bks = BK.filter(b => inR(dOf(b.start_at)));
  const lines = RL.filter(l => !['Rejected', 'Cancelled'].includes(l.status) && inR(dOf(l.created_at)));
  const revs = REV.filter(r => inR(r.day));
  const label = lo === hi ? shortDate(lo) : shortDate(lo) + ' to ' + shortDate(hi);
  const card = (x, y) => `<div class="grid ge" style="margin-top:16px"><div class="card"><h3>${x}</h3><div id="h1"></div></div><div class="card"><h3>${y}</h3><div id="h2"></div></div></div>`;
  const wide = h => `<div class="card tw" style="margin-top:16px"><h3 style="margin-bottom:8px">${h}</h3><div id="h1"></div></div>`;
  let k = [], body = '', post = () => {};

  if (rt === 'Booking') {
    const c = s => bks.filter(b => bkStatus(b.status) === s).length;
    const st = [['Completed', c('Completed')], ['Confirmed', c('Confirmed') + c('Active')], ['Pending', c('Pending')], ['Cancelled', c('Cancelled') + c('Rejected')]];
    k = [['Total bookings', bks.length], ['Confirmed', st[1][1]], ['Pending', st[2][1]], ['Completed', st[0][1]], ['Cancelled', st[3][1]]];
    body = card('Bookings by status', 'Bookings by studio');
    post = () => { hbs('h1', st.map(x => [x[0], x[1], x[1]])); hbs('h2', STU.map(s => { const n = bks.filter(b => b.studio_id === s.studio_id).length; return [s.name, n, n]; })); };
  } else if (rt === 'Sales') {
    const sv = sum(revs.filter(r => r.kind === 'Studio').map(r => num(r.amount))), ev = sum(revs.filter(r => r.kind === 'Equipment').map(r => num(r.amount)));
    k = [['Studio revenue', money(sv)], ['Equipment revenue', money(ev)], ['Total revenue', money(sv + ev)]];
    body = card('Revenue by studio', 'Estimated rental income by equipment');
    post = () => {
      hbs('h1', STU.map(s => { const v = sum(revs.filter(r => r.kind === 'Studio' && r.studio_name === s.name).map(r => num(r.amount))); return [s.name, money(v), v]; }));
      hbs('h2', STK.map(e => { const v = sum(lines.filter(l => l.equipment_id === e.equipment_id).map(lineIncome)); return [e.name, money(v), v]; }).filter(x => x[2] > 0));
    };
  } else if (rt === 'Rental') {
    const by = STK.map(e => { const ls = lines.filter(l => l.equipment_id === e.equipment_id); return { n: e.name, times: sum(ls.map(l => l.quantity)), income: sum(ls.map(lineIncome)) }; }).filter(x => x.times > 0).sort((a, b) => b.times - a.times);
    k = [['Items rented', sum(by.map(x => x.times))], ['Rental income', money(sum(by.map(x => x.income)))], ['Most rented', by.length ? by[0].n : 'None']];
    body = wide('Rental activity');
    post = () => tb('h1', ['Equipment', 'Times rented', 'Income'], by.map(x => [esc(x.n), String(x.times), money(x.income)]));
  } else if (rt === 'Customer') {
    const sp = {};
    const get = (id, n) => (sp[id] = sp[id] || { id, n, s: [], q: [], ss: 0, qs: 0 });
    bks.filter(b => b.payment_status === 'Verified').forEach(b => { const c = get(b.customer_id, b.customer_name); c.s.push(b); c.ss += num(b.total_amount); });
    lines.forEach(l => { const c = get(l.customer_id, l.customer_name); c.q.push(l); c.qs += lineIncome(l); });
    const cu = Object.values(sp).map(c => ({ ...c, t: c.ss + c.qs })).filter(c => c.t > 0).sort((a, b) => b.t - a.t);
    if (hc && !cu.find(x => x.id === hc)) hc = null;
    const acct = id => (CUS.find(c => c.customer_id === id) || {}).account_type;
    k = [['Customers who spent', cu.length], ['Registered', cu.filter(c => acct(c.id) === 'Registered').length], ['Guests', cu.filter(c => acct(c.id) === 'Guest').length], ['Total spent', money(sum(cu.map(c => c.t)))]];
    body = wide('Customer spending') + '<div id="h2"></div>';
    post = () => {
      tb('h1', ['Customer', 'Total spent', ''], cu.map(x => [esc(x.n), money(x.t), `<button class="btn sm ${x.id === hc ? '' : 'line'}" data-h="${x.id}">View history</button>`]));
      const x = cu.find(y => y.id === hc);
      if (x) $('#h2').innerHTML = `<div class="card" style="margin-top:16px"><div class="row"><h3>Spending history: ${esc(x.n)}</h3><button class="btn sm line" data-x="1">Close</button></div><p class="mut" style="margin:4px 0 12px">${label}</p>
        <h3 style="font-size:14px">Studio rooms booked</h3><div class="tw">${tbl(['Booking', 'Studio', 'Date', 'Hours', 'Amount'], x.s.map(y => [y.booking_ref, esc(y.studio_name), shortDate(dOf(y.start_at)), String(Math.round(num(y.hours))), money(y.total_amount)]))}</div>
        <h3 style="font-size:14px;margin-top:14px">Equipment rented</h3><div class="tw">${tbl(['Equipment', 'Qty', 'Date', 'Amount'], x.q.map(y => [esc(y.equipment_name), String(y.quantity), shortDate(dOf(y.created_at)), money(lineIncome(y))]))}</div>
        <div class="tot"><span>Total spent</span><span>${money(x.t)}</span></div></div>`;
    };
  } else if (rt === 'Returns') {
    const done = RL.filter(l => l.line_returned_at && inR(dOf(l.line_returned_at)));
    const late = done.filter(l => lateDays(l) > 0).length, ontime = done.length - late;
    const ov = openLines().filter(l => l.days_overdue > 0);
    k = [['Returned on time', ontime], ['Returned late', late], ['Currently overdue', ov.length], ['On-time rate', done.length ? Math.round(ontime / done.length * 100) + '%' : '-']];
    body = card('Return status', 'Overdue days by equipment') + '<div class="card tw" style="margin-top:16px"><h3 style="margin-bottom:8px">Overdue rentals right now</h3><div id="h3"></div></div>';
    post = () => {
      hbs('h1', [['Returned on time', ontime, ontime], ['Returned late', late, late], ['Overdue now', ov.length, ov.length]]);
      const g = {}; ov.forEach(l => { g[l.equipment_name] = (g[l.equipment_name] || 0) + l.days_overdue * l.quantity; });
      hbs('h2', Object.entries(g).map(x => [x[0], pl(x[1], 'day'), x[1]]));
      tb('h3', ['Order', 'Customer', 'Equipment', 'Return by', 'Overdue'], ov.map(l => [esc(l.rental_type === 'Add-on' ? (l.booking_ref || l.rental_ref) : l.rental_ref), esc(l.customer_name), esc(l.equipment_name), dueLabel(l), dueB(l)]));
    };
  } else {
    k = [['Items in stock', sum(STK.map(e => e.total_quantity))], ['Available', sum(STK.map(e => e.available))], ['In use', sum(STK.map(e => e.in_use))], ['Low stock', STK.filter(e => e.stock_status === 'Low' || e.stock_status === 'In Use').length]];
    body = wide('Stock by equipment');
    post = () => tb('h1', ['Equipment', 'Total', 'Available', 'In use', 'Status'], STK.map(e => [esc(e.name), String(e.total_quantity), String(e.available), String(e.in_use), badge(e.stock_status)]));
  }

  $('#rp-p').style.opacity = inv ? .45 : 1;
  $('#rp-p').innerHTML = '<span class="mut" style="align-self:center;margin-right:4px">Period</span>' + ['Today', 'Week', 'Month', 'Custom'].map(x => `<button data-p="${x}" class="${x === rp ? 'on' : ''}">${x === 'Custom' ? 'Custom range' : x}</button>`).join('');
  $('#rp-t').innerHTML = '<span class="mut" style="align-self:center;margin-right:4px">Report</span>' + Object.keys(RT).map(x => `<button data-r="${x}" class="${x === rt ? 'on' : ''}">${x}</button>`).join('');
  $('#rp').innerHTML = `<div class="card" style="margin-bottom:16px"><h2>${rt} report</h2><p class="mut">${inv ? 'Current stock' : 'Showing ' + label}. ${RT[rt]}</p></div>` +
    (rp === 'Custom' && !inv ? `<div class="row" style="justify-content:flex-start;margin-bottom:16px"><input type="date" id="rp-from" value="${cFrom}" aria-label="From" style="max-width:170px"><input type="date" id="rp-to" value="${cTo}" aria-label="To" style="max-width:170px"><button class="btn sm" id="rp-apply">Apply</button></div>` : '') +
    `<div class="grid g4">${k.map(x => KPI(x[0], x[1])).join('')}</div>` + body;
  post();
}

$('#a-rep').addEventListener('click', e => {
  const x = e.target.closest('button'); if (!x) return;
  if (x.dataset.p) rp = x.dataset.p;
  else if (x.dataset.r) { rt = x.dataset.r; hc = null; }
  else if (x.dataset.h !== undefined) hc = +x.dataset.h;
  else if (x.dataset.x !== undefined) hc = null;
  else if (x.id === 'rp-apply') { cFrom = $('#rp-from').value || cFrom; cTo = $('#rp-to').value || cTo; }
  else return;
  renderReports();
});
