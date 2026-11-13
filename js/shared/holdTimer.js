/* =====================================================================
   shared/holdTimer.js - "Closes in m:ss if idle" countdown for any window that holds a slot
   (Extend, Reschedule ...). Same rule as the booking form: any activity inside the window
   restarts the 2 minutes; when it runs out the window closes, which frees the hold.
   No imports, so the customer and the staff pages can both use it.
   ===================================================================== */

export const IDLE_TTL = 2 * 60 * 1000;

/* The bar-style timer used by the booking form: a dot, "Slot held for you - m:ss" and a bar that empties over the
   hold (amber then red near the end). Markup for the element that carries class "holdtimer": */
export const HOLD_TIMER_INNER = '<span class="ht-row"><span class="ht-dot" aria-hidden="true"></span><span class="ht-txt"></span></span><i class="ht-bar" aria-hidden="true"><b></b></i>';

export function drawHoldTimer(el, left, ttl = IDLE_TTL, noun = 'Slot') {
    if (!el)
        return;
    if (!el.querySelector('.ht-txt'))
        el.innerHTML = HOLD_TIMER_INNER;
    const secs = Math.max(0, Math.ceil(left / 1000)), clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    const level = secs <= 15 ? 'crit' : secs <= 40 ? 'warn' : '';
    el.className = 'holdtimer' + (level ? ' ' + level : '');
    el.querySelector('.ht-txt').innerHTML = level
        ? `${noun} released in <b>${clock}</b> &middot; tap anywhere to keep it`
        : `${noun} held for you &middot; <b>${clock}</b>`;
    el.querySelector('.ht-bar b').style.width = Math.min(100, left / ttl * 100) + '%';
}

/* holdCountdown(dialog, { label, active, onExpire, ttl })
   dialog   - the <dialog> (or form) element whose activity keeps the hold alive
   label    - element that shows the text (or a function that returns it, for content that is redrawn)
   active   - optional () => boolean; while false the timer is paused and hidden (e.g. nothing held yet)
   keepRunning - true for a form that stays on the page (the timer is not stopped when it runs out)
   bar      - true to draw the booking form's bar-style timer (see drawHoldTimer) instead of plain text
   noun     - what is held, for the bar style: 'Slot' (default) or 'Item'
   onExpire - called once when time runs out (close the window, show a message)
   Returns stop(). Call it when the window closes. */
export function holdCountdown(dialog, { label, active = () => true, onExpire, ttl = IDLE_TTL, keepRunning = false, bar = false, noun = 'Slot' }) {
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
            if (bar) {
                drawHoldTimer(el(), left, ttl, noun);
                return;
            }
            el().textContent = `Closes in ${Math.floor(left / 6e4)}:${s < 10 ? '0' : ''}${s} if idle`;
        }
    }, 1000);

    function stop() {
        clearInterval(id);
        ac.abort();
    }

    return stop;
}
