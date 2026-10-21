/* =====================================================================
   shared/availability.js - which hours are taken
   DB: rpc get_busy_slots. Keeps BUSY / HELD / BOOKED lookup tables and the
   "is this hour in the past" rules (Manila time).
   ===================================================================== */

import { sb } from '../config/supabaseClient.js';
import { STUDIOS } from './catalog.js';
import { HOLD_TOKEN } from './holds.js';
import { SLOTS, manilaDay, manilaParts, manilaTS, toast } from './utils.js';

/* The signed-in customer's own bookings (filled by customer.js).
   status: Pending | Confirmed | Active | Completed | Cancelled | Rejected */
export const BOOKINGS = [];

/* Taken hours per studio and day, loaded from the database (get_busy_slots).
   Key: 'studioDbId|YYYY-MM-DD'  ->  Set of slot indexes (0 = 10:00 AM). */
export const BUSY = {};

export const HELD = {};     // same key -> slots that are only being held by someone filling in the booking form (2 minutes)

export const BOOKED = {};   // same key -> slots that are really booked

export async function loadBusy(studioIdx, fromDate, toDate) {
  const s = STUDIOS[studioIdx];
  if (!s) return;
  for (const k of Object.keys(BUSY)) {
    const [id, d] = k.split('|');
    if (+id === s.dbId && d >= fromDate && d <= toDate) { delete BUSY[k]; delete HELD[k]; delete BOOKED[k]; }
  }
  const { data, error } = await sb.rpc('get_busy_slots', {
    p_studio_id: s.dbId,
    p_from: manilaTS(fromDate, 0),
    p_to: new Date(new Date(manilaTS(toDate, 0)).getTime() + 864e5).toISOString(),
    p_token: HOLD_TOKEN
  });
  if (error) { console.error(error); toast('Could not load availability.'); return; }
  (data || []).forEach(r => {
    const end = new Date(r.end_at).getTime();
    for (let t = new Date(r.start_at).getTime(); t < end; t += 3600e3) {
      const p = manilaParts(new Date(t)), idx = p.hour - 10;
      if (idx < 0 || idx >= SLOTS.length) continue;
      const key = s.dbId + '|' + p.date;
      (BUSY[key] = BUSY[key] || new Set()).add(idx);
      const bucket = r.kind === 'held' ? HELD : BOOKED;
      (bucket[key] = bucket[key] || new Set()).add(idx);
    }
  });
}

/* Has this hour already started or passed (Manila time)? Index 0 = 10:00 AM.
   Bookings must start at a later hour, so the current hour counts as past too. */
export function isPastSlot(dateISO, i) {
  const now = manilaParts(new Date());
  return dateISO < now.date || (dateISO === now.date && 10 + i <= now.hour);
}

/* After the last start time of the day (the studio closes at 10 PM, the last hour you can start is
   9 PM) nothing more can be booked today, so the first day that can be booked is tomorrow. */
export const todayIsClosed = () => SLOTS.every((_, i) => isPastSlot(manilaDay(0), i));

export const firstBookableDate = () => manilaDay(todayIsClosed() ? 1 : 0);

/* Slots held (not booked) by someone else right now. */
export const heldSlots = (studioIdx, dateISO) => new Set(HELD[STUDIOS[studioIdx].dbId + '|' + dateISO] || []);

/* Why can't these hours be used? 'booked' = already booked, 'held' = someone is filling in a booking for them */
export function conflictKind(studioIdx, dateISO, first, hours) {
  const booked = BOOKED[STUDIOS[studioIdx].dbId + '|' + dateISO] || new Set();
  for (let i = first; i < first + hours; i++) if (booked.has(i)) return 'booked';
  return 'held';
}

/* Slot indexes already taken for a studio on a date (call loadBusy first).
   ignoreRef lets a booking ignore itself (used when rescheduling). */
export function takenSlots(studioIdx, dateISO, ignoreRef) {
  const s = STUDIOS[studioIdx];
  const taken = new Set(BUSY[s.dbId + '|' + dateISO] || []);
  if (ignoreRef) {
    const b = BOOKINGS.find(x => x.ref === ignoreRef);
    if (b && b.studio === s.id && b.date === dateISO) {
      const first = SLOTS.indexOf(b.start);
      for (let h = 0; h < b.hours; h++) taken.delete(first + h);
    }
  }
  return taken;
}
