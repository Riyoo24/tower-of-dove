/* =====================================================================
   customer/swapChoice.js - "Choose your replacement item"
   When equipment a customer booked can no longer be given (for example it came back damaged), staff can offer
   1 to 5 equivalent items instead. This file shows those offers in My rental / My bookings and lets the customer
   pick one (nothing extra is charged and nothing is refunded) or say none of them suit them.
   DB: rpc my_swap_offers, customer_choose_swap, customer_decline_swap (71_customer_swap_choice.sql).
   Until that file is run the rpc fails and nothing is shown.
   ===================================================================== */

import { sb } from '../config/supabaseClient.js';
import { state } from './state.js';
import { askConfirm, dlg, showDialog } from './ui.js';
import { loadMyBookings, loadMyRentals } from './data.js';
import { fmtDT } from './rent.js';
import { isMember } from '../shared/session.js';
import { btnBusy, btnReset, btnSuccess } from '../shared/btnState.js';
import { $, esc, toast } from '../shared/utils.js';

state.OFFERS = [];   // open offers of this customer: [{ id, ref, type, bookingRef, oldName, qty, deadline, auto, start, end, options: [{ id, name, category, image }] }]

state.FOLLOWUPS = new Set();   // rental refs where the customer declined (or did not answer) and the studio still has to follow up

/* true while the studio still has to contact the customer about a replacement (shown as the rental's status) */
export const awaitingStudio = rentalRef => state.FOLLOWUPS.has(rentalRef);

/* open offers for one rental reference (used by the My rental menu and status chip) */
export const offersFor = rentalRef => (state.OFFERS || []).filter(o => o.ref === rentalRef);

export async function loadSwapOffers() {
    state.OFFERS = [];
    state.FOLLOWUPS = new Set();
    if (isMember()) {
        const fu = await sb.rpc('my_swap_followups');   // needs 72_customer_swap_followup.sql; without it the status simply stays as it was
        if (!fu.error)
            state.FOLLOWUPS = new Set((fu.data || []).map(r => r.rental_ref));
        const { data, error } = await sb.rpc('my_swap_offers');   // an error (71_customer_swap_choice.sql not run yet) just means "nothing to choose"
        if (!error) {
            const map = new Map();
            (data || []).forEach(r => {
                if (!map.has(r.offer_id))
                    map.set(r.offer_id, {
                        id: r.offer_id,
                        ref: r.rental_ref,
                        type: r.rental_type === 'Add-on' ? 'addon' : 'out',
                        bookingRef: r.booking_ref,
                        oldName: r.old_name,
                        qty: r.quantity,
                        deadline: r.deadline_at,
                        auto: !!r.auto_assign,
                        start: r.w_start,
                        end: r.w_end,
                        options: []
                    });
                map.get(r.offer_id).options.push({ id: r.option_id, name: r.option_name, category: r.option_category || '', image: r.option_image || '' });
            });
            state.OFFERS = [...map.values()];
        }
    }
    renderSwapNotice();
}

/* The notice above My rental and My bookings: one row per open offer, with a Choose button. */
export function renderSwapNotice() {
    ['rt-member', 'bk-member'].forEach(id => {
        const card = document.getElementById(id);
        if (!card)
            return;
        let slot = card.previousElementSibling;
        if (!slot || !slot.classList.contains('swap-slot')) {
            slot = document.createElement('div');
            slot.className = 'swap-slot';
            card.parentNode.insertBefore(slot, card);
        }
        const list = state.OFFERS;
        slot.innerHTML = !list.length ? '' : `<div class="alert warn swapbar" role="alert">
          <div><b>${list.length === 1 ? 'Action needed: choose a replacement item' : `Action needed: ${list.length} replacement items to choose`}</b>
          <p>The studio cannot give you equipment you booked. Pick an equivalent item instead. It is free: nothing extra is charged.</p>
          <ul>${list.map(o => `<li><b>${esc(o.oldName)} x${o.qty}</b> for ${esc(o.ref)} <span class="mut">(answer by ${esc(fmtDT(o.deadline))})</span> <button type="button" class="btn sm gold" data-swap-choose="${o.id}">Choose</button></li>`).join('')}</ul></div>
        </div>`;
    });
}

function openChoice(offerId) {
    const o = state.OFFERS.find(x => String(x.id) === String(offerId));
    if (!o)
        return toast('That offer is no longer open. Please check My rental or contact the studio.');
    const first = o.options[0];
    if (dlg.open)
        dlg.close();
    showDialog(`
    <h2 style="margin:0 0 6px">Choose your replacement</h2>
    <p class="mut" style="margin:0 0 6px"><b>${esc(o.oldName)} x${o.qty}</b> on ${esc(o.ref)} can no longer be given to you${o.start ? ` for ${esc(fmtDT(o.start))}${o.end ? ' to ' + esc(fmtDT(o.end)) : ''}` : ''}. We are sorry about that.</p>
    <p class="mut" style="margin:0 0 10px">Pick one of these equivalent items. <b>There is no extra charge and no refund</b>: your booking stays as it is, with the same price.</p>
    ${o.options.length ? `<div class="dmg-choices sw-choices" role="radiogroup" aria-label="Replacement items">
      ${o.options.map(x => `<label class="dmg-choice">
        <input type="radio" name="sw-pick" value="${x.id}">
        <span>${x.image ? `<img class="sw-img" src="${esc(x.image)}" alt="" width="44" height="44" loading="lazy" decoding="async">` : ''}<b>${esc(x.name)}</b>${x.category ? `<small>${esc(x.category)}</small>` : ''}</span>
      </label>`).join('')}
    </div>` : '<p class="mut">None of the offered items can be rented right now. Please press "None of these suit me" and the studio will contact you.</p>'}
    <p class="mut" style="margin:12px 0 0;font-size:13px"><b>Please answer by ${esc(fmtDT(o.deadline))}.</b> ${o.auto && first
        ? `If we do not hear from you, we will give you <b>${esc(first.name)}</b>.` : 'If we do not hear from you, the studio will contact you.'}</p>
    <label for="sw-note" style="margin-top:10px">Message to the studio (optional, sent only if none of these suit you)</label>
    <input id="sw-note" maxlength="300" placeholder="For example: I would like to move it to another day">
    <div class="alert" id="sw-err" role="alert" hidden></div>
    <div class="acts">
      <button type="button" class="btn line" data-close>Decide later</button>
      <button type="button" class="btn line" id="sw-none">None of these suit me</button>
      <button type="button" class="btn gold" id="sw-ok" disabled>Confirm my choice</button>
    </div>`);

    const ok = $('#sw-ok'), none = $('#sw-none'), err = t => {
        const box = $('#sw-err');
        box.textContent = t;
        box.hidden = !t;
    };
    const picked = () => {
        const r = dlg.querySelector('[name="sw-pick"]:checked');
        return r ? o.options.find(x => String(x.id) === r.value) : null;
    };
    dlg.querySelectorAll('[name="sw-pick"]').forEach(r => r.addEventListener('change', () => {
        ok.disabled = !picked();
        err('');
    }));

    // whatever went wrong (the time ran out, someone else took it), show the newest list again
    const refreshAll = async () => {
        await loadMyBookings();
        await loadMyRentals();
    };

    ok.addEventListener('click', async () => {
        err('');
        const item = picked();
        if (!item)
            return;
        const yes = await askConfirm({
            title: 'Confirm your choice?',
            message: `${item.name} will replace ${o.oldName} x${o.qty} on ${o.ref}. There is no extra charge and no refund.`,
            ok: 'Yes, use this item',
            cancel: 'Not yet'
        });
        if (!yes)
            return;
        btnBusy(ok, 'Saving…');
        const { error } = await sb.rpc('customer_choose_swap', { p_offer_id: o.id, p_equipment_id: item.id });
        if (error) {
            btnReset(ok);
            err(error.message);
            await refreshAll();   // the offer may have closed: the notice disappears, or the list shrinks
            return;
        }
        await btnSuccess(ok, 'Saved', { keep: true });
        dlg.close();
        await refreshAll();
        toast(`Done. ${item.name} will be ready for ${o.ref} instead of ${o.oldName}.`);
    });

    none.addEventListener('click', async () => {
        err('');
        const yes = await askConfirm({
            title: 'None of these suit you?',
            message: 'The studio will contact you to arrange something else, such as another date. Nothing changes until then.',
            ok: 'Yes, contact me',
            cancel: 'Back'
        });
        if (!yes)
            return;
        btnBusy(none, 'Sending…');
        const { error } = await sb.rpc('customer_decline_swap', { p_offer_id: o.id, p_note: $('#sw-note').value.trim() || null });
        if (error) {
            btnReset(none);
            err(error.message);
            await refreshAll();
            return;
        }
        await btnSuccess(none, 'Sent', { keep: true });
        dlg.close();
        await refreshAll();
        toast('Thank you. The studio was told and will contact you.');
    });
}

export function initSwapChoice() {
    document.addEventListener('click', e => {
        const b = e.target.closest('[data-swap-choose]');
        if (b)
            openChoice(b.dataset.swapChoose);
    });
}

export const openSwapChoice = openChoice;
