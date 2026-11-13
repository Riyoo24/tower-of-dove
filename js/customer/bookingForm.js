/* =====================================================================
   customer/bookingForm.js - booking form dialog, time slots, add-ons, payment
   DB: rpc hold_slot / release_hold (slot holds) and the booking creation rpc, plus
   storage upload of the payment screenshot. Opened from the Book Now button.
   ===================================================================== */

import { noShowTerms } from './noShow.js';
import { PAY_DOWN, dueNow, onPayOption, optName, payOptionHtml, readPayOption } from '../shared/payOption.js';
import { allocationMessage, clearCart, maxFor, qtyIn, remainingFor, setQty, stockOf, trimCartToStock } from './cart.js';
import { state } from './state.js';
import { sb } from '../config/supabaseClient.js';
import { refreshBook } from './book.js';
import { blockMessage, isBlocked } from './damageBlock.js';
import { loadMyBookings, loadMyRentals, profileReady } from './data.js';
import { openRegisterModal } from './registerModal.js';
import { renderCart, renderEquipment } from './rent.js';
import { calendarEvent } from '../shared/calendar.js';
import { bkDlg, showStockAlert, showSuccess, stampLabel } from './ui.js';
import {
    conflictKind,
    heldSlots,
    isPastSlot,
    loadBusy,
    staffHeldSlots,
    takenSlots
} from '../shared/availability.js';
import { browseHtml, noteHtml, paintBrowse, stockLine, suggestionBlock } from '../shared/eqBrowse.js';
import { changeMessage, modalToast } from '../shared/eqModal.js';
import { matchesSearch } from '../shared/eqFilter.js';
import { EQUIPMENT, STUDIOS, gcashQrUrl } from '../shared/catalog.js';
import { gcashProofHtml, initGcashProof, uploadGcashProof } from '../shared/gcashProof.js';
import { drawHoldTimer as sharedDrawHoldTimer } from '../shared/holdTimer.js';
import { HOLD_TOKEN, LOCK_TTL, holdError, holdSlots, releaseHold } from '../shared/holds.js';
import { rememberGuestBooking, savePendingBooking } from '../shared/guestStore.js';
import { isMember } from '../shared/session.js';
import { receiptSending, sendReceipt, showReceiptResult } from '../shared/receipt.js';
import { btnBusy, btnReset, btnSuccess } from '../shared/btnState.js';
import { applyChecks, check, liveCheck } from '../shared/fieldCheck.js';
import {
    $,
    SLOTS,
    endTime,
    esc,
    longDate,
    manilaDay,
    manilaTS,
    normalizeEmail,
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

/* How many hours in a row are free from start slot t (no maximum). Stops at the next booked or held hour,
   an hour that already passed, or the 10:00 PM closing time. */
const freeRun = t => {
    const { si, d } = state.draft, taken = takenSlots(si, d);
    let n = 0;
    while (t + n < SLOTS.length && !taken.has(t + n) && !isPastSlot(d, t + n))
        n++;
    return Math.max(1, n);
};

/* The grid lists every time on the clock, including the 10:00 PM closing time (an end time only). */
const CLOSE_LABEL = '10:00 PM';

const slotLabel = i => SLOTS[i] || CLOSE_LABEL;

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
    $('#bk-foot-lbl').textContent = full ? 'Pay now' : 'Pay now (50%)';   // footer repeats the amount due, like the checkout
    $('#bk-foot-amt').textContent = peso(m.down);
    $('#bk-foot-tot').textContent = peso(m.total);
    $('#bk-dpl').textContent = full ? 'Full payment due now (100%)' : 'Down payment due now (50%)';
    $('#bk-bal').textContent = peso(m.balance);
    $('#bk-bal2').textContent = peso(m.balance);
    $('#bk-balrow').hidden = full;
    $('#bk-balnote').hidden = full;
    $('#bk-paidnote').hidden = !full;
    $('#bk-reflabel').firstChild.textContent = full ? 'GCash reference number (full payment) ' : 'GCash reference number (down payment) ';
    $('#bk-agreetxt').innerHTML = full
        ? 'I understand and agree that the <b>full payment is non-refundable</b> if this booking/reservation is cancelled.'
        : 'I understand and agree that the <b>50% down payment is non-refundable</b> if this booking/reservation is cancelled, and that I pay the <b>remaining balance at the studio</b>.' + noShowTerms();
    $('#bk-holdnote').textContent = full ? 'Your payment starts as Pending until staff verify it.' : 'Your down payment starts as Pending until staff verify it.';
    $('#bk-when').textContent = SLOTS[state.draft.t];
    if ($('#bk-qa'))
        $('#bk-qa').textContent = peso(m.down);
    if ($('#bk-qkind'))
        $('#bk-qkind').textContent = full ? 'full payment' : 'down payment';
    // until a start AND an end time are clicked there is no duration, so no price either (nothing is chosen for the customer)
    if (state.draft.none || state.draft.pick === 'end') {
        $('#bk-hh').textContent = state.draft.none ? 'Choose a start and end time' : `Start ${SLOTS[state.draft.t]}: choose an end time`;
        ['#bk-st', '#bk-t', '#bk-dp', '#bk-foot-amt', '#bk-foot-tot', '#bk-bal', '#bk-bal2', '#bk-qa'].forEach(id => {
            if ($(id))
                $(id).textContent = '\u2014';
        });
        if (state.draft.none)
            $('#bk-when').textContent = '\u2014';
    }
}

/* Wording for a time that someone else holds or has booked */
const MSG_HELD = 'Someone is already trying to book this schedule. Please try again in a moment or choose another time.';

const MSG_STAFF = 'This time is Held by Staff for a moment. Please try again shortly or choose another time.';

const heldMsg = kind => kind === 'staff' ? MSG_STAFF : kind === 'held' ? MSG_HELD : MSG_BOOKED;

const MSG_BOOKED = 'That time was just booked by someone else. Please choose another time.';

const slotError = msg => /just taken by another customer/i.test(msg) ? MSG_HELD : /no longer available/i.test(msg) ? MSG_BOOKED : msg;

/* Two-click time picker: click 1 sets the start time, click 2 sets the end time (state.draft.pick = 'end' while the
   end time is still to be chosen). The duration and the price follow from the two times. */
function drawSlots() {
    const dr = state.draft, taken = takenSlots(dr.si, dr.d),
        held = heldSlots(dr.si, dr.d),
        staff = staffHeldSlots(dr.si, dr.d);
    const none = !!dr.none, t = dr.t, picking = !none && dr.pick === 'end', endIdx = t + dr.h, reach = freeRun(t);
    const tip = (text, kind) => ` data-tip="${text}"${kind ? ` data-tip-kind="${kind}"` : ''}`;
    $('#bk-slots').innerHTML = Array.from({ length: SLOTS.length + 1 }, (_, i) => {
        const label = slotLabel(i), closing = i === SLOTS.length, past = !closing && isPastSlot(dr.d, i);
        const isStaff = !closing && taken.has(i) && staff.has(i), isHeld = !closing && taken.has(i) && held.has(i);
        // can this time be clicked right now?
        let ok, why = '', kind = '';
        if (picking) {
            if (i === t)
                ok = true;
            else if (i < t)
                ok = !taken.has(i) && !past;   // an earlier time starts the choice again
            else {
                ok = i - t <= reach;           // an end time: every hour from the start up to it must be free
                if (!ok) {
                    why = 'Part of that session is already booked or held. Choose an earlier end time.';
                    kind = 'bad';
                }
            }
        }
        else
            ok = !closing && !taken.has(i) && !past;
        if (!ok && !why) {
            if (closing) {
                why = 'The studio closes at 10:00 PM. Sessions can end here.';
                kind = 'mute';
            }
            else if (past) {
                why = 'This time has already passed. Please choose a later time.';
                kind = 'mute';
            }
            else if (isStaff) {
                why = 'Held by staff for a moment. Try again shortly or pick another time.';
                kind = 'warn';
            }
            else if (isHeld) {
                why = 'Someone is already trying to book this time. It may open up again soon.';
                kind = 'warn';
            }
            else if (taken.has(i)) {
                why = dr.d === manilaDay(0) ? 'This time is already booked or has passed. Please choose a later time.' : 'This time is already booked. Please choose another time.';
                kind = dr.d === manilaDay(0) ? 'mute' : 'bad';
            }
        }
        const isStart = !none && i === t, isEnd = !none && !picking && i === endIdx, mid = !none && !picking && i > t && i < endIdx;
        let tipAttr = '';
        if (isStart)
            tipAttr = tip(picking ? 'Start time. Now click an end time' : 'Start time');
        else if (isEnd)
            tipAttr = tip('End time');
        else if (picking && ok && i > t)
            tipAttr = tip(`End at ${label} (${pl(i - t, 'hr')})`);
        else if (why)
            tipAttr = tip(why, kind);
        if (!ok && isStaff && !isEnd)
            return `<button type="button" data-i="${i}" class="held staff" disabled${tipAttr}>${label}<span class="sh">Held by Staff</span></button>`;
        const cls = [closing ? 'closing' : '', isStart ? 'sel' : '', isEnd ? 'end' : '', mid ? 'mid' : '', picking && ok && i > t ? 'endok' : '', !ok && past ? 'past' : '', !ok && isHeld ? 'held' : ''].filter(Boolean).join(' ');
        return `<button type="button" data-i="${i}" class="${cls}" ${ok ? '' : 'disabled'}${tipAttr}>${label}${closing ? '<span class="cl">Closing time \u00b7 end only</span>' : ''}${!none && !picking && i >= t && i < endIdx && i < SLOTS.length ? '<span class="ln" aria-hidden="true"></span>' : ''}</button>`;
    }).join('');
    if ($('#bk-pick'))
        $('#bk-pick').innerHTML = `<span class="pk-steps" aria-hidden="true"><span class="pk-s${picking ? ' done' : ' on'}"><b>${picking ? '&#10003;' : '1'}</b>Start</span><span class="pk-line"></span><span class="pk-s${picking ? ' on' : ''}"><b>2</b>End</span></span>`
            + `<span class="pk-txt">${picking
                ? '<strong>Now click your end time.</strong> It can be any highlighted time. Click an earlier time to start over.'
                : none ? '<strong>Click your start time, then click your end time.</strong> Nothing is chosen for you. Your duration and price are worked out from the two times.'
                : '<strong>Click a start time, then click an end time.</strong> Your duration and price are worked out for you. Click a new start time to change your choice.'}</span>`;
    if ($('#bk-range'))
        $('#bk-range').innerHTML = none
            ? '<span><i class="rg-start"></i>Start <b>Click a start time</b></span><span><i class="rg-end"></i>End <b>Click an end time</b></span>'
            : picking
            ? `<span><i class="rg-start"></i>Start <b>${SLOTS[t]}</b></span><span><i class="rg-end"></i>End <b>Click an end time</b></span>`
            : `<span><i class="rg-start"></i>Start <b>${SLOTS[t]}</b></span><span><i class="rg-end"></i>End <b>${endTime(SLOTS[t], dr.h)}</b></span><span>Duration <b>${pl(dr.h, 'hour')}</b></span>`;
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
        bkError('That runs past closing time. Choose an earlier end time.');
        return false;
    }
    const ok = await holdSlots(state.draft.si, state.draft.d, t, h);
    if (!state.draft)
        return false;                    // the form was closed while this request was running (the release is queued behind it)
    if (!ok) {
        const refused = holdError;   // keep the database's own reason: the re-hold below resets it
        await holdSlots(state.draft.si, state.draft.d, state.draft.t, state.draft.h);   // a failed move drops the old hold, so take it back
        if (!state.draft)
            return false;
        await loadBusy(state.draft.si, state.draft.d, state.draft.d);
        if (!state.draft)
            return false;
        // a refusal by the database itself (not a taken hour) is shown as it is, instead of a wrong "someone else has it" message
        bkError(refused || heldMsg(conflictKind(state.draft.si, state.draft.d, t, h)));
        drawSlots();
        return false;
    }
    state.draft.t = t;
    state.draft.h = h;
    bkError('');
    drawSlots();
    return true;
}

/* ---- dedicated add-on equipment window (opened from the booking form) ----
   Filter by category, see the photo and the full description, pick a quantity. */
const eqDlg = $('#eqdlg');

let eqCat = 'All';
let eqQuery = '';   // text typed in the window's search box (cleared each time the window opens)

/* the Rent tab shows the same shared cart, so redraw it whenever the booking form changes it */
const syncRentTab = () => {
    renderCart();
    renderEquipment();
};

/* The "slot held" countdown beside the form title: a bar that empties over the 2-minute hold, amber then red near the end.
   Any activity in the form refills it (see keepAlive). */
const drawHoldTimer = left => sharedDrawHoldTimer($('#bk-left'), left, LOCK_TTL);

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

/* The window is drawn by shared/eqBrowse.js, the same layout the staff's onsite rental window uses. */
function addOnItem(e) {
    return { id: e.id, name: e.name, category: e.category, desc: e.desc, img: e.img, price: peso(e.addonPrice) };
}

function drawAddOnModal() {
    const list = EQUIPMENT.filter(e => e.addon && stockOf(e, 'book') > 0);
    const hidden = state.winStock.book ? EQUIPMENT.filter(e => e.addon).length - list.length : 0;
    // what the numbers mean (never leave the customer guessing why an item is missing or whether the count is for their hours)
    const note = noteHtml(state.winErr.book ? 'error' : state.winStock.book ? 'hours' : 'today', {
        forWhat: 'your session',
        hidden,
        tail: state.winErr.book ? 'We check again when you book.'
            : 'Equipment is not held for you until staff verify your payment, so availability is checked again when you book.'
    });
    const cats = ['All', ...new Set(list.map(e => e.category).filter(Boolean))];
    const shown = list.filter(e => (eqCat === 'All' || e.category === eqCat) && matchesSearch(e, eqQuery));
    const chosen = Object.keys(state.cart.book).map(id => EQUIPMENT.find(x => x.id === +id)).filter(Boolean).map(addOnItem);
    const studio = state.draft ? STUDIOS[state.draft.si] : null;
    paintBrowse(eqDlg, browseHtml({
        title: 'Add equipment to your booking',
        intro: 'Used inside the studio during your session.',
        note,
        query: eqQuery,
        cats,
        cat: eqCat,
        cards: shown.map(e => {
            const rent = qtyIn('addon', e.id) + qtyIn('out', e.id);
            return {
                ...addOnItem(e),
                unit: 'per session',
                qty: qtyIn('book', e.id),
                max: Math.min(maxFor('book', e.id), 10),
                inLabel: 'In your booking',
                stockText: stockLine(stockOf(e, 'book'), !!state.winStock.book, remainingFor('book', e.id), 'your session', rent ? ` (${rent} held in your Rent equipment lists)` : '')
            };
        }),
        sugg: state.draft ? suggestionBlock({
            studio,
            chosen,
            pool: list.filter(e => remainingFor('book', e.id) > 0 && !qtyIn('book', e.id)).map(addOnItem),
            query: eqQuery,
            unit: 'per session'
        }) : '',
        selRows: addOnSelection().map(x => {
            const e = EQUIPMENT.find(y => y.id === x.equipment_id);
            return e ? { id: e.id, name: e.name, qty: x.quantity, price: peso(e.addonPrice * x.quantity) } : null;
        }).filter(Boolean),
        selTitle: 'Added to your booking'
    }), q => {
        eqQuery = q;
        drawAddOnModal();
    });
}

function eqCount() {
    const n = addOnSelection().length;
    const el = $('#eqd-n');
    if (el)
        el.textContent = n ? `${n} item${n === 1 ? '' : 's'} selected` : 'Nothing selected yet';
}

/* how many of each item are free during the session being booked (equipment_available_between, file 51) */
async function loadSessionStock() {
    const d = state.draft;
    state.winStock.book = null;
    state.winErr.book = false;
    if (!d)
        return;
    const { data, error } = await sb.rpc('equipment_available_between', {
        p_from: manilaTS(d.d, 10 + d.t),
        p_to: manilaTS(d.d, 10 + d.t + d.h)
    });
    if (state.draft !== d)
        return;
    if (!error && data)
        state.winStock.book = Object.fromEntries(data.map(r => [r.equipment_id, r.available]));
    else
        state.winErr.book = true;   // say so in the window instead of quietly showing today's stock
}

/* cuts what the customer chose to what is still free for the session, and refreshes everything that shows it */
function fitAddOnsToStock() {
    const trimmed = trimCartToStock('book');
    if (trimmed) {
        syncRentTab();
        renderAddOnSummary();
        updateTotals();
        eqCount();
    }
    return trimmed;
}

/* Other customers keep ordering while this window is open: ask again every 30 seconds and update the numbers.
   It waits while a quantity list is open, so a list the customer is using is never closed under them. */
let eqTimer = 0;

const stopEqRefresh = () => {
    clearInterval(eqTimer);
    eqTimer = 0;
};

async function refreshOpenAddOnModal() {
    if (!eqDlg.open || !state.draft || document.hidden)
        return;
    if (document.activeElement && document.activeElement.tagName === 'SELECT' && eqDlg.contains(document.activeElement))
        return;
    const before = JSON.stringify([state.winStock.book, state.winErr.book]);
    await loadSessionStock();
    if (!eqDlg.open || !state.draft || JSON.stringify([state.winStock.book, state.winErr.book]) === before)
        return;
    const trimmed = fitAddOnsToStock();
    drawAddOnModal();
    if (trimmed)
        toast('Availability changed, so we adjusted your equipment to what is still free for your session.');
}

async function openAddOnModal() {
    if (!state.draft)
        return;
    await loadSessionStock();
    if (!state.draft)
        return;
    eqCat = 'All';
    eqQuery = '';
    drawAddOnModal();
    eqDlg.showModal();
    stopEqRefresh();
    eqTimer = setInterval(refreshOpenAddOnModal, 30 * 1000);
}

eqDlg.addEventListener('close', stopEqRefresh);

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

eqDlg.addEventListener('click', e => {
    const sg = e.target.closest('[data-sadd]');   // a suggestion's "+ Add" adds one
    const rmSel = e.target.closest('[data-sel-rm]');   // "Remove" in the Added list takes the whole item out
    const b = sg || rmSel || e.target.closest('[data-qstep]');
    if (!b || b.disabled || !state.draft)
        return;
    const id = +(sg ? sg.dataset.sadd : rmSel ? rmSel.dataset.selRm : b.dataset.id), max = Math.min(maxFor('book', id), 10);
    const before = qtyIn('book', id);
    const want = rmSel ? 0 : Math.max(0, Math.min(max, before + (sg ? 1 : +b.dataset.qstep))), r = setQty('book', id, want);   // state.draft.addons is the booking form's own cart
    if (r.capped)
        showStockAlert(allocationMessage(id, 'book'));
    const sc = eqDlg.querySelector('.in');
    const top = sc ? sc.scrollTop : 0;
    drawAddOnModal();
    if (sc) eqDlg.querySelector('.in').scrollTop = top;
    syncRentTab();
    renderAddOnSummary();
    updateTotals();
    eqCount();
    const item = EQUIPMENT.find(x => x.id === id), msg = item && changeMessage(item.name, before, r.q, 'your booking');
    if (msg && !r.capped)   // (when the stock ran out, the stock alert above already explains)
        modalToast(msg[0], msg[1]);
    if (bumpIdle)
        bumpIdle();
});

/* prefill (optional) = a booking picked before the customer went to register:
   { h, addons: { equipmentId: qty }, first, last, phone }. Used by restorePendingBooking() in index.js. */
export async function openBook(startIndex, prefill = null) {
    await profileReady;
    if (isBlocked())
        return toast(blockMessage());   // unpaid damage fee (the database refuses the booking too)
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

    let h = 1;   // default duration: 1 hour
    // a restored booking keeps its hours when they are all still free
    const wantH = prefill ? Math.round(+prefill.h) : 0;
    if (wantH >= 1 && t + wantH <= SLOTS.length
        && Array.from({ length: wantH }, (_, i) => t + i).every(i => !taken.has(i) && !isPastSlot(d, i)))
        h = wantH;
    if (!(await holdSlots(si, d, t, h))) {
        await loadBusy(si, d, d);
        return toast(heldMsg(conflictKind(si, d, t, h)));
    }

    clearCart('book');   // every new booking form starts with no add-ons
    state.winStock.book = null;
    state.draft = {
        si,
        d,
        t,
        h,
        pick: h === 1 ? 'end' : 'start',   // a fresh 1-hour choice waits for its end time
        none: startIndex == null && !prefill,   // opened without a time: nothing is picked until the customer clicks a start and an end
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
        <div class="row"><h2 style="margin:0">Book Studio ${s.id}</h2>
          <span class="holdtimer" id="bk-left" role="timer" aria-live="off"><span class="ht-row"><span class="ht-dot" aria-hidden="true"></span><span class="ht-txt"></span></span><i class="ht-bar" aria-hidden="true"><b></b></i></span></div>
        <p class="mut">${longDate(d)}. ${peso(s.rate)} per hour. Your slot is held while this form is open and released after 2 minutes of inactivity.</p>

        <div class="bk-grid">
          <div class="bk-gl">
          <div class="bk-dc">
        <h3 class="co-h">Booking details</h3>
        <label>Choose your time</label>
        <div class="bk-pick" id="bk-pick" aria-live="polite"></div>
        <div class="slots" id="bk-slots"></div>
        <p class="bk-range" id="bk-range" aria-live="polite"></p>
        <p class="mut" style="margin-top:6px">The studio is open 10:00 AM to 10:00 PM. The last session starts at 9:00 PM, so every session ends by closing time.</p>
        <p class="mut" id="bk-hint" style="margin-top:6px" hidden>Times with a dashed outline are being booked by someone else right now. They may open up again in about 2 minutes.</p>

        <label>Add-on equipment <span class="mut" style="font-weight:400">(optional)</span></label>
        <div class="adsum" id="bk-ad"></div>
        <button type="button" class="btn line sm" id="bk-ad-open" style="margin-top:8px">Browse equipment</button>
          </div>
          <section class="bk-sumcol" aria-label="Order summary">
            <h3 class="co-h">Order summary</h3>
            <div class="co-sum bk-sum">
              <div class="bkt">
                <div><span>Studio (<span id="bk-hh"></span>)</span><span id="bk-st"></span></div>
                <div id="bk-adr" hidden><span>Add-on equipment</span><span id="bk-ao"></span></div>
              </div>
              <div class="tot"><span>Total</span><span id="bk-t"></span></div>
              <div class="co-due" id="bk-split">
                <div class="co-due-main"><span id="bk-dpl">Down payment due now (50%)</span><b id="bk-dp"></b></div>
                <div class="co-due-rest" id="bk-balrow"><span>Balance to pay at the studio</span><span id="bk-bal"></span></div>
              </div>
            </div>
        <div class="policy"><b>Pick-up and balance</b>
          <ul>
            <li>Check in with our staff at <b>Studio ${s.id}</b> on <b>${longDate(d)}</b> at <b id="bk-when"></b>.</li>
            <li id="bk-balnote">Pay the remaining balance of <b id="bk-bal2"></b> at the studio when you arrive. Any add-on equipment is handed over there too.</li>
            <li id="bk-paidnote" hidden>Your booking is paid in full. Nothing is left to pay when you arrive. Any add-on equipment is handed over at the studio.</li>
            <li>Extra hours or equipment added later are paid separately, with the 50% or full payment option, and verified by staff.</li>
          </ul>
        </div>
          </section>
          </div>
          <div class="bk-gr">
          <div class="bk-dc">
        <h3 class="co-h">Customer details</h3>
        ${guest ? `<fieldset class="acct-choice" id="bk-acct">
          <legend>How would you like to book?</legend>
          <label class="acct-opt"><input type="radio" name="bk-acct" value="guest" checked><span><b>Continue as Guest</b><small>No account needed. You get a booking code to look your booking up later.</small></span></label>
          <label class="acct-opt"><input type="radio" name="bk-acct" value="register"><span><b>Register an account to save your data</b><small>Keep your bookings and details in one place. Sign up in a quick pop-up and we keep this booking for you to finish.</small></span></label>
        </fieldset>
        <div class="policy" id="bk-regnote" hidden>Create your account in the pop-up. Your selection is kept and the time is checked again when you come back. You pay and submit the booking once you are logged in, and it goes straight to your account.</div>` : ''}

        <div class="fg2">
          <div><label for="bk-fn">First name <span class="req" aria-hidden="true">*</span></label><input id="bk-fn" data-letters autocomplete="given-name" required aria-required="true"></div>
          <div><label for="bk-ln">Last name <span class="req" aria-hidden="true">*</span></label><input id="bk-ln" data-letters autocomplete="family-name" required aria-required="true"></div>
        </div>
        <label for="bk-p">Phone <span class="req" aria-hidden="true">*</span></label>
        <input id="bk-p" type="tel" data-phone inputmode="tel" maxlength="15" placeholder="e.g. 0917 123 4567" autocomplete="tel" required aria-required="true">
        ${guest ? `<div id="bk-emrow">
          <label for="bk-em">Email address <span class="req" aria-hidden="true">*</span></label>
          <input id="bk-em" type="email" inputmode="email" placeholder="name@example.com" autocomplete="email" maxlength="254" required aria-required="true">
          <p class="mut" style="margin-top:4px">We email your booking receipt to this address.</p>
        </div>` : ''}
          </div>
          <section class="bk-pay" aria-label="Payment">
            <div id="bk-paybox">
              <h3 class="co-h">Payment</h3>
              <input type="hidden" id="bk-m" value="GCash">
              <div class="pay-step">
                <p class="step-t"><span class="step-n" aria-hidden="true">1</span>Choose how much to pay now</p>
                ${payOptionHtml('bk', 'at the studio')}
              </div>
              <div id="bk-gw">
                <div class="pay-step">
                  <p class="step-t"><span class="step-n" aria-hidden="true">2</span>Scan and pay with GCash</p>
          <div class="gq">
            <img id="bk-qr" alt="GCash QR code to scan" hidden>
            <p class="mut" id="bk-qn">Scan this QR code with GCash and pay the <span id="bk-qkind">down payment</span> of <b id="bk-qa"></b>. Then enter the reference number from your GCash receipt below.</p>
          </div>
                </div>
                <div class="pay-step">
                  <p class="step-t"><span class="step-n" aria-hidden="true">3</span>Confirm your payment</p>
                  ${gcashProofHtml('bk')}
                  <label for="bk-g" id="bk-reflabel">GCash reference number (down payment) <span class="req" aria-hidden="true">*</span></label>
                  <input id="bk-g" data-gcash-ref placeholder="13-digit reference" inputmode="numeric" required aria-required="true">
                </div>
              </div>
            </div>
          </section>
          </div>
        </div>

        <label class="terms" id="bk-terms">
          <input type="checkbox" id="bk-agree">
          <span id="bk-agreetxt">I understand and agree that the <b>50% down payment is non-refundable</b> if this booking/reservation is cancelled, and that I pay the <b>remaining balance at the studio</b>.${noShowTerms()}</span>
        </label>
        <div class="alert" id="bk-e" hidden></div>
        <p class="hold" id="bk-holdnote">Your down payment starts as Pending until staff verify it.</p>
        <div class="co-foot bk-foot">
          <div class="co-foot-due bk-foot-sum" id="bk-foot-due">
            <div class="ft-tot"><span>Total</span><b id="bk-foot-tot"></b></div>
            <div class="ft-due"><span id="bk-foot-lbl">Pay now (50%)</span><b id="bk-foot-amt"></b></div>
          </div>
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
        $('#bk-foot-due').hidden = reg;     // nothing is paid yet when registering first
        $('#bk-regnote').hidden = !reg;
        $('#bk-go').textContent = reg ? 'Register and continue' : 'Submit booking';
        bkError('');
        if (reg)
            openRegister();   // pop up right away
    };
    if (guest)
        $('#bk-acct').onchange = applyAcctChoice;

    $('#bk-slots').onclick = async e => {
        const b = e.target.closest('button');
        if (!b || b.disabled || !state.draft)
            return;
        const i = +b.dataset.i, dr = state.draft;
        if (!dr.none && dr.pick === 'end' && i > dr.t) {          // click 2: the end time sets the duration
            if (i - dr.t > freeRun(dr.t))
                return;
            if (await moveDraft(dr.t, i - dr.t) && state.draft) {
                state.draft.pick = 'start';
                bkError('');
                drawSlots();
            }
            return;
        }
        if (!dr.none && dr.pick === 'end' && i === dr.t)          // the start clicked again: still waiting for an end time
            return;
        // click 1: a new start time (1 hour until the end time is chosen)
        if (await moveDraft(i, 1) && state.draft) {
            state.draft.pick = 'end';
            state.draft.none = false;
            drawSlots();
        }
    };
    const proof = initGcashProof('bk', { ref: '#bk-g' });

    /* the rules of this form, used when leaving a field and again when the form is sent */
    const PAY_FIELDS = ['#bk-ss', '#bk-g'];
    const fieldRules = () => [
        ['#bk-fn', () => check.first($('#bk-fn').value)],
        ['#bk-ln', () => check.last($('#bk-ln').value)],
        ['#bk-p', () => check.phone($('#bk-p').value)],
        ...(guest ? [['#bk-em', () => check.email($('#bk-em').value)]] : []),
        ['#bk-ss', () => check.file(proof.file(), 'Attach a screenshot of your GCash payment.')],
        ['#bk-g', () => check.gcashRef($('#bk-g').value)],
        ['#bk-terms', () => $('#bk-agree').checked ? '' : 'Please tick the box to confirm you understand the no-refund policy.']
    ];
    liveCheck(fieldRules());
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
        if (document.hidden || !state.draft || !bkDlg.open)
            return;
        await loadBusy(state.draft.si, state.draft.d, state.draft.d);
        drawSlots();
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
        drawHoldTimer(left);
    }, 1000);
    drawHoldTimer(state.idleUntil - Date.now());


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
        // the end time must be clicked: a start time alone is not a booking
        if (state.draft && (state.draft.none || state.draft.pick === 'end')) {
            bkError(state.draft.none ? 'Please click a start time and an end time for your booking.' : 'Please click an end time for your booking.');
            const box = $('#bk-slots');
            if (box && box.scrollIntoView)
                box.scrollIntoView({ block: 'center', behavior: 'smooth' });
            return;
        }
        const first = $('#bk-fn').value.trim(),
            last = $('#bk-ln').value.trim(),
            phone = $('#bk-p').value.trim();
        const email = guest ? normalizeEmail($('#bk-em').value) : '';   // logged-in customers: the database uses the account email
        const method = $('#bk-m').value, gcash = $('#bk-g').value.replace(/\s/g, '');

        if (registerChosen()) {
            openRegister();   // normally already open: it pops up as soon as Register is picked
            return;
        }

        bkError('');
        const payOpt = readPayOption('bk');
        if (!payOpt)
            return bkError('Choose 50% Downpayment or Full Payment.');
        // every wrong field is marked under itself and the page jumps to the first one
        if (!applyChecks(fieldRules().filter(([t]) => method === 'GCash' || !PAY_FIELDS.includes(t)).map(([t, rule]) => [t, rule()])))
            return;

        const items = addOnSelection();
        const snap = {
            s: STUDIOS[state.draft.si],
            d: state.draft.d,
            t: state.draft.t,
            h: state.draft.h
        };
        const money = bookingMoney();
        const btn = ev.target.querySelector('.btn.gold');
        btnBusy(btn, 'Sending…');
        if (method === 'GCash') {
            const up = await uploadGcashProof(proof.file(), gcash);   // the screenshot goes first; staff see it when verifying
            if (up.error) {
                btnReset(btn);
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
        if (error) {
            btnReset(btn);
            if (/available for those hours/i.test(error.message || '')) {
                // another customer's equipment order got there first: update what this form shows to what is free now
                await loadSessionStock();
                if (fitAddOnsToStock())
                    return bkError(slotError(error.message) + ' Your equipment list was updated to what is still free. Check it and try again.');
            }
            return bkError(slotError(error.message));
        }

        await btnSuccess(btn, 'Booked', { keep: true });   // a brief check mark before the receipt window opens
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
            calendar: calendarEvent({ ref: row.booking_ref, studio: snap.s.id, date: snap.d, start: SLOTS[snap.t], hours: snap.h, pending: true }),
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
