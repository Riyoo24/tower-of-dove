/* =====================================================================
   shared/utils.js - small helpers used everywhere
   DOM shortcuts ($, $$), text/number formatting, dates (Manila time), the
   bookable time slots, the toast message and the e-mail / name checks.
   ===================================================================== */

/* Accounts (customers and staff) log in with a real e-mail address. */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const normalizeEmail = v => String(v).trim().toLowerCase();
export const isEmail = v => EMAIL_RE.test(normalizeEmail(v)) && normalizeEmail(v).length <= 254;

/* First and last names: letters only (any language), plus spaces, hyphens, apostrophes and dots
   (so "Mary-Ann", "De la Cruz" and "Ma. Cristina" still work). Numbers and other symbols are refused. */
export const NAME_BAD = /[^\p{L}\p{M}\s.'\u2019-]/gu;
export const isName = v => {
    const t = String(v).trim();
    return t.length > 0 && /\p{L}/u.test(t) && !/[^\p{L}\p{M}\s.'\u2019-]/u.test(t);
};

/* Philippine mobile numbers: 11 digits starting with 09, like 0917 123 4567 (spaces and dashes are ignored). */
export const PHONE_BAD = /[^\d\s-]/g;
export const PHONE_MAX_DIGITS = 11;   // 0917 123 4567
export const isPhone = v => /^09\d{9}$/.test(String(v).replace(/[\s-]/g, ''));

/* The database stores real timestamps; the studio runs on Manila time (UTC+8). */
export const manilaTS = (dateISO, hour) => `${dateISO}T${String(hour).padStart(2, '0')}:00:00+08:00`;

/* timestamp from the database -> { date: 'YYYY-MM-DD', hour: 14, minute: 31 } in Manila time */
export function manilaParts(ts) {
    const m = new Date(new Date(ts).getTime() + 8 * 3600e3);
    return {
        date: m.toISOString().slice(0, 10),
        hour: m.getUTCHours(),
        minute: m.getUTCMinutes()
    };
}

/* Bookable hourly slots (10:00 AM to 9:00 PM start times). */
export const SLOTS = [
    '10:00 AM',
    '11:00 AM',
    '12:00 PM',
    '1:00 PM',
    '2:00 PM',
    '3:00 PM',
    '4:00 PM',
    '5:00 PM',
    '6:00 PM',
    '7:00 PM',
    '8:00 PM',
    '9:00 PM'
];

/* ============================ 2. HELPERS ============================ */

export const $ = s => document.querySelector(s);

export const $$ = s => [...document.querySelectorAll(s)];

export const esc = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/* Turns a studio description into tidy HTML. A line ending in ":" becomes a small heading,
   lines starting with "-" become list items (a tick under "Included", a cross under "Not included"),
   and any other line stays a plain paragraph, so old one-line descriptions still look right. */
export function descHTML(text, cls = '') {
    const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length)
        return '';
    const out = [];
    // Several plain lines (no "-" items, no "Heading:" lines) are a spec sheet, one spec per line: show them as tidy rows.
    // A single line stays a one-line tagline. A line saying "not included" gets a cross instead of a dot.
    if (lines.length > 1 && !lines.some(l => /^[-\u2013\u2022*]\s*\S/.test(l) || l.endsWith(':'))) {
        const rows = lines.map(l => `<li${/\b(not included|excluded|not available|not provided)\b/i.test(l) ? ' class="x"' : ''}>${esc(l)}</li>`);
        return `<div class="desc ${cls} rich"><div class="ds specs"><ul>${rows.join('')}</ul></div></div>`;
    }
    let sec = null;   // the list currently being filled
    const close = () => { if (sec) { out.push('</ul></div>'); sec = null; } };
    for (const l of lines) {
        const item = l.match(/^[-\u2013\u2022*]\s*(.+)$/);
        if (item) {
            if (!sec) { out.push('<div class="ds"><ul>'); sec = 'plain'; }
            out.push(`<li>${esc(item[1])}</li>`);
        } else if (l.endsWith(':')) {
            close();
            const no = /^(not|exclud|no\b)/i.test(l);
            out.push(`<div class="ds ${no ? 'no' : 'yes'}"><h4>${esc(l.slice(0, -1))}</h4><ul>`);
            sec = no ? 'no' : 'yes';
        } else {
            close();
            out.push(`<p>${esc(l)}</p>`);
        }
    }
    close();
    const rich = out.some(x => x.startsWith('<div class="ds'));   // has lists, not just a tagline
    return `<div class="desc ${cls}${rich ? ' rich' : ''}">${out.join('')}</div>`;
}

/* What a room card needs from a studio: a short tagline (the Description field), the gear list and the notes (the Room specs field).
   Room specs: one item per line (a leading "-" is fine); a line saying "not included" or "excluded", or anything under a
   "Not included:" heading, becomes a note instead of an item.
   Older studios have no Room specs yet and kept their gear in the Description: when that has several lines it is read as the gear list. */
const readSpecs = text => {
    const items = [], notes = [];
    let no = false;
    for (const l of String(text || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean)) {
        if (l.endsWith(':')) {
            no = /^(not|exclud|no\b)/i.test(l);
            continue;
        }
        const t = l.replace(/^[-\u2013\u2022*]\s*/, '');
        (no || /\b(not included|excluded|not available|not provided)\b/i.test(t) ? notes : items).push(t);
    }
    return { items, notes };
};

export function specsOf(desc, specs) {
    const d = String(desc || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (String(specs || '').trim())
        return { tagline: d.join(' '), ...readSpecs(specs) };
    if (d.length <= 1 && !d.some(l => l.endsWith(':')))
        return { tagline: d[0] || '', items: [], notes: [] };
    return { tagline: '', ...readSpecs(desc) };   // legacy: gear typed into the Description
}

/* Description + Room specs as one text for descHTML() (the booking page): the description, then "In the room" and "Not included" lists. */
export function descWithSpecs(desc, specs) {
    if (!String(specs || '').trim())
        return desc || '';
    const { items, notes } = readSpecs(specs);
    return [String(desc || '').trim(), items.length ? 'In the room:' : '', ...items.map(t => '- ' + t), notes.length ? 'Not included:' : '', ...notes.map(t => '- ' + t.replace(/\s*[,:\-]?\s*\b(not included|excluded)\b\s*$/i, ''))].filter(Boolean).join('\n');
}

export const peso = n => '₱' + n.toLocaleString('en-US');

export const badge = status => `<span class="b ${status.toLowerCase().replace(/ /g, '')}">${status}</span>`;

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export const pad = n => String(n).padStart(2, '0');

export const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const dayOffset = n => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return toISO(d);
};

export const TODAY = dayOffset(0);

export const longDate = iso => new Date(iso + 'T00:00').toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
});

export const shortDate = iso => new Date(iso + 'T00:00').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric'
});

/* "2:00 PM" + 2 hours -> "4:00 PM" */
export function endTime(startLabel, hours) {
    const h = 10 + SLOTS.indexOf(startLabel) + hours;
    return `${h % 12 || 12}:00 ${h < 12 ? 'AM' : 'PM'}`;
}

export let toastTimer;

/* The toast is shown as a popover, which puts it in the browser's "top layer". Windows opened with showModal()
   (cancel, reschedule, checkout, staff drawers...) sit in that layer too and would otherwise cover a normal fixed
   element, so an error raised while a window was open used to be invisible. The last popover shown is the top-most,
   so the toast is re-shown each time. Browsers without popover support fall back to the plain fixed toast. */
function hideToast(t) {
    if (typeof t.hidePopover === 'function') {
        try {
            if (t.matches(':popover-open'))
                t.hidePopover();
        } catch (e) {
            /* already closed */
        }
    }
    t.hidden = true;
}

/* Only one floating message is on screen at a time (the page toast, the "added" pop-up and the browse-window
   message share the same spot), so showing a new one closes the others instead of stacking on top of them. */
export function dismissToasts(keep) {
    const t = $('#toast');
    if (t && t !== keep && !t.hidden)
        hideToast(t);
    const pop = $('#add-pop');
    if (pop && pop !== keep)
        pop.hidden = true;
    document.querySelectorAll('.eq-toast').forEach(el => {
        if (el === keep)
            return;
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
    });
}

export function toast(message) {
    const t = $('#toast');
    if (!t)
        return;
    dismissToasts(t);
    t.textContent = message;
    t.hidden = false;
    if (typeof t.showPopover === 'function') {
        if (!t.hasAttribute('popover'))
            t.setAttribute('popover', 'manual');
        try {
            if (t.matches(':popover-open'))
                t.hidePopover();
            t.showPopover();
        } catch (e) {
            /* not allowed right now: the plain fixed toast is still shown */
        }
    }
    clearTimeout(toastTimer);
    // longer messages (usually errors) stay a little longer so they can be read
    toastTimer = setTimeout(() => hideToast(t), Math.min(9000, Math.max(4000, String(message).length * 70)));
}

/* Dates on the studio's clock (Manila), whatever the visitor's device says. */
export const manilaDay = n => manilaParts(new Date(Date.now() + n * 864e5)).date;

export const sum = a => a.reduce((x, y) => x + y, 0);

/* 50% down payment paid now with GCash. The balance (total - down payment) is paid at the studio or at pick-up.
   Studio bookings and outside rentals use this same rule (the database applies it too). */
export const downPayment = total => Math.round(total * 50) / 100;

export const pl = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');

/* Like setInterval, but does nothing while the tab is hidden and catches up once when the tab
   comes back (so a background tab does no work). Returns a function that stops it. */
export function everyVisible(fn, ms) {
    let missed = false;
    const id = setInterval(() => {
        if (document.hidden)
            missed = true;
        else
            fn();
    }, ms);
    const onShow = () => {
        if (!document.hidden && missed) {
            missed = false;
            fn();
        }
    };
    document.addEventListener('visibilitychange', onShow);
    return () => {
        clearInterval(id);
        document.removeEventListener('visibilitychange', onShow);
    };
}