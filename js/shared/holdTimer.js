/* =====================================================================
   shared/holdTimer.js - "Closes in m:ss if idle" countdown for any window that holds a slot
   (Extend, Reschedule ...). Same rule as the booking form: any activity inside the window
   restarts the 2 minutes; when it runs out the window closes, which frees the hold.
   No imports, so the customer and the staff pages can both use it.
   ===================================================================== */

export const IDLE_TTL = 2 * 60 * 1000;

/* holdCountdown(dialog, { label, active, onExpire, ttl })
   dialog   - the <dialog> (or form) element whose activity keeps the hold alive
   label    - element that shows the text (or a function that returns it, for content that is redrawn)
   active   - optional () => boolean; while false the timer is paused and hidden (e.g. nothing held yet)
   keepRunning - true for a form that stays on the page (the timer is not stopped when it runs out)
   onExpire - called once when time runs out (close the window, show a message)
   Returns stop(). Call it when the window closes. */
export function holdCountdown(dialog, { label, active = () => true, onExpire, ttl = IDLE_TTL, keepRunning = false }) {
    const ac = new AbortController();
    const el = () => (typeof label === 'function' ? label() : label);
    let until = Date.now() + ttl;
    const bump = () => {
        until = Date.now() + ttl;
    };
    ['pointerdown', 'keydown', 'input', 'touchstart'].forEach(ev =>
        dialog.addEventListener(ev, bump, { signal: ac.signal }));
    dialog.addEventListener('scroll', bump, { signal: ac.signal, capture: true });

    const id = setInterval(() => {
        // paused while nothing is held, or while a confirmation window sits on top of this one
        if (!active() || document.querySelectorAll('dialog[open]').length > (dialog.matches('dialog') ? 1 : 0)) {
            bump();
            if (el())
                el().hidden = !active();
            return;
        }
        const left = until - Date.now();
        if (left <= 0) {
            if (keepRunning)
                bump();   // a form that stays on the page: keep watching for the next hold
            else
                stop();
            if (onExpire)
                onExpire();
            return;
        }
        if (el()) {
            const s = Math.floor(left / 1e3) % 60;
            el().hidden = false;
            el().textContent = `Closes in ${Math.floor(left / 6e4)}:${s < 10 ? '0' : ''}${s} if idle`;
        }
    }, 1000);

    function stop() {
        clearInterval(id);
        ac.abort();
    }

    return stop;
}
