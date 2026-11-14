/* =====================================================================
   customer/index.js - entry point of pages/customer.html
   Wires every tab, then waits for the catalog and draws everything.
   URL params (?studio=A&date=...&time=...&item=...) are applied at the end.
   ===================================================================== */

import { state } from './state.js';
import { initBookTab, refreshBook } from './book.js';
import { initDamageBlock, loadDamageBlock } from './damageBlock.js';
import { openBook } from './bookingForm.js';
import { loadMyBookings, loadMyRentals, profileReady } from './data.js';
import { initBookingsTab } from './myBookings.js';
import { initHome } from '../home/index.js';
import { applyAccessMode, initMyRentals, initRentalLookup } from './myRentals.js';
import { initSwapChoice } from './swapChoice.js';
import { initRentTab, renderCart, renderEquipment, renderRentMode } from './rent.js';
import { bkDlg, showTab } from './ui.js';
import { firstBookableDate, isPastSlot, lastBookableDate, loadBusy, takenSlots } from '../shared/availability.js';
import { EQUIPMENT, STUDIOS, dataReady, isClosed, studioIndex } from '../shared/catalog.js';
import { clearPendingBooking, readPendingBooking } from '../shared/guestStore.js';
import { isMember } from '../shared/session.js';
import { $, SLOTS, everyVisible, toast } from '../shared/utils.js';
import { injectChrome } from '../shared/layout.js';
import '../shared/formRules.js';
import '../shared/qrZoom.js';

injectChrome();   // top navigation bar

/* After logging in, land on Home, not on the Book tab.
   The login page sends the customer to this page; this runs once for that arrival (a fresh navigation that
   came from login.html) and switches the URL to #home before any tab is drawn. It leaves alone:
   - a refresh or Back/Forward (the customer chose that tab themselves),
   - links that carry ?studio=&date=&time=&item= (an explicit request),
   - a saved booking from the guest "Register an account" flow, which restorePendingBooking() reopens on #book. */
(function landOnHomeAfterLogin() {
    try {
        const nav = performance.getEntriesByType('navigation')[0];
        if (nav && nav.type !== 'navigate')
            return;
        if (!/\/login\.html$/.test(new URL(document.referrer).pathname))
            return;
        if (location.search || readPendingBooking())
            return;
        history.replaceState(null, '', location.pathname + '#home');
    } catch (e) {
        /* no referrer or blocked: leave the URL as it is */
    }
})();

/* Show the right tab straight away. The page's HTML starts on Home, and the catalog takes a moment to load,
   so waiting for it before choosing the tab made a refresh on #rent (or any other tab) flash Home first. */
showTab();

/* ============================ 6. START ============================ */

async function applyUrlParams() {
    const q = new URLSearchParams(location.search);

    const studio = studioIndex(q.get('studio'));
    if (studio >= 0)
        state.selStudio = studio;

    const date = q.get('date');
    if (/^\d{4}-\d{2}-\d{2}$/.test(date || '') && date >= firstBookableDate() && date <= lastBookableDate()) {
        state.selDate = date;
        state.calMonth = new Date(date + 'T00:00');
        state.calMonth.setDate(1);
    }

    await refreshBook();

    const time = q.get('time');
    if (time && SLOTS.includes(time) && !isClosed(STUDIOS[state.selStudio]))
        openBook(SLOTS.indexOf(time));

    const item = q.get('item');
    if (item !== null && EQUIPMENT[+item]) {
        const card = $(`#eq [data-eq="${+item}"]`);
        if (card) {
            card.classList.add('hl');
            if (location.hash === '#rent')
                card.scrollIntoView({ block: 'center' });
        }
    }
}

/* A guest chose "Register an account" in the booking form: after they log in, open the booking form again
   with the same studio, date, time, hours, add-ons and details. It is restored once, then forgotten. */
async function restorePendingBooking() {
    const p = readPendingBooking();
    if (!p || !isMember() || bkDlg.open)
        return;
    clearPendingBooking();
    const si = studioIndex(p.studio);
    if (si < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(p.date) || p.date < firstBookableDate() || p.date > lastBookableDate() || isClosed(STUDIOS[si]))
        return toast('Your saved booking is no longer available. Please choose a studio and time again.');

    state.selStudio = si;
    state.selDate = p.date;
    state.calMonth = new Date(p.date + 'T00:00');
    state.calMonth.setDate(1);
    location.hash = 'book';
    await refreshBook();
    await profileReady;

    await loadBusy(si, p.date, p.date);
    const t = Number.isInteger(p.t) ? p.t : -1;
    if (t < 0 || t >= SLOTS.length || takenSlots(si, p.date).has(t) || isPastSlot(p.date, t))
        return toast('Welcome! The time you picked is no longer free. Please choose another time on the calendar.');
    toast('Welcome! We saved your booking. Check the details, pay the down payment and submit.');
    openBook(t, p);
}

initBookTab();

initRentTab();

initBookingsTab();

initRentalLookup();

initMyRentals();
initSwapChoice();   // the Choose button of the "choose your replacement item" notice
initDamageBlock();

applyAccessMode();

initHome();   // Home + Contact Us tabs

/* Every tab switch happens inside this page (no reload):
   - hashchange: the tab links (#book, #rent, #my-bookings, #my-rentals, #home, #contact)
   - popstate: Back / Forward between entries that differ only by their ?query
   - tod:route: navigate() moved here with a ?studio=&date=&time=&item= query (see shared/navigation.js) */
window.addEventListener('hashchange', showTab);
window.addEventListener('popstate', showTab);
window.addEventListener('tod:route', async () => {
    showTab();
    await applyUrlParams();
    history.replaceState(null, '', location.pathname + location.hash);   // the params are used up: a refresh must not re-open the form
});

// wait for studios and equipment to load, then draw everything
dataReady.then(async () => {
    state.selStudio = Math.max(0, STUDIOS.findIndex(s => !isClosed(s)));
    renderEquipment();
    renderCart();
    renderRentMode();
    profileReady.then(() => {
        if (!state.PROFILE)
            return;
        if (!$('#on-fn').value)
            $('#on-fn').value = state.PROFILE.first;
        if (!$('#on-ln').value)
            $('#on-ln').value = state.PROFILE.last;
        if (!$('#oc').value)
            $('#oc').value = state.PROFILE.number;
    });
    await loadMyBookings();
    await loadMyRentals();
    await loadDamageBlock();
    await applyUrlParams();
    await restorePendingBooking();
    // pick up changes staff make (an extended session, an overdue rental) without a manual reload
    everyVisible(() => {
        if (state.PROFILE) {
            loadMyBookings().then(loadMyRentals).then(loadDamageBlock);   // one after the other: rentals read the bookings
        }
    }, 30000);
});