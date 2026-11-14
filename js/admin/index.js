/* =====================================================================
   admin/index.js - entry point of pages/admin.html
   Tab switching by #hash, first data load, and the 30 s / 60 s refresh timers.
   ===================================================================== */

import { checkTimeAlerts } from './alerts.js';
import { renderBookings } from './bookings.js';
import { renderCalendar } from './calendar.js';
import './noShow.js';   // Sessions tab: no-show countdown, Hold and Release now (needs 78_no_show_release.sql)
import './checkIn.js';   // Check in: record when the customer arrived (needs 87_booking_check_in.sql)
import './balance.js';   // Start session / Issue equipment: verify and collect the remaining balance first
import './globalSearch.js';   // search box at the top: find a customer, booking or rental from any tab
import './topbar.js';   // "Updated 12s ago" + refresh button and the "+ New" menu
import { renderCustomers } from './customers.js';
import { STU, refresh } from './data.js';
import { renderEquipmentTab } from './equipment.js';
import { setOpts } from './helpers.js';
import { renderOverview, updateNavBadges } from './overview.js';
import { renderPayments } from './payments.js';
import { renderRentals } from './rentals.js';
import { renderReports } from './reports.js';
import { renderSessions } from './sessions.js';
import { initProfileView } from './profile.js';
import { renderStaff } from './settings.js';
import { renderStudios } from './studios.js';
import { dataReady } from '../shared/catalog.js';
import { setActiveNav } from '../shared/layout.js';
import { $, $$, esc, everyVisible } from '../shared/utils.js';
import { injectChrome } from '../shared/layout.js';
import '../shared/formRules.js';
import { ROOT } from '../config/paths.js';
import { who } from './helpers.js';

injectChrome();   // sidebar + mobile bar

/* The dashboard is for owner and staff only. (shared/session.js redirects too.) */
const allowed = !!who && (who.role === 'owner' || who.role === 'staff');
if (!allowed)
    location.replace(ROOT + 'pages/login.html#login');

// pending-request badges next to "Rentals", "Payment", "Studio Sessions" and "Bookings" in the sidebar
(() => {
    [['a-rent', 'rcnt'], ['a-pay', 'pcnt'], ['a-sess', 'scnt'], ['a-book', 'bcnt']].forEach(([side, id]) => {
        const l = document.querySelector(`[data-side="${side}"] .lbl`);
        if (l)
            l.insertAdjacentHTML('beforeend', `<span class="cnt" id="${id}" hidden></span>`);
    });
})();

/* ============================ 12. START ============================ */

export function renderAll(poll) {
    setOpts($('#bk-s'), '<option value="">All studios</option>'
        + STU.map(s => `<option value="${s.studio_id}">${esc(s.name)}</option>`).join(''));
    renderOverview();
    renderBookings();
    renderPayments();
    renderSessions();
    renderCalendar();
    renderStudios();
    renderEquipmentTab();
    renderRentals();
    renderCustomers();
    renderStaff();
    if (!poll || location.hash === '#a-rep')
        renderReports();
    checkTimeAlerts();   // pop-ups for start times reached and sessions about to end (admin/alerts.js)
}

/* Owner and staff both land on the Overview. */
const DEFAULT_TAB = 'a-over';

function showTab(id) {
    const tabs = $$('.pg');
    const key = tabs.some(p => p.id === id) ? id : DEFAULT_TAB;
    // no hash, or one that matches no tab: show the Overview and make the address say so
    if (key !== id)
        history.replaceState(null, '', location.pathname + location.search + '#' + key);
    tabs.forEach(p => p.classList.toggle('on', p.id === key));
    if (typeof setActiveNav === 'function')
        setActiveNav(key);
    if (key === 'a-rep')
        renderReports();
    if (key === 'a-cal')
        renderCalendar();
    scrollTo(0, 0);
}

window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));

(async function start() {
    if (!allowed)
        return;
    await dataReady;
    showTab(location.hash.slice(1));
    await refresh(false);
    initProfileView();
    document.documentElement.dataset.todReady = '1';   // tells the safety net in admin.html that the dashboard finished loading
    // all three pause while the tab is hidden and catch up once when it is shown again
    everyVisible(() => refresh(true), 30000);   // new bookings appear on their own
    everyVisible(() => { renderSessions(); checkTimeAlerts(); if (location.hash === '#a-cal') renderCalendar(); }, 15000);   // remaining session time, the "ends in 5 minutes" notice and its pop-up
    everyVisible(updateNavBadges, 60000);       // rentals whose start / return time has come
})();