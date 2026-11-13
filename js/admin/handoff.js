/* =====================================================================
   admin/handoff.js - the same item rented back to back (the "tight handoff")
   Example: a unit is out from 10 AM to 6 PM and another customer's booking / rental of the same unit starts at 6 PM,
   and it is the only unit. If the first customer is late, the second one has nothing to use.

   Nothing here talks to the database: it is worked out from the rental lines (RL), bookings (BK) and stock (STK) the dashboard
   has already loaded. It gives:
     handoffRisks()        pairs [item still out] -> [rental waiting for it] for the pop-up alert (30 minutes before the return time)
     handoffWarnings(ref)  the same, for ONE rental that is not issued yet: shown when staff verify / approve it
     waitingForItem(g)     a verified rental whose start time has come, but the item is still out with someone else
     openHandoffDialog(r)  "Swap or contact customer": who to call, and the existing swap flow for the next customer
   ===================================================================== */

import { RL, STK } from './data.js';
import { findBk } from './bookings.js';
import { ACT, btn, dlg, num, showDlg, tOf } from './helpers.js';
import { revealRental } from './rentals.js';
import { swapActions } from './swapOffer.js';
import { esc, pl } from '../shared/utils.js';

export const HANDOFF_AHEAD = 30 * 60e3;   // the alert starts this long before the return time
const TIGHT = 3 * 36e5;                   // "back to back" = the next rental starts within 3 hours after the return time
const SLACK = 60e3;                       // one minute of tolerance between "ends at 6:00" and "starts at 6:00"

const ms = v => {
    const n = v ? new Date(v).getTime() : NaN;
    return Number.isFinite(n) ? n : null;
};
const open = l => !l.line_returned_at;

/* When a line needs its item: an outside rental from pick-up to return, an add-on during its booking's session */
function span(l) {
    if (l.rental_type === 'Add-on') {
        const b = l.booking_ref ? findBk(l.booking_ref) : null;
        return b ? { s: ms(b.start_at), e: ms(b.end_at), booking: b } : { s: null, e: null, booking: null };
    }
    return { s: ms(l.pickup_date), e: ms(l.return_date) ?? ms(l.due_at), booking: null };
}

const totalOf = eid => {
    const c = STK.find(x => String(x.equipment_id) === String(eid));
    return c ? num(c.total_quantity) : null;
};

/* the number people know the rental by: the booking reference for an add-on, the OUT- number for an outside rental */
export const refOf = l => l.rental_type === 'Add-on' && l.booking_ref ? l.booking_ref : l.rental_ref;

/* The lines that hold the SAME item and are expected back before line n starts, when the item cannot cover both.
   includeApproved: also count verified rentals that were not issued yet (right for the approval warning; the alert only
   cares about items that are really out). */
function riskyLines(n, includeApproved, now) {
    if (!open(n) || !['Pending', 'Approved'].includes(n.status))
        return [];
    const nw = span(n);
    if (nw.s == null)
        return [];
    if (nw.booking && !['Pending', 'Approved', 'In Progress'].includes(nw.booking.status))
        return [];
    const total = totalOf(n.equipment_id);
    if (total == null)
        return [];
    const risky = [];
    let holding = 0;
    RL.forEach(l => {
        if (l === n || l.rental_ref === n.rental_ref || !open(l) || String(l.equipment_id) !== String(n.equipment_id))
            return;
        if (!(l.status === 'Active' || (l.status === 'Approved' && includeApproved)))
            return;   // Pending requests hold nothing; Approved ones only matter for the approval warning
        const w = span(l);
        if (w.e == null)
            return;
        if (w.e <= nw.s + SLACK) {
            // expected back before n starts: a risk when the gap is short (or n has already started and it is still out)
            if (nw.s - w.e <= TIGHT || now >= nw.s)
                risky.push({ line: l, due: w.e });
        } else if ((w.s ?? -Infinity) <= nw.s)
            holding += l.quantity;   // legitimately out while n starts: already accounted for when n was accepted
    });
    const riskyQty = risky.reduce((s, r) => s + r.line.quantity, 0);
    return risky.length && holding + n.quantity + riskyQty > total ? risky.sort((a, b) => a.due - b.due) : [];
}

/* ---- the pop-up alert: item still out (or due back within 30 minutes) while a verified rental needs it ---- */
export function handoffRisks(now = Date.now()) {
    const out = new Map();
    RL.forEach(n => {
        if (n.status !== 'Approved' || !open(n))
            return;
        riskyLines(n, false, now).forEach(r => {
            if (now < r.due - HANDOFF_AHEAD)
                return;   // not yet: the alert starts 30 minutes before the return time
            const key = `${r.line.rental_ref}:${r.line.equipment_id}:${n.rental_ref}`;
            if (out.has(key))
                return;
            out.set(key, {
                key,
                stage: now >= r.due ? 'late' : 'soon',
                late: r.line,
                next: n,
                dueAt: r.due,
                needAt: span(n).s,
                started: span(n).s <= now
            });
        });
    });
    return [...out.values()];
}

export const handoffHeadline = r => {
    const what = esc(r.late.equipment_name);
    if (r.stage === 'late')
        return r.started
            ? `Overdue: ${what} is still out, and ${esc(refOf(r.next))} has been waiting for it since ${tOf(r.needAt)}`
            : `Overdue: ${what} is still out, and ${esc(refOf(r.next))} needs it at ${tOf(r.needAt)}`;
    return `${what} is due back at ${tOf(r.dueAt)}, and ${esc(refOf(r.next))} needs it at ${tOf(r.needAt)}`;
};

export const handoffDetail = r => `${r.late.customer_name} (${r.late.rental_ref}) has it. Next: ${r.next.customer_name}.`;

/* ---- the warning when staff verify / approve a rental that is not issued yet ---- */
export function handoffWarnings(ref) {
    const now = Date.now(), out = [];
    RL.filter(n => n.rental_ref === ref && open(n)).forEach(n => {
        const w = span(n);
        riskyLines(n, true, now).forEach(r => out.push({
            next: n,
            late: r.line,
            dueAt: r.due,
            needAt: w.s,
            text: `${r.line.equipment_name} is booked out until ${tOf(r.due)} by ${r.line.customer_name} (${refOf(r.line)}), and this rental needs it from ${tOf(w.s)}. There is no spare unit, so if it comes back late this customer will have to wait or get a replacement.`
        }));
    });
    return out;
}

/* html for the Verify window; empty when there is no risk */
export const handoffNoteHtml = ref => {
    const list = handoffWarnings(ref);
    return list.length
        ? `<div class="alert warn"><b>Tight handoff.</b> ${list.map(w => esc(w.text)).join(' ')} You can still approve it. Keep an eye on the return, or offer the customer a replacement in advance.
          <div style="margin-top:8px">${[...new Map(list.map(w => [w.next.rental_detail_id, w.next])).values()].map(n => swapActions(n.rental_ref, n.rental_detail_id, n.status)).join('')}</div></div>`
        : '';
};

/* ---- "Waiting for item": verified, its start time has come, but the item is still out with someone else ---- */
export function waitingForItem(g) {
    if (g.status !== 'Approved')
        return null;
    const now = Date.now();
    for (const n of g.lines) {
        if (!open(n))
            continue;
        const w = span(n);
        const started = n.rental_type === 'Add-on' ? !!(w.booking && w.booking.status === 'In Progress') : (w.s != null && w.s <= now);
        if (!started)
            continue;
        const total = totalOf(n.equipment_id);
        if (total == null)
            continue;
        const blockers = RL.filter(l => open(l) && l.status === 'Active' && l.rental_ref !== n.rental_ref && String(l.equipment_id) === String(n.equipment_id));
        const held = blockers.reduce((s, l) => s + l.quantity, 0);
        if (blockers.length && total - held < n.quantity)
            return { line: n, blockers };
    }
    return null;
}

/* ---- the "Swap or contact customer" window ---- */
const phone = p => p ? `<a href="tel:${esc(p)}">${esc(p)}</a>` : '<span class="mut">No number on file</span>';

export function openHandoffDialog(r) {
    const l = r.late, n = r.next;
    const hrs = r.stage === 'late' ? Math.max(1, Math.ceil((Date.now() - r.dueAt) / 36e5)) : 0;
    const canSwap = ['Pending', 'Approved'].includes(n.status);
    showDlg(`<div class="dr" style="padding:0">
    <div class="row"><div><p class="mut" style="margin:0">Item may not be back in time</p><h2 style="margin:0">${esc(l.equipment_name)}</h2></div><button type="button" class="btn sm line" data-close aria-label="Close">Close</button></div>
    <p style="margin:0">${handoffHeadline(r)}.</p>
    <h3>Still out</h3><dl class="dl"><dt>Customer</dt><dd>${esc(l.customer_name)}</dd><dt>Phone</dt><dd>${phone(l.customer_number)}</dd>
      <dt>Rental</dt><dd>${esc(l.rental_ref)}${l.rental_type === 'Add-on' && l.booking_ref ? ' <span class="mut">(add-on of ' + esc(l.booking_ref) + ')</span>' : ''}</dd>
      <dt>Due back</dt><dd>${tOf(r.dueAt)}${hrs ? ' <span class="b overdue">' + pl(hrs, 'hour') + ' overdue</span>' : ''}</dd></dl>
    <h3>Needs it next</h3><dl class="dl"><dt>Customer</dt><dd>${esc(n.customer_name)}</dd><dt>Phone</dt><dd>${phone(n.customer_number)}</dd>
      <dt>${n.rental_type === 'Add-on' ? 'Booking' : 'Rental'}</dt><dd>${esc(refOf(n))}</dd><dt>Needs it at</dt><dd>${tOf(r.needAt)}</dd></dl>
    <p class="mut" style="margin:0;font-size:13px">Call the customer who has the item and ask them to return it now. If it will not be back in time, offer the next customer an equivalent item (they choose, or you swap it yourself, no extra charge) so their session is not affected.</p>
    <div class="acts">${canSwap ? btn('ho-offer', n.rental_ref, 'Let the next customer choose') + btn('ho-swap', n.rental_ref, 'Swap the next customer\'s item', 1) : ''}${btn('ho-open', n.rental_ref, 'Open the next rental', 1)}<button type="button" class="btn line" data-close>Close</button></div></div>`);
}

ACT['ho-offer'] = ref => {
    dlg.close();
    return ACT['rn-offer'](ref);   // the existing "Let customer choose" window
};

ACT['ho-swap'] = ref => {
    dlg.close();
    return ACT['rn-fix'](ref);   // the existing flow: Let customer choose / Swap item
};

ACT['ho-open'] = ref => {
    dlg.close();
    location.hash = 'a-rent';
    revealRental(ref);
};
