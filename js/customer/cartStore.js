/* =====================================================================
   customer/cartStore.js - persist the equipment cart across page navigations
   The cart lives in state.cart (in-memory), which is wiped on every full
   page load.  This module snapshots it to sessionStorage so that going to
   the home page and back restores exactly what the customer had picked.

   Only the two Rent-tab carts are saved ('addon' and 'out').
   The booking-form cart ('book') is intentionally NOT saved — it is owned
   by the booking form and is cleared when that form closes.

   sessionStorage is used (not localStorage) so the cart is private to this
   browser tab and disappears when the tab is closed, matching the user's
   natural expectation.
   ===================================================================== */

const CART_KEY = 'tod_rent_cart';
const MODE_KEY = 'tod_rent_mode';

/* ---- read ---- */

/** Returns the saved cart ({ addon:{}, out:{} }) or null if nothing was saved. */
export function loadSavedCart() {
    try {
        const raw = sessionStorage.getItem(CART_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        // Validate shape: must have addon and out as plain objects
        if (!parsed || typeof parsed !== 'object') return null;
        const addon = parsed.addon && typeof parsed.addon === 'object' ? parsed.addon : {};
        const out   = parsed.out   && typeof parsed.out   === 'object' ? parsed.out   : {};
        // Sanitise: values must be positive integers
        const sanitise = obj => {
            const clean = {};
            Object.entries(obj).forEach(([k, v]) => {
                const id = +k, qty = Math.floor(+v);
                if (Number.isFinite(id) && id > 0 && qty > 0)
                    clean[id] = qty;
            });
            return clean;
        };
        return { addon: sanitise(addon), out: sanitise(out) };
    } catch (e) {
        return null;
    }
}

/** Returns the saved rentMode ('addon' or 'out'), or null. */
export function loadSavedRentMode() {
    try {
        const v = sessionStorage.getItem(MODE_KEY);
        return v === 'addon' || v === 'out' ? v : null;
    } catch (e) {
        return null;
    }
}

/* ---- write ---- */

/** Snapshots state.cart.addon and state.cart.out to sessionStorage. */
export function saveCart(cart) {
    try {
        sessionStorage.setItem(CART_KEY, JSON.stringify({
            addon: cart.addon || {},
            out:   cart.out   || {}
        }));
    } catch (e) {
        /* storage blocked / quota exceeded — fail silently */
    }
}

/** Snapshots state.rentMode to sessionStorage. */
export function saveRentMode(mode) {
    try {
        sessionStorage.setItem(MODE_KEY, mode);
    } catch (e) { /* ignore */ }
}

/** Wipes the persisted cart and mode (called after a rental is submitted). */
export function clearSavedCart() {
    try {
        sessionStorage.removeItem(CART_KEY);
        sessionStorage.removeItem(MODE_KEY);
    } catch (e) { /* ignore */ }
}
