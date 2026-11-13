/* =====================================================================
   customer/state.js - the customer page's shared variables
   Variables that several customer modules read AND change live in this one object.
   Use state.selStudio, state.draft ... (never copy them into local variables).
   ===================================================================== */

import { firstBookableDate } from '../shared/availability.js';
import { loadSavedCart, loadSavedRentMode } from './cartStore.js';

/* Restore any cart the customer had before navigating away (e.g. to home). */
const _savedCart = loadSavedCart();
const _savedMode = loadSavedRentMode();

export const state = {
    /* Rentals of the signed-in customer (loaded from the database).
       type: 'addon' (tied to a booking) | 'out' (taken outside the studio)
       status: Pending | Approved | In Use | Returned | Rejected | Cancelled */
    RENTALS: [],
    DAMAGE: {},  // rental reference -> [{ id, item, qty, condition, reason, amount, status, ... }] damage fees (needs 58_damage_charges.sql)
    OFFERS: [],  // open replacement offers: staff let the customer choose another item (customer/swapChoice.js, needs 71_customer_swap_choice.sql)
    EXT: {},  // booking reference -> [{ id, hours, cost, down, status, payment, reason, newEnd, created }] extension requests, newest first
    ADDONS: {},  // booking reference -> [{ name, qty, price }] add-on equipment on that booking
    ADDPAID: {},  // booking reference -> { rental reference: GCash amount paid for add-ons added later }
    selStudio: 0,  // studio picked in the booking tab (set once data loads)
    selDate: firstBookableDate(),  // day picked on the calendar (tomorrow once today's last start time has passed)
    calMonth: null,  // month shown on the calendar
    draft: null,  // booking form in progress
    idleUntil: 0,  // time (ms) when the open booking form's hold runs out
    idleTimer: 0,  // setInterval id of the 'Closes in m:ss' countdown
    rentMode: _savedMode || 'addon',  // 'addon' | 'out' — restored from sessionStorage if available
    /* Equipment carts, each { equipmentId: quantity }:
       addon = Rent tab, studio add-on mode | out = Rent tab, outside rent | book = Browse equipment window of
       the booking form (state.draft.addons points at it; emptied when that form closes).
       The Rent tab's carts survive switching modes (and page navigations) and are NOT copied into the booking form.
       All three share the same stock (see cart.js). */
    cart: {
        addon: _savedCart ? { ..._savedCart.addon } : {},
        out:   _savedCart ? { ..._savedCart.out }   : {},
        book: {}
    },
    /* How many of each item are free for the HOURS being asked for (equipment_available_between):
       { equipmentId: free } per cart, or null when the hours are not known yet (then the stock right now is used).
       addon = the chosen booking's hours, out = pick-up to return, book = the booking form's session hours. */
    winStock: { addon: null, out: null, book: null },
    /* true when the last attempt to ask for the hours' free stock FAILED (then the cards show today's stock and say so) */
    winErr: { addon: false, out: false, book: false },
    /* The signed-in customer's own details, used to pre-fill the booking and rental forms. */
    PROFILE: null,
};

state.calMonth = new Date(state.selDate + 'T00:00');
state.calMonth.setDate(1);
