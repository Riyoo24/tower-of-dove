/* =====================================================================
   shared/utils.js - small helpers used everywhere
   DOM shortcuts ($, $$), text/number formatting, dates (Manila time), the
   bookable time slots, the toast message and the username -> e-mail helper.
   ===================================================================== */

/* Usernames become fake emails for Supabase Auth: juan -> juan@towerofdove.app */
export const toEmail = username => String(username).trim().toLowerCase() + '@towerofdove.app';

/* The database stores real timestamps; the studio runs on Manila time (UTC+8). */
export const manilaTS = (dateISO, hour) => `${dateISO}T${String(hour).padStart(2, '0')}:00:00+08:00`;

/* timestamp from the database -> { date: 'YYYY-MM-DD', hour: 14 } in Manila time */
export function manilaParts(ts) {
  const m = new Date(new Date(ts).getTime() + 8 * 3600e3);
  return { date: m.toISOString().slice(0, 10), hour: m.getUTCHours() };
}

/* Bookable hourly slots (10:00 AM to 9:00 PM start times). */
export const SLOTS = ['10:00 AM', '11:00 AM', '12:00 PM', '1:00 PM', '2:00 PM', '3:00 PM',
               '4:00 PM', '5:00 PM', '6:00 PM', '7:00 PM', '8:00 PM', '9:00 PM'];

/* ============================ 2. HELPERS ============================ */

export const $  = s => document.querySelector(s);

export const $$ = s => [...document.querySelectorAll(s)];

export const esc  = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export const peso = n => '₱' + n.toLocaleString('en-US');

export const badge = status => `<span class="b ${status.toLowerCase().replace(/ /g, '')}">${status}</span>`;

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export const pad = n => String(n).padStart(2, '0');

export const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const dayOffset = n => { const d = new Date(); d.setDate(d.getDate() + n); return toISO(d); };

export const TODAY = dayOffset(0);

export const longDate  = iso => new Date(iso + 'T00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

export const shortDate = iso => new Date(iso + 'T00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/* "2:00 PM" + 2 hours -> "4:00 PM" */
export function endTime(startLabel, hours) {
  const h = 10 + SLOTS.indexOf(startLabel) + hours;
  return `${h % 12 || 12}:00 ${h < 12 ? 'AM' : 'PM'}`;
}

export let toastTimer;

export function toast(message) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
}

/* Dates on the studio's clock (Manila), whatever the visitor's device says. */
export const manilaDay = n => manilaParts(new Date(Date.now() + n * 864e5)).date;

export const sum = a => a.reduce((x, y) => x + y, 0);

export const pl = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
