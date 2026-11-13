/* =====================================================================
   shared/eqModal.js - feedback inside the "Browse equipment" windows
   - modalToast(text, kind)   a small message that shows ABOVE an open window (the normal toast() sits behind it)
   - selectionHtml(rows, ...) the "Added to the rental" list at the bottom of the window
   Used by the customer's booking window (customer/bookingForm.js) and the staff's rental window (admin/onsite.js).
   No database changes.
   ===================================================================== */

import { esc } from './utils.js';

const ICON = {
    add: '<path d="M20 6L9 17l-5-5"/>',
    remove: '<path d="M5 12h14"/>',
    warn: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>'
};

let el = null, timer = 0;

/* Windows opened with showModal() sit in the browser's "top layer", above everything else, including the page toast.
   A popover is shown in the top layer too, and the last one shown is the top-most, so the message is re-shown each time.
   Browsers without popover support fall back to a fixed message (it can then be hidden behind a window). */
export function modalToast(text, kind = 'add') {
    if (!el) {
        el = document.createElement('div');
        el.className = 'eq-toast';
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        if ('popover' in el)
            el.setAttribute('popover', 'manual');
        else
            el.hidden = true;
        document.body.appendChild(el);
    }
    el.dataset.kind = kind;
    el.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON[kind] || ICON.add}</svg><span>${esc(text)}</span>`;
    if (typeof el.showPopover === 'function') {
        try {
            if (el.matches(':popover-open'))
                el.hidePopover();
            el.showPopover();
        } catch (e) {
            /* not allowed right now: nothing to show */
        }
    }
    else
        el.hidden = false;
    el.classList.remove('show');
    void el.offsetWidth;   // restart the pop-in animation when items are added quickly
    el.classList.add('show');
    clearTimeout(timer);
    timer = setTimeout(() => {
        if (typeof el.hidePopover === 'function') {
            try {
                if (el.matches(':popover-open'))
                    el.hidePopover();
            } catch (e) {
                /* already closed */
            }
        }
        else
            el.hidden = true;
    }, 2000);
}

/* Wording for a quantity change: before / after are the quantities in the rental. Returns [text, kind] or null (nothing changed). */
export function changeMessage(name, before, after, where = 'the rental') {
    if (after === before)
        return null;
    if (after > before)
        return [before ? `${name}: added ${after - before} more, ${after} now in ${where}` : `${name} added to ${where}${after > 1 ? ` (x${after})` : ''}`, 'add'];
    return [after > 0 ? `${name}: removed ${before - after}, ${after} left in ${where}` : `${name} removed from ${where}`, 'remove'];
}

/* The list of what has been added so far, so nobody has to scroll back through the cards to check.
   rows: [{ id, name, qty, price }] (price already formatted). */
export function selectionHtml(rows, title = 'Added to the rental') {
    if (!rows.length)
        return '';
    return `<section class="eq-sel" aria-label="${esc(title)}">
      <p class="eq-sel-t">${esc(title)} <span>${rows.length} item${rows.length === 1 ? '' : 's'}</span></p>
      <ul class="eq-sel-list">${rows.map(r => `<li><span class="eq-sel-n">${esc(r.name)} <b>x${r.qty}</b></span><span class="eq-sel-p">${esc(r.price)}</span><button type="button" class="lk" data-sel-rm="${r.id}" aria-label="Remove ${esc(r.name)}">Remove</button></li>`).join('')}</ul>
    </section>`;
}
