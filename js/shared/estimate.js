/* =====================================================================
   shared/estimate.js - "what will it cost?" before the booking form
   ---------------------------------------------------------------------
   Uses the same rule as the booking form and the database: total = hourly
   rate x hours (gear is extra), and the amount due now is dueNow() from
   shared/payOption.js (50% down payment). No database changes.
   ===================================================================== */

import { PAY_DOWN, dueNow } from './payOption.js';
import { esc, peso, pl } from './utils.js';

export const EST_HOURS = [1, 2, 3, 4];

/* A small table for the Book tab: hours, total, and what is paid now. */
export function estimateTable(rate) {
    if (!(rate > 0))
        return '';
    const rows = EST_HOURS.map(h => {
        const total = rate * h;
        return `<tr><th scope="row">${esc(pl(h, 'hour'))}</th><td>${esc(peso(total))}</td><td>${esc(peso(dueNow(total, PAY_DOWN)))}</td></tr>`;
    }).join('');
    return `
      <p class="cal-sub">What it costs</p>
      <table class="est-table">
        <thead><tr><th scope="col">Session</th><th scope="col">Total</th><th scope="col">Pay now (50%)</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="mut est-note">Rented gear is extra. You can also pay in full when you book.</p>`;
}
