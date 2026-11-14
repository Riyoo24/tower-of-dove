/* =====================================================================
   shared/holdTimer.js - countdown for any window that holds a slot (Extend, Reschedule ...).
   Staff windows: any activity restarts the 2 minutes; when it runs out the window closes, which frees the hold.
   Customer windows: a fixed 10-minute countdown (activity never restarts it) plus a 2-minute idle countdown.
   No imports, so the customer and the staff pages can both use it.
   ===================================================================== */

export const IDLE_TTL = 2 * 60 * 1000;

/* Customer-page windows that hold a slot: a fixed 10-minute running countdown. Activity does NOT restart it. */
export const CUSTOMER_HOLD_TTL = 10 * 60 * 1000;

/* ...plus a 2-minute IDLE countdown on top: any activity inside the window restarts the idle time (never the 10 minutes);
   if the person does nothing for 2 minutes the window closes and the hold is released. Shown as a second line. */
export const CUSTOMER_IDLE_TTL = IDLE_TTL;

/* The bar-style timer used by the booking form: a dot, "Slot held for you - m:ss" and a bar that empties over the
   hold (amber then red near the end). Markup for the element that carries class "holdtimer": */
export const HOLD_TIMER_INNER = '<span class="ht-row"><span class="ht-dot" aria-hidden="true"></span><span class="ht-txt"></span><span class="ht-idle" hidden></span></span><i class="ht-bar" aria-hidden="true"><b></b></i>';

export function drawHoldTimer(el, left, ttl = IDLE_TTL, noun = 'Slot', fixed = false, idleLeft = null) {
    if (!el)
        return;
    if (!el.querySelector('.ht-txt'))
        el.innerHTML = HOLD_TIMER_INNER;
    if (!el.querySelector('.ht-idle'))
        el.querySelector('.ht-row').insertAdjacentHTML('beforeend', '<span class="ht-idle" hidden></span>');
    const secs = Math.max(0, Math.ceil(left / 1000)), clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    const level = fixed ? (secs <= 30 ? 'crit' : secs <= 90 ? 'warn' : '') : (secs <= 15 ? 'crit' : secs <= 40 ? 'warn' : '');
    el.className = 'holdtimer' + (level ? ' ' + level : '');
    el.querySelector('.ht-txt').innerHTML = level
        ? (fixed ? `${noun} released in <b>${clock}</b>` : `${noun} released in <b>${clock}</b> &middot; tap anywhere to keep it`)
        : `${noun} held for you &middot; <b>${clock}</b>`;
    el.querySelector('.ht-bar b').style.width = Math.min(100, left / ttl * 100) + '%';
    drawIdleLine(el.querySelector('.ht-idle'), idleLeft);
}

/* The small idle countdown at the right of the top row ("idle 1:45"); becomes "tap to stay 0:20" near the end. */
function drawIdleLine(line, idleLeft) {
    if (!line)
        return;
    if (idleLeft === null || idleLeft === undefined) {
        line.hidden = true;
        return;
    }
    const secs = Math.max(0, Math.ceil(idleLeft / 1000)), clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    const level = secs <= 10 ? 'crit' : secs <= 30 ? 'warn' : '';
    line.hidden = false;
    line.className = 'ht-idle' + (level ? ' ' + level : '');
    line.innerHTML = level ? `tap to stay <b>${clock}</b>` : `idle <b>${clock}</b>`;
}

/* holdCountdown(dialog, { label, active, onExpire, ttl })
   dialog   - the <dialog> (or form) element whose activity keeps the hold alive
   label    - element that shows the text (or a function that returns it, for content that is redrawn)
   active   - optional () => boolean; while false the timer is paused and hidden (e.g. nothing held yet)
   keepRunning - true for a form that stays on the page (the timer is not stopped when it runs out)
   bar      - true to draw the booking form's bar-style timer (see drawHoldTimer) instead of plain text
   noun     - what is held, for the bar style: 'Slot' (default) or 'Item'
   fixed    - true for a plain running countdown: activity does not restart it, and it keeps running while a
              confirmation window sits on top. It starts when the hold first becomes active (active() true).
   idleTtl  - with fixed: also close after this many ms without activity (restarted by any activity; shown as a second line
              under the bar, or after the text for the plain style). Paused while a confirmation window sits on top.
   onExpire - called once when time runs out (close the window, show a message). Receives 'idle' when the idle time ran
              out, otherwise 'time'.
   Returns stop(). Call it when the window closes. */
export function holdCountdown(dialog, { label, active = () => true, onExpire, ttl = IDLE_TTL, keepRunning = false, bar = false, noun = 'Slot', fixed = false, idleTtl = 0 }) {
    const ac = new AbortController();
    const el = () => (typeof label === 'function' ? label() : label);
    let until = Date.now() + ttl;   // (fixed windows reset this when the first hold starts)
    let started = !fixed || active();
    let idleUntil = Date.now() + idleTtl;
    if (idleTtl) {
        const touch = () => {
            idleUntil = Date.now() + idleTtl;
        };
        ['pointerdown', 'keydown', 'input', 'touchstart'].forEach(ev =>
            dialog.addEventListener(ev, touch, { signal: ac.signal }));
        dialog.addEventListener('scroll', touch, { signal: ac.signal, capture: true });
    }
    const bump = () => {
        if (!fixed)
            until = Date.now() + ttl;
    };
    if (!fixed) {
        ['pointerdown', 'keydown', 'input', 'touchstart'].forEach(ev =>
            dialog.addEventListener(ev, bump, { signal: ac.signal }));
        dialog.addEventListener('scroll', bump, { signal: ac.signal, capture: true });
    }

    const id = setInterval(() => {
        // paused while nothing is held, or while a confirmation window sits on top of this one
        if (fixed) {
            if (!started) {
                if (!active()) {
                    if (el())
                        el().hidden = true;
                    return;
                }
                started = true;
                until = Date.now() + ttl;   // the first hold starts the 10 minutes; later picks do not restart it
                idleUntil = Date.now() + idleTtl;
            }
            // a confirmation window on top of this one: the person is busy there, so the idle time waits (the 10 minutes do not)
            if (idleTtl && document.querySelectorAll('dialog[open]').length > (dialog.matches('dialog') ? 1 : 0))
                idleUntil = Date.now() + idleTtl;
        } else if (!active() || document.querySelectorAll('dialog[open]').length > (dialog.matches('dialog') ? 1 : 0)) {
            bump();
            if (el())
                el().hidden = !active();
            return;
        }
        const left = until - Date.now();
        const idleLeft = idleTtl ? idleUntil - Date.now() : null;
        if (left <= 0 || (idleLeft !== null && idleLeft <= 0)) {
            if (keepRunning)
                bump();   // a form that stays on the page: keep watching for the next hold
            else
                stop();
            if (onExpire)
                onExpire(left > 0 ? 'idle' : 'time');
            return;
        }
        if (el()) {
            const s = Math.floor(left / 1e3) % 60;
            el().hidden = false;
            if (bar) {
                drawHoldTimer(el(), left, ttl, noun, fixed, idleLeft);
                return;
            }
            el().textContent = `Closes in ${Math.floor(left / 6e4)}:${s < 10 ? '0' : ''}${s}${fixed ? '' : ' if idle'}`;
        }
    }, 1000);

    function stop() {
        clearInterval(id);
        ac.abort();
    }

    return stop;
}