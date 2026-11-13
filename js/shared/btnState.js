/* =====================================================================
   shared/btnState.js - loading and success states for buttons
   A button that sends something (a booking, a payment, a request) shows a small spinner and "Sending…" while it
   works, then a check mark and a short word ("Sent") before the window moves on. Use:
     btnBusy(btn, 'Sending…')              spinner + label, the button is disabled (and cannot be double-clicked)
     await btnSuccess(btn, 'Sent', opts)   check mark for a moment, then the button goes back (opts.keep = stay as is)
     btnReset(btn)                         back to the normal button, enabled (use it when the request failed)
   The button's own text is remembered by btnBusy and put back by btnReset, so no label is lost.
   ===================================================================== */

const saved = new WeakMap();   // button -> { html, minWidth }

const CHECK = '<svg class="btn-check" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">'
    + '<path d="M3 8.5l3.2 3.2L13 4.8" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

function remember(btn) {
    if (!saved.has(btn))
        saved.set(btn, { html: btn.innerHTML, minWidth: btn.style.minWidth });
}

/* spinner + label; the button keeps its width so it does not jump */
export function btnBusy(btn, label = 'Sending…') {
    if (!btn)
        return;
    remember(btn);
    if (!btn.classList.contains('is-busy'))
        btn.style.minWidth = btn.offsetWidth + 'px';
    btn.classList.remove('is-done');
    btn.classList.add('is-busy');
    btn.setAttribute('aria-busy', 'true');
    btn.disabled = true;
    btn.innerHTML = `<span class="btn-spin" aria-hidden="true"></span><span class="btn-lbl">${esc(label)}</span>`;
}

/* back to the normal button. enable: false leaves it disabled (when the page decides that next) */
export function btnReset(btn, enable = true) {
    if (!btn)
        return;
    const s = saved.get(btn);
    if (s) {
        btn.innerHTML = s.html;
        btn.style.minWidth = s.minWidth;
        saved.delete(btn);
    }
    btn.classList.remove('is-busy', 'is-done');
    btn.removeAttribute('aria-busy');
    if (enable)
        btn.disabled = false;
}

/* check mark + label for a moment. Resolves when it is time to move on.
   opts.ms    how long the check stays (default 800 ms)
   opts.keep  true = leave the button showing the check (use when the window closes right after) */
export function btnSuccess(btn, label = 'Sent', opts = {}) {
    if (!btn)
        return Promise.resolve();
    const { ms = 800, keep = false } = opts;
    remember(btn);
    btn.classList.remove('is-busy');
    btn.classList.add('is-done');
    btn.removeAttribute('aria-busy');
    btn.disabled = true;
    btn.innerHTML = `${CHECK}<span class="btn-lbl">${esc(label)}</span>`;
    return new Promise(resolve => setTimeout(() => {
        if (!keep)
            btnReset(btn);
        resolve();
    }, ms));
}
