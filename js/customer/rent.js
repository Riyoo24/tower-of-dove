/* =====================================================================
   customer/rent.js - "Rent equipment" tab
   Equipment cards, rental summary, add-on / outside rental request.
   DB: rental request rpc and ID upload for outside rentals.
   ===================================================================== */

import { state } from './state.js';
import { sb } from '../config/supabaseClient.js';
import { loadMyBookings, loadMyRentals } from './data.js';
import { normRef } from './myBookings.js';
import { blockMessage, isBlocked } from './damageBlock.js';
import { askConfirm, showIdViewer, showStockAlert, showSuccess } from './ui.js';
import { PAY_DOWN, PAY_FULL, dueNow, onPayOption, optName, payOptionHtml, readPayOption } from '../shared/payOption.js';
import { allocationMessage, clearCart, qtyIn, remainingFor, setQty, stockOf, trimCartToStock } from './cart.js';
import { clearSavedCart, saveCart, saveRentMode } from './cartStore.js';
import { BOOKINGS, firstBookableDate, isPastSlot, lastBookableDate } from '../shared/availability.js';
import { equipmentImage } from '../shared/cards.js';
import { bindToolbar, matchesSearch, suggestFor, suggestionsHtml, toolbarHtml } from '../shared/eqFilter.js';
import { EQUIPMENT, STUDIOS, dataReady, gcashQrUrl } from '../shared/catalog.js';
import { gcashProofHtml, initGcashProof, uploadGcashProof } from '../shared/gcashProof.js';
import { isMember } from '../shared/session.js';
import { HOLD_TOKEN, holdEquipment, releaseHold } from '../shared/holds.js';
import { holdCountdown } from '../shared/holdTimer.js';
import { receiptSending, sendReceipt, showReceiptResult } from '../shared/receipt.js';
import { btnBusy, btnReset, btnSuccess } from '../shared/btnState.js';
import { applyChecks, check, clearFieldErrors, liveCheck } from '../shared/fieldCheck.js';
import { emptyState } from '../shared/emptyState.js';
import {
    $,
    $$,
    SLOTS,
    TODAY,
    badge,
    dayOffset,
    esc,
    longDate,
    manilaParts,
    manilaTS,
    peso,
    shortDate,
    sum,
    toast,
    everyVisible
} from '../shared/utils.js';

/* ============================ 3. RENT EQUIPMENT ============================ */

const unitPrice = e => state.rentMode === 'addon' ? e.addonPrice : e.outsidePrice;

/* The cart of the chosen mode ({ equipmentId: quantity }). The other mode's cart is kept untouched. */
const curCart = () => state.cart[state.rentMode];

const eqById = id => EQUIPMENT.find(e => e.id === +id);

const hourLabel = h => `${h % 12 || 12}:00 ${h < 12 ? 'AM' : 'PM'}`;

export const fmtDT = ts => {
    const p = manilaParts(ts);
    return `${shortDate(p.date)}, ${hourLabel(p.hour)}`;
};

/* Guests may add equipment to a studio booking, but outside rentals need an account. */
const outBlocked = () => state.rentMode === 'out' && !isMember();

/* Outside rentals: the price covers the first 8 hours; every extra hour adds price / 8. */
function outsideHours() {
    const pd = $('#pd').value, rd = $('#rd').value;
    if (!pd || !rd)
        return null;
    const h = (new Date(manilaTS(rd, +$('#rt').value)) - new Date(manilaTS(pd, +$('#pt').value))) / 3600e3;
    return h > 0 ? h : null;
}

const billedHours = () => Math.max(8, Math.ceil(outsideHours() || 8));

function lineTotal(id) {
    const e = eqById(id), q = curCart()[id], unit = unitPrice(e);
    return state.rentMode === 'out' ? unit * q * billedHours() / 8 : unit * q;
}

/* Price of the current rental and what is paid now. The customer picks 50% (down payment) or 100% (full payment).
   Outside rentals add extra hours; add-ons are priced as listed. The database works out the same amounts. */
const optId = () => state.rentMode === 'out' ? 'rt' : 'ao';

function rentalMoney() {
    const keys = Object.keys(curCart()).filter(eqById), out = state.rentMode === 'out', hrs = out ? billedHours() : 8;   // (items not loaded yet are skipped)
    const base = sum(keys.map(id => unitPrice(eqById(id)) * curCart()[id]));
    const extraHrs = out ? hrs - 8 : 0,
        extra = base / 8 * extraHrs,
        total = base + extra,
        opt = readPayOption(optId()) || PAY_DOWN,
        down = dueNow(total, opt);
    return {
        base,
        extraHrs,
        extra,
        total,
        opt,
        down,
        balance: total - down
    };
}

/* wording that follows the chosen option (outside rental: 'rt', add-on: 'ao') */
function renderPayTexts() {
    const m = rentalMoney(), full = m.opt === 'full';
    const kind = full ? 'full payment' : 'down payment';
    [['oq', 'og', 'rt'], ['aq', 'ag', 'ao']].forEach(([q, g]) => {
        if ($(`#${q}-amt`))
            $(`#${q}-amt`).textContent = peso(m.down);
        if ($(`#${q}-kind`))
            $(`#${q}-kind`).textContent = kind;
        $(`#${g}-l`).firstChild.textContent = `GCash reference number (${kind}) `;
    });
    $('#or-agreetxt').innerHTML = `I understand and agree that: the <b>${full ? 'full payment' : '50% down payment'} is non-refundable</b> if I cancel this rental; the price covers <b>up to 8 hours</b> and returning earlier does not lower it; renting for <b>more than 8 hours</b> adds one-eighth of the item's price for every extra hour; and returning the equipment <b>late</b> (after the full 8-hour window) adds the same one-eighth charge for every hour it is late, which I pay at the studio when I return it.`;
}

function renderSummary() {
    const box = $('#rsum'), due = $('#co-due'), keys = Object.keys(curCart());
    renderPayTexts();
    if (!keys.length) {
        box.hidden = true;
        due.hidden = true;
        $('#co-foot-due').hidden = true;
        return;
    }
    const m = rentalMoney(), full = m.opt === 'full', out = state.rentMode === 'out';
    // price breakdown (outside rentals only: base 8 hours + extra hours)
    const rows = (out ? `<div><span>Rental (first 8 hours)</span><span>${peso(m.base)}</span></div>` : '') +
        (m.extraHrs ? `<div><span>Extra hours (${m.extraHrs} x ${peso(m.base / 8)})</span><span>${peso(m.extra)}</span></div>` : '');
    box.innerHTML = rows;
    box.hidden = !rows;
    // what is paid now, and what is left (shown under the total)
    const dueLbl = full ? 'Pay now (full payment)' : 'Pay now (50% down payment)';
    if (!due.querySelector('#co-due-amt'))   // built once, so the amounts keep the same elements and can roll
        due.innerHTML =
            '<div class="co-due-main"><span id="co-due-lbl"></span><b id="co-due-amt"></b></div>' +
            '<div class="co-due-rest" id="co-due-rest"><span id="co-due-rl"></span><span id="co-due-bal"></span></div>';
    $('#co-due-lbl').textContent = dueLbl;
    $('#co-due-amt').textContent = peso(m.down);
    $('#co-due-rest').hidden = full;
    $('#co-due-rl').textContent = `Balance to pay ${out ? 'at pick-up' : 'at the studio'}`;
    $('#co-due-bal').textContent = peso(m.balance);
    due.hidden = false;
    $('#co-foot-lbl').textContent = full ? 'Pay now' : 'Pay now (50%)';
    $('#co-foot-amt').textContent = peso(m.down);
    $('#co-foot-due').hidden = false;
}

function renderDuration() {
    const el = $('#rdur'), h = outsideHours(), w = windowFor('out'), when = $('#co-when');
    const msg = h === null ? 'The return must be after the pick-up.'
        : h < 8 ? `Rental length: ${h} hour${h === 1 ? '' : 's'}. The price covers up to 8 hours, so returning early does not lower it.`
            : h === 8 ? 'Rental length: 8 hours (the full base duration, included in the price).'
                : `Rental length: ${h} hours. ${Math.ceil(h) - 8} extra hour${Math.ceil(h) - 8 === 1 ? '' : 's'} added to the price.`;
    el.textContent = msg;
    // checkout window: the same fields as before, locked (the times are chosen in the Rental summary)
    if (when) {
        when.hidden = state.rentMode !== 'out' || !w;
        if (w) {
            const a = manilaParts(w[0]), z = manilaParts(w[1]);
            const ro = (id, label, val) => `<div><label for="${id}">${label}</label><input id="${id}" value="${esc(val)}" readonly tabindex="-1" aria-readonly="true"></div>`;
            when.innerHTML = `<div class="fg2">${ro('co-pd', 'Pick-up date', longDate(a.date))}${ro('co-pt', 'Pick-up time', hourLabel(a.hour))}</div>`
                + `<div class="fg2">${ro('co-rd', 'Return date', longDate(z.date))}${ro('co-rt', 'Return time', hourLabel(z.hour))}</div>`
                + `<p class="mut" style="margin-top:6px">${esc(msg)}</p>`
                + '<p class="mut" style="margin-top:2px">These times were chosen in the Rental summary. To change them, close this window first.</p>';
        }
    }
}

/* category filter above the equipment cards (same idea as the add-on equipment window) */
let rentCat = 'All';

/* search box and "In stock only" switch above the equipment cards (kept while switching between add-on and outside rent) */
let rentQ = '', rentInStock = false;

/* Only equipment offered for the chosen kind of rent is listed:
   studio add-ons show the items allowed as add-ons, outside rent shows the items allowed to be taken out. */
const isOffered = e => state.rentMode === 'addon' ? e.addon : e.outside;

function renderCategories() {
    const cats = ['All', ...new Set(EQUIPMENT.filter(isOffered).map(e => e.category).filter(Boolean))];
    if (!cats.includes(rentCat))
        rentCat = 'All';
    $('#eq-cats').innerHTML = cats.map(c => `<button type="button" data-cat="${esc(c)}" class="${c === rentCat ? 'on' : ''}">${esc(c)}</button>`).join('');
}

/* "Frequently added with": gear that usually goes with the studio you booked or with what is already in the cart */
function attachedStudio() {
    let letter = '';
    if (state.rentMode !== 'addon')
        return null;
    if (isMember()) {
        const b = BOOKINGS.find(x => x.ref === $('#lb').value);
        letter = b ? b.studio : '';
    }
    else if (attachBooking)
        letter = attachBooking.studio || '';
    letter = String(letter || '').replace(/^studio\s*/i, '');
    return STUDIOS.find(s => s.id === letter) || null;
}

export function renderSuggestions() {
    const box = $('#eq-sugg');
    if (!box)
        return;
    const ctx = state.rentMode;
    if (outBlocked() || rentQ.trim() || !EQUIPMENT.length) {
        box.innerHTML = '';
        return;
    }
    const chosen = Object.keys(curCart()).map(eqById).filter(Boolean), studio = attachedStudio();
    const seeds = [studio && `Studio ${studio.id} ${studio.desc}`, ...chosen.map(e => `${e.name} ${e.category || ''} ${e.desc || ''}`)];
    const pool = EQUIPMENT.filter(isOffered).filter(e => remainingFor(ctx, e.id) > 0);
    const items = suggestFor(seeds, pool, { chosen, max: 4 });
    const title = chosen.length
        ? `Frequently added with ${chosen.length === 1 ? chosen[0].name : 'your items'}`
        : `Frequently added with Studio ${studio ? studio.id : ''}`.trim();
    box.innerHTML = !chosen.length && !studio ? '' : suggestionsHtml(title, items, {
        attr: 'data-sadd',
        price: e => `${peso(unitPrice(e))} ${ctx === 'addon' ? 'per session' : 'per 8 hours'}`
    });
}

export function renderEquipment() {
    renderCategories();
    renderStockNote();
    renderSuggestions();
    const offered = EQUIPMENT.filter(isOffered);
    const shown = offered.filter(e => (rentCat === 'All' || e.category === rentCat)
        && matchesSearch(e, rentQ)
        && (!rentInStock || stockOf(e, state.rentMode) > 0));
    if (!shown.length) {
        const filtered = offered.length && (rentQ.trim() || rentInStock || rentCat !== 'All');
        $('#eq').innerHTML = emptyState(filtered
            ? {
                icon: 'headphones',
                title: 'No matching equipment',
                text: rentQ.trim()
                    ? `Nothing matches "${rentQ.trim()}"${rentInStock ? ' that is in stock' : ''}. Try a different word or clear the search.`
                    : rentInStock ? 'Everything in this list is out of stock for your hours right now.' : 'Nothing in this category.'
            }
            : {
                icon: 'headphones',
                title: 'No equipment right now',
                text: `Nothing is offered ${state.rentMode === 'addon' ? 'as a studio add-on' : 'for outside rent'} at the moment. Please check back soon.`
            });
        return;
    }
    $('#eq').innerHTML = EQUIPMENT.map((e, i) => {
        if (!isOffered(e) || (rentCat !== 'All' && e.category !== rentCat))
            return '';   // hidden, not shown as unavailable
        if (!matchesSearch(e, rentQ) || (rentInStock && stockOf(e, state.rentMode) < 1))
            return '';   // filtered out by the search box or "In stock only"
        const mine = qtyIn(state.rentMode, e.id), room = remainingFor(state.rentMode, e.id);
        const st = stockOf(e, state.rentMode), ok = st > 0 && !outBlocked();
        const unit = state.rentMode === 'addon' ? 'per session' : 'per 8 hours, then 1/8 per extra hour';

        const info = `${e.desc ? `<p class="mut" style="margin-top:4px">${esc(e.desc)}</p>` : ''}<p class="mut">${st} ${state.winStock[state.rentMode] ? 'free for your hours' : 'in stock now'}${mine || room < st ? `, ${room} still selectable` : ''}</p>`;

        /* − / count / + : the count is what is in this rental right now, so taking one back is one tap on the card.
           (+ stays enabled while the item can be bought, so tapping it at the limit explains where the stock is held.) */
        const control = `<div class="qtyl"><span>Qty</span>
            <div class="qstep" role="group" aria-label="Quantity of ${esc(e.name)}">
              <button type="button" class="qbtn" data-qstep="-1" data-id="${e.id}" aria-label="Remove one ${esc(e.name)}" ${mine > 0 ? '' : 'disabled'}>&minus;</button>
              <output class="qval" aria-live="polite">${mine}</output>
              <button type="button" class="qbtn" data-qstep="1" data-id="${e.id}" aria-label="Add one ${esc(e.name)}" ${ok ? '' : 'disabled'}>+</button>
            </div></div>`;

        return `
      <div class="card${mine > 0 ? ' sel' : ''}" data-eq="${e.id}">
        ${equipmentImage(e)}
        ${mine > 0 ? `<span class="eq-in">In your rental x${mine}</span>` : ''}
        <p class="cat">${esc(e.category || '')}</p>
        <div class="row"><h3>${esc(e.name)}</h3>${st < 2 ? badge(st < 1 ? (state.winStock[state.rentMode] ? 'Reserved' : 'In Use') : 'Low') : ''}</div>
        ${info}
        <div class="eq-foot">
          <p class="eq-tags">${e.addon ? '<span class="b addon">Add-on</span> ' : ''}${e.outside ? '<span class="b out">Outside</span>' : ''}</p>
          <div class="row eq-buy">
            <span><b>${peso(unitPrice(e))}</b> <span class="mut">${unit}</span></span>
            <span class="row" style="margin-left:auto">${control}</span>
          </div>
        </div>
      </div>`;
    }).join('');
}

export function renderCart() {
    /* A cart restored from the last visit lists equipment ids, but the equipment list itself is still loading
       when the page starts. Drawing it now would crash on the missing items (and stop the whole page from
       starting), so wait: customer/index.js draws the cart again as soon as the catalog has arrived. */
    if (!EQUIPMENT.length && Object.keys(curCart()).length)
        return;
    const keys = Object.keys(curCart());

    $('#bundle-tag-wrap').innerHTML = state.rentMode === 'out' && keys.length >= 2
        ? `<div class="bundle-tag">Rental bundle: ${keys.length} items</div>` : '';

    $('#cart').innerHTML = keys.length
        ? keys.map(id => {
            const e = eqById(id), q = curCart()[id];
            // the quantity shows in the - / + stepper, so the name is not followed by "x 1"
            const label = state.rentMode === 'out' ? `${esc(e.name)} (${billedHours()} hrs)` : esc(e.name);
            const ok = remainingFor(state.rentMode, id) > 0 && !outBlocked();
            return `<li><span class="cart-name"><span>${label}</span>
              <span class="qstep sm" role="group" aria-label="Quantity of ${esc(e.name)}">
                <button type="button" class="qbtn" data-qstep="-1" data-id="${id}" aria-label="Remove one ${esc(e.name)}">&minus;</button>
                <output class="qval" aria-live="polite">${q}</output>
                <button type="button" class="qbtn" data-qstep="1" data-id="${id}" aria-label="Add one ${esc(e.name)}" ${ok ? '' : 'disabled'}>+</button>
              </span></span><span>${peso(lineTotal(id))}</span></li>`;
        }).join('')
        : `<li class="empty-li">${emptyState({
            icon: 'cart',
            title: 'Your cart is empty',
            text: 'Pick equipment from the list to add it here.',
            action: { label: 'Browse equipment', scrollTo: '#eq-cats' },
            compact: true
        })}</li>`;

    const grand = keys.reduce((n, id) => n + lineTotal(id), 0);
    $('#ctt').textContent = peso(grand);
    $('#co-total').textContent = peso(grand);
    $('#co-foot-tot').textContent = peso(grand);
    // phone bar: appears once something is in the cart
    $('#rs-total').textContent = peso(grand);
    $('#rs-count').textContent = keys.length ? `${keys.length} ${keys.length === 1 ? 'item' : 'items'} in your rental` : '';
    $('#rent-sticky').hidden = !keys.length || outBlocked();
    $('#co-items').innerHTML = keys.map(id => {
        const e = eqById(id), q = curCart()[id];
        const label = state.rentMode === 'out' ? `${esc(e.name)} x ${q} (${billedHours()} hrs)` : `${esc(e.name)} x ${q}`;
        return `<li><span>${label}</span><span>${peso(lineTotal(id))}</span></li>`;
    }).join('');
    $('#rco').disabled = !keys.length;
    $('#rco-m').disabled = $('#rco').disabled;
    if (!keys.length && $('#rcdlg').open)
        $('#rcdlg').close();   // nothing left to check out
    renderSummary();
    renderDuration();
}

/* A guest has no account, so they type the booking reference code. The booking must exist, belong to
   a guest booking (the database hides registered accounts' bookings) and still be open. */
let attachBooking = null;   // { ref, text } once the guest's code has been found

async function findGuestBooking() {
    const info = $('#lb-info'), ref = normRef($('#lb-ref').value);
    attachBooking = null;
    if (!ref) {
        info.className = 'mut';
        info.textContent = 'Enter the booking reference code first.';
        syncAddonPayOption();
        refreshWindowStock();
        updateRequestButton();
        return;
    }
    info.className = 'mut';
    info.textContent = 'Looking for that booking...';
    const { data, error } = await sb.rpc('lookup_booking', { p_ref: ref });
    if (error || !data) {
        info.className = 'bad-text';
        info.textContent = `No booking found for ${ref}. Check the code and try again. If you booked with an account, log in instead.`;
    } else if (!['Pending', 'Approved', 'In Progress'].includes(data.status)) {
        info.className = 'bad-text';
        info.textContent = `${data.booking_ref} is ${data.status.toLowerCase()}, so equipment can't be added to it.`;
    } else {
        const a = manilaParts(data.start_at), z = manilaParts(data.end_at);
        attachBooking = { ref: data.booking_ref, studio: data.studio, startAt: data.start_at, endAt: data.end_at, started: data.status === 'In Progress' || new Date(data.start_at) <= new Date() };
        info.className = 'ok-text';
        info.textContent = `Found ${data.booking_ref}: ${data.studio}, ${longDate(a.date)}, ${hourLabel(a.hour)} to ${hourLabel(z.hour)}. Current total ${peso(+(data.grand_total ?? data.total))}.`;
    }
    syncAddonPayOption();
    refreshWindowStock();
    renderSuggestions();
    updateRequestButton();
}

export function renderRentMode() {
    $('#fa-member').hidden = !isMember();
    $('#fa-guest').hidden = isMember();
    $('#fa').hidden = state.rentMode !== 'addon';
    $('#fo').hidden = state.rentMode === 'addon';
    $('#fo-guest').hidden = !outBlocked();
    $('#rm-guest').hidden = !outBlocked();   // note beside the toggle, visible on the page itself
    // A guest on "Outside rent" can't rent anything, so the empty cart, total and checkout button are just noise: hide them.
    for (const el of [$('#bundle-tag-wrap'), $('#cart'), $('.rsum-card .tot'), $('#rco')])
        if (el) el.hidden = outBlocked();
    if (outBlocked() && $('#rent-sticky')) $('#rent-sticky').hidden = true;
    $('#rco').disabled = outBlocked();
    $('#rco-m').disabled = $('#rco').disabled;
    $('#fo-form').hidden = outBlocked();
    $('#fo-id').hidden = state.rentMode !== 'out' || outBlocked();
    $('#rs-when').hidden = state.rentMode !== 'out' || outBlocked();   // pick-up / return times sit in the Rental summary
    $('#apay').hidden = state.rentMode !== 'addon';
    $('#opay-wrap').hidden = state.rentMode !== 'out' || outBlocked();
    $('#rmh').textContent = state.rentMode === 'addon'
        ? 'Equipment for the studio session you booked. Pay 50% now and the rest at the studio, or pay in full. Once your session has started, equipment is paid in full.'
        : 'Equipment you take out of the studio, for registered customers. The price covers 8 hours. Pay 50% now and the rest at pick-up, or pay in full. You get an OUT reference.';
    $$('#rm button, #rm-top button').forEach(b => {
        const on = b.dataset.m === state.rentMode;
        b.classList.toggle('on', on);
        if (b.closest('#rm-top'))
            b.setAttribute('aria-pressed', String(on));
    });
    $('#rm-top-note').hidden = !outBlocked();   // a guest who picks Outside rent is told why right where they tapped
    renderEquipment();
    updateRequestButton();
}

/* Outside rentals need a member account and an ID file before the request button unlocks. */
function updateRequestButton() {
    $('#rq').disabled = state.rentMode === 'out' ? (outBlocked() || !$('#vf').files.length || !(proofs.og && proofs.og.file()))
        : (!isMember() && !attachBooking);   // a guest needs a found booking first
}

/* The rules of the checkout form. Each is [field, () => message]; they are used when a field is left and when the request is sent. */
const AGREE_MSG = 'Please tick the box to confirm you agree to the rental terms.';
const SHOT_MSG = 'Attach a screenshot of your GCash payment.';
const rules = {
    fn: ['#on-fn', () => check.first($('#on-fn').value)],
    ln: ['#on-ln', () => check.last($('#on-ln').value)],
    contact: ['#oc', () => check.phone($('#oc').value, 'contact number')],
    backup: ['#sm-link', () => check.phone($('#sm-link').value, 'backup contact number')],
    id: ['#vf', () => check.file($('#vf').files[0], 'Attach a valid ID.')],
    outShot: ['#og-ss', () => check.file(proofs.og.file(), SHOT_MSG)],
    outRef: ['#og', () => check.gcashRef($('#og').value)],
    agree: ['#or-terms', () => $('#or-agree').checked ? '' : AGREE_MSG],
    addShot: ['#ag-ss', () => check.file(proofs.ag.file(), SHOT_MSG)],
    addRef: ['#ag', () => check.gcashRef($('#ag').value)]
};
const runRules = keys => applyChecks(keys.map(k => [rules[k][0], rules[k][1]()]));   // true when all are fine

/* "Attach GCash Screenshot" fields under the QR code: og = outside rental, ag = add-on rental */
const proofs = {};
function setupProofs() {
    ['og', 'ag'].forEach(p => {
        $(`#${p}-proof`).innerHTML = gcashProofHtml(p);
        proofs[p] = initGcashProof(p, { ref: `#${p}`, onChange: updateRequestButton });
    });
}

/* ---- Valid ID preview: the customer can look at the file they picked before sending it ---- */
let idObjUrl = null;
const idIsPdf = f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

function updateIdPreview() {
    const f = $('#vf').files[0];
    if (idObjUrl) {
        URL.revokeObjectURL(idObjUrl);
        idObjUrl = null;
    }
    $('#vf-prev').hidden = !f;
    if (!f) {
        $('#vf-img').removeAttribute('src');
        return;
    }
    idObjUrl = URL.createObjectURL(f);
    const pdf = idIsPdf(f);
    $('#vf-img').hidden = pdf;
    $('#vf-pdf').hidden = !pdf;
    if (!pdf)
        $('#vf-img').src = idObjUrl;
    $('#vf-name').textContent = f.name;
}

function viewPickedId() {
    const f = $('#vf').files[0];
    if (f && idObjUrl)
        showIdViewer({
            url: idObjUrl,
            pdf: idIsPdf(f),
            title: 'Your valid ID'
        });
}

/* ---- free stock for the hours asked for ----
   Studio add-ons need the equipment during the chosen booking, outside rentals from pick-up to return. Two orders only
   compete when their hours overlap, so the website asks the database how many are free for those hours
   (equipment_available_between, file 51) and shows / limits the quantities with that. */
let winSeq = 0, winKey = '', winAt = 0;

function windowFor(ctx) {
    if (ctx === 'addon') {
        if (isMember()) {
            const b = BOOKINGS.find(x => x.ref === $('#lb').value);
            return b && b.startAt && b.endAt ? [b.startAt, b.endAt] : null;
        }
        return attachBooking && attachBooking.startAt ? [attachBooking.startAt, attachBooking.endAt] : null;
    }
    const pd = $('#pd').value, rd = $('#rd').value;
    if (!pd || !rd)
        return null;
    const a = manilaTS(pd, +$('#pt').value), z = manilaTS(rd, +$('#rt').value);
    return new Date(z) > new Date(a) ? [a, z] : null;
}

/* One line above the cards that says what the numbers mean, so a customer is never left guessing:
   - the numbers are for the chosen hours, or only today's stock because the hours are not known yet
   - the check failed (then it says so instead of quietly showing today's stock)
   - nothing is held for them until staff verify the payment (so the count is checked again when they send the request) */
function renderStockNote() {
    const el = $('#eq-note');
    if (!el)
        return;
    const ctx = state.rentMode, known = !!state.winStock[ctx];
    if (state.winErr[ctx]) {
        el.className = 'bad-text';
        el.textContent = "We couldn't check availability for your hours just now, so the numbers below are today's stock. We check again when you send your request.";
    }
    else if (!known) {
        el.className = 'mut';
        if (ctx === 'out' && $('#pd').value && $('#rd').value && !windowFor('out'))
            el.textContent = "The return must be after the pick-up, so we can't check availability yet. The numbers below are today's stock.";
        else
            el.textContent = ctx === 'addon'
                ? "Choose the booking this equipment is for to see how many are free for your hours. The numbers below are today's stock."
                : "Choose your pick-up and return times in the Rental summary to see how many are free for your hours. The numbers below are today's stock.";
    }
    else {
        el.className = 'mut';
        const w = windowFor(ctx);
        el.textContent = (ctx === 'out' && w ? `Showing what is free from ${fmtDT(w[0])} to ${fmtDT(w[1])}. Change the pick-up or return time in the Rental summary to check another time. ` : 'Numbers are for your hours only. ')
            + 'Your items are held for 2 minutes while checkout is open, and reserved once you send your request.';
    }
}

/* force = ask again even if the hours are the same as a moment ago (timer, or a request that was refused for stock) */
export async function refreshWindowStock(force = false) {
    const wins = { addon: windowFor('addon'), out: windowFor('out') }, key = JSON.stringify(wins);
    if (!force && key === winKey && Date.now() - winAt < 30000)
        return;   // same hours as a moment ago: nothing to ask again
    winKey = key;
    winAt = Date.now();
    await dataReady;   // never trim or redraw the cart before the equipment list is loaded
    const seq = ++winSeq, maps = {}, errs = {};
    if (wins[state.rentMode] && $('#eq-note')) {
        $('#eq-note').className = 'mut';
        $('#eq-note').textContent = 'Checking what is free for your hours...';
    }
    for (const ctx of ['addon', 'out']) {
        const w = wins[ctx];
        maps[ctx] = null;
        errs[ctx] = false;
        if (!w)
            continue;
        const { data, error } = await sb.rpc('equipment_available_between', { p_from: w[0], p_to: w[1], p_token: HOLD_TOKEN });
        if (!error && data)
            maps[ctx] = Object.fromEntries(data.map(r => [r.equipment_id, r.available]));   // needs 51_stock_by_time.sql
        else
            errs[ctx] = true;   // not installed yet, or the network failed: say so instead of quietly showing today's stock
    }
    if (seq !== winSeq)
        return;   // the hours changed again while asking: the newer answer wins
    state.winStock.addon = maps.addon;
    state.winStock.out = maps.out;
    state.winErr.addon = errs.addon;
    state.winErr.out = errs.out;
    const trimmed = trimCartToStock();
    renderEquipment();
    renderCart();
    if (trimmed)
        say('Availability changed, so we adjusted your list to what is still free for your hours.');
}

/* Equipment added to a session that has already started is paid in full (the database enforces it too, file 50):
   a 50% balance would have to be collected by staff in the middle of the session. Before the session starts the
   customer still picks 50% or 100%. */
let addonFullOnly = null;

function selectedBookingStarted() {
    if (isMember()) {
        const b = BOOKINGS.find(x => x.ref === $('#lb').value);
        return !!b && (b.status === 'Active' || (!!b.startAt && new Date(b.startAt) <= new Date()));
    }
    return !!(attachBooking && attachBooking.started);
}

export function syncAddonPayOption() {
    const full = selectedBookingStarted();
    if (full === addonFullOnly)
        return;   // nothing changed: keep what the customer picked
    addonFullOnly = full;
    $('#apay-opt').innerHTML = payOptionHtml('ao', 'at the studio', full ? PAY_FULL : PAY_DOWN, full);
    onPayOption('ao', renderCart);
    renderCart();
}

/* Bookings an add-on can be attached to: upcoming and not cancelled. */
export function renderAttachOptions() {
    const usable = BOOKINGS.filter(b => b.mine && b.date >= TODAY && ['Pending', 'Confirmed', 'Active'].includes(b.status));
    $('#lb').innerHTML = usable.length
        ? usable.map(b => `<option value="${b.ref}">${b.ref} - Studio ${b.studio}, ${b.date === TODAY ? 'today' : shortDate(b.date)} ${b.start}</option>`).join('')
        : '<option value="">No upcoming booking. Book a studio first.</option>';
    syncAddonPayOption();
    refreshWindowStock();
}

function loadRentalQr() {
    [['#oq-img', '#oq-note', 'oq'], ['#aq-img', '#aq-note', 'aq']].forEach(([imgSel, noteSel, q]) => {
        const img = $(imgSel);
        img.onload = () => {
            img.hidden = false;
        };
        img.onerror = () => {
            img.hidden = true;
            $(noteSel).innerHTML = `Pay the <span id="${q}-kind">down payment</span> of <b id="${q}-amt"></b> using the studio's GCash account, then enter the reference number from your receipt below. Ask staff if you need the account details.`;
            renderSummary();
        };
        img.src = gcashQrUrl();
    });
}

/* ---- Outside rental: no past times (Manila time) ----
   Before 9:00 PM today's hours that already passed are greyed out in BOTH the pick-up and the
   return list (at 11:31 AM the first choice for today is 12:00 PM). From 9:00 PM on, today is
   closed, so the date pickers start tomorrow (firstBookableDate). */
function limitOutsidePickers() {
    const min = firstBookableDate();
    const pd = $('#pd'), rd = $('#rd');
    pd.min = min;
    pd.max = rd.max = lastBookableDate();   // no more than 4 weeks ahead
    if (pd.value && pd.value > pd.max)
        pd.value = pd.max;
    if (rd.value && rd.value > rd.max)
        rd.value = rd.max;
    if (pd.value && pd.value < min)
        pd.value = min;                    // typed/old date -> earliest allowed day
    rd.min = (pd.value && pd.value > min) ? pd.value : min;            // return is never before pick-up
    if (rd.value && rd.value < rd.min)
        rd.value = rd.min;

    refreshWindowStock();   // the hours may have moved (a past hour was skipped)
    [['#pd', '#pt'], ['#rd', '#rt']].forEach(([dateSel, timeSel]) => {
        const date = $(dateSel).value, list = $(timeSel);
        [...list.options].forEach(o => {
            o.disabled = !!date && isPastSlot(date, +o.value - 10);
        });
        const chosen = list.selectedOptions[0];
        if (chosen && chosen.disabled) {
            // move to the first hour still open
            const open = [...list.options].find(o => !o.disabled);
            if (open)
                list.value = open.value;
        }
    });
}

/* Small pop-up alert in the middle of the top of the screen: "<item> was added". It closes by itself
   after about 2 seconds (or when tapped) and never blocks the page. */
let addedTimer = 0;

function showAddedPopup(name, qty, kind, stock, added = qty) {
    let pop = $('#add-pop');
    if (!pop) {
        pop = document.createElement('div');
        pop.id = 'add-pop';
        pop.className = 'add-pop';
        pop.setAttribute('role', 'status');
        pop.setAttribute('aria-live', 'polite');
        pop.onclick = () => {
            pop.hidden = true;
        };
        document.body.appendChild(pop);
    }
    const warn = kind === 'max' || kind === 'capped';
    const text = {
        added: 'Added to your rental',
        stacked: `Added ${added} more, ${qty} now in your rental`,
        capped: `Only ${stock} in stock, so all ${stock} are now in your rental`,
        max: stock === 1 ? 'Only 1 in stock, and it is already in your rental' : `Only ${stock} in stock, and all of them are already in your rental`
    }[kind];
    pop.classList.toggle('warn', warn);
    pop.innerHTML = `${warn
        ? '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>'
        : '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>'}
      <span><b>${esc(name)}</b>${kind === 'max' ? '' : ' x' + qty}<br><small>${text}</small></span>`;
    pop.hidden = false;
    pop.classList.remove('show');
    void pop.offsetWidth;   // restart the animation when another item is added quickly
    pop.classList.add('show');
    clearTimeout(addedTimer);
    addedTimer = setTimeout(() => {
        pop.hidden = true;
    }, 2200);
}

export function initRentTab() {
    // pick-up times: studio hours; return times also allow 10:00 PM closing
    $('#pt').innerHTML = SLOTS.map((t, i) => `<option value="${10 + i}">${t}</option>`).join('');
    $('#rt').innerHTML = SLOTS.map((t, i) => `<option value="${10 + i}">${t}</option>`).join('') + '<option value="22">10:00 PM</option>';
    $('#pd').value = $('#rd').value = dayOffset(1);
    $('#pt').value = '10';
    $('#rt').value = '18';
    limitOutsidePickers();
    everyVisible(limitOutsidePickers, 60 * 1000);   // keeps the list right when the hour changes or 9:00 PM passes
    $('#opay-opt').innerHTML = payOptionHtml('rt', 'at pick-up');
    syncAddonPayOption();
    onPayOption('rt', renderCart);
    $('#lb').addEventListener('change', () => {
        syncAddonPayOption();
        refreshWindowStock();
        renderSuggestions();
    });
    ['#pd', '#pt', '#rd', '#rt'].forEach(sel => $(sel).addEventListener('change', () => refreshWindowStock()));
    // other customers keep ordering: ask again every 30 seconds while the equipment list is on screen
    everyVisible(() => {
        const list = $('#eq');
        if (list && list.offsetParent !== null)
            refreshWindowStock(true);
    }, 30 * 1000);
    refreshWindowStock();
    loadRentalQr();

    /* Two copies of the same switch: the one in the Rental summary and (phones) the one at the top of the list */
    const onModeClick = e => {
        const btn = e.target.closest('[data-m]');
        const m = btn && btn.dataset.m;
        if (!m)
            return;
        // On a phone the equipment list sits above this card. Redrawing it changes its height and pushes the
        // card (and the toggle under the finger) up or down, which looks like a jump. Keep the toggle where it is.
        const anchor = e.currentTarget, top0 = anchor.getBoundingClientRect().top;
        state.rentMode = m;   // each mode keeps its own items; nothing is cleared when switching
        saveRentMode(m);       // persist so the active mode is restored after navigating away
        renderCart();
        renderRentMode();
        let stop = false;
        const halt = () => { stop = true; };
        addEventListener('wheel', halt, { once: true, passive: true });
        addEventListener('touchstart', halt, { once: true, passive: true });
        const t0 = performance.now();
        (function hold() {
            const d = anchor.getBoundingClientRect().top - top0;
            if (Math.abs(d) > 0.5)
                scrollBy({ top: d, behavior: 'instant' });
            if (!stop && performance.now() - t0 < 700)
                requestAnimationFrame(hold);
        })();
    };
    $('#rm').addEventListener('click', onModeClick);
    $('#rm-top').addEventListener('click', onModeClick);

    $('#eq-cats').addEventListener('click', e => {
        const c = e.target.closest('[data-cat]');
        if (!c)
            return;
        rentCat = c.dataset.cat;
        renderEquipment();
    });

    /* Redrawing the cards / suggestions / cart changes their height (the "In your rental" tag, a longer title,
       a different suggestion...). On a phone that pushes whatever is under the finger up or down, which looks
       like the page jumping. keepInPlace remembers where `locate()` sits on screen, runs the change, then scrolls
       by the difference so that element stays exactly where it was. It keeps correcting for a moment while images
       settle, and lets go the instant the person scrolls. */
    function keepInPlace(locate, change) {
        const before = locate(), top0 = before ? before.getBoundingClientRect().top : null;
        const result = change();
        if (top0 === null)
            return result;
        let stop = false;
        const halt = () => { stop = true; };
        addEventListener('wheel', halt, { once: true, passive: true });
        addEventListener('touchstart', halt, { once: true, passive: true });
        const t0 = performance.now();
        (function hold() {
            const el = locate();
            if (el) {
                const d = el.getBoundingClientRect().top - top0;
                if (Math.abs(d) > 0.5)
                    scrollBy({ top: d, behavior: 'instant' });
            }
            if (!stop && performance.now() - t0 < 500)
                requestAnimationFrame(hold);
        })();
        return result;
    }

    /* Add stacks: pressing it again adds the chosen quantity on top of what is already in this rental */
    function addItem(id, want) {
        const item = eqById(id), ctx = state.rentMode;
        const have = qtyIn(ctx, id);
        if (remainingFor(ctx, id) <= 0)   // every unit is already held (here or in the other list)
            return showStockAlert(allocationMessage(id, ctx));
        const r = setQty(ctx, id, have + want);
        renderCart();
        renderEquipment();
        if (r.capped)   // asked for more than is left: keep what fits, then explain where the rest is held
            return showStockAlert(allocationMessage(id, ctx));
        showAddedPopup(item.name, r.q, have ? 'stacked' : 'added', stockOf(item, ctx), r.q - have);
    }

    /* The cards redraw after every tap, so put the keyboard / screen-reader focus back on the button that was used. */
    const refocusStep = (id, step, root = '#eq') => {
        const same = $(`${root} [data-qstep="${step}"][data-id="${id}"]`);
        const other = $(`${root} [data-qstep="${-step}"][data-id="${id}"]`);
        const target = same && !same.disabled ? same : other && !other.disabled ? other : null;
        if (target && document.activeElement === document.body)
            target.focus({ preventScroll: true });
    };

    /* − / + on a card or on a line of the rental summary: + adds one (same stock rules as before), − takes one back out of this rental */
    const onQtyStep = e => {
        const btn = e.target.closest('[data-qstep]');
        if (!btn || btn.disabled)
            return;
        const root = e.currentTarget.id === 'cart' ? '#cart' : '#eq';
        const id = +btn.dataset.id, step = +btn.dataset.qstep, ctx = state.rentMode;
        // the button is redrawn, so find it again by id after each redraw
        const locate = () => $(`${root} [data-qstep="${step}"][data-id="${id}"]`) || $(`${root} [data-eq="${id}"]`) || $(root);
        if (step > 0) {
            keepInPlace(locate, () => addItem(id, 1));
            return refocusStep(id, step, root);
        }
        const item = eqById(id), have = qtyIn(ctx, id);
        if (!item || have <= 0)
            return;
        keepInPlace(locate, () => {
            setQty(ctx, id, have - 1);
            renderCart();
            renderEquipment();
        });
        toast(have - 1 > 0
            ? `Removed 1 ${item.name}. ${have - 1} left in your rental.`
            : `${item.name} removed from your rental.`);
        refocusStep(id, step, root);
    };
    $('#eq').addEventListener('click', onQtyStep);
    $('#cart').addEventListener('click', onQtyStep);

    // "Frequently added with": one tap adds one
    $('#eq-sugg').addEventListener('click', e => {
        const btn = e.target.closest('[data-sadd]');
        if (!btn)
            return;
        // the tapped suggestion is replaced by the next one, so keep the same slot (row) under the finger
        const idx = [...$$('#eq-sugg [data-sadd]')].indexOf(btn);
        keepInPlace(() => $$('#eq-sugg [data-sadd]')[idx] || $('#eq-sugg'), () => addItem(+btn.dataset.sadd, 1));
    });

    // search box + "In stock only" (the toolbar is drawn once, so typing never loses focus)
    $('#eq-toolbar').innerHTML = toolbarHtml('eqs', { q: rentQ, inStock: rentInStock });
    bindToolbar($('#eq-toolbar'), 'eqs', ({ q, inStock }) => {
        rentQ = q;
        rentInStock = inStock;
        renderEquipment();
    });

    $('#cart').addEventListener('click', e => {
        const rm = e.target.closest('[data-rm]');
        if (rm) {
            const id = rm.dataset.rm, e = eqById(id), left = (curCart()[id] || 0) - 1;   // remove one at a time
            if (left > 0)
                curCart()[id] = left;
            else
                delete curCart()[id];
            saveCart(state.cart);   // persist removal so it survives navigating away
            keepInPlace(() => $('#cart'), () => {
                renderCart();
                renderEquipment();
            });
            toast(left > 0
                ? `Removed 1 ${e.name}. ${left} left in your rental.`
                : `${e.name} removed from your rental.`);
        }
    });

    $('#pd').addEventListener('change', () => {
        $('#rd').min = $('#pd').value || firstBookableDate();
        if ($('#rd').value < $('#pd').value)
            $('#rd').value = $('#pd').value;
        limitOutsidePickers();
        renderCart();
    });
    $('#rd').addEventListener('change', () => {
        limitOutsidePickers();
        renderCart();
    });
    ['#pt', '#rt'].forEach(sel => $(sel).addEventListener('change', renderCart));
    $('#or-agree').addEventListener('change', e => {
        if (e.target.checked)
            $('#or-terms').classList.remove('err');
    });
    setupProofs();
    liveCheck(Object.values(rules));   // fields are checked when left, and again while a mistake is being fixed
    $('#vf').addEventListener('change', () => {
        updateIdPreview();
        updateRequestButton();
    });
    $('#vf-view').addEventListener('click', viewPickedId);
    $('#vf-img').addEventListener('click', viewPickedId);
    $('#vf-clear').addEventListener('click', () => {
        $('#vf').value = '';
        updateIdPreview();
        updateRequestButton();
    });
    $('#rq').addEventListener('click', requestRental);
    $('#rco').addEventListener('click', openCheckout);
    $('#rco-m').addEventListener('click', () => $('#rco').click());   // phone bar
    $('#co-close').addEventListener('click', () => $('#rcdlg').close());
    // any way of closing the window (button, Esc, backdrop, timeout, a sent request) frees the hold and stops the timers
    $('#rcdlg').addEventListener('close', () => {
        stopCheckoutTimers();
        $('#co-hold').hidden = true;
        releaseHold();
        refreshWindowStock(true);
    });
    $('#co-cancel').addEventListener('click', () => $('#rcdlg').close());
    $('#rcdlg').addEventListener('click', e => {
        if (e.target === $('#rcdlg'))   // click on the dim backdrop
            $('#rcdlg').close();
    });
    $('#lb-find').addEventListener('click', findGuestBooking);
    $('#lb-ref').addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            e.preventDefault();
            findGuestBooking();
        }
    });
    $('#lb-ref').addEventListener('input', () => {
        attachBooking = null;
        syncAddonPayOption();
        refreshWindowStock();
        updateRequestButton();
    });
}

/* "Proceed to Checkout": the details, ID upload and payment live in a wide pop-up over the page */
let coStop = null, coRenew = null;   // idle countdown + hold renewal of the open checkout window

function stopCheckoutTimers() {
    if (coStop)
        coStop();
    clearInterval(coRenew);
    coStop = coRenew = null;
}

/* the cart as the database wants it, and the hours it is needed (a studio add-on: the whole session; outside: pick-up to return) */
function holdRequest() {
    const w = windowFor(state.rentMode);
    const items = Object.entries(curCart()).map(([id, quantity]) => ({ equipment_id: +id, quantity }));
    return w && items.length ? { items, from: w[0], to: w[1] } : null;
}

async function openCheckout() {
    if (isBlocked())
        return toast(blockMessage());
    if (outBlocked())
        return toast('Guests cannot book an outside rental. Please register or log in first.');
    if (!Object.keys(curCart()).length)
        return toast('Add at least one item first.');
    // the booking is picked in the Rental summary on the page, so ask for it there rather than inside the pop-up
    if (state.rentMode === 'addon' && !(isMember() ? $('#lb').value : (attachBooking && attachBooking.ref))) {
        toast(isMember() ? 'Attach the rental to a studio booking first.' : 'Find your booking with its reference code first.');
        return $(isMember() ? '#lb' : '#lb-ref').focus();
    }
    // Hold the items for 2 minutes (same as the studio booking form) so nobody else can take the last unit meanwhile
    const req = holdRequest();
    if (!req)
        return toast(state.rentMode === 'addon' ? 'Choose the booking this equipment is for first.' : 'Choose a pick-up and return time first.');
    const btns = [$('#rco'), $('#rco-m')];
    btns.forEach(b => (b.disabled = true));
    const held = await holdEquipment(req.items, req.from, req.to);
    btns.forEach(b => (b.disabled = false));
    renderRentMode();   // puts the disabled state of the buttons back the way the mode needs it
    if (!held) {
        refreshWindowStock(true);
        return toast('Someone else is checking out some of this equipment for the same hours, so it is on hold for them right now. The list was updated. Try again in a moment, or choose a smaller quantity.');
    }
    coMsg('');
    clearFieldErrors('#rcdlg');
    renderRentMode();
    renderCart();
    stopCheckoutTimers();
    $('#rcdlg').showModal();
    // keep the hold alive while the window is open; if it can no longer be held (a long sleep, say) close the window
    coRenew = setInterval(async () => {
        const r = holdRequest();
        if (r && !(await holdEquipment(r.items, r.from, r.to)) && $('#rcdlg').open) {
            $('#rcdlg').close();
            refreshWindowStock(true);
            toast('Your equipment hold ran out and someone else took it. The list was updated.');
        }
    }, 60000);
    // same 2-minute idle rule as the booking form: no activity = the window closes and the items are released
    coStop = holdCountdown($('#rcdlg'), {
        label: $('#co-hold'),
        bar: true,
        noun: 'Item',
        onExpire: () => {
            $('#rcdlg').close();
            toast('Checkout closed after 2 minutes of inactivity. The equipment was released.');
        }
    });
    $('#co-title').focus({ preventScroll: true });   // keeps the browser from focusing the close button first
    $('#rcdlg .co-body').scrollTop = 0;
}

/* Messages shown while the checkout pop-up is open appear inside it (the page toast sits behind a modal). */
function coMsg(text) {
    const box = $('#co-err');
    box.textContent = text;
    box.hidden = !text;
    if (text)
        box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

const say = m => $('#rcdlg').open ? coMsg(m) : toast(m);

/* an error from the database; when it is a stock refusal, the numbers on screen are out of date, so ask again */
function rentalFail(error) {
    say(error.message);
    if (/available for those hours/i.test(error.message || ''))
        refreshWindowStock(true);
}

async function requestRental() {
    if (isBlocked())
        return say(blockMessage());
    const keys = Object.keys(curCart());
    if (!keys.length)
        return say('Add at least one item first.');
    const items = keys.map(id => ({
        equipment_id: +id,
        quantity: curCart()[id]
    }));
    const btn = $('#rq');
    coMsg('');
    btn.disabled = true;

    try {
        if (state.rentMode === 'addon') {
            const ref = isMember() ? $('#lb').value : (attachBooking && attachBooking.ref);
            if (!ref)
                return say(isMember() ? 'Attach the rental to a studio booking first.' : 'Find your booking with its reference code first.');
            const list = items.map(x => {
                const e = EQUIPMENT.find(y => y.id === x.equipment_id);
                return `${e.name} x${x.quantity}`;
            }).join(', ');
            const payOpt = readPayOption('ao'), agref = $('#ag').value.replace(/\s/g, '');
            if (!payOpt)
                return say('Choose 50% Downpayment or Full Payment.');
            if (!runRules(['addShot', 'addRef']))
                return;   // the wrong fields are marked under themselves
            const money = rentalMoney();
            const yes = await askConfirm({
                title: 'Add this equipment to your studio booking?',
                message: `${list} will be added to booking ${ref}. The cost is added to that booking's total. You are paying ${peso(money.down)} now (${optName(payOpt).toLowerCase()})${payOpt === 'full' ? '.' : `, and ${peso(money.balance)} at the studio.`}`,
                ok: 'Yes, add to my booking',
                cancel: 'Not yet'
            });
            if (!yes)
                return;
            btnBusy(btn, 'Sending…');
            const aup = await uploadGcashProof(proofs.ag.file(), agref);
            if (aup.error)
                return say('Could not upload your GCash screenshot: ' + aup.error.message);
            const { data: ares, error } = await sb.rpc('request_addon_rental', {
                p_booking_ref: ref,
                p_items: items,
                p_pay_option: payOpt,
                p_gcash_reference: agref,
                p_hold_token: HOLD_TOKEN
            });
            if (error)
                return rentalFail(error);
            const arow = (Array.isArray(ares) ? ares[0] : ares) || {};
            const afull = (arow.pay_option || payOpt) === 'full';
            const apaid = Number(arow.down_payment) || money.down, atotal = Number(arow.total_amount) || money.total;
            const added = items.map(x => {
                const e = EQUIPMENT.find(y => y.id === x.equipment_id);
                return ['Added', `${e.name} x${x.quantity}`];
            });
            await btnSuccess(btn, 'Sent', { keep: true });   // brief check mark before the confirmation opens
            clearCart('addon');
            clearSavedCart();   // wipe persisted cart — rental was submitted successfully
            proofs.ag.reset();
            $('#ag').value = '';
            renderCart();
            renderEquipment();
            await loadMyBookings();
            await loadMyRentals();
            // the booking's total now includes the new equipment
            const { data: bk } = await sb.rpc('lookup_booking', { p_ref: ref });
            if (!isMember()) {
                $('#lb-ref').value = '';
                attachBooking = null;
                $('#lb-info').className = 'mut';
                $('#lb-info').textContent = 'Enter the reference code from your booking confirmation. The equipment is added to that booking and its total is updated.';
            }
            $('#rcdlg').close();
            showSuccess({
                title: 'Equipment added to your booking!',
                label: 'Booking reference code',
                ref,
                lines: [
                    ...added,
                    ['Equipment total', peso(atotal)],
                    ['Payment option', optName(afull ? 'full' : 'down')],
                    [afull ? 'Full payment sent' : 'Down payment sent (50%)', peso(apaid)],
                    ['Balance at the studio', afull ? 'Paid in full' : peso(Math.max(0, atotal - apaid))],
                    ...(bk ? [['Booking total now', peso(+(bk.grand_total ?? bk.total))]] : []),
                    ['Receipt email', receiptSending(isMember() ? 'your account email' : 'the email on your booking'), 'ok-receipt']
                ],
                shot: 'It is your official receipt. Show it to our staff when you arrive so we can verify your booking and equipment.',
                note: 'Staff verify your GCash payment and review the equipment request. The new total is shown when you look up this booking.'
            });
            sendReceipt('rental', arow.rental_ref).then(showReceiptResult);
            return;
        }

        /* ---- outside rental (members only, with a 50% down payment) ---- */
        if (!isMember())
            return say('Please log in to rent equipment outside the studio.');
        const pd = $('#pd').value, rd = $('#rd').value, ph = +$('#pt').value, rh = +$('#rt').value;
        const first = $('#on-fn').value.trim(), last = $('#on-ln').value.trim();
        const contact = $('#oc').value.trim(), backup = $('#sm-link').value.trim();
        const payOpt = readPayOption('rt');
        const gref = $('#og').value.replace(/\s/g, ''), file = $('#vf').files[0], hours = outsideHours();

        // names, phone numbers, ID, GCash screenshot and reference, terms: each is marked under its own field
        if (!runRules(['fn', 'ln', 'contact', 'backup', 'id', 'outShot', 'outRef', 'agree']))
            return;
        if (!pd || !rd)
            return say('Choose the pick-up and return dates.');
        if (pd < firstBookableDate())
            return say('Same-day rentals are closed after 9:00 PM. Choose tomorrow or a later date.');
        if (pd > lastBookableDate() || rd > lastBookableDate())
            return say('Equipment can only be rented up to 4 weeks from today. Choose an earlier date.');
        if (isPastSlot(pd, ph - 10))
            return say('The pick-up time must be later than now.');
        if (isPastSlot(rd, rh - 10))
            return say('The return time must be later than now.');
        if (hours === null)
            return say('The return time must be after the pick-up time.');
        if (!payOpt)
            return say('Choose 50% Downpayment or Full Payment.');

        btnBusy(btn, 'Sending…');
        // upload the ID photo first; the request stores only its path
        const ext = ((file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '')) || 'jpg';
        const path = `${crypto.randomUUID()}/${Date.now()}.${ext}`;
        const up = await sb.storage.from('rental-ids').upload(path, file, { contentType: file.type });
        if (up.error)
            return say('Could not upload your ID: ' + up.error.message);
        const gup = await uploadGcashProof(proofs.og.file(), gref);
        if (gup.error)
            return say('Could not upload your GCash screenshot: ' + gup.error.message);

        const money = rentalMoney();
        const { data, error } = await sb.rpc('request_outside_rental', {
            p_items: items,
            p_first_name: first,
            p_last_name: last,
            p_number: contact,
            p_pickup_date: manilaTS(pd, ph),
            p_return_date: manilaTS(rd, rh),
            p_contact_number: contact,
            p_backup_contact: backup,
            p_id_type: $('#vt').value,
            p_id_image_path: path,
            p_gcash_reference: gref,
            p_pay_option: payOpt,
            p_hold_token: HOLD_TOKEN
        });
        if (error)
            return rentalFail(error);
        const row = Array.isArray(data) ? data[0] : data;
        const full = (row.pay_option || payOpt) === 'full';
        const paid = Number(row.down_payment) || money.down, rtotal = Number(row.total_amount) || money.total;

        await btnSuccess(btn, 'Sent', { keep: true });   // brief check mark before the confirmation opens
        clearCart('out');
        clearSavedCart();   // wipe persisted cart — rental was submitted successfully
        renderEquipment();
        $('#vf').value = '';
        updateIdPreview();
        proofs.og.reset();
        $('#og').value = '';
        $('#or-agree').checked = false;
        renderCart();
        await loadMyRentals();
        $('#rcdlg').close();
        showSuccess({
            title: 'Rental request sent!',
            label: 'Your rental reference code',
            ref: row.rental_ref,
            lines: [
                ['Pick-up', `${shortDate(pd)}, ${hourLabel(ph)}`],
                ['Return', `${shortDate(rd)}, ${hourLabel(rh)}`],
                ['Total', peso(rtotal)],
                ['Payment option', optName(full ? 'full' : 'down')],
                [full ? 'Full payment sent' : 'Down payment sent (50%)', peso(paid)],
                ['Balance at pick-up', full ? 'Paid in full' : peso(Math.max(0, rtotal - paid))],
                ['Receipt email', receiptSending('your account email'), 'ok-receipt']
            ],
            shot: 'It is your official receipt. Show it to our staff when you pick up the equipment so we can verify your rental.',
            note: `Staff will check your ID and verify your ${full ? 'full payment' : 'down payment'}. Bring the same ID when you pick up the equipment.`
        });
        sendReceipt('rental', row.rental_ref).then(showReceiptResult);
    } finally {
        btnReset(btn);
        updateRequestButton();
    }
}
