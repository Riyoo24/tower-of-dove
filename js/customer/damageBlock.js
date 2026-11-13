/* =====================================================================
   customer/damageBlock.js - "you have an unpaid damage fee" notice
   DB: rpc my_damage_block (64_damage_block_reputation.sql). The database ALSO refuses the booking / rental with the same
   message, so this file only makes the page clearer; it is not the lock.
   Kept free of imports from the other customer modules so any of them can import it.
   ===================================================================== */

import { sb } from '../config/supabaseClient.js';
import { state } from './state.js';
import { isMember } from '../shared/session.js';
import { $, esc, peso } from '../shared/utils.js';

state.BLOCK = { blocked: false, message: '', owed: 0, waiting: 0, refs: [], generic: false };

let payHandler = null;
/* myRentals.js registers its existing GCash damage-fee dialog here */
export const onPayDamage = fn => { payHandler = fn; };

export const isBlocked = () => !!state.BLOCK.blocked;
export const blockMessage = () => state.BLOCK.message || '';

/* Load the signed-in customer's block status (a guest has none to load; the database checks the phone number on submit). */
export async function loadDamageBlock() {
    state.BLOCK = { blocked: false, message: '', owed: 0, waiting: 0, refs: [], generic: false };
    if (isMember()) {
        const { data, error } = await sb.rpc('my_damage_block');   // errors (migration 64 not run yet) simply mean "no block shown"
        const r = Array.isArray(data) ? data[0] : data;
        if (!error && r && r.blocked)
            state.BLOCK = {
                blocked: true,
                message: r.message || '',
                owed: Number(r.owed) || 0,
                waiting: Number(r.waiting) || 0,
                refs: Array.isArray(r.refs) ? r.refs : [],
                generic: !!r.generic
            };
    }
    renderDamageBlock();
}

/* Notice at the top of the Book and Rent tabs; the Book Now / Proceed to Checkout buttons are disabled with the same text. */
export function renderDamageBlock() {
    const b = state.BLOCK, payable = b.refs.filter(x => Number(x.unpaid) > 0);
    const html = !b.blocked ? '' : `
    <div class="blockbar" role="alert">
      <div><b>Booking and renting are paused.</b><p>${esc(b.message)}</p></div>
      ${payable.length ? `<div class="blockbar-act">${payable.map(x =>
        `<button type="button" class="btn gold" data-pay-damage="${esc(x.ref)}">Pay ${peso(Number(x.unpaid))} for ${esc(x.ref)}</button>`).join('')}</div>` : ''}
    </div>`;
    document.querySelectorAll('.blockbar-slot').forEach(el => { el.innerHTML = html; });
    const why = b.blocked ? b.message : '';
    [['#bk-now', 'Book Now'], ['#rco', 'Proceed to Checkout'], ['#rq', 'Request rental']].forEach(([sel]) => {
        const el = $(sel);
        if (!el)
            return;
        el.classList.toggle('is-blocked', b.blocked);
        if (b.blocked) {
            el.setAttribute('aria-disabled', 'true');
            el.title = why;
        } else {
            el.removeAttribute('aria-disabled');
            el.removeAttribute('title');
        }
    });
}

export function initDamageBlock() {
    document.addEventListener('click', e => {
        const pay = e.target.closest('[data-pay-damage]');
        if (pay && payHandler)
            payHandler(pay.dataset.payDamage);
    });
}
