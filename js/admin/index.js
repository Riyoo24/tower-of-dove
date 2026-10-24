/* =====================================================================
   admin/index.js - entry point of pages/admin.html
   Tab switching by #hash, first data load, and the 30 s / 60 s refresh timers.
   ===================================================================== */

import { renderBookings } from './bookings.js';
import { renderCustomers } from './customers.js';
import { STU, refresh } from './data.js';
import { renderEquipmentTab } from './equipment.js';
import { setOpts } from './helpers.js';
import { renderOverview } from './overview.js';
import { renderPayments } from './payments.js';
import { renderRentals } from './rentals.js';
import { renderReports } from './reports.js';
import { renderSessions } from './sessions.js';
import { fillProfile, renderStaff } from './settings.js';
import { renderStudios } from './studios.js';
import { dataReady } from '../shared/catalog.js';
import { setActiveNav } from '../shared/layout.js';
import { $, $$, esc } from '../shared/utils.js';
import { injectChrome } from '../shared/layout.js';
import '../shared/formRules.js';
import { ROOT } from '../config/paths.js';
import { who } from './helpers.js';

injectChrome();   // sidebar + mobile bar

/* The dashboard is for owner and staff only. (shared/session.js redirects too.) */
const allowed = !!who && (who.role === 'owner' || who.role === 'staff');
if (!allowed) location.replace(ROOT + 'pages/login.html#login');

// pending-request badge next to "Rentals" in the sidebar
(() => { const l = document.querySelector('[data-side="a-rent"] .lbl');
  if (l) l.insertAdjacentHTML('beforeend', '<span class="cnt" id="rcnt" hidden></span>'); })();

/* ============================ 12. START ============================ */

export function renderAll(poll) {
  setOpts($('#bk-s'), '<option value="">All studios</option>' + STU.map(s => `<option value="${s.studio_id}">${esc(s.name)}</option>`).join(''));
  renderOverview(); renderBookings(); renderPayments(); renderSessions(); renderStudios();
  renderEquipmentTab(); renderRentals(); renderCustomers(); renderStaff();
  if (!poll || location.hash === '#a-rep') renderReports();
}

function showTab(id) {
  const tabs = $$('.pg');
  const key = tabs.some(p => p.id === id) ? id : 'a-over';
  tabs.forEach(p => p.classList.toggle('on', p.id === key));
  if (typeof setActiveNav === 'function') setActiveNav(key);
  if (key === 'a-rep') renderReports();
  scrollTo(0, 0);
}

window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));

(async function start() {
  if (!allowed) return;
  await dataReady;
  showTab(location.hash.slice(1));
  await refresh(false);
  fillProfile();
  setInterval(() => { if (!document.hidden) refresh(true); }, 30000);   // new bookings appear on their own
  setInterval(renderSessions, 60000);                                  // remaining session time
})();
