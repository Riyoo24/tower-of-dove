/* =====================================================================
   shared/formRules.js - input rules that apply to every page
   Any <input data-letters> only accepts letters: digits and symbols are removed as the
   person types or pastes. Import this file once per page (the page entry files do).
   Any <input data-phone> only accepts digits, spaces and dashes, and stops at 11 digits.
   Any <input data-gcash-ref> only accepts digits and stops at 13 (a GCash reference number); spaces in a pasted
   number such as "1234 567 890123" are dropped. (No maxlength attribute: it would cut a pasted number that has spaces.)
   One listener on the document also covers inputs that are created later (dialogs).
   ===================================================================== */

import { NAME_BAD, PHONE_BAD, PHONE_MAX_DIGITS } from './utils.js';

document.addEventListener('input', e => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement) || e.isComposing)
        return;
    if (el.hasAttribute('data-gcash-ref')) {
        const digits = el.value.replace(/\D/g, '').slice(0, 13);
        if (digits !== el.value) {
            const pos = Math.max(0, (el.selectionStart ?? digits.length) - (el.value.length - digits.length));
            el.value = digits;
            try {
                el.setSelectionRange(Math.min(pos, digits.length), Math.min(pos, digits.length));
            } catch (err) {
                /* some input types have no cursor */
            }
        }
        return;
    }
    const bad = el.hasAttribute('data-letters') ? NAME_BAD : el.hasAttribute('data-phone') ? PHONE_BAD : null;
    if (!bad)
        return;
    let clean = el.value.replace(bad, '');
    if (el.hasAttribute('data-phone')) {
        /* a Philippine mobile number has 11 digits (0917 123 4567); extra digits are dropped */
        let n = 0, out = '';
        for (const ch of clean) {
            if (/\d/.test(ch) && ++n > PHONE_MAX_DIGITS)
                continue;
            out += ch;
        }
        clean = out.slice(0, 15);
    }
    if (clean !== el.value) {
        const pos = Math.max(0, (el.selectionStart ?? clean.length) - (el.value.length - clean.length));
        el.value = clean;
        try {
            el.setSelectionRange(pos, pos);
        } catch (err) {
            /* some input types have no cursor */
        }
    }
});
