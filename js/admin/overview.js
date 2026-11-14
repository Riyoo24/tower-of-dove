/* =====================================================================
   admin/overview.js - Overview tab (KPIs, last 7 days, studios now, needs attention)

   ===================================================================== */

import { notifyBadgeCounts } from './alerts.js';
import { setBookingFilter } from './bookings.js';
import { setRentalFilter } from './rentals.js';
import { setReportDay } from './reports.js';
import { BK, CNT, DMG, RL, STK, STU } from './data.js';
import { dmgOwed, dmgStatus } from './damage.js';

/* late fees that were left unpaid at the return: refs still owed (unpaid), refs whose GCash payment staff must check (pending), and the total */
export function openLateFees() {
    const open = RL.filter(l => l.late_fee_deferred && !l.late_fee_paid_at && num(l.late_fee) > 0);
    return {
        refs: new Set(open.map(l => l.rental_ref)),
        pending: new Set(open.filter(l => l.late_fee_pending_reference).map(l => l.rental_ref)),
        unpaid: new Set(open.filter(l => !l.late_fee_pending_reference).map(l => l.rental_ref)),
        amount: sum(open.map(l => num(l.late_fee)))
    };
}
import { KPI, OWNER, dOf, money, num, tOf } from './helpers.js';
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
    /* Same markup as before. Extras for phones only (admin.css): --r (bar share of the max), .bn (count) and .bm (month). */
    const dateHtml = d => {
        const sd = shortDate(d), i = sd.lastIndexOf(' ');
        return i > 0 ? `<span class="bm">${sd.slice(0, i + 1)}</span>${sd.slice(i + 1)}` : sd;
    };
    $('#bars').innerHTML = counts.map((v, i) => `<div${OWNER ? ` class="go" data-go="rp:${days[i]}" role="link" tabindex="0" aria-label="${shortDate(days[i])}: ${pl(v, 'booking')}. Open report"` : ''}><i class="${i === 6 ? 'hi' : ''}" style="height:${Math.max(4, Math.round(v / max * 100))}px;--r:${(v / max).toFixed(3)}"></i><span class="bn">${v}</span><br>${dateHtml(days[i])}</div>`).join('');

    const open = openLines();
    const overdue = open.filter(l => l.days_overdue > 0), due = open.filter(dueToday);
    const back = RL.filter(l => l.line_returned_at && dOf(l.line_returned_at) === TODAY);
    $('#rkpi').innerHTML =
        KPI('Overdue rentals', overdue.length, 'var(--bad)', itemCount(overdue) + ' past return date', 'rn:Overdue') +
        KPI('To return today', due.length, 'var(--warn)', itemCount(due) + ' still to come back', 'rn:Due today') +
        KPI('Returned today', back.length, 'var(--ok)', itemCount(back) + ' checked in', 'rn:Returned');

    const unpaidDmg = new Set(DMG.filter(d => ['Unpaid', 'Pending'].includes(d.status) && num(d.amount) > 0).map(d => d.rental_ref));
    const lateOpen = openLateFees();   // late fees left unpaid at the return (83_late_fee_collection.sql)
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

    const low = STK.filter(e => e.stock_status === 'Low' || e.stock_status === 'In Use' || e.stock_status === 'Out of Stock').map(e => e.name + (e.stock_status === 'In Use' || e.stock_status === 'Out of Stock' ? ' (none left)' : ''));
        /* each row opens the tab where the work is done; rows with something to do are coloured, zeros fade back */
    const na = (label, value, count, go, tone) => `<li class="na${count ? ' on ' + tone : ''}" data-go="${go}" role="link" tabindex="0" aria-label="${esc(label)}: ${esc(String(value))}. Click to view"><span>${esc(label)}</span><b>${esc(String(value))}<i class="na-ch" aria-hidden="true">&rsaquo;</i></b></li>`;
    const overdueOrders = new Set(overdue.map(l => l.rental_ref)).size;
    $('#ovl').innerHTML =
        na('Pending payments', num(CNT.pending_payments), num(CNT.pending_payments), 'tab:a-pay', 'warn') +
        na('Unpaid damage fees', unpaidDmg.size ? unpaidDmg.size + ' (' + money(sum([...unpaidDmg].map(dmgOwed))) + ')' : 'None', unpaidDmg.size, 'tab:a-pay', 'warn') +
        na('Unpaid late fees', lateOpen.refs.size ? lateOpen.refs.size + ' (' + money(lateOpen.amount) + ')' : 'None', lateOpen.refs.size, 'tab:a-pay', 'warn') +
        na('Rental requests to review', num(CNT.rental_requests), num(CNT.rental_requests), 'tab:a-rent', 'warn') +
        na('Active sessions', num(CNT.active_sessions), num(CNT.active_sessions), 'tab:a-sess', 'info') +
        na('Equipment currently rented', itemCount(open), open.length, 'tab:a-rent', 'info') +
        na('Overdue rentals', overdueOrders, overdueOrders, 'rn:Overdue', 'bad') +
        na('Low-stock equipment', low.join(', ') || 'None', low.length, 'tab:a-eqp', 'warn');
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
    const counts = {};
    // damage fees the customer still owes (an unpaid fee keeps the Payment badge lit until it is collected)
    const late = openLateFees();
    const unpaidDmg = new Set(DMG.filter(d => Number(d.amount) > 0 && dmgStatus(d.rental_ref) === 'Unpaid').map(d => d.rental_ref)).size + late.unpaid.size;
    const payToVerify = num(CNT.pending_payments) + new Set(DMG.filter(d => d.status === 'Pending').map(d => d.rental_ref)).size + late.pending.size;
    // [badge id, number shown, number the "new item" pop-up counts]. Unpaid damage fees have their own pop-up (alerts.js), so they are not counted twice.
    [['#rcnt', num(CNT.rental_requests) + startDue.size + returnDue.size], ['#pcnt', payToVerify + unpaidDmg, payToVerify], ['#bcnt', num(CNT.pending_bookings)]].forEach(([id, n, forPopup]) => {
        counts[id.slice(1)] = forPopup ?? n;
        const c = $(id);
        if (c) {
            c.textContent = n;
            c.hidden = !n;
            if (id === '#pcnt')
                c.title = unpaidDmg ? `${payToVerify} to verify, ${unpaidDmg} fee(s) unpaid` : '';
        }
    });
    notifyBadgeCounts(counts);   // pop-up when a count went up (admin/alerts.js)
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
    } else if (kind === 'tab') {
        location.hash = arg;   // "Needs attention" rows
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