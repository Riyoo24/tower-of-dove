/* =====================================================================
   shared/formRules.js - input rules that apply to every page
   Any <input data-letters> only accepts letters: digits and symbols are removed as the
   person types or pastes. Import this file once per page (the page entry files do).
   Any <input data-phone> only accepts digits, +, spaces, dashes and brackets.
   One listener on the document also covers inputs that are created later (dialogs).
   ===================================================================== */

import { NAME_BAD, PHONE_BAD } from './utils.js';

document.addEventListener('input', e => {
    const el = e.target;
    if (!(el instanceof HTMLInputElement) || e.isComposing)
        return;
    const bad = el.hasAttribute('data-letters') ? NAME_BAD : el.hasAttribute('data-phone') ? PHONE_BAD : null;
    if (!bad)
        return;
    const clean = el.value.replace(bad, '');
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
