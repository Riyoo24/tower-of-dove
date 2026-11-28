/* =====================================================================
   shared/guestStore.js - what the browser remembers about a not-yet-registered customer
   1. Guest bookings: the booking code + phone of bookings made without an account.
      After the customer registers or logs in they are moved onto the account (claim_guest_bookings).
   2. Pending booking: the studio, date, time, hours and add-ons picked in the booking form when the
      customer chose "Register an account". It is restored on the booking page after they log in.
   Kept in localStorage (not sessionStorage) because the e-mail confirmation link usually opens
   in a NEW tab, which would not see sessionStorage. The pending booking expires after 24 hours.
   The guest bookings are also mirrored in a small cookie (reference + phone only), so they survive when
   localStorage alone is cleared. The pages read them back from the database with those two values.
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
const COOKIE = 'tod_guest';
const COOKIE_DAYS = 400;   // browsers cap this anyway
const MAX_GUEST = 20;      // the database reads at most 20 per call

const digits = v => String(v || '').replace(/\D/g, '');

/* cookie copy: "TOD-AAAA.0917..~TOD-BBBB.0918..". Only what is needed to look the booking up again. */
function writeCookie(list) {
    try {
        const value = list.map(b => `${b.ref}.${digits(b.phone)}`).join('~');
        const flags = `; path=/; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`;
        document.cookie = value
            ? `${COOKIE}=${encodeURIComponent(value)}; max-age=${COOKIE_DAYS * 86400}${flags}`
            : `${COOKIE}=; max-age=0${flags}`;
    } catch (e) {
        /* cookies blocked */
    }
}

function readCookie() {
    try {
        const hit = document.cookie.split('; ').find(c => c.startsWith(COOKIE + '='));
        if (!hit)
            return [];
        return decodeURIComponent(hit.slice(COOKIE.length + 1)).split('~')
            .map(x => x.split('.'))
            .filter(([ref, phone]) => /^TOD-[A-Z0-9]+$/i.test(ref || '') && /^09\d{9}$/.test(phone || ''))
            .map(([ref, phone]) => ({ ref: ref.toUpperCase(), phone }));
    } catch (e) {
        return [];
    }
}

const saveGuest = list => {
    const kept = list.slice(-MAX_GUEST);
    write(GUEST_KEY, kept);
    writeCookie(kept);
};

export const guestBookings = () => {
    const local = read(GUEST_KEY, []);
    const list = Array.isArray(local) ? local.filter(b => b && b.ref) : [];
    if (list.length)
        return list;
    return readCookie();   // localStorage was cleared or is blocked: the cookie still knows the references
};

/* one entry per reference: a booking found again later replaces the older copy */
export function rememberGuestBooking(b) {
    const phone = digits(b.phone);
    saveGuest([...guestBookings().filter(x => x.ref !== b.ref), { ...b, phone }]);
}

export function forgetGuestBookings(refs) {
    const gone = new Set(refs);
    saveGuest(guestBookings().filter(b => !gone.has(b.ref)));
}

/* keep only these references (used once the database answered, so bookings that no longer exist
   for this phone number or that were moved to an account elsewhere do not stay on the device) */
export function keepGuestBookings(refs) {
    const keep = new Set(refs);
    const list = guestBookings();
    if (list.some(b => !keep.has(b.ref)))
        saveGuest(list.filter(b => keep.has(b.ref)));
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