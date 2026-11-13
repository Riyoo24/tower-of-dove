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

export function toast(message) {
    const t = $('#toast');
    if (!t)
        return;
    t.textContent = message;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 4000);
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
