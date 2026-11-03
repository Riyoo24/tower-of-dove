/* =====================================================================
   admin/overview.js - Overview tab (KPIs, last 7 days, studios now, needs attention)

   ===================================================================== */

import { setBookingFilter } from './bookings.js';
import { setRentalFilter } from './rentals.js';
import { setReportDay } from './reports.js';
import { BK, CNT, RL, STK, STU } from './data.js';
import { KPI, OWNER, dOf, num, tOf } from './helpers.js';
import { $, TODAY, badge, dayOffset, esc, pl, shortDate, sum } from '../shared/utils.js';

/* ============================ 3. OVERVIEW, BOOKINGS, PAYMENTS ============================ */

export const openLines = () => RL.filter(l => l.status === 'Active' && !l.line_returned_at);

export const dueToday = l => l.due_at && dOf(l.due_at) === TODAY && !(l.days_overdue > 0);

const itemCount = a => pl(sum(a.map(l => l.quantity)), 'item');

export function renderOverview() {
    $('#a-over .sub').textContent = new Date().toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric'
    })
        + '. Here is what is happening right now.';
    $('#ovk').innerHTML = KPI('Total bookings', num(CNT.total_bookings), '', '', 'bk:All') + KPI("Today's bookings", num(CNT.todays_bookings), '', '', 'bk:Today') +
        KPI('Confirmed', num(CNT.confirmed_bookings), '', '', 'bk:Confirmed')
        + KPI('Pending', num(CNT.pending_bookings), '', '', 'bk:Pending');

    const days = Array.from({ length: 7 }, (_, i) => dayOffset(i - 6));
    const counts = days.map(d => BK.filter(b => dOf(b.start_at) === d && !['Cancelled', 'Rejected'].includes(b.status)).length);
    const max = Math.max(...counts, 1);
    $('#bars').innerHTML = counts.map((v, i) => `<div${OWNER ? ` class="go" data-go="rp:${days[i]}" role="link" tabindex="0" aria-label="${shortDate(days[i])}: ${pl(v, 'booking')}. Open report"` : ''}><i class="${i === 6 ? 'hi' : ''}" style="height:${Math.max(4, Math.round(v / max * 100))}px"></i>${v}<br>${shortDate(days[i])}</div>`).join('');

    const open = openLines();
    const overdue = open.filter(l => l.days_overdue > 0), due = open.filter(dueToday);
    const back = RL.filter(l => l.line_returned_at && dOf(l.line_returned_at) === TODAY);
    $('#rkpi').innerHTML =
        KPI('Overdue rentals', overdue.length, 'var(--bad)', itemCount(overdue) + ' past return date', 'rn:Overdue') +
        KPI('To return today', due.length, 'var(--warn)', itemCount(due) + ' still to come back', 'rn:Due today') +
        KPI('Returned today', back.length, 'var(--ok)', itemCount(back) + ' checked in', 'rn:Returned');

    const now = Date.now();
    $('#ost').innerHTML = STU.map(s => {
        const live = BK.find(b => b.studio_id === s.studio_id && b.status === 'In Progress');
        const next = BK.filter(b => b.studio_id === s.studio_id && b.status === 'Approved' && new Date(b.start_at) > now)
            .sort((a, b) => new Date(a.start_at) - new Date(b.start_at))[0];
        const status = live ? 'Occupied' : s.status;
        const text = live ? `${esc(live.customer_name)}, until ${tOf(live.end_at)}`
            : s.status !== 'Available' ? 'Not taking bookings'
                : next ? `Next: ${dOf(next.start_at) === TODAY ? '' : shortDate(dOf(next.start_at)) + ', '}${tOf(next.start_at)}, ${esc(next.customer_name)}` : 'No upcoming bookings';
        return `<div class="card go" data-go="ss" role="link" tabindex="0" aria-label="${esc(s.name)}: open Studio sessions"><div class="row"><h3><i class="lamp ${live ? 'live' : ''}"></i>${esc(s.name)}</h3>${badge(status)}</div><p class="mut" style="margin-top:6px">${text}</p></div>`;
    }).join('');

    const low = STK.filter(e => e.stock_status === 'Low' || e.stock_status === 'In Use').map(e => e.name + (e.stock_status === 'In Use' ? ' (none left)' : ''));
    $('#ovl').innerHTML =
        `<li><span>Pending payments</span><b>${num(CNT.pending_payments)}</b></li>` +
        `<li><span>Rental requests to review</span><b>${num(CNT.rental_requests)}</b></li>` +
        `<li><span>Active sessions</span><b>${num(CNT.active_sessions)}</b></li>` +
        `<li><span>Equipment currently rented</span><b>${itemCount(open)}</b></li>` +
        `<li><span>Overdue rentals</span><b style="color:var(--bad)">${new Set(overdue.map(l => l.rental_ref)).size}</b></li>` +
        `<li><span>Low-stock equipment</span><b>${esc(low.join(', ') || 'None')}</b></li>`;

    updateNavBadges();
}

/* Sidebar badges.
   Rentals: requests to review + outside rentals whose pick-up time has come (still to be issued) + outside rentals whose return time has come (add-ons are not included).
   Payment: payments waiting to be verified. Bookings: pending bookings. */
export function updateNavBadges() {
    const now = Date.now();
    const startDue = new Set(), returnDue = new Set();
    RL.forEach(l => {
        if (l.rental_type !== 'Outside')
            return;   // add-ons ride on their booking's session, so they do not raise this alert
        if (l.status === 'Approved') {
            if (l.pickup_date && new Date(l.pickup_date).getTime() <= now)
                startDue.add(l.rental_ref);   // pick-up time has come, not issued yet
        } else if (l.status === 'Active' && !l.line_returned_at && l.due_at && new Date(l.due_at).getTime() <= now) {
            returnDue.add(l.rental_ref);   // return time has come
        }
    });
    [['#rcnt', num(CNT.rental_requests) + startDue.size + returnDue.size], ['#pcnt', num(CNT.pending_payments)], ['#bcnt', num(CNT.pending_bookings)]].forEach(([id, n]) => {
        const c = $(id);
        if (c) {
            c.textContent = n;
            c.hidden = !n;
        }
    });
}


/* ---- Overview cards are shortcuts: set the filter first, then open the tab ---- */
function goFromCard(code) {
    const [kind, arg] = code.split(':');
    if (kind === 'bk') {
        setBookingFilter(arg === 'Today' ? 'All' : arg, arg === 'Today' ? TODAY : '', arg === 'All');   // the Total bookings card also opens Past and closed
        location.hash = 'a-book';
    } else if (kind === 'rn') {
        setRentalFilter(arg);
        location.hash = 'a-rent';
    } else if (kind === 'rp') {
        setReportDay(arg);   // Reports is owner-only; the bars are only clickable for the owner
        location.hash = 'a-rep';
    } else if (kind === 'ss') {
        location.hash = 'a-sess';
    }
}

const ovPage = $('#a-over');
ovPage.addEventListener('click', e => {
    const c = e.target.closest('[data-go]');
    if (c)
        goFromCard(c.dataset.go);
});
ovPage.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ')
        return;
    const c = e.target.closest('[data-go]');
    if (!c)
        return;
    e.preventDefault();
    goFromCard(c.dataset.go);
});
