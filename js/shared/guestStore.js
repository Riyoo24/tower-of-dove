/* =====================================================================
   shared/guestStore.js - what the browser remembers about a not-yet-registered customer
   1. Guest bookings: the booking code + phone of bookings made without an account.
      After the customer registers or logs in they are moved onto the account (claim_guest_bookings).
   2. Pending booking: the studio, date, time, hours and add-ons picked in the booking form when the
      customer chose "Register an account". It is restored on the booking page after they log in.
   Kept in localStorage (not sessionStorage) because the e-mail confirmation link usually opens
   in a NEW tab, which would not see sessionStorage. The pending booking expires after 24 hours.
   Used by the booking page and the login page, so it imports nothing from either.
   ===================================================================== */

const GUEST_KEY = 'tod_guest_bookings';

const PENDING_KEY = 'tod_pending_booking';

const PENDING_TTL = 24 * 60 * 60 * 1000;

const read = (key, fallback) => {
    try {
        return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback;
    } catch (e) {
        return fallback;
    }
};

const write = (key, value) => {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
        /* storage blocked */
    }
};

/* ---- guest bookings ---- */
export const guestBookings = () => {
    const list = read(GUEST_KEY, []);
    return Array.isArray(list) ? list : [];
};

export const rememberGuestBooking = b => write(GUEST_KEY, [...guestBookings(), b]);

export function forgetGuestBookings(refs) {
    const gone = new Set(refs);
    write(GUEST_KEY, guestBookings().filter(b => !gone.has(b.ref)));
}

/* guest bookings that can still be moved to an account (they need the phone number used to book) */
export const claimableGuestBookings = () => guestBookings().filter(b => b && b.ref && b.phone);

/* ---- booking in progress ---- */
export const savePendingBooking = snapshot => write(PENDING_KEY, {
    ...snapshot,
    savedAt: Date.now()
});

export function readPendingBooking() {
    const p = read(PENDING_KEY, null);
    if (!p || typeof p !== 'object' || !p.studio || !p.date || !Number.isFinite(p.savedAt))
        return null;
    if (Date.now() - p.savedAt > PENDING_TTL) {
        clearPendingBooking();
        return null;
    }
    return p;
}

export function clearPendingBooking() {
    try {
        localStorage.removeItem(PENDING_KEY);
    } catch (e) {
        /* storage blocked */
    }
}
