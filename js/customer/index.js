/* =====================================================================
   customer/index.js - entry point of pages/customer.html
   Wires every tab, then waits for the catalog and draws everything.
   URL params (?studio=A&date=...&time=...&item=...) are applied at the end.
   ===================================================================== */

import { state } from './state.js';
import { initBookTab, refreshBook } from './book.js';
import { openBook } from './bookingForm.js';
import { loadMyBookings, loadMyRentals, profileReady } from './data.js';
import { initBookingsTab } from './myBookings.js';
import { applyAccessMode, initMyRentals, initRentalLookup } from './myRentals.js';
import { initRentTab, renderCart, renderEquipment, renderRentMode } from './rent.js';
import { showTab } from './ui.js';
import { firstBookableDate } from '../shared/availability.js';
import { EQUIPMENT, STUDIOS, dataReady, isClosed, studioIndex } from '../shared/catalog.js';
import { $, SLOTS } from '../shared/utils.js';
import { injectChrome } from '../shared/layout.js';

injectChrome();   // sidebar + mobile bar

/* ============================ 6. START ============================ */

async function applyUrlParams() {
  const q = new URLSearchParams(location.search);

  const studio = studioIndex(q.get('studio'));
  if (studio >= 0) state.selStudio = studio;

  const date = q.get('date');
  if (/^\d{4}-\d{2}-\d{2}$/.test(date || '') && date >= firstBookableDate()) {
    state.selDate = date;
    state.calMonth = new Date(date + 'T00:00');
    state.calMonth.setDate(1);
  }

  await refreshBook();

  const time = q.get('time');
  if (time && SLOTS.includes(time) && !isClosed(STUDIOS[state.selStudio])) openBook(SLOTS.indexOf(time));

  const item = q.get('item');
  if (item !== null && EQUIPMENT[+item]) {
    const card = $(`#eq [data-eq="${+item}"]`);
    if (card) {
      card.classList.add('hl');
      if (location.hash === '#rent') card.scrollIntoView({ block: 'center' });
    }
  }
}

initBookTab();

initRentTab();

initBookingsTab();

initRentalLookup();

initMyRentals();

applyAccessMode();

window.addEventListener('hashchange', showTab);

// wait for studios and equipment to load, then draw everything
dataReady.then(async () => {
  state.selStudio = Math.max(0, STUDIOS.findIndex(s => !isClosed(s)));
  renderEquipment();
  renderCart();
  renderRentMode();
  profileReady.then(() => {
    if (!state.PROFILE) return;
    if (!$('#on-fn').value) $('#on-fn').value = state.PROFILE.first;
    if (!$('#on-ln').value) $('#on-ln').value = state.PROFILE.last;
    if (!$('#oc').value) $('#oc').value = state.PROFILE.number;
  });
  showTab();
  await loadMyBookings();
  await loadMyRentals();
  await applyUrlParams();
});
