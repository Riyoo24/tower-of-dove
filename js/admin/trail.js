/* =====================================================================
   admin/trail.js - History (audit trail) of a booking, a rental or an extension
   Built from the dates the database already keeps (requested, payment sent, balance collected, issued, returned,
   damage fee recorded / paid), so no new table is needed. It looks like the History of the Damage fee window.
   trailHtml(entries) -> HTML; entry = { at, action, amount, item, by, note }.
   ===================================================================== */

import { DMG, EVT, EXT, LFL, OFR, RL, SWP } from './data.js';
import { staffName } from './damage.js';
import { money, num, stampLabel } from './helpers.js';
import { offerOptionNames } from './swapOffer.js';
import { esc } from '../shared/utils.js';

const CUSTOMER = 'Customer';

function line(e) {
    return `<li><span class="mut">${esc(stampLabel(e.at))}</span> <b>${esc(e.action)}</b>${e.amount ? ' ' + money(e.amount) : ''}`
        + `${e.item ? ` <span class="mut">(${esc(e.item)})</span>` : ''}${e.by ? ` <span class="mut">by ${esc(e.by)}</span>` : ''}`
        + `${e.note ? `<br><span class="dc-note">${esc(e.note)}</span>` : ''}</li>`;
}

export function trailHtml(entries) {
    const list = entries.filter(e => e && e.at && !Number.isNaN(new Date(e.at).getTime()))
        .sort((a, b) => new Date(a.at) - new Date(b.at));
    if (!list.length)
        return '';
    return `<details class="dc-history">
      <summary>History <span class="mut">(${list.length})</span></summary>
      <ul class="dc-log">${list.map(line).join('')}</ul>
    </details>`;
}

const payNote = p => p ? `${p.method || 'Payment'}${p.method === 'GCash' && p.gcash_reference ? ' (ref ' + p.gcash_reference + ')' : ''}` : '';

/* the payment the customer sent (online) or that was recorded at the studio */
const paymentEntry = (p, online) => p && p.created_at ? {
    at: p.created_at, action: online ? 'Payment sent' : 'Payment recorded', amount: num(p.amount), by: online ? CUSTOMER : '', note: payNote(p)
} : null;

/* the damage fee steps of a rental order */
function damageEntries(ref) {
    const out = [];
    for (const d of DMG.filter(x => x.rental_ref === ref)) {
        if (num(d.amount) <= 0)
            continue;
        out.push({ at: d.created_at, action: 'Damage fee recorded', amount: num(d.amount), item: d.equipment_name, by: d.recorded_by ? staffName(d.recorded_by) : '', note: d.reason || '' });
        if (d.customer_paid_at)
            out.push({ at: d.customer_paid_at, action: 'Damage fee payment sent', amount: num(d.amount), item: d.equipment_name, by: CUSTOMER, note: d.gcash_reference ? 'GCash (ref ' + d.gcash_reference + ')' : '' });
        if (d.status === 'Paid' && d.paid_at)
            out.push({ at: d.paid_at, action: 'Damage fee paid', amount: num(d.amount), item: d.equipment_name, by: d.collected_by ? staffName(d.collected_by) : '', note: d.paid_method || '' });
    }
    return out;
}

/* the late fee steps of a rental order: left unpaid, customer payment sent / rejected, collected, waived (late_fee_log, 83_late_fee_collection.sql) */
const lateFeeEntries = ref => LFL.filter(x => x.rental_ref === ref).map(x => ({
    at: x.created_at, action: `Late fee: ${String(x.action).toLowerCase()}`, amount: num(x.amount),
    by: x.by_customer ? CUSTOMER : x.by_user_id ? staffName(x.by_user_id) : '', note: x.note || ''
}));

/* the History of the late fee, shown in the Collect late fee window */
export const lateFeeTrail = ref => trailHtml(lateFeeEntries(ref));

/* items staff swapped for an equivalent one (61_swap_rental_item.sql) */
const swapEntries = ref => SWP.filter(x => x.rental_ref === ref).map(x => ({
    at: x.created_at, action: 'Item swapped', item: `${x.old_name} to ${x.new_name}`, by: x.by_user_id ? staffName(x.by_user_id) : '', note: `${x.reason || ''}${x.reason ? ' ' : ''}(no extra charge)`
}));

/* replacement offers (71_customer_swap_choice.sql): offered, then declined / no answer / cancelled. A customer's choice or an automatic
   assignment already shows as "Item swapped" above, with the reason. */
const offerEntries = ref => OFR.filter(o => o.rental_ref === ref).flatMap(o => [
    { at: o.created_at, action: 'Replacement offered', item: `${o.old_name}: ${offerOptionNames(o).join(', ')}`, by: o.created_by ? staffName(o.created_by) : '',
      note: `Customer to choose by ${stampLabel(o.deadline_at)}${o.auto_assign ? ', otherwise the first choice is used' : ''}` },
    o.status === 'Declined' ? { at: o.resolved_at, action: 'Customer declined the offered items', by: CUSTOMER, note: o.note || '' } : null,
    o.status === 'Expired' ? { at: o.resolved_at, action: 'No answer by the deadline', note: o.note || '' } : null,
    o.status === 'Cancelled' ? { at: o.resolved_at, action: 'Replacement offer cancelled', by: o.resolved_by === 'staff' ? 'Staff' : '', note: o.note || '' } : null
]);

/* g = a rental group (see rentals.js groups()), pay = its payment row (or null) */
export function rentalTrail(g, pay) {
    const l0 = g.lines[0] || {}, online = g.source === 'Online', many = g.lines.length > 1;
    const out = [
        { at: l0.created_at, action: 'Rental requested', by: online ? CUSTOMER : '' },
        paymentEntry(pay, online),
        num(l0.balance_paid_amount) > 0 ? { at: l0.balance_paid_at, action: 'Balance collected', amount: num(l0.balance_paid_amount) } : null,
        { at: l0.issued_at, action: 'Equipment issued' },
        ...g.lines.filter(l => l.line_returned_at).map(l => ({ at: l.line_returned_at, action: 'Returned', item: many ? l.equipment_name : '' })),
        ...offerEntries(g.ref),
        ...swapEntries(g.ref),
        ...damageEntries(g.ref),
        ...lateFeeEntries(g.ref)
    ];
    return trailHtml(out);
}

export function bookingTrail(b, pay) {
    const online = b.source === 'Online';
    const out = [
        { at: b.created_at, action: 'Booking requested', by: online ? CUSTOMER : '' },
        paymentEntry(pay, online),
        num(b.balance_paid_amount) > 0 ? { at: b.balance_paid_at, action: 'Balance collected', amount: num(b.balance_paid_amount), note: b.balance_paid_method || '' } : null,
        ...EXT.filter(x => x.booking_ref === b.booking_ref).map(x => ({ at: x.created_at, action: `Extension requested (+${x.extra_hours} hr)`, amount: num(x.extra_cost), by: CUSTOMER, note: x.status === 'Rejected' ? 'Rejected' + (x.rejected_reason ? ': ' + x.rejected_reason : '') : x.status })),
        ...RL.filter(l => l.booking_ref === b.booking_ref && l.rental_type === 'Add-on').map(l => ({ at: l.created_at, action: 'Add-on requested', item: `${l.equipment_name} x${l.quantity}` })),
        // holds and no-show releases (78_no_show_release.sql)
        ...EVT.filter(x => x.booking_id === b.booking_id).map(x => ({ at: x.at, action: x.action, by: x.by_name || '', note: x.note || '' }))
    ];
    return trailHtml(out);
}

export function extensionTrail(x, pay) {
    return trailHtml([
        { at: x.created_at, action: `Extension requested (+${x.extra_hours} hr)`, amount: num(x.extra_cost), by: CUSTOMER },
        paymentEntry(pay, true)
    ]);
}
