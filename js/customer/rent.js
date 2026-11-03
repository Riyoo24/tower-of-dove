/* =====================================================================
   customer/rent.js - "Rent equipment" tab
   Equipment cards, rental summary, add-on / outside rental request.
   DB: rental request rpc and ID upload for outside rentals.
   ===================================================================== */

import { state } from './state.js';
import { sb } from '../config/supabaseClient.js';
import { loadMyBookings, loadMyRentals } from './data.js';
import { normRef } from './myBookings.js';
import { askConfirm, showIdViewer, showStockAlert, showSuccess } from './ui.js';
import { PAY_DOWN, dueNow, onPayOption, optName, payOptionHtml, readPayOption } from '../shared/payOption.js';
import { allocationMessage, clearCart, qtyIn, remainingFor, setQty } from './cart.js';
import { BOOKINGS, firstBookableDate, isPastSlot, lastBookableDate } from '../shared/availability.js';
import { equipmentImage } from '../shared/cards.js';
import { EQUIPMENT, gcashQrUrl } from '../shared/catalog.js';
import { gcashProofHtml, initGcashProof, uploadGcashProof } from '../shared/gcashProof.js';
import { isMember } from '../shared/session.js';
import { receiptSending, sendReceipt, showReceiptResult } from '../shared/receipt.js';
import {
    $,
    $$,
    SLOTS,
    TODAY,
    badge,
    dayOffset,
    esc,
    isName,
    longDate,
    manilaParts,
    manilaTS,
    peso,
    shortDate,
    sum,
    toast
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
    const keys = Object.keys(curCart()), out = state.rentMode === 'out', hrs = out ? billedHours() : 8;
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
    const box = $('#rsum'), keys = Object.keys(curCart());
    renderPayTexts();
    if (!keys.length) {
        box.hidden = true;
        return;
    }
    const m = rentalMoney(), full = m.opt === 'full', out = state.rentMode === 'out';
    box.hidden = false;
    box.innerHTML =
        (out ? `<div><span>Rental (first 8 hours)</span><span>${peso(m.base)}</span></div>` : '') +
        (m.extraHrs ? `<div><span>Extra hours (${m.extraHrs} x ${peso(m.base / 8)})</span><span>${peso(m.extra)}</span></div>` : '') +
        `<div><b style="color:var(--ink)">${full ? 'Full payment due now (100%)' : 'Down payment due now (50%)'}</b><b style="color:var(--ink)">${peso(m.down)}</b></div>` +
        (full ? '' : `<div><span>Balance to pay ${out ? 'at pick-up' : 'at the studio'}</span><span>${peso(m.balance)}</span></div>`);
}

function renderDuration() {
    const el = $('#rdur'), h = outsideHours();
    el.textContent = h === null ? 'The return must be after the pick-up.'
        : h < 8 ? `Rental length: ${h} hour${h === 1 ? '' : 's'}. The price covers up to 8 hours, so returning early does not lower it.`
            : h === 8 ? 'Rental length: 8 hours (the full base duration, included in the price).'
                : `Rental length: ${h} hours. ${Math.ceil(h) - 8} extra hour${Math.ceil(h) - 8 === 1 ? '' : 's'} added to the price.`;
}

/* category filter above the equipment cards (same idea as the add-on equipment window) */
let rentCat = 'All';

/* Only equipment offered for the chosen kind of rent is listed:
   studio add-ons show the items allowed as add-ons, outside rent shows the items allowed to be taken out. */
const isOffered = e => state.rentMode === 'addon' ? e.addon : e.outside;

function renderCategories() {
    const cats = ['All', ...new Set(EQUIPMENT.filter(isOffered).map(e => e.category).filter(Boolean))];
    if (!cats.includes(rentCat))
        rentCat = 'All';
    $('#eq-cats').innerHTML = cats.map(c => `<button type="button" data-cat="${esc(c)}" class="${c === rentCat ? 'on' : ''}">${esc(c)}</button>`).join('');
}

export function renderEquipment() {
    renderCategories();
    const shown = EQUIPMENT.filter(isOffered).filter(e => rentCat === 'All' || e.category === rentCat);
    if (!shown.length) {
        $('#eq').innerHTML = `<p class="mut">No equipment is offered ${state.rentMode === 'addon' ? 'as a studio add-on' : 'for outside rent'} right now.</p>`;
        return;
    }
    $('#eq').innerHTML = EQUIPMENT.map((e, i) => {
        if (!isOffered(e) || (rentCat !== 'All' && e.category !== rentCat))
            return '';   // hidden, not shown as unavailable
        const mine = qtyIn(state.rentMode, e.id), room = remainingFor(state.rentMode, e.id);
        const ok = e.stock > 0 && !outBlocked();
        const unit = state.rentMode === 'addon' ? 'per session' : 'per 8 hours, then 1/8 per extra hour';

        const info = `${e.desc ? `<p class="mut" style="margin-top:4px">${esc(e.desc)}</p>` : ''}<p class="mut">${e.stock} in stock${mine || room < e.stock ? `, ${room} still selectable` : ''}</p>`;

        const control = `<input class="qty" type="number" min="1" max="${Math.max(1, e.stock)}" value="1" aria-label="Quantity" data-q="${e.id}" ${ok ? '' : 'disabled'}>`;

        return `
      <div class="card" data-eq="${e.id}">
        ${equipmentImage(e)}
        <p class="cat">${esc(e.category || '')}</p>
        <div class="row"><h3>${esc(e.name)}</h3>${e.stock < 2 ? badge('Low') : ''}</div>
        ${info}
        <p style="margin-top:6px">${e.addon ? '<span class="b addon">Add-on</span> ' : ''}${e.outside ? '<span class="b out">Outside</span>' : ''}</p>
        <div class="row" style="margin-top:10px;flex-wrap:wrap">
          <span><b>${peso(unitPrice(e))}</b> <span class="mut">${unit}</span></span>
          <span class="row" style="margin-left:auto">${control}<button class="btn sm" data-add="${e.id}" ${ok ? '' : 'disabled'}>Add</button></span>
        </div>
      </div>`;
    }).join('');
}

export function renderCart() {
    const keys = Object.keys(curCart());

    $('#bundle-tag-wrap').innerHTML = state.rentMode === 'out' && keys.length >= 2
        ? `<div class="bundle-tag">Rental bundle: ${keys.length} items</div>` : '';

    $('#cart').innerHTML = keys.length
        ? keys.map(id => {
            const e = eqById(id), q = curCart()[id];
            const label = state.rentMode === 'out' ? `${esc(e.name)} x ${q} (${billedHours()} hrs)` : `${esc(e.name)} x ${q}`;
            return `<li><span>${label} <button class="lk" data-rm="${id}" aria-label="Remove ${esc(e.name)}">Remove</button></span><span>${peso(lineTotal(id))}</span></li>`;
        }).join('')
        : '<li><span class="mut">Nothing added yet</span><span></span></li>';

    $('#ctt').textContent = peso(keys.reduce((n, id) => n + lineTotal(id), 0));
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
        attachBooking = { ref: data.booking_ref };
        info.className = 'ok-text';
        info.textContent = `Found ${data.booking_ref}: ${data.studio}, ${longDate(a.date)}, ${hourLabel(a.hour)} to ${hourLabel(z.hour)}. Current total ${peso(+(data.grand_total ?? data.total))}.`;
    }
    updateRequestButton();
}

export function renderRentMode() {
    $('#fa-member').hidden = !isMember();
    $('#fa-guest').hidden = isMember();
    $('#fa').hidden = state.rentMode !== 'addon';
    $('#fo').hidden = state.rentMode === 'addon';
    $('#fo-guest').hidden = !outBlocked();
    $('#fo-form').hidden = outBlocked();
    $('#rmh').textContent = state.rentMode === 'addon'
        ? 'Used inside the studio you booked. Tied to your booking reference. Priced per session; drum sets are priced per rental. Pay 50% down payment (the rest at the studio) or the full payment now.'
        : 'Taken out of the studio, for registered customers. The price covers 8 hours and every extra hour adds one-eighth of the price. Pay 50% down payment (the rest at pick-up) or the full payment now. You get an OUT reference instead of a booking reference.';
    $$('#rm button').forEach(b => b.classList.toggle('on', b.dataset.m === state.rentMode));
    renderEquipment();
    updateRequestButton();
}

/* Outside rentals need a member account and an ID file before the request button unlocks. */
function updateRequestButton() {
    $('#rq').disabled = state.rentMode === 'out' ? (outBlocked() || !$('#vf').files.length || !(proofs.og && proofs.og.file()))
        : (!isMember() && !attachBooking);   // a guest needs a found booking first
}

/* "Attach GCash Screenshot" fields under the QR code: og = outside rental, ag = add-on rental */
const proofs = {};
function setupProofs() {
    ['og', 'ag'].forEach(p => {
        $(`#${p}-proof`).innerHTML = gcashProofHtml(p);
        proofs[p] = initGcashProof(p, { ref: `#${p}`, onChange: updateRequestButton, onError: toast });
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

/* Bookings an add-on can be attached to: upcoming and not cancelled. */
export function renderAttachOptions() {
    const usable = BOOKINGS.filter(b => b.mine && b.date >= TODAY && ['Pending', 'Confirmed', 'Active'].includes(b.status));
    $('#lb').innerHTML = usable.length
        ? usable.map(b => `<option value="${b.ref}">${b.ref} - Studio ${b.studio}, ${b.date === TODAY ? 'today' : shortDate(b.date)} ${b.start}</option>`).join('')
        : '<option value="">No upcoming booking. Book a studio first.</option>';
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
    setInterval(limitOutsidePickers, 60 * 1000);   // keeps the list right when the hour changes or 9:00 PM passes
    $('#opay-opt').innerHTML = payOptionHtml('rt', 'at pick-up');
    $('#apay-opt').innerHTML = payOptionHtml('ao', 'at the studio');
    onPayOption('rt', renderCart);
    onPayOption('ao', renderCart);
    loadRentalQr();

    $('#rm').addEventListener('click', e => {
        const m = e.target.dataset.m;
        if (!m)
            return;
        state.rentMode = m;   // each mode keeps its own items; nothing is cleared when switching
        renderCart();
        renderRentMode();
    });

    $('#eq-cats').addEventListener('click', e => {
        const c = e.target.closest('[data-cat]');
        if (!c)
            return;
        rentCat = c.dataset.cat;
        renderEquipment();
    });

    $('#eq').addEventListener('click', e => {
        const btn = e.target.closest('[data-add]');
        if (!btn)
            return;
        const id = +btn.dataset.add, input = $(`[data-q="${id}"]`), item = eqById(id), ctx = state.rentMode;
        // Add stacks: pressing it again adds the chosen quantity on top of what is already in this rental
        const have = qtyIn(ctx, id), want = input ? Math.max(Math.floor(+input.value) || 1, 1) : 1;
        if (remainingFor(ctx, id) <= 0)   // every unit is already held (here or in the other list)
            return showStockAlert(allocationMessage(id));
        const r = setQty(ctx, id, have + want);
        renderCart();
        renderEquipment();
        if (r.capped)   // asked for more than is left: keep what fits, then explain where the rest is held
            return showStockAlert(allocationMessage(id));
        showAddedPopup(item.name, r.q, have ? 'stacked' : 'added', item.stock, r.q - have);
    });

    $('#cart').addEventListener('click', e => {
        const rm = e.target.closest('[data-rm]');
        if (rm) {
            delete curCart()[rm.dataset.rm];
            renderCart();
            renderEquipment();
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
    $('#lb-find').addEventListener('click', findGuestBooking);
    $('#lb-ref').addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            e.preventDefault();
            findGuestBooking();
        }
    });
    $('#lb-ref').addEventListener('input', () => {
        attachBooking = null;
        updateRequestButton();
    });
}

async function requestRental() {
    const keys = Object.keys(curCart());
    if (!keys.length)
        return toast('Add at least one item first.');
    const items = keys.map(id => ({
        equipment_id: +id,
        quantity: curCart()[id]
    }));
    const btn = $('#rq');
    btn.disabled = true;

    try {
        if (state.rentMode === 'addon') {
            const ref = isMember() ? $('#lb').value : (attachBooking && attachBooking.ref);
            if (!ref)
                return toast(isMember() ? 'Attach the rental to a studio booking first.' : 'Find your booking with its reference code first.');
            const list = items.map(x => {
                const e = EQUIPMENT.find(y => y.id === x.equipment_id);
                return `${e.name} x${x.quantity}`;
            }).join(', ');
            const payOpt = readPayOption('ao'), agref = $('#ag').value.replace(/\s/g, '');
            if (!payOpt)
                return toast('Choose 50% Downpayment or Full Payment.');
            if (!proofs.ag.file())
                return toast('Attach a screenshot of your GCash payment.');
            if (!/^\d{13}$/.test(agref))
                return toast('Enter the 13-digit GCash reference number of your payment.');
            const money = rentalMoney();
            const yes = await askConfirm({
                title: 'Add this equipment to your studio booking?',
                message: `${list} will be added to booking ${ref}. The cost is added to that booking's total. You are paying ${peso(money.down)} now (${optName(payOpt).toLowerCase()})${payOpt === 'full' ? '.' : `, and ${peso(money.balance)} at the studio.`}`,
                ok: 'Yes, add to my booking',
                cancel: 'Not yet'
            });
            if (!yes)
                return;
            const aup = await uploadGcashProof(proofs.ag.file(), agref);
            if (aup.error)
                return toast('Could not upload your GCash screenshot: ' + aup.error.message);
            const { data: ares, error } = await sb.rpc('request_addon_rental', {
                p_booking_ref: ref,
                p_items: items,
                p_pay_option: payOpt,
                p_gcash_reference: agref
            });
            if (error)
                return toast(error.message);
            const arow = (Array.isArray(ares) ? ares[0] : ares) || {};
            const afull = (arow.pay_option || payOpt) === 'full';
            const apaid = Number(arow.down_payment) || money.down, atotal = Number(arow.total_amount) || money.total;
            const added = items.map(x => {
                const e = EQUIPMENT.find(y => y.id === x.equipment_id);
                return ['Added', `${e.name} x${x.quantity}`];
            });
            clearCart('addon');
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
            return toast('Please log in to rent equipment outside the studio.');
        const pd = $('#pd').value, rd = $('#rd').value, ph = +$('#pt').value, rh = +$('#rt').value;
        const first = $('#on-fn').value.trim(), last = $('#on-ln').value.trim();
        const contact = $('#oc').value.trim(), backup = $('#sm-link').value.trim();
        const payOpt = readPayOption('rt');
        const gref = $('#og').value.replace(/\s/g, ''), file = $('#vf').files[0], hours = outsideHours();

        if (!first || !last)
            return toast('Enter your first and last name.');
        if (!isName(first) || !isName(last))
            return toast('First and last names can only contain letters.');
        if (!pd || !rd)
            return toast('Choose the pick-up and return dates.');
        if (pd < firstBookableDate())
            return toast('Same-day rentals are closed after 9:00 PM. Choose tomorrow or a later date.');
        if (pd > lastBookableDate() || rd > lastBookableDate())
            return toast('Equipment can only be rented up to 4 weeks from today. Choose an earlier date.');
        if (isPastSlot(pd, ph - 10))
            return toast('The pick-up time must be later than now.');
        if (isPastSlot(rd, rh - 10))
            return toast('The return time must be later than now.');
        if (hours === null)
            return toast('The return time must be after the pick-up time.');
        if (!/^[\d\s+()-]{7,}$/.test(contact))
            return toast('Enter a valid contact number.');
        if (!backup)
            return toast('Enter a backup contact number.');
        if (!/^[\d\s+()-]{7,}$/.test(backup))
            return toast('The backup contact must be a phone number.');
        if (!file)
            return toast('Attach a valid ID.');
        if (!payOpt)
            return toast('Choose 50% Downpayment or Full Payment.');
        if (!proofs.og.file())
            return toast('Attach a screenshot of your GCash payment.');
        if (!/^\d{13}$/.test(gref))
            return toast('Enter the 13-digit GCash reference number of your payment.');
        if (!$('#or-agree').checked) {
            $('#or-terms').classList.add('err');
            return toast('Please tick the box to confirm you agree to the rental terms.');
        }

        // upload the ID photo first; the request stores only its path
        const ext = ((file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '')) || 'jpg';
        const path = `${crypto.randomUUID()}/${Date.now()}.${ext}`;
        const up = await sb.storage.from('rental-ids').upload(path, file, { contentType: file.type });
        if (up.error)
            return toast('Could not upload your ID: ' + up.error.message);
        const gup = await uploadGcashProof(proofs.og.file(), gref);
        if (gup.error)
            return toast('Could not upload your GCash screenshot: ' + gup.error.message);

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
            p_pay_option: payOpt
        });
        if (error)
            return toast(error.message);
        const row = Array.isArray(data) ? data[0] : data;
        const full = (row.pay_option || payOpt) === 'full';
        const paid = Number(row.down_payment) || money.down, rtotal = Number(row.total_amount) || money.total;

        clearCart('out');
        renderEquipment();
        $('#vf').value = '';
        updateIdPreview();
        proofs.og.reset();
        $('#og').value = '';
        $('#or-agree').checked = false;
        renderCart();
        await loadMyRentals();
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
        btn.disabled = false;
        updateRequestButton();
    }
}
