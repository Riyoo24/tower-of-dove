/* =====================================================================
   admin/analytics.js - the "Analytics" report (owner only): revenue trend, busy times, studio
   utilisation, repeat customers and equipment usage for the period chosen on the Reports tab.
   buildAnalytics(lo, hi) -> { k, html, sections }  (k = the KPI cards, sections = the same numbers for the CSV file)
   Future days are left out, so a month that is half over is not judged against days that have not happened.
   ===================================================================== */

import { BK, RL, REV, STK, STU } from './data.js';
import { money, num } from './helpers.js';
import { hbars, heatmap, vbars } from './charts.js';
import { TODAY, esc, manilaParts, shortDate, sum } from '../shared/utils.js';

const OPEN = 10, CLOSE = 22;                       // studio hours: first start 10 AM, last booking ends 10 PM
const HOURS = Array.from({ length: CLOSE - OPEN }, (_, i) => OPEN + i);
const COUNTED = ['Approved', 'In Progress', 'Completed'];   // bookings that really use a room
const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const addDays = (iso, n) => {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
};
const dow = iso => (new Date(iso + 'T00:00:00Z').getUTCDay() + 6) % 7;   // Monday = 0
const hourLabel = h => (h % 12 || 12) + (h < 12 ? ' AM' : ' PM');
const pct = (a, b) => b ? Math.round(a / b * 100) : 0;

/* estimated income of one rental line: outside rentals = price x hours / 8 (8 hours minimum) */
export function lineIncome(l) {
    const f = l.rental_type === 'Outside' ? Math.max(8, Math.ceil(num(l.rental_hours) || 8)) / 8 : 1;
    return num(l.unit_price_at_request) * l.quantity * f + num(l.late_fee);
}

/* where a booking sits in the day: { day, hour (whole start hour), len (hours) } */
export function spanOf(b) {
    const p = manilaParts(b.start_at);
    const ms = new Date(b.end_at) - new Date(b.start_at);
    const len = Math.max(1, Math.round((Number.isFinite(ms) && ms > 0 ? ms / 36e5 : num(b.hours)) || 1));
    return { day: p.date, hour: p.hour, min: p.minute, len };
}

export function buildAnalytics(lo, hiWanted) {
    const hi = hiWanted > TODAY ? TODAY : hiWanted;
    const days = [];
    for (let d = lo; d <= hi && days.length < 400; d = addDays(d, 1))
        days.push(d);
    const inR = d => d >= lo && d <= hi;

    /* ---- studio use: every booked hour counted once per studio ---- */
    const spans = BK.filter(b => COUNTED.includes(b.status)).map(b => ({ b, ...spanOf(b) })).filter(s => inR(s.day));
    const heat = WEEK.map(() => HOURS.map(() => 0));
    const perStudio = new Map();
    spans.forEach(s => {
        for (let h = s.hour; h < s.hour + s.len; h++) {
            if (h < OPEN || h >= CLOSE)
                continue;
            heat[dow(s.day)][h - OPEN]++;
            perStudio.set(s.b.studio_id, (perStudio.get(s.b.studio_id) || 0) + 1);
        }
    });
    const bookedHours = sum([...perStudio.values()]);
    const studios = STU.filter(s => s.status === 'Available' || perStudio.has(s.studio_id));
    const perStudioHours = days.length * HOURS.length;
    const util = studios.map(s => {
        const booked = perStudio.get(s.studio_id) || 0;
        return { name: s.name, booked, avail: perStudioHours, p: pct(booked, perStudioHours) };
    });
    const utilAll = pct(bookedHours, perStudioHours * studios.length);
    const byHour = HOURS.map((h, i) => sum(heat.map(r => r[i])));
    const byDow = heat.map(r => sum(r));
    const peakH = byHour.some(Boolean) ? HOURS[byHour.indexOf(Math.max(...byHour))] : null;
    const peakD = byDow.some(Boolean) ? byDow.indexOf(Math.max(...byDow)) : null;

    /* ---- revenue trend: one bar per day, or per week for a long period ---- */
    const revs = REV.filter(r => inR(r.day));
    const total = sum(revs.map(r => num(r.amount)));
    const weekly = days.length > 45;
    const trend = [];
    for (let i = 0; i < days.length; i += weekly ? 7 : 1) {
        const from = days[i], to = days[Math.min(i + (weekly ? 6 : 0), days.length - 1)];
        const v = sum(revs.filter(r => r.day >= from && r.day <= to).map(r => num(r.amount)));
        const label = shortDate(from);
        trend.push({ label, v, tip: `${weekly ? label + ' to ' + shortDate(to) : label}: ${money(v)}` });
    }

    /* ---- repeat customers: booked 2 or more times (all history loaded) ---- */
    const allCount = new Map();
    BK.filter(b => COUNTED.includes(b.status)).forEach(b => allCount.set(b.customer_id, (allCount.get(b.customer_id) || 0) + 1));
    const cust = new Map();
    spans.forEach(s => {
        const c = cust.get(s.b.customer_id) || { name: s.b.customer_name, n: 0, hrs: 0 };
        c.n++;
        c.hrs += s.len;
        cust.set(s.b.customer_id, c);
    });
    const people = [...cust.entries()].map(([id, c]) => ({ ...c, all: allCount.get(id) || c.n }));
    const repeat = people.filter(c => c.all >= 2);
    const repeatRate = pct(repeat.length, people.length);
    people.sort((a, b) => b.all - a.all || b.n - a.n);

    /* ---- equipment usage (rental lines created in the period) ---- */
    const lines = RL.filter(l => !['Rejected', 'Cancelled'].includes(l.status) && inR(manilaParts(l.created_at).date));
    const eq = STK.map(e => {
        const ls = lines.filter(l => l.equipment_id === e.equipment_id);
        return { n: e.name, cat: e.category_name || '', times: sum(ls.map(l => l.quantity)), income: sum(ls.map(lineIncome)) };
    }).sort((a, b) => b.times - a.times || b.income - a.income);
    const eqUsed = eq.filter(x => x.times > 0);

    /* ---- KPI cards ---- */
    const k = [
        ['Revenue', money(total), days.length ? `${money(total / days.length)} per day` : ''],
        ['Hours booked', bookedHours, `${spans.length} bookings`],
        ['Studio utilisation', utilAll + '%', `of ${HOURS.length} open hours per studio per day`],
        ['Repeat-customer rate', people.length ? repeatRate + '%' : '-', `${repeat.length} of ${people.length} customers booked 2+ times`],
        ['Peak hour', peakH === null ? '-' : hourLabel(peakH), peakH === null ? '' : `${byHour[peakH - OPEN]} booked hours in total`],
        ['Busiest day', peakD === null ? '-' : WEEK[peakD], peakD === null ? '' : `${byDow[peakD]} booked hours in total`]
    ];

    /* ---- screen ---- */
    const card = (h, body, note) => `<div class="card"><h3>${h}</h3>${note ? `<p class="mut" style="margin:2px 0 8px">${note}</p>` : ''}${body}</div>`;
    const html = `
      ${days.length ? '' : '<p class="mut" style="margin-top:16px">This period has not started yet.</p>'}
      <div style="margin-top:16px">${card('Revenue trend', vbars(trend, money), `Verified payments per ${weekly ? 'week' : 'day'}, studio and equipment together.`)}</div>
      <div style="margin-top:16px">${card('Busy times', heatmap(HOURS.map(h => (h % 12 || 12) + (h < 12 ? 'a' : 'p')), WEEK.map((d, i) => ({ label: d, cells: heat[i] }))), 'Booked room-hours by weekday and start hour. Darker means busier, so the pale cells are your gaps.')}</div>
      <div class="grid ge" style="margin-top:16px">
        ${card('Studio utilisation', hbars(util.map(u => [u.name, `${u.p}% (${u.booked} of ${u.avail} h)`, u.p])), 'Booked hours divided by open hours.')}
        ${card('Repeat customers', hbars([['Booked once', String(people.length - repeat.length), people.length - repeat.length], ['Booked 2+ times', String(repeat.length), repeat.length]]) + `<p class="mut" style="margin-top:10px">Based on confirmed, active and completed bookings.</p>`)}
      </div>
      <div class="grid ge" style="margin-top:16px">
        ${card('Equipment usage', hbars(eqUsed.slice(0, 8).map(x => [x.n, `${x.times} rented`, x.times])), `${eqUsed.length} of ${eq.length} items were rented in this period.`)}
        ${card('Most loyal customers', people.length ? `<div class="tw"><table><thead><tr><th>Customer</th><th>In period</th><th>All time</th></tr></thead><tbody>${people.slice(0, 6).map(c => `<tr><td>${esc(c.name)}</td><td>${c.n}</td><td>${c.all}</td></tr>`).join('')}</tbody></table></div>` : '<p class="mut">Nothing in this period.</p>')}
      </div>`;

    /* ---- the same numbers for the CSV file ---- */
    const sections = [
        { title: 'Summary', head: ['Metric', 'Value'], rows: k.map(x => [x[0], String(x[1]).replace(/<[^>]*>/g, '')]) },
        { title: weekly ? 'Revenue per week (PHP)' : 'Revenue per day (PHP)', head: [weekly ? 'Week starting' : 'Day', 'Revenue'], rows: trend.map((t, i) => [days[i * (weekly ? 7 : 1)], Math.round(t.v * 100) / 100]) },
        { title: 'Booked room-hours by weekday and hour', head: ['Day', ...HOURS.map(hourLabel)], rows: WEEK.map((d, i) => [d, ...heat[i]]) },
        { title: 'Studio utilisation', head: ['Studio', 'Booked hours', 'Open hours', 'Utilisation %'], rows: util.map(u => [u.name, u.booked, u.avail, u.p]) },
        { title: 'Customers in this period', head: ['Customer', 'Bookings in period', 'Bookings all time', 'Hours booked', 'Repeat customer'], rows: people.map(c => [c.name, c.n, c.all, c.hrs, c.all >= 2 ? 'Yes' : 'No']) },
        { title: 'Equipment usage', head: ['Equipment', 'Category', 'Times rented', 'Estimated income (PHP)'], rows: eq.map(x => [x.n, x.cat, x.times, Math.round(x.income * 100) / 100]) }
    ];
    return { k, html, sections, hi };
}
