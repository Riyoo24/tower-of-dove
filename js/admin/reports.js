/* =====================================================================
   admin/reports.js - Reports tab (owner only)
   Period + type selector, income table, bars.
   ===================================================================== */

import { BK, CUS, DMG, REV, RL, STK, STU } from './data.js';
import { KPI, bkStatus, dOf, hbs, money, num, tOf, tb, tbl } from './helpers.js';
import { buildAnalytics, lineIncome } from './analytics.js';
import { csvDownload, plain, printSection, slug } from './export.js';
import { openLines } from './overview.js';
import { dueB, dueLabel, lateDays } from './rentals.js';
import { $, TODAY, badge, dayOffset, esc, pad, pl, shortDate, sum } from '../shared/utils.js';

/* ============================ 11. REPORTS ============================ */

let rp = 'Month', rt = 'Booking', cFrom = dayOffset(-30), cTo = TODAY, hc = null, cur = null;

const RT = {
    Booking: 'Total bookings, how many are confirmed, pending, completed or cancelled, and bookings per studio.',
    Sales: 'Verified payments for studio bookings and equipment, split by studio and by equipment. Damage fees are a separate line: they count only once they are Paid and are not part of the revenue above.',
    Rental: 'How often each item was rented and the income it earned (estimated from rental lines).',
    Customer: 'Customers who spent in this period and how much. Use View history for the details.',
    Inventory: 'Current stock for each item: available, in use and low stock. This is a snapshot, so the period filter does not apply.',
    Returns: 'Rentals returned on time or late, and equipment that is overdue right now.',
    Analytics: 'Revenue trend, busy times, studio utilisation, repeat customers and equipment usage. Days that have not happened yet are left out.'
};

function rangeOf() {
    if (rp === 'Today')
        return [TODAY, TODAY];
    if (rp === 'Week')
        return [dayOffset(-6), TODAY];
    if (rp === 'Month') {
        const y = +TODAY.slice(0, 4), m = +TODAY.slice(5, 7);
        return [`${y}-${pad(m)}-01`, `${y}-${pad(m)}-${pad(new Date(y, m, 0).getDate())}`];
    }
    return [cFrom <= cTo ? cFrom : cTo, cFrom <= cTo ? cTo : cFrom];
}

/* Used by the Overview bar chart: show the Booking report for one single day */
export function setReportDay(day) {
    rp = 'Custom';
    rt = 'Booking';
    cFrom = cTo = day;
    hc = null;
    renderReports();
}

export function renderReports() {
    const [lo, hi] = rangeOf(), inR = d => d >= lo && d <= hi, inv = rt === 'Inventory';
    const bks = BK.filter(b => inR(dOf(b.start_at)));
    const lines = RL.filter(l => !['Rejected', 'Cancelled'].includes(l.status) && inR(dOf(l.created_at)));
    const revs = REV.filter(r => inR(r.day));
    const label = lo === hi ? shortDate(lo) : shortDate(lo) + ' to ' + shortDate(hi);
    const card = (x, y) => `<div class="grid ge" style="margin-top:16px"><div class="card"><h3>${x}</h3><div id="h1"></div></div><div class="card"><h3>${y}</h3><div id="h2"></div></div></div>`;
    const wide = h => `<div class="card" style="margin-top:16px"><h3 style="margin-bottom:8px">${h}</h3><div id="h1"></div></div>`;
    let k = [], body = '', sec = [], post = () => {
    };

    if (rt === 'Booking') {
        const c = s => bks.filter(b => bkStatus(b.status) === s).length;
        const st = [
            ['Completed', c('Completed')],
            ['Confirmed', c('Confirmed') + c('Active')],
            ['Pending', c('Pending')],
            ['Cancelled', c('Cancelled') + c('Rejected')]
        ];
        k = [
            ['Total bookings', bks.length],
            ['Confirmed', st[1][1]],
            ['Pending', st[2][1]],
            ['Completed', st[0][1]],
            ['Cancelled', st[3][1]]
        ];
        body = card('Bookings by status', 'Bookings by studio');
        sec = [
            { title: 'Bookings by status', head: ['Status', 'Bookings'], rows: st.map(x => [x[0], x[1]]) },
            { title: 'Bookings by studio', head: ['Studio', 'Bookings'], rows: STU.map(s => [s.name, bks.filter(b => b.studio_id === s.studio_id).length]) },
            {
                title: 'Booking list',
                head: ['Reference', 'Customer', 'Studio', 'Date', 'Start', 'Hours', 'Status', 'Source', 'Payment status', 'Total (PHP)', 'Balance due (PHP)'],
                rows: bks.slice().sort((a, b) => new Date(a.start_at) - new Date(b.start_at)).map(b => [b.booking_ref, b.customer_name, b.studio_name, dOf(b.start_at), tOf(b.start_at), Math.round(num(b.hours)), bkStatus(b.status), b.source || '', b.payment_status || '', num(b.total_amount), num(b.balance_due)])
            }
        ];
        post = () => {
            hbs('h1', st.map(x => [x[0], x[1], x[1]]));
            hbs('h2', STU.map(s => {
                const n = bks.filter(b => b.studio_id === s.studio_id).length;
                return [s.name, n, n];
            }));
        };
    } else if (rt === 'Sales') {
        const sv = sum(revs.filter(r => r.kind === 'Studio').map(r => num(r.amount))),
            ev = sum(revs.filter(r => r.kind === 'Equipment').map(r => num(r.amount)));
        // damage fees: money OWED until Paid, so only fees paid in this period are counted, on their own line
        const dmgPaid = DMG.filter(d => d.status === 'Paid' && d.paid_at && inR(dOf(d.paid_at)));
        const dmgOwed = DMG.filter(d => ['Unpaid', 'Pending'].includes(d.status) && num(d.amount) > 0);
        k = [['Studio revenue', money(sv)], ['Equipment revenue', money(ev)], ['Total revenue', money(sv + ev)],
            ['Damage fees collected', money(sum(dmgPaid.map(d => num(d.amount))))], ['Damage fees still unpaid', money(sum(dmgOwed.map(d => num(d.amount))))]];
        sec = [
            { title: 'Revenue by studio (PHP)', head: ['Studio', 'Revenue'], rows: STU.map(s => [s.name, sum(revs.filter(r => r.kind === 'Studio' && r.studio_name === s.name).map(r => num(r.amount)))]) },
            { title: 'Estimated rental income by equipment (PHP)', head: ['Equipment', 'Income'], rows: STK.map(e => [e.name, Math.round(sum(lines.filter(l => l.equipment_id === e.equipment_id).map(lineIncome)) * 100) / 100]).filter(x => x[1] > 0) },
            { title: 'Verified payments by day (PHP)', head: ['Day', 'Type', 'Studio', 'Amount', 'Payments'], rows: revs.slice().sort((a, b) => a.day < b.day ? -1 : 1).map(r => [r.day, r.kind, r.studio_name || '', num(r.amount), num(r.payments)]) },
            { title: 'Damage fees paid in this period (PHP)', head: ['Rental', 'Customer', 'Item', 'Quantity', 'Fee', 'Paid by', 'Paid on'], rows: dmgPaid.map(d => [d.rental_ref, d.customer_name, d.equipment_name, d.quantity, num(d.amount), d.paid_method || '', dOf(d.paid_at)]) }
        ];
        body = card('Revenue by studio', 'Estimated rental income by equipment')
            + '<div class="card" style="margin-top:16px"><h3 style="margin-bottom:8px">Damage fees paid in this period</h3><div id="h3"></div></div>';
        post = () => {
            tb('h3', ['Rental', 'Customer', 'Item', 'Fee', 'Paid by', 'Paid on'], dmgPaid.map(d => [
                esc(d.rental_ref), esc(d.customer_name), esc(d.equipment_name) + ' x' + d.quantity, money(d.amount),
                esc(d.paid_method || '-'), shortDate(dOf(d.paid_at))
            ]));
            hbs('h1', STU.map(s => {
                const v = sum(revs.filter(r => r.kind === 'Studio' && r.studio_name === s.name).map(r => num(r.amount)));
                return [s.name, money(v), v];
            }));
            hbs('h2', STK.map(e => {
                const v = sum(lines.filter(l => l.equipment_id === e.equipment_id).map(lineIncome));
                return [e.name, money(v), v];
            }).filter(x => x[2] > 0));
        };
    } else if (rt === 'Rental') {
        const by = STK.map(e => {
            const ls = lines.filter(l => l.equipment_id === e.equipment_id);
            return {
                n: e.name,
                cat: e.category_name || '',
                times: sum(ls.map(l => l.quantity)),
                income: sum(ls.map(lineIncome))
            };
        }).filter(x => x.times > 0).sort((a, b) => b.times - a.times);
        k = [
            ['Items rented', sum(by.map(x => x.times))],
            ['Rental income', money(sum(by.map(x => x.income)))],
            ['Most rented', by.length ? esc(by[0].n) : 'None', by.length && by[0].cat ? `<span class="so-cat">${esc(by[0].cat)}</span>` : '']
        ];
        sec = [{ title: 'Rental activity', head: ['Equipment', 'Category', 'Times rented', 'Income (PHP)'], rows: by.map(x => [x.n, x.cat, x.times, Math.round(x.income * 100) / 100]) }];
        body = wide('Rental activity');
        post = () => tb('h1', ['Equipment', 'Category', 'Times rented', 'Income'], by.map(x => [esc(x.n), x.cat ? `<span class="so-cat">${esc(x.cat)}</span>` : '-', String(x.times), money(x.income)]));
    } else if (rt === 'Customer') {
        const sp = {};
        const get = (id, n) => (sp[id] = sp[id] || {
            id,
            n,
            s: [],
            q: [],
            ss: 0,
            qs: 0
        });
        bks.filter(b => b.payment_status === 'Verified').forEach(b => {
            const c = get(b.customer_id, b.customer_name);
            c.s.push(b);
            c.ss += num(b.total_amount);
        });
        lines.forEach(l => {
            const c = get(l.customer_id, l.customer_name);
            c.q.push(l);
            c.qs += lineIncome(l);
        });
        const cu = Object.values(sp).map(c => ({
            ...c,
            t: c.ss + c.qs
        })).filter(c => c.t > 0).sort((a, b) => b.t - a.t);
        if (hc && !cu.find(x => x.id === hc))
            hc = null;
        const acct = id => (CUS.find(c => c.customer_id === id) || {}).account_type;
        k = [
            ['Customers who spent', cu.length],
            ['Registered', cu.filter(c => acct(c.id) === 'Registered').length],
            ['Guests', cu.filter(c => acct(c.id) === 'Guest').length],
            ['Total spent', money(sum(cu.map(c => c.t)))]
        ];
        sec = [{ title: 'Customer spending', head: ['Customer', 'Account', 'Studio bookings (PHP)', 'Equipment (PHP)', 'Total spent (PHP)'], rows: cu.map(c => [c.n, acct(c.id) || '', c.ss, Math.round(c.qs * 100) / 100, Math.round(c.t * 100) / 100]) }];
        body = wide('Customer spending') + '<div id="h2"></div>';
        post = () => {
            tb('h1', ['Customer', 'Total spent', ''], cu.map(x => [
                esc(x.n),
                money(x.t),
                `<button class="btn sm ${x.id === hc ? '' : 'line'}" data-h="${x.id}">View history</button>`
            ]));
            const x = cu.find(y => y.id === hc);
            if (x)
                $('#h2').innerHTML = `<div class="card" style="margin-top:16px"><div class="row"><h3>Spending history: ${esc(x.n)}</h3><button class="btn sm line" data-x="1">Close</button></div><p class="mut" style="margin:4px 0 12px">${label}</p>
        <h3 style="font-size:14px">Studio rooms booked</h3>${tbl(['Booking', 'Studio', 'Date', 'Hours', 'Amount'], x.s.map(y => [
                    y.booking_ref,
                    esc(y.studio_name),
                    shortDate(dOf(y.start_at)),
                    String(Math.round(num(y.hours))),
                    money(y.total_amount)
                ]))}
        <h3 style="font-size:14px;margin-top:14px">Equipment rented</h3>${tbl(['Equipment', 'Qty', 'Date', 'Amount'], x.q.map(y => [esc(y.equipment_name), String(y.quantity), shortDate(dOf(y.created_at)), money(lineIncome(y))]))}
        <div class="tot"><span>Total spent</span><span>${money(x.t)}</span></div></div>`;
        };
    } else if (rt === 'Returns') {
        const done = RL.filter(l => l.line_returned_at && inR(dOf(l.line_returned_at)));
        const late = done.filter(l => lateDays(l) > 0).length, ontime = done.length - late;
        const ov = openLines().filter(l => l.days_overdue > 0);
        k = [
            ['Returned on time', ontime],
            ['Returned late', late],
            ['Currently overdue', ov.length],
            ['On-time rate', done.length ? Math.round(ontime / done.length * 100) + '%' : '-']
        ];
        sec = [
            { title: 'Return status', head: ['Status', 'Count'], rows: [['Returned on time', ontime], ['Returned late', late], ['Overdue now', ov.length]] },
            { title: 'Overdue rentals right now', head: ['Order', 'Customer', 'Equipment', 'Quantity', 'Days overdue'], rows: ov.map(l => [l.rental_type === 'Add-on' ? (l.booking_ref || l.rental_ref) : l.rental_ref, l.customer_name, l.equipment_name, l.quantity, l.days_overdue]) }
        ];
        body = card('Return status', 'Overdue days by equipment')
            + '<div class="card" style="margin-top:16px"><h3 style="margin-bottom:8px">Overdue rentals right now</h3><div id="h3"></div></div>';
        post = () => {
            hbs('h1', [
                ['Returned on time', ontime, ontime],
                ['Returned late', late, late],
                ['Overdue now', ov.length, ov.length]
            ]);
            const g = {};
            ov.forEach(l => {
                g[l.equipment_name] = (g[l.equipment_name] || 0) + l.days_overdue * l.quantity;
            });
            hbs('h2', Object.entries(g).map(x => [x[0], pl(x[1], 'day'), x[1]]));
            tb('h3', ['Order', 'Customer', 'Equipment', 'Return by', 'Overdue'], ov.map(l => [
                esc(l.rental_type === 'Add-on' ? (l.booking_ref || l.rental_ref) : l.rental_ref),
                esc(l.customer_name),
                esc(l.equipment_name),
                dueLabel(l),
                dueB(l)
            ]));
        };
    } else if (rt === 'Analytics') {
        const an = buildAnalytics(lo, hi);
        k = an.k;
        sec = an.sections;
        body = an.html;
    } else {
        k = [
            ['Items in stock', sum(STK.map(e => e.total_quantity))],
            ['Available', sum(STK.map(e => e.available))],
            ['In use', sum(STK.map(e => e.in_use))],
            ['Low stock', STK.filter(e => e.stock_status === 'Low' || e.stock_status === 'In Use' || e.stock_status === 'Out of Stock').length]
        ];
        sec = [{ title: 'Stock by equipment', head: ['Equipment', 'Total', 'Available', 'In use', 'Status'], rows: STK.map(e => [e.name, e.total_quantity, e.available, e.in_use, e.stock_status]) }];
        body = wide('Stock by equipment');
        post = () => tb('h1', ['Equipment', 'Total', 'Available', 'In use', 'Status'], STK.map(e => [
            esc(e.name),
            String(e.total_quantity),
            String(e.available),
            String(e.in_use),
            badge(e.stock_status)
        ]));
    }

    $('#rp-p').style.opacity = inv ? .45 : 1;
    $('#rp-p').innerHTML = '<span class="mut" style="align-self:center;margin-right:4px">Period</span>'
        + ['Today', 'Week', 'Month', 'Custom'].map(x => `<button data-p="${x}" class="${x === rp ? 'on' : ''}">${x === 'Custom' ? 'Custom range' : x}</button>`).join('');
    $('#rp-t').innerHTML = '<span class="mut" style="align-self:center;margin-right:4px">Report</span>'
        + Object.keys(RT).map(x => `<button data-r="${x}" class="${x === rt ? 'on' : ''}">${x}</button>`).join('');
    cur = { name: `tower-of-dove-${slug(rt)}-report-${inv ? TODAY : lo + (lo === hi ? '' : '_to_' + hi)}.csv`, title: rt + ' report', label: inv ? 'Current stock' : label, k, sec };
    $('#rp').innerHTML = `<div class="print-head rp-head" aria-hidden="true"><b>Tower of Dove Music Studio</b><span>${esc(rt)} report &middot; ${esc(cur.label)} &middot; created ${esc(new Date().toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Manila' }))}</span></div>`
        + `<div class="card" style="margin-bottom:16px"><div class="row" style="align-items:flex-start;gap:12px;flex-wrap:wrap"><div style="min-width:0;flex:1 1 320px"><h2>${rt} report</h2><p class="mut">${inv ? 'Current stock' : 'Showing ' + label}. ${RT[rt]}</p></div>`
        + `<div class="rp-export no-print"><button class="btn sm line" data-exp="csv" title="Download this report as a spreadsheet file">Download CSV</button><button class="btn sm line" data-exp="pdf" title="Opens the print window. Choose Save as PDF as the printer.">Save as PDF</button></div></div></div>` +
        (rp === 'Custom' && !inv ? `<div class="row" style="justify-content:flex-start;margin-bottom:16px"><input type="date" id="rp-from" value="${cFrom}" aria-label="From" style="max-width:170px"><input type="date" id="rp-to" value="${cTo}" aria-label="To" style="max-width:170px"><button class="btn sm" id="rp-apply">Apply</button></div>` : '') +
        `<div class="grid g4">${k.map(x => KPI(x[0], x[1], null, x[2])).join('')}</div>`
        + body;
    post();
}

$('#a-rep').addEventListener('click', e => {
    const x = e.target.closest('button');
    if (!x)
        return;
    if (x.dataset.exp) {
        if (!cur)
            return;
        if (x.dataset.exp === 'pdf')
            return printSection($('#a-rep'));
        const kpis = { title: 'Summary', head: ['Metric', 'Value'], rows: cur.k.map(y => [y[0], plain(y[1])]) };
        const hasSummary = cur.sec.some(y => y.title === 'Summary');
        return csvDownload(cur.name, hasSummary ? cur.sec : [kpis, ...cur.sec], [['Tower of Dove Music Studio'], [cur.title], ['Period', cur.label], ['Created', new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' })]]);
    }
    if (x.dataset.p)
        rp = x.dataset.p;
    else if (x.dataset.r) {
        rt = x.dataset.r;
        hc = null;
    }
    else if (x.dataset.h !== undefined)
        hc = +x.dataset.h;
    else if (x.dataset.x !== undefined)
        hc = null;
    else if (x.id === 'rp-apply') {
        cFrom = $('#rp-from').value || cFrom;
        cTo = $('#rp-to').value || cTo;
    }
    else
        return;
    renderReports();
});
