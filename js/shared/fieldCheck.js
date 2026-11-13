/* =====================================================================
   shared/fieldCheck.js - inline field validation
   A mistake shows where it was made: the field gets a red border and a short message right under it, and
   the page scrolls to the first one (important on phones, where a message at the top of a long form is out of sight).

   check.*             the rules (a value goes in, '' or a message comes out)
   applyChecks(list)   list = [[field, message], ...] in page order. Shows or clears each one, focuses the first
                       wrong field and returns true when everything is fine.
   liveCheck(list)     list = [[field, () => message], ...]. After that, a field with something typed in it is checked when
                       the person leaves it, and a field that shows an error is checked again on every key,
                       so the message goes away the moment it is fixed.
   setFieldError / clearFieldError / clearFieldErrors   for one field, or every field inside a form.
   A field is an element or a selector. The "I agree" box (a label with class "terms") works too.
   ===================================================================== */

import { isEmail, isName, reducedMotion } from './utils.js';

const find = t => typeof t === 'string' ? document.querySelector(t) : t;
const isTerms = el => el.classList.contains('terms');
const inputOf = el => isTerms(el) ? (el.querySelector('input') || el) : el;
const anchorOf = el => el.closest('.pw') || el;   // a password box has an eye button around it: the message goes below that
const BAD = el => isTerms(el) ? 'err' : 'invalid';

let counter = 0;
const boxId = el => {
    if (!el.id)
        el.id = 'fld' + (++counter);
    return el.id + '-err';
};

export function setFieldError(target, message) {
    const el = find(target);
    if (!el)
        return null;
    if (!message)
        return clearFieldError(el);
    const id = boxId(el);
    let box = document.getElementById(id);
    if (!box) {
        box = document.createElement('p');
        box.id = id;
        box.className = 'field-err';
        anchorOf(el).insertAdjacentElement('afterend', box);
    }
    box.textContent = message;
    el.classList.add(BAD(el));
    const inp = inputOf(el);
    inp.setAttribute('aria-invalid', 'true');
    const ids = (inp.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
    if (!ids.includes(id))
        inp.setAttribute('aria-describedby', [...ids, id].join(' '));
    return box;
}

export function clearFieldError(target) {
    const el = find(target);
    if (!el)
        return null;
    const id = el.id ? el.id + '-err' : '';
    const box = id && document.getElementById(id);
    if (box)
        box.remove();
    el.classList.remove(BAD(el));
    const inp = inputOf(el);
    inp.removeAttribute('aria-invalid');
    const ids = (inp.getAttribute('aria-describedby') || '').split(/\s+/).filter(x => x && x !== id);
    if (ids.length)
        inp.setAttribute('aria-describedby', ids.join(' '));
    else
        inp.removeAttribute('aria-describedby');
    return null;
}

export function clearFieldErrors(root) {
    const scope = find(root) || document;
    scope.querySelectorAll('.field-err').forEach(box => {
        const el = document.getElementById(box.id.replace(/-err$/, ''));
        if (el)
            clearFieldError(el);
        else
            box.remove();
    });
}

export const hasFieldError = target => {
    const el = find(target);
    return !!el && el.classList.contains(BAD(el));
};

function focusField(el) {
    const inp = inputOf(el);
    try {
        inp.focus({ preventScroll: true });
    } catch (e) {
        /* not focusable */
    }
    el.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
}

export function applyChecks(list) {
    let first = null;
    list.forEach(([target, message]) => {
        const el = find(target);
        if (!el)
            return;
        if (message) {
            setFieldError(el, message);
            if (!first)
                first = el;
        }
        else
            clearFieldError(el);
    });
    if (first)
        focusField(first);
    return !first;
}

export function liveCheck(list) {
    list.forEach(([target, rule]) => {
        const el = find(target);
        if (!el)
            return;
        const inp = inputOf(el);
        const again = () => setFieldError(el, rule());
        if (inp.type === 'checkbox') {
            inp.addEventListener('change', () => {
                if (hasFieldError(el))
                    again();
            });
            return;
        }
        inp.addEventListener('input', () => {
            if (hasFieldError(el))
                again();
        });
        inp.addEventListener('blur', () => {
            if (String(inp.value).trim() !== '')
                again();
        });
    });
}

/* ------------------------------ the rules ------------------------------ */

const PHONE_OK = /^[\d\s-]{7,}$/;

export const check = {
    first: v => !v.trim() ? 'Enter your first name.' : !isName(v) ? 'The first name can only contain letters.' : '',
    last: v => !v.trim() ? 'Enter your last name.' : !isName(v) ? 'The last name can only contain letters.' : '',
    phone: (v, what = 'phone number') => !v.trim() ? `Enter your ${what}.` : (!PHONE_OK.test(v.trim()) || v.replace(/\D/g, '').length > 11) ? `Enter a valid ${what}, like 0917 123 4567.` : '',
    email: v => !v.trim() ? 'Enter your email address.' : !isEmail(v) ? 'Enter a valid email address, like name@example.com.' : '',
    gcashRef: v => {
        const d = String(v).replace(/\s/g, '');
        if (!d)
            return 'Enter the 13-digit GCash reference number from your receipt.';
        if (/\D/.test(d))
            return 'The reference number has digits only, no letters or symbols.';
        if (d.length !== 13)
            return `The reference number has 13 digits. You typed ${d.length}.`;
        return '';
    },
    password: (v, empty = 'Enter a password.') => !v ? empty : v.length < 8 ? 'Use a password with at least 8 characters.' : '',
    confirm: (v, pass) => !v ? 'Enter the password again.' : v !== pass ? 'The two passwords do not match.' : '',
    file: (file, message) => file ? '' : message
};
