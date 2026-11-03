/* =====================================================================
   customer/state.js - the customer page's shared variables
   Variables that several customer modules read AND change live in this one object.
   Use state.selStudio, state.draft ... (never copy them into local variables).
   ===================================================================== */

import { firstBookableDate } from '../shared/availability.js';

export const state = {
    /* Rentals of the signed-in customer (loaded from the database).
       type: 'addon' (tied to a booking) | 'out' (taken outside the studio)
       status: Pending | Approved | In Use | Returned | Rejected | Cancelled */
    RENTALS: [],
    EXT: {},  // booking reference -> [{ id, hours, cost, down, status, payment, reason, newEnd, created }] extension requests, newest first
    ADDONS: {},  // booking reference -> [{ name, qty, price }] add-on equipment on that booking
    ADDPAID: {},  // booking reference -> { rental reference: GCash amount paid for add-ons added later }
    selStudio: 0,  // studio picked in the booking tab (set once data loads)
    selDate: firstBookableDate(),  // day picked on the calendar (tomorrow once today's last start time has passed)
    calMonth: null,  // month shown on the calendar
    draft: null,  // booking form in progress
    idleUntil: 0,  // time (ms) when the open booking form's hold runs out
    idleTimer: 0,  // setInterval id of the 'Closes in m:ss' countdown
    rentMode: 'addon',  // 'addon' | 'out'
    /* Equipment carts, each { equipmentId: quantity }:
       addon = Rent tab, studio add-on mode | out = Rent tab, outside rent | book = Browse equipment window of
       the booking form (state.draft.addons points at it; emptied when that form closes).
       The Rent tab's carts survive switching modes and are NOT copied into the booking form.
       All three share the same stock (see cart.js). */
    cart: { addon: {}, out: {}, book: {} },
    /* The signed-in customer's own details, used to pre-fill the booking and rental forms. */
    PROFILE: null,
};

state.calMonth = new Date(state.selDate + 'T00:00');
state.calMonth.setDate(1);
