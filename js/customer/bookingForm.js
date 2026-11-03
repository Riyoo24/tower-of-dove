/* =====================================================================
   customer/bookingForm.js - booking form dialog, time slots, add-ons, payment
   DB: rpc hold_slot / release_hold (slot holds) and the booking creation rpc, plus
   storage upload of the payment screenshot. Opened from the Book Now button.
   ===================================================================== */

import { PAY_DOWN, dueNow, onPayOption, optName, payOptionHtml, readPayOption } from '../shared/payOption.js';
import { allocationMessage, clearCart, maxFor, qtyIn, remainingFor, setQty } from './cart.js';
import { state } from './state.js';
import { sb } from '../config/supabaseClient.js';
import { refreshBook } from './book.js';
import { loadMyBookings, loadMyRentals, profileReady } from './data.js';
import { openRegisterModal } from './registerModal.js';
import { renderCart, renderEquipment } from './rent.js';
import { bkDlg, showStockAlert, showSuccess, stampLabel } from './ui.js';
import {
    conflictKind,
    heldSlots,
    isPastSlot,
    loadBusy,
    staffHeldSlots,
    takenSlots
} from '../shared/availability.js';
import { equipmentImage } from '../shared/cards.js';
import { EQUIPMENT, STUDIOS, gcashQrUrl } from '../shared/catalog.js';
import { gcashProofHtml, initGcashProof, uploadGcashProof } from '../shared/gcashProof.js';
import { HOLD_TOKEN, LOCK_TTL, holdSlots, releaseHold } from '../shared/holds.js';
import { rememberGuestBooking, savePendingBooking } from '../shared/guestStore.js';
import { isMember } from '../shared/session.js';
import { receiptSending, sendReceipt, showReceiptResult } from '../shared/receipt.js';
import {
    $,
    SLOTS,
    endTime,
    esc,
    isEmail,
    isName,
    longDate,
    manilaDay,
    manilaTS,
    normalizeEmail,
    pad,
    peso,
    pl,
    shortDate,
    toast
} from '../shared/utils.js';

const bkError = msg => {
    const x = $('#bk-e');
    x.textContent = msg;
    x.hidden = !msg;
};

/* How many hours in a row are free from start slot t (max 4). Stops at the next booked or held hour,
   an hour that already passed, or the 10:00 PM closing time. */
const freeRun = t => {
    const { si, d } = state.draft, taken = takenSlots(si, d);
    let n = 0;
    while (n < 4 && t + n < SLOTS.length && !taken.has(t + n) && !isPastSlot(d, t + n))
        n++;
    return Math.max(1, n);
};

/* Only the durations that really fit are offered: not past 10:00 PM and not into an hour somebody else has. */
const durationOptions = (t, h) => {
    const max = state.draft ? freeRun(t) : Math.min(4, SLOTS.length - t);
    return Array.from({ length: max }, (_, i) => `<option value="${i + 1}" ${i + 1 === h ? 'selected' : ''}>${i + 1} hour${i ? 's' : ''}</option>`).join('');
};

/* redraw the Duration list only when the available hours changed (so an open list is not closed) */
const refreshDurations = () => {
    const sel = $('#bk-h');
    if (!sel || !state.draft)
        return;
    if (sel.options.length !== freeRun(state.draft.t))
        sel.innerHTML = durationOptions(state.draft.t, state.draft.h);
};

/* add-on equipment picked in the booking form: [{ equipment_id, quantity }] */
const addOnSelection = () => Object.entries(state.draft ? state.draft.addons : {}).map(([id, q]) => ({
    equipment_id: +id,
    quantity: +q
})).filter(x => x.quantity > 0);

const addOnPrice = id => {
    const e = EQUIPMENT.find(x => x.id === id);
    return e ? e.addonPrice : 0;
};

/* studio price + add-ons = total. The customer pays 50% (down payment) or 100% (full payment) now by GCash and
   the balance, if any, at the studio. The database calculates the same amounts when it saves the booking. */
function bookingMoney() {
    const studio = STUDIOS[state.draft.si].rate * state.draft.h;
    const sel = addOnSelection(),
        addons = sel.reduce((n, x) => n + addOnPrice(x.equipment_id) * x.quantity, 0);
    const total = studio + addons, opt = readPayOption('bk') || PAY_DOWN, down = dueNow(total, opt);
    return {
        studio,
        addons,
        hasAddons: sel.length > 0,
        total,
        opt,
        down,
        balance: total - down
    };
}

function updateTotals() {
    const m = bookingMoney();
    $('#bk-hh').textContent = `${pl(state.draft.h, 'hr')}, ${SLOTS[state.draft.t]} to ${endTime(SLOTS[state.draft.t], state.draft.h)}`;
    $('#bk-st').textContent = peso(m.studio);
    $('#bk-adr').hidden = !m.hasAddons;
    $('#bk-ao').textContent = peso(m.addons);
    $('#bk-t').textContent = peso(m.total);
    const full = m.opt === 'full';
    $('#bk-dp').textContent = peso(m.down);
    $('#bk-dpl').textContent = full ? 'Full payment due now (100%)' : 'Down payment due now (50%)';
    $('#bk-bal').textContent = peso(m.balance);
    $('#bk-bal2').textContent = peso(m.balance);
    $('#bk-balrow').hidden = full;
    $('#bk-balnote').hidden = full;
    $('#bk-paidnote').hidden = !full;
    $('#bk-reflabel').firstChild.textContent = full ? 'GCash reference number (full payment) ' : 'GCash reference number (down payment) ';
    $('#bk-agreetxt').innerHTML = full
        ? 'I understand and agree that the <b>full payment is non-refundable</b> if this booking/reservation is cancelled.'
        : 'I understand and agree that the <b>50% down payment is non-refundable</b> if this booking/reservation is cancelled, and that I pay the <b>remaining balance at the studio</b>.';
    $('#bk-holdnote').textContent = full ? 'Your payment starts as Pending until staff verify it.' : 'Your down payment starts as Pending until staff verify it.';
    $('#bk-when').textContent = SLOTS[state.draft.t];
    if ($('#bk-qa'))
        $('#bk-qa').textContent = peso(m.down);
    if ($('#bk-qkind'))
        $('#bk-qkind').textContent = full ? 'full payment' : 'down payment';
}

/* Wording for a time that someone else holds or has booked */
const MSG_HELD = 'Someone is already trying to book this schedule. Please try again in a moment or choose another time.';

const MSG_STAFF = 'This time is Held by Staff for a moment. Please try again shortly or choose another time.';

const heldMsg = kind => kind === 'staff' ? MSG_STAFF : kind === 'held' ? MSG_HELD : MSG_BOOKED;

const MSG_BOOKED = 'That time was just booked by someone else. Please choose another time.';

const slotError = msg => /just taken by another customer/i.test(msg) ? MSG_HELD : /no longer available/i.test(msg) ? MSG_BOOKED : msg;

function drawSlots() {
    const taken = takenSlots(state.draft.si, state.draft.d),
        held = heldSlots(state.draft.si, state.draft.d),
        staff = staffHeldSlots(state.draft.si, state.draft.d);
    $('#bk-slots').innerHTML = SLOTS.map((t, i) => {
        const isStaff = taken.has(i) && staff.has(i),
            isHeld = taken.has(i) && held.has(i),
            past = isPastSlot(state.draft.d, i),
            late = i + state.draft.h > SLOTS.length;
        if (isStaff)
            return `<button type="button" data-i="${i}" class="held staff" disabled title="Held by Staff">${t}<span class="sh">Held by Staff</span></button>`;
        const tip = isHeld ? ' title="Someone is already trying to book this schedule"'
            : late ? ` title="A ${state.draft.h}-hour session from ${t} would run past the 10:00 PM closing time"` : '';
        return `<button type="button" data-i="${i}" class="${i === state.draft.t ? 'sel' : ''}${isHeld ? ' held' : ''}" ${taken.has(i) || past || late ? 'disabled' : ''}${tip}>${t}</button>`;
    }).join('');
    if ($('#bk-hint')) {
        $('#bk-hint').hidden = !SLOTS.some((_, i) => taken.has(i) && held.has(i));
        $('#bk-hint').textContent = SLOTS.some((_, i) => staff.has(i))
            ? 'Times with a dashed outline are being booked by someone else, or are Held by Staff for a session extension. They may open up again in a few minutes.'
            : 'Times with a dashed outline are being booked by someone else right now. They may open up again in about 2 minutes.';
    }
    updateTotals();
}

/* Try to hold hours t..t+h for this customer (held on the server for 2 minutes). */
async function moveDraft(t, h) {
    if (t + h > SLOTS.length) {
        bkError('That runs past closing time. Choose a shorter duration.');
        return false;
    }
    const ok = await holdSlots(state.draft.si, state.draft.d, t, h);
    if (!state.draft)
        return false;                    // the form was closed while this request was running (the release is queued behind it)
    if (!ok) {
        await holdSlots(state.draft.si, state.draft.d, state.draft.t, state.draft.h);   // a failed move drops the old hold, so take it back
        if (!state.draft)
            return false;
        await loadBusy(state.draft.si, state.draft.d, state.draft.d);
        if (!state.draft)
            return false;
        bkError(heldMsg(conflictKind(state.draft.si, state.draft.d, t, h)));
        drawSlots();
        return false;
    }
    state.draft.t = t;
    state.draft.h = h;
    $('#bk-h').innerHTML = durationOptions(t, h);
    bkError('');
    drawSlots();
    return true;
}

/* ---- dedicated add-on equipment window (opened from the booking form) ----
   Filter by category, see the photo and the full description, pick a quantity. */
const eqDlg = $('#eqdlg');

let eqCat = 'All';

/* the Rent tab shows the same shared cart, so redraw it whenever the booking form changes it */
const syncRentTab = () => {
    renderCart();
    renderEquipment();
};

let bumpIdle = null;   // set while the booking form is open, keeps its 2-minute hold alive

function renderAddOnSummary() {
    const sel = addOnSelection();
    $('#bk-ad').innerHTML = sel.length
        ? sel.map(x => {
            const e = EQUIPMENT.find(y => y.id === x.equipment_id);
            return `<div class="adrow"><span>${esc(e.name)} x${x.quantity}</span><span>${peso(e.addonPrice * x.quantity)} <button type="button" class="lk" data-rm-ad="${x.equipment_id}">Remove</button></span></div>`;
        }).join('')
        : '<p class="mut">No equipment added.</p>';
}

function addOnCard(e) {
    const q = qtyIn('book', e.id), max = Math.min(maxFor('book', e.id), 10), rent = qtyIn('addon', e.id) + qtyIn('out', e.id);
    const info = e.desc ? `<p>${esc(e.desc)}</p>` : '<p class="mut">No description yet.</p>';
    return `<div class="eqcard">
      ${equipmentImage(e)}
      <p class="cat">${esc(e.category || '')}</p>
      <h3>${esc(e.name)}</h3>
      ${info}
      <p class="mut" style="margin-top:6px">${e.stock} in stock, ${remainingFor('book', e.id)} still selectable${rent ? ` (${rent} held in your Rent equipment lists)` : ''}</p>
      <div class="row" style="margin-top:8px">
        <b>${peso(e.addonPrice)} <span class="mut" style="font-weight:400">per session</span></b>
        <label class="qtyl">Qty <select data-aq="${e.id}" aria-label="Quantity of ${esc(e.name)}">${Array.from({ length: max + 1 }, (_, n) => `<option value="${n}" ${n === q ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      </div>
    </div>`;
}

function drawAddOnModal() {
    const list = EQUIPMENT.filter(e => e.addon && e.stock > 0);
    const cats = ['All', ...new Set(list.map(e => e.category).filter(Boolean))];
    const shown = list.filter(e => eqCat === 'All' || e.category === eqCat);
    eqDlg.innerHTML = `<div class="in">
    <div class="row"><h2 style="margin:0">Add equipment to your booking</h2><button type="button" class="btn sm line" data-close>Close</button></div>
    <p class="mut" style="margin-top:4px">Used inside the studio during your session. Choose a quantity for each item you want.</p>
    <div class="tabs" style="margin-top:10px">${cats.map(c => `<button type="button" data-cat="${esc(c)}" class="${c === eqCat ? 'on' : ''}">${esc(c)}</button>`).join('')}</div>
    <div class="eqgrid">${shown.map(addOnCard).join('') || '<p class="mut">Nothing available in this category.</p>'}</div>
    <div class="acts"><span class="mut" id="eqd-n" style="margin-right:auto"></span><button type="button" class="btn gold" data-close>Done</button></div>
  </div>`;
    eqCount();
}

function eqCount() {
    const n = addOnSelection().length;
    const el = $('#eqd-n');
    if (el)
        el.textContent = n ? `${n} item${n === 1 ? '' : 's'} selected` : 'Nothing selected yet';
}

function openAddOnModal() {
    if (!state.draft)
        return;
    eqCat = 'All';
    drawAddOnModal();
    eqDlg.showModal();
}

eqDlg.addEventListener('click', e => {
    const cat = e.target.closest('[data-cat]');
    if (cat) {
        eqCat = cat.dataset.cat;
        drawAddOnModal();
    }
    else if (e.target.closest('[data-close]'))
        eqDlg.close();
    if (bumpIdle)
        bumpIdle();
});

eqDlg.addEventListener('change', e => {
    const s = e.target.closest('[data-aq]');
    if (!s || !state.draft)
        return;
    const id = +s.dataset.aq, want = +s.value, r = setQty('book', id, want);   // state.draft.addons is the booking form's own cart
    if (r.capped)
        showStockAlert(allocationMessage(id));
    drawAddOnModal();
    syncRentTab();
    renderAddOnSummary();
    updateTotals();
    eqCount();
    if (bumpIdle)
        bumpIdle();
});

/* prefill (optional) = a booking picked before the customer went to register:
   { h, addons: { equipmentId: qty }, first, last, phone }. Used by restorePendingBooking() in index.js. */
export async function openBook(startIndex, prefill = null) {
    await profileReady;
    const si = state.selStudio, d = state.selDate;
    await loadBusy(si, d, d);
    const taken = takenSlots(si, d);
    let t = startIndex;
    // never start in the past: on today's date the default is the next upcoming free hour (e.g. 11:31 AM -> 12:00 PM)
    if (t == null || t < 0 || isPastSlot(d, t))
        t = SLOTS.findIndex((_, i) => !taken.has(i) && !isPastSlot(d, i));
    if (t < 0)
        return toast(d === manilaDay(0) ? 'No more times are available today. Choose another date.' : 'No free times for that day.');
    if (taken.has(t))
        return toast('No free times for that day.');

    let h = (t + 1 < SLOTS.length && !taken.has(t + 1)) ? 2 : 1;
    // a restored booking keeps its hours when they are all still free
    const wantH = prefill ? Math.round(+prefill.h) : 0;
    if (wantH >= 1 && wantH <= 4 && t + wantH <= SLOTS.length
        && Array.from({ length: wantH }, (_, i) => t + i).every(i => !taken.has(i) && !isPastSlot(d, i)))
        h = wantH;
    if (!(await holdSlots(si, d, t, h))) {
        await loadBusy(si, d, d);
        return toast(heldMsg(conflictKind(si, d, t, h)));
    }

    clearCart('book');   // every new booking form starts with no add-ons
    state.draft = {
        si,
        d,
        t,
        h,
        addons: state.cart.book   // the booking form's own add-ons (not copied from the Rent tab)
    };
    if (prefill && prefill.addons) {
        clearCart('book');
        // keep only equipment that can still be added, and never more than is in stock
        Object.entries(prefill.addons).forEach(([id, q]) => {
            const e = EQUIPMENT.find(x => x.id === +id && x.addon && x.stock > 0);
            if (e && +q > 0)
                setQty('book', e.id, Math.min(+q, 10));
        });
    }
    const s = STUDIOS[si];
    const guest = !isMember();   // signed-in customers are never asked: their bookings go to their account

    bkDlg.innerHTML = `
    <div class="in">
      <form id="bkf" novalidate>
        <div class="row"><h2 style="margin:0">Book Studio ${s.id}</h2><span class="mut" id="bk-left"></span></div>
        <p class="mut">${longDate(d)}. ${peso(s.rate)} per hour. Your slot is held while this form is open and released after 2 minutes of inactivity.</p>

        <label>Start time</label>
        <div class="slots" id="bk-slots"></div>
        <p class="mut" style="margin-top:6px">The studio is open 10:00 AM to 10:00 PM. The last session starts at 9:00 PM, so every session ends by closing time.</p>
        <p class="mut" id="bk-hint" style="margin-top:6px" hidden>Times with a dashed outline are being booked by someone else right now. They may open up again in about 2 minutes.</p>

        <label for="bk-h">Duration</label>
        <select id="bk-h">${durationOptions(t, h)}</select>

        ${guest ? `<fieldset class="acct-choice" id="bk-acct">
          <legend>How would you like to book?</legend>
          <label class="acct-opt"><input type="radio" name="bk-acct" value="guest" checked><span><b>Continue as Guest</b><small>No account needed. You get a booking code to look your booking up later.</small></span></label>
          <label class="acct-opt"><input type="radio" name="bk-acct" value="register"><span><b>Register an account to save your data</b><small>Keep your bookings and details in one place. Sign up in a quick pop-up and we keep this booking for you to finish.</small></span></label>
        </fieldset>
        <div class="policy" id="bk-regnote" hidden>Create your account in the pop-up. Your selection is kept and the time is checked again when you come back. You pay and submit the booking once you are logged in, and it goes straight to your account.</div>` : ''}

        <p class="req-note"><span class="req">*</span> Required</p>
        <div class="fg2">
          <div><label for="bk-fn">First name <span class="req" aria-hidden="true">*</span></label><input id="bk-fn" data-letters autocomplete="given-name" required aria-required="true"></div>
          <div><label for="bk-ln">Last name <span class="req" aria-hidden="true">*</span></label><input id="bk-ln" data-letters autocomplete="family-name" required aria-required="true"></div>
        </div>
        <label for="bk-p">Phone <span class="req" aria-hidden="true">*</span></label>
        <input id="bk-p" type="tel" placeholder="09XX XXX XXXX" autocomplete="tel" required aria-required="true">
        ${guest ? `<div id="bk-emrow">
          <label for="bk-em">Email address <span class="req" aria-hidden="true">*</span></label>
          <input id="bk-em" type="email" inputmode="email" placeholder="name@example.com" autocomplete="email" maxlength="254" required aria-required="true">
          <p class="mut" style="margin-top:4px">We email your booking receipt to this address.</p>
        </div>` : ''}

        <label>Add-on equipment <span class="mut" style="font-weight:400">(optional)</span></label>
        <div class="adsum" id="bk-ad"></div>
        <button type="button" class="btn line sm" id="bk-ad-open" style="margin-top:8px">Browse equipment</button>

        <div id="bk-paybox">
        <label for="bk-m">Payment method</label>
        <div class="payfix"><b>GCash</b> <span class="mut">Online bookings are paid with GCash now. Choose how much to pay below.</span></div>
        ${payOptionHtml('bk', 'at the studio')}
        <input type="hidden" id="bk-m" value="GCash">
        <div id="bk-gw">
          <div class="gq">
            <img id="bk-qr" alt="GCash QR code to scan" hidden>
            <p class="mut" id="bk-qn">Scan this QR code with GCash and pay the <span id="bk-qkind">down payment</span> of <b id="bk-qa"></b>. Then enter the reference number from your GCash receipt below.</p>
          </div>
          ${gcashProofHtml('bk')}
          <label for="bk-g" id="bk-reflabel">GCash reference number (down payment) <span class="req" aria-hidden="true">*</span></label>
          <input id="bk-g" placeholder="13-digit reference" inputmode="numeric" required aria-required="true">
        </div>
        </div>

        <div class="bkt">
          <div><span>Studio (<span id="bk-hh"></span>)</span><span id="bk-st"></span></div>
          <div id="bk-adr" hidden><span>Add-on equipment</span><span id="bk-ao"></span></div>
        </div>
        <div class="tot"><span>Total</span><span id="bk-t"></span></div>
        <div class="bkt" id="bk-split" style="margin-top:6px;border-top:0;padding-top:0">
          <div><b style="color:var(--ink)" id="bk-dpl">Down payment due now (50%)</b><b style="color:var(--ink)" id="bk-dp"></b></div>
          <div id="bk-balrow"><span>Balance to pay at the studio</span><span id="bk-bal"></span></div>
        </div>
        <div class="policy"><b>Pick-up and balance</b>
          <ul>
            <li>Check in with our staff at <b>Studio ${s.id}</b> on <b>${longDate(d)}</b> at <b id="bk-when"></b>.</li>
            <li id="bk-balnote">Pay the remaining balance of <b id="bk-bal2"></b> at the studio when you arrive. Any add-on equipment is handed over there too.</li>
            <li id="bk-paidnote" hidden>Your booking is paid in full. Nothing is left to pay when you arrive. Any add-on equipment is handed over at the studio.</li>
            <li>Extra hours or equipment added later are paid separately, with the 50% or full payment option, and verified by staff.</li>
          </ul>
        </div>

        <label class="terms" id="bk-terms">
          <input type="checkbox" id="bk-agree">
          <span id="bk-agreetxt">I understand and agree that the <b>50% down payment is non-refundable</b> if this booking/reservation is cancelled, and that I pay the <b>remaining balance at the studio</b>.</span>
        </label>
        <div class="alert" id="bk-e" hidden></div>
        <p class="hold" id="bk-holdnote">Your down payment starts as Pending until staff verify it.</p>
        <div class="acts">
          <button type="button" class="btn line" id="bk-x">Cancel</button>
          <button class="btn gold" id="bk-go">Submit booking</button>
        </div>
      </form>
    </div>`;

    drawSlots();
    state.idleUntil = Date.now() + LOCK_TTL;
    if (state.PROFILE) {
        $('#bk-fn').value = state.PROFILE.first;
        $('#bk-ln').value = state.PROFILE.last;
        $('#bk-p').value = state.PROFILE.number;
    }   // signed-in customers: fill in their details
    if (prefill) {
        // details typed before registering (the account's own details win when they exist)
        if (!$('#bk-fn').value)
            $('#bk-fn').value = prefill.first || '';
        if (!$('#bk-ln').value)
            $('#bk-ln').value = prefill.last || '';
        if (!$('#bk-p').value)
            $('#bk-p').value = prefill.phone || '';
    }

    /* Guest or Register: Register skips the payment part, because the booking is paid and submitted
       after the customer has an account. */
    /* The "Create your account" pop-up opens on top of this form (the slot stays held while they type).
       It is filled in with the name and phone typed so far. Cancelling it puts the choice back on Guest. */
    const openRegister = () => {
        const first = $('#bk-fn').value.trim(), last = $('#bk-ln').value.trim(), phone = $('#bk-p').value.trim();
        const snap = {
            studio: STUDIOS[state.draft.si].id,
            date: state.draft.d,
            t: state.draft.t,
            h: state.draft.h,
            addons: { ...state.draft.addons },
            first,
            last,
            phone
        };
        openRegisterModal({
            first,
            last,
            phone,
            savedNote: 'Your booking is saved. After you log in, we bring you back here to pay the down payment and submit it.',
            onActivity: () => {
                if (bumpIdle)
                    bumpIdle();
            },
            onAccount: () => {
                if ($('#rgm-fn')) {   // keep what they typed in the pop-up
                    snap.first = $('#rgm-fn').value.trim();
                    snap.last = $('#rgm-ln').value.trim();
                    snap.phone = $('#rgm-phone').value.trim();
                }
                savePendingBooking(snap);   // restored by the booking page after login
                if (state.draft)
                    state.draft.why = 'register';
                bkDlg.close();   // also frees the held hours
            },
            onClose: () => {
                if (!bkDlg.open || !state.draft)
                    return;
                const g = $('#bkf').querySelector('input[name="bk-acct"][value="guest"]');
                if (g) {
                    g.checked = true;
                    applyAcctChoice();
                }
            }
        });
    };
    const registerChosen = () => guest && !!$('#bkf').querySelector('input[name="bk-acct"][value="register"]:checked');
    const applyAcctChoice = () => {
        const reg = registerChosen();
        $('#bk-paybox').hidden = reg;
        if ($('#bk-emrow'))
            $('#bk-emrow').hidden = reg;   // the account's own email is used after registering
        $('#bk-terms').hidden = reg;
        $('#bk-holdnote').hidden = reg;
        $('#bk-regnote').hidden = !reg;
        $('#bk-go').textContent = reg ? 'Register and continue' : 'Submit booking';
        bkError('');
        if (reg)
            openRegister();   // pop up right away
    };
    if (guest)
        $('#bk-acct').onchange = applyAcctChoice;

    $('#bk-slots').onclick = e => {
        const b = e.target.closest('button');
        if (b && !b.disabled)
            moveDraft(+b.dataset.i, Math.min(state.draft.h, freeRun(+b.dataset.i)));   // a shorter free gap: keep the hours that fit
    };
    $('#bk-h').onchange = async e => {
        if (!(await moveDraft(state.draft.t, +e.target.value)))
            e.target.value = state.draft.h;
    };
    const proof = initGcashProof('bk', { ref: '#bk-g', onError: bkError });
    onPayOption('bk', updateTotals);
    $('#bk-m').onchange = e => {
        $('#bk-gw').hidden = e.target.value !== 'GCash';
    };
    $('#bk-x').onclick = () => bkDlg.close();
    $('#bk-ad-open').onclick = openAddOnModal;
    $('#bk-ad').onclick = e => {
        const r = e.target.closest('[data-rm-ad]');
        if (r) {
            delete state.draft.addons[r.dataset.rmAd];
            syncRentTab();
            renderAddOnSummary();
            updateTotals();
        }
    };
    renderAddOnSummary();
    $('#bk-agree').onchange = e => {
        if (e.target.checked) {
            $('#bk-terms').classList.remove('err');
            bkError('');
        }
    };

    // the studio's GCash QR (uploaded by the owner in Settings), shown above the reference number
    const qr = $('#bk-qr');
    qr.onload = () => {
        qr.hidden = false;
    };
    qr.onerror = () => {
        qr.hidden = true;
        $('#bk-qn').innerHTML = 'Pay the down payment of <b id="bk-qa"></b> using the studio\'s GCash account, then enter the reference number from your receipt below. Ask staff if you need the account details.';
        updateTotals();
    };
    qr.src = gcashQrUrl();
    updateTotals();

    // any activity keeps the hold alive
    let lastHold = Date.now();
    const keepAlive = () => {
        state.idleUntil = Date.now() + LOCK_TTL;
        if (state.draft && Date.now() - lastHold > 30000) {
            lastHold = Date.now();
            holdSlots(state.draft.si, state.draft.d, state.draft.t, state.draft.h);
        }
    };
    bumpIdle = keepAlive;
    // refresh the day every 15 seconds so times someone else was holding open up again
    const slotPoll = setInterval(async () => {
        if (!state.draft || !bkDlg.open)
            return;
        await loadBusy(state.draft.si, state.draft.d, state.draft.d);
        drawSlots();
        refreshDurations();
    }, 15000);
    ['pointerdown', 'keydown', 'input', 'touchstart'].forEach(ev => bkDlg.addEventListener(ev, keepAlive));
    bkDlg.addEventListener('scroll', keepAlive, true);

    clearInterval(state.idleTimer);
    state.idleTimer = setInterval(() => {
        const left = state.idleUntil - Date.now();
        if (left <= 0) {
            state.draft.why = 'timeout';
            bkDlg.close();
            return;
        }
        $('#bk-left').textContent = `Closes in ${Math.floor(left / 6e4)}:${pad(Math.floor(left / 1e3) % 60)} if idle`;
    }, 1000);

    bkDlg.onclose = () => {
        clearInterval(state.idleTimer);
        clearInterval(slotPoll);
        releaseHold();
        bumpIdle = null;
        if (eqDlg.open)
            eqDlg.close();
        const why = state.draft && state.draft.why;
        state.draft = null;
        clearCart('book');   // the form is closed, so its picks no longer reserve stock
        syncRentTab();
        refreshBook();
        if (why === 'timeout')
            toast('Booking closed after 2 minutes of inactivity. Your slot was released.');
    };

    $('#bkf').onsubmit = async ev => {
        ev.preventDefault();
        const first = $('#bk-fn').value.trim(),
            last = $('#bk-ln').value.trim(),
            phone = $('#bk-p').value.trim();
        const email = guest ? normalizeEmail($('#bk-em').value) : '';   // logged-in customers: the database uses the account email
        const method = $('#bk-m').value, gcash = $('#bk-g').value.replace(/\s/g, '');

        if (registerChosen()) {
            openRegister();   // normally already open: it pops up as soon as Register is picked
            return;
        }

        if (!first)
            return bkError('Enter your first name.');
        if (!isName(first))
            return bkError('The first name can only contain letters.');
        if (!last)
            return bkError('Enter your last name.');
        if (!isName(last))
            return bkError('The last name can only contain letters.');
        if (!/^[\d\s+()-]{7,}$/.test(phone))
            return bkError('Enter a valid phone number.');
        if (guest && !email)
            return bkError('Enter your email address.');
        if (guest && !isEmail(email))
            return bkError('Enter a valid email address, like name@example.com.');
        const payOpt = readPayOption('bk');
        if (!payOpt)
            return bkError('Choose 50% Downpayment or Full Payment.');
        if (method === 'GCash' && !proof.file())
            return bkError('Attach a screenshot of your GCash payment.');
        if (method === 'GCash' && !/^\d{13}$/.test(gcash))
            return bkError('Enter the 13-digit GCash reference number of your payment.');
        if (!$('#bk-agree').checked) {
            $('#bk-terms').classList.add('err');
            return bkError('Please tick the box to confirm you understand the no-refund policy.');
        }

        const items = addOnSelection();
        const snap = {
            s: STUDIOS[state.draft.si],
            d: state.draft.d,
            t: state.draft.t,
            h: state.draft.h
        };
        const money = bookingMoney();
        const btn = ev.target.querySelector('.btn.gold');
        btn.disabled = true;
        if (method === 'GCash') {
            const up = await uploadGcashProof(proof.file(), gcash);   // the screenshot goes first; staff see it when verifying
            if (up.error) {
                btn.disabled = false;
                return bkError('Could not upload your GCash screenshot: ' + up.error.message);
            }
        }
        const { data, error } = await sb.rpc('create_booking_with_addons', {
            p_studio_id: snap.s.dbId,
            p_start_at: manilaTS(snap.d, 10 + snap.t),
            p_end_at: manilaTS(snap.d, 10 + snap.t + snap.h),
            p_first_name: first,
            p_last_name: last,
            p_number: phone,
            p_payment_method: method,
            p_gcash_reference: method === 'GCash' ? gcash : null,
            p_hold_token: HOLD_TOKEN,
            p_items: items,
            p_pay_option: payOpt,
            p_email: guest ? email : null
        });
        btn.disabled = false;
        if (error)
            return bkError(slotError(error.message));

        const row = Array.isArray(data) ? data[0] : data;
        const total = Number(row.total_amount) || money.total,
            down = Number(row.down_payment) || money.down,
            balance = Math.max(0, total - down),
            full = (row.pay_option || payOpt) === 'full';
        if (!isMember())
            rememberGuestBooking({
                phone,   // proves the booking is theirs when it is moved to an account later
                ref: row.booking_ref,
                studio: snap.s.id,
                date: snap.d,
                start: SLOTS[snap.t],
                hours: snap.h,
                total,
                down
            });
        const lines = [
            ['Name', `${first} ${last}`],
            ['Studio', `Studio ${snap.s.id}`],
            ['Date', longDate(snap.d)],
            ['Time', `${SLOTS[snap.t]} to ${endTime(SLOTS[snap.t], snap.h)}`]
        ];
        items.forEach(x => {
            const e = EQUIPMENT.find(y => y.id === x.equipment_id);
            lines.push(['Add-on', `${e.name} x${x.quantity}`]);
        });
        lines.push(['Total', peso(total)]);
        lines.push(['Payment option', optName(full ? 'full' : 'down')]);
        lines.push([full ? 'Full payment sent' : 'Down payment sent (50%)', peso(down)]);
        lines.push(['Balance at the studio', full ? 'Paid in full' : peso(balance)]);
        lines.push([
            'Pick-up',
            full ? `Studio ${snap.s.id}, ${shortDate(snap.d)}, ${SLOTS[snap.t]}. Nothing left to pay`
                : `Studio ${snap.s.id}, ${shortDate(snap.d)}, ${SLOTS[snap.t]}. Pay the balance on arrival`
        ]);
        lines.push(['Payment', `GCash ${full ? 'full payment' : 'down payment'}, waiting for staff to verify`]);
        lines.push(['Booked on', stampLabel(new Date())]);
        lines.push(['Receipt email', receiptSending(guest ? email : 'your account email'), 'ok-receipt']);

        state.draft.why = 'done';
        clearCart('book');   // sent with the booking
        bkDlg.close();
        syncRentTab();
        showSuccess({
            title: 'Successfully booked!',
            label: 'Your booking reference code',
            ref: row.booking_ref,
            lines,
            shot: 'It is your official receipt. Show it to our staff when you arrive so we can verify your reservation.',
            note: full ? 'Staff confirm your booking once your payment is verified. Nothing is left to pay at the studio. You can also use this code to look up your booking later.'
                : 'Staff confirm your booking once your down payment is verified. Bring the balance to pay at the studio when you arrive. You can also use this code to look up your booking later.',
            extraActions: isMember() ? [] : [{
                label: 'Register to save this booking',
                className: 'line',
                // the booking is added to the new account after the first login
                onClick: () => openRegisterModal({
                    first,
                    last,
                    phone,
                    savedNote: 'Your booking is added to your account when you log in.'
                })
            }]
        });
        sendReceipt('booking', row.booking_ref).then(showReceiptResult);   // same email template for guests and members
        loadMyBookings().then(loadMyRentals);
    };

    bkDlg.showModal();
}
