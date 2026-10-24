/* =====================================================================
   shared/formRules.js - input rules that apply to every page
   Any <input data-letters> only accepts letters: digits and symbols are removed as the
   person types or pastes. Import this file once per page (the page entry files do).
   One listener on the document also covers inputs that are created later (dialogs).
   ===================================================================== */

import { NAME_BAD } from './utils.js';

document.addEventListener('input', e => {
  const el = e.target;
  if (!(el instanceof HTMLInputElement) || !el.hasAttribute('data-letters') || e.isComposing) return;
  const clean = el.value.replace(NAME_BAD, '');
  if (clean !== el.value) {
    const pos = Math.max(0, (el.selectionStart ?? clean.length) - (el.value.length - clean.length));
    el.value = clean;
    try { el.setSelectionRange(pos, pos); } catch (err) { /* some input types have no cursor */ }
  }
});
