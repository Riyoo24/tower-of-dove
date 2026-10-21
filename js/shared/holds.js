/* =====================================================================
   shared/holds.js - temporary slot holds while a booking form is open
   DB: rpc hold_slot / release_hold. One token = one browser = one hold.
   ===================================================================== */

import { SUPABASE_ANON_KEY, SUPABASE_URL, sb } from '../config/supabaseClient.js';
import { STUDIOS } from './catalog.js';
import { manilaTS } from './utils.js';

/* ============================ 3. SLOT HOLDS ============================
   While someone fills in a booking form, the hours are held on the server
   for 2 minutes (hold_slot). One token = one browser = one hold at a time. */

/* The token lives in sessionStorage, so reloading the page keeps the same token and the old hold
   is simply replaced (it never shows up as "someone else" to the same person). */
export const HOLD_TOKEN = (() => {
  const fresh = () => 'h' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  try {
    let t = sessionStorage.getItem('tod_hold');
    if (!t) { t = fresh(); sessionStorage.setItem('tod_hold', t); }
    return t;
  } catch (e) { return fresh(); }
})();

export const LOCK_TTL = 2 * 60 * 1000;

/* Hold and release calls run one after another. That way a release can never be overtaken by a
   hold request that was still on its way when the form was closed. */
export let holdChain = Promise.resolve();

export let holdActive = false;                 // true while this browser may be holding hours

export const queueHold = fn => { const run = holdChain.then(fn); holdChain = run.catch(() => {}); return run; };

export function holdSlots(studioIdx, date, first, hours) {
  return queueHold(async () => {
    const s = STUDIOS[studioIdx];
    const { data, error } = await sb.rpc('hold_slot', {
      p_studio_id: s.dbId,
      p_start_at: manilaTS(date, 10 + first),
      p_end_at: manilaTS(date, 10 + first + hours),
      p_token: HOLD_TOKEN
    });
    if (error) { console.error(error); return false; }
    holdActive = data === true;
    return data === true;
  });
}

export function releaseHold() {
  holdActive = false;
  return queueHold(async () => {
    try { await sb.rpc('release_hold', { p_token: HOLD_TOKEN }); } catch (e) { /* ignore */ }
  });
}

/* Closing the tab, leaving the page or the browser going away: free the hours right away
   (a normal request would be cancelled, so this one is sent with keepalive). */
window.addEventListener('pagehide', () => {
  if (!holdActive) return;
  try {
    fetch(SUPABASE_URL + '/rest/v1/rpc/release_hold', {
      method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: 'Bearer ' + SUPABASE_ANON_KEY },
      body: JSON.stringify({ p_token: HOLD_TOKEN })
    });
  } catch (e) { /* ignore */ }
});
