/* =====================================================================
   home/info.js - "Before you book" and the FAQ on the Home tab
   ---------------------------------------------------------------------
   Every rule written here is one the system already enforces (booking form
   terms, customer/noShow.js, shared/availability.js, the database). The
   no-show minutes are read from the database through loadGrace(); the other
   numbers are constants below. If a rule changes, change it here too.
   ===================================================================== */

import { GRACE, loadGrace } from '../customer/noShow.js';
import { BOOKING_WINDOW_DAYS } from '../shared/availability.js';
import { VENUE } from '../shared/venue.js';
import { $, esc } from '../shared/utils.js';

const HOLD_MINUTES = 2;     // slot hold while the form is open (shared/holds.js)
const CUTOFF_HOURS = 24;    // changes and cancellations close this long before the start

const before = () => [
    ['Pay half now, the rest at the studio',
        'Reserve with a 50% GCash down payment, or pay in full. The payment is non-refundable if you cancel.'],
    [`Change or cancel ${CUTOFF_HOURS} hours ahead`,
        `Rescheduling and cancelling close ${CUTOFF_HOURS} hours before your start time.`],
    [`Arrive within ${GRACE} minutes`,
        `If you have not arrived or contacted the studio ${GRACE} minutes after your start time, the booking is cancelled and the slot is released.`],
    ['Add gear while you book',
        'Pick add-on gear for your room in the booking form (Browse equipment), or rent it to take outside for up to 8 hours. Outside rentals need an account and a valid ID.']
];

const faq = () => [
    ['Do I need an account to book?',
        '<p>No. You can book a room as a guest and look it up later with your reference code. An account is needed to rent gear to take outside, to extend a session, and to use the &ldquo;I&rsquo;m running late&rdquo; button. If you book as a guest, you can register afterwards to keep the booking in your account.</p>'],
    ['How do I pay?',
        '<p>By GCash. Scan the studio&rsquo;s QR code, then enter the reference number and attach your screenshot. You choose a 50% down payment or full payment. Your booking stays <b>Pending</b> until staff verify the payment, and you get a receipt by email.</p>'],
    ['How long is my time slot held?',
        `<p>While you fill in the booking form, your hours are held for ${HOLD_MINUTES} minutes. If nothing happens for ${HOLD_MINUTES} minutes, the hold is released so others can book. Have your GCash ready before you start.</p>`],
    ['When can I book?',
        `<p>The studio is open daily from 10 AM to 10 PM. Sessions are booked by the hour, and the last start time is 9 PM. You can book up to ${BOOKING_WINDOW_DAYS} days ahead.</p>`],
    ['Can I get a refund if I cancel?',
        `<p>No. The down payment (or full payment) is non-refundable once a booking is cancelled. If your plans change, reschedule instead: you can move a booking to another open time up to ${CUTOFF_HOURS} hours before it starts.</p>`],
    ['What happens if I am late?',
        `<p>Your slot is held for ${GRACE} minutes after your start time. After that, the booking is cancelled and the slot is released. Logged-in customers can press <b>I&rsquo;m running late</b> in My bookings once to get 15 more minutes. Your session still ends at its booked time.</p>`],
    ['Can I extend my session?',
        '<p>Yes, if you are logged in and the hours after your session are free. Open <b>My bookings</b>, choose <b>Actions</b>, then <b>Extend</b>. You pay 50% (or all) of the extra time by GCash and the rest at the studio.</p>'],
    ['How does gear rental work?',
        '<p><b>Studio add-on:</b> choose gear in the booking form under <b>Browse equipment</b>, or on the Rent tab, and it is ready in your room, priced per session. <b>Outside rental:</b> for registered customers with a valid ID. The price covers up to 8 hours, and each extra hour costs one eighth of the price. Damage to rented gear is charged to the renter.</p>'],
    ['Where are you?',
        `<p>${esc(VENUE.address)}. <a href="${esc(VENUE.maps)}" target="_blank" rel="noopener">Open in Google Maps</a>, or call ${esc(VENUE.phone)}.</p>`]
];

/* 0977 103 9287 */
const phoneLabel = p => String(p).replace(/^(\d{4})(\d{3})(\d{4})$/, '$1 $2 $3');

export function renderInfo() {
    const byb = $('#byb-list'), list = $('#faq-list'), help = $('#faq-help');
    if (byb)
        byb.innerHTML = before().map(([t, d]) => `<li><h3>${esc(t)}</h3><p>${esc(d)}</p></li>`).join('');
    if (help)
        help.innerHTML = `
          <a href="tel:${esc(VENUE.phone)}"><span>Call or text</span><b>${esc(phoneLabel(VENUE.phone))}</b></a>
          <a href="${esc(VENUE.facebook)}" target="_blank" rel="noopener"><span>Facebook</span><b>Message the studio</b></a>
          <a href="mailto:${esc(VENUE.email)}"><span>Email</span><b>${esc(VENUE.email)}</b></a>`;
    if (list) {
        // keep whatever the visitor already opened; the first question starts open
        const open = list.children.length ? [...list.children].map(d => d.open) : [true];
        list.innerHTML = faq().map(([q, a], i) => `<details class="faq-item"${open[i] ? ' open' : ''}><summary>${esc(q)}</summary><div class="faq-a">${a}</div></details>`).join('');
    }
}

export async function initInfo() {
    renderInfo();
    const was = GRACE;
    await loadGrace();   // the studio can change the no-show minutes; redraw only if they differ
    if (GRACE !== was)
        renderInfo();
}
