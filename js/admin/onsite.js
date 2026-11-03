/* =====================================================================
   admin/onsite.js - Onsite booking and Onsite rental tabs
   DB: onsite booking / rental rpc functions.
   ===================================================================== */

import { BK, STK, refresh } from './data.js';
import { askConfirm, money, notifyVerified, num, run, setOpts, tlabel } from './helpers.js';
import { sb } from '../config/supabaseClient.js';
import { loadBusy, takenSlots } from '../shared/availability.js';
import { HOLD_TOKEN, holdOnsiteSlots, releaseHold } from '../shared/holds.js';
import { holdCountdown } from '../shared/holdTimer.js';
import { equipmentImage } from '../shared/cards.js';
import { STUDIOS, loadCatalog } from '../shared/catalog.js';
import {
    $,
    SLOTS,
    esc,
    isEmail,
    isName,
    isPhone,
    longDate,
    manilaDay,
    manilaParts,
    manilaTS,
    normalizeEmail,
    toast
} from '../shared/utils.js';

/* ============================ 10. ONSITE BOOKING & RENTAL ============================ */

/* ---- opening hours rule ----
   The studio closes at 9:00 PM. Until then, today is bookable but only from the current time onward.
   From 9:00 PM, nothing more can be booked for today, so the first selectable date is tomorrow. */
const CLOSE_HOUR = 21;
const nowMins = () => {
    const p = manilaParts(new Date());
    return p.hour * 60 + p.minute;
};
const todayOpen = () => nowMins() < CLOSE_HOUR * 60;
const firstDay = () => manilaDay(todayOpen() ? 0 : 1);
const isPast = (date, hour) => date === manilaDay(0) && hour * 60 < nowMins();   // that hour already started or passed
const nextDay = d => new Date(new Date(d + 'T00:00:00Z').getTime() + 864e5).toISOString().slice(0, 10);
const pastDateMsg = () => todayOpen() ? 'Past dates can\'t be selected. The earliest date is today.' : 'The studio is closed for today (9:00 PM). The earliest date is tomorrow.';

const nameParts = n => {
    const [first, ...rest] = n.trim().split(/\s+/);
    return [first, rest.join(' ')];
};

export function renderForms() {
    setOpts($('#ob-s'), STUDIOS.map((s, i) => ['Maintenance', 'Unavailable'].includes(s.status) ? '' : `<option value="${i}">Studio ${esc(s.id)}, ${money(s.rate)}/hr</option>`).join(''));
    $('#ob-d').min = firstDay();
    if (!$('#ob-d').value || $('#ob-d').value < firstDay())
        $('#ob-d').value = firstDay();   // after 9 PM the default becomes tomorrow
    onbFree();
    orForm();
}

/* ---- slot hold ----
   Once staff pick a time, those hours are held ("Held by Staff") for 2 minutes, renewed every minute.
   The hold is released after 2 minutes of inactivity (a countdown is shown), when staff leave this tab,
   when no time is selected, or after the booking is recorded. */
let held = false, expired = false;   // expired: the hold was dropped for being idle
const onbOn = () => location.hash === '#a-onb';

function holdNote() {
    const n = $('#ob-hold');
    if (!held) {
        n.hidden = true;
        return;
    }
    const t = +$('#ob-t').value, h = +$('#ob-h').value;
    n.hidden = false;
    n.innerHTML = `<b>Held by Staff:</b> ${SLOTS[t]} to ${SLOTS[t + h] || '10:00 PM'} is reserved while this form is open. <span id="ob-left"></span>`;
}

async function onbHold() {
    const si = +$('#ob-s').value, d = $('#ob-d').value, h = +$('#ob-h').value, t = $('#ob-t').value;
    if (!onbOn() || !STUDIOS[si] || !d || t === '') {
        return onbRelease();
    }
    const ok = await holdOnsiteSlots(si, d, +t, h);
    if (!onbOn())
        return onbRelease();
    held = ok;
    expired = false;
    holdNote();
    if (!ok) {
        toast('Those hours were just taken. Pick another time.');
        onbFree();
    }
}

function onbRelease() {
    if (!held)
        return;
    held = false;
    holdNote();
    releaseHold();
}

holdCountdown($('#onb'), {
    label: () => $('#ob-left'),
    active: () => held,
    keepRunning: true,
    onExpire: () => {
        onbRelease();
        expired = true;
        toast('Onsite hold released after 2 minutes of inactivity. Pick the time again to hold it.');
    }
});
setInterval(() => {
    if (held)
        onbHold();
}, 60000);
$('#onb').addEventListener('input', () => {
    if (expired && !held && onbOn())
        onbHold();   // staff are active again after a timeout: take the hold back
});
window.addEventListener('hashchange', () => {
    if (!onbOn())
        onbRelease();
});

/* "Total received". A booking for a later day can take a 50% down payment (the rest is collected at the studio),
   so the payment option box only appears for a date after today. */
function onbTot() {
    const si = +$('#ob-s').value, h = +$('#ob-h').value, d = $('#ob-d').value;
    if (!STUDIOS[si])
        return;
    const total = STUDIOS[si].rate * h, later = !!d && d > manilaDay(0);
    $('#ob-pow').hidden = !later;
    if (!later)
        $('#ob-po').value = 'full';
    const now = Math.round(total * 50) / 100;
    $('#ob-tot').textContent = later && $('#ob-po').value === 'down' ? `${money(now)} now, ${money(total - now)} at the studio (total ${money(total)})` : money(total);
}
$('#ob-po').addEventListener('change', onbTot);

async function onbFree(takeHold = false) {
    const si = +$('#ob-s').value, d = $('#ob-d').value, h = +$('#ob-h').value;
    if (!STUDIOS[si] || !d) {
        $('#ob-t').innerHTML = '<option value="">No free time</option>';
        return;
    }
    await loadBusy(si, d, d);
    const taken = takenSlots(si, d);
    const free = SLOTS.map((_, i) => i).filter(i => i + h <= SLOTS.length && !isPast(d, 10 + i) && Array.from({ length: h }, (_, j) => !taken.has(i + j)).every(Boolean));
    const cur = $('#ob-t').value;
    $('#ob-t').innerHTML = free.length ? free.map(i => `<option value="${i}">${SLOTS[i]}</option>`).join('') : '<option value="">No free time</option>';
    if (free.map(String).includes(cur))
        $('#ob-t').value = cur;
    onbTot();
    $('#ob-gw').hidden = $('#ob-m').value !== 'GCash';
    if (takeHold)
        await onbHold();
    else if (held && $('#ob-t').value === '')
        onbRelease();
}

['ob-s', 'ob-d', 'ob-h', 'ob-m'].forEach(x => $('#' + x).addEventListener('change', () => {
    if (x === 'ob-d' && $('#ob-d').value < firstDay()) {
        $('#ob-d').value = firstDay();
        toast(pastDateMsg());
    }
    onbFree(true);
}));
$('#ob-t').addEventListener('change', onbHold);

/* The optional receipt email of the onsite forms. Saves the address on the new onsite booking / rental and asks the
   send-receipt Edge Function (the same "verified" email staff already send) to email the customer.
   Resolves true when the email went out. A failed email never undoes the booking or rental. */
async function sendOnsiteReceipt(kind, ref, email) {
    const r = await run(sb.rpc('staff_set_receipt_email', { p_kind: kind, p_ref: ref, p_email: email || null }));
    const paymentId = r && r.data;
    return paymentId ? notifyVerified(paymentId, true) : false;
}

$('#onb').onsubmit = async e => {
    e.preventDefault();
    const si = +$('#ob-s').value, d = $('#ob-d').value, h = +$('#ob-h').value, t = $('#ob-t').value;
    const n = $('#ob-n').value.trim(), m = $('#ob-m').value, g = $('#ob-g').value.trim();
    const er = x => {
        $('#ob-e').textContent = x;
        $('#ob-e').hidden = !x;
    };
    if (!n)
        return er('Enter the customer name.');
    if (!isName(n))
        return er('The customer name can only contain letters.');
    if (!$('#ob-p').value.trim())
        return er('Enter the customer\'s phone number.');
    if (!isPhone($('#ob-p').value))
        return er('Enter a valid phone number, like 0917 123 4567 or +63 917 123 4567.');
    const email = normalizeEmail($('#ob-em').value);
    if (email && !isEmail(email))
        return er('Enter a valid email address, like name@gmail.com, or leave it blank.');
    if (!d)
        return er('Pick a date.');
    if (d < firstDay()) {
        $('#ob-d').value = firstDay();
        onbFree();
        return er(pastDateMsg());
    }
    if (t === '')
        return er('No free time for that studio and date.');
    if (isPast(d, 10 + +t)) {
        onbFree();
        return er('That start time has already passed. Pick a later time.');
    }
    // the GCash reference is optional for onsite bookings
    const yes = await askConfirm({
        title: 'Record this onsite booking?',
        message: `${n}, Studio ${STUDIOS[si].id}, ${longDate(d)}, ${SLOTS[+t]} for ${h} hour${h > 1 ? 's' : ''}. Received now: ${$('#ob-tot').textContent}, paid by ${m}.${email ? ` The receipt is emailed to ${email}.` : ''}`,
        ok: 'Yes, record booking'
    });
    if (!yes)
        return;
    const [first, last] = nameParts(n);
    const r = await run(sb.rpc('staff_create_onsite_booking', {
        p_studio_id: STUDIOS[si].dbId,
        p_start_at: manilaTS(d, 10 + +t),
        p_end_at: manilaTS(d, 10 + +t + h),
        p_first_name: first,
        p_last_name: last,
        p_number: $('#ob-p').value.trim(),
        p_payment_method: m,
        p_gcash_reference: m === 'GCash' && g ? g : null,
        p_pay_option: $('#ob-pow').hidden ? 'full' : $('#ob-po').value,   // 'down' only for a booking on a later day
        p_token: HOLD_TOKEN
    }));
    if (!r)
        return er('Could not record the booking. See the message above.');
    er('');
    const row = Array.isArray(r.data) ? r.data[0] : r.data;
    held = false;   // the database removed the hold when it saved the booking
    holdNote();
    $('#onb').reset();
    $('#ob-d').value = firstDay();
    await refresh();
    const sent = email && row && row.booking_ref ? await sendOnsiteReceipt('booking', row.booking_ref, email) : false;
    toast(`Onsite booking ${row && row.booking_ref ? row.booking_ref : ''} recorded.${sent ? ' Receipt emailed.' : email ? ' The receipt email could not be sent.' : ''}`);
};

/* ---- items chosen for this rental (several items can go in one rental, like the customer Rent page) ---- */
let orCart = [];   // [{ equipment_id, quantity }]

const inCart = id => (orCart.find(x => x.equipment_id === id) || { quantity: 0 }).quantity;

const offered = (e, m) => (m === 'a' ? e.allow_addon : e.allow_outside) && e.stock_status !== 'Unavailable';

function orForm() {
    const m = $('#or-m').value;
    // drop cart items that can no longer be rented (stock changed, or no longer offered for this kind of rent)
    orCart = orCart.map(x => {
        const e = STK.find(y => y.equipment_id === x.equipment_id);
        return e && offered(e, m) ? { ...x, quantity: Math.min(x.quantity, e.available) } : null;
    }).filter(x => x && x.quantity >= 1);

    ['or-aw'].forEach(x => {
        $('#' + x).hidden = m !== 'a';
    });
    ['or-ow', 'or-rw', 'or-tw', 'or-cw', 'or-emw'].forEach(x => {   // or-emw: the receipt email is asked for outside rentals only (an add-on uses its booking's email)
        $('#' + x).hidden = m !== 'o';
    });
    $('#or-gw').hidden = $('#or-pm').value !== 'GCash';
    setOpts($('#or-b'), BK.filter(b => ['Approved', 'In Progress'].includes(b.status)).map(b => `<option value="${b.booking_ref}">${b.booking_ref}, ${esc(b.customer_name)}</option>`).join('')
        || '<option value="">No confirmed bookings</option>');
    // start and return choices (studio hours)
    const opt = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `<option value="${from + i}">${tlabel(from + i)}</option>`).join('');
    if (!$('#or-st').options.length) {
        $('#or-st').innerHTML = opt(10, 22);
        $('#or-rt').innerHTML = opt(10, 22);
    }
    if (!$('#or-sd').value) {
        // default: the first open day, starting at the next full hour, returning 8 hours later (or at closing)
        const day = firstDay(),
            start = day === manilaDay(0) ? Math.min(22, Math.max(10, Math.ceil(nowMins() / 60))) : 10;
        $('#or-sd').value = day;
        $('#or-st').value = String(start);
        $('#or-r').value = day;
        $('#or-rt').value = String(Math.min(22, start + 8));
    }
    syncRentalTimes();
    orTot();
}

/* Keeps the rental dates and times valid: no past date, no past time today, and a return after the pick-up.
   Times that can't be chosen are greyed out (disabled). */
function syncRentalTimes(notify) {
    const first = firstDay();
    $('#or-sd').min = first;
    if (!$('#or-sd').value || $('#or-sd').value < first) {
        if ($('#or-sd').value && notify)
            toast(pastDateMsg());
        $('#or-sd').value = first;
    }
    const sd = $('#or-sd').value;
    const mark = (sel, bad) => {
        [...sel.options].forEach(o => {
            o.disabled = bad(+o.value);
        });
        if (!sel.value || sel.selectedOptions[0].disabled) {
            const ok = [...sel.options].find(o => !o.disabled);
            sel.value = ok ? ok.value : '';
        }
    };
    mark($('#or-st'), h => isPast(sd, h));
    $('#or-r').min = sd;
    if (!$('#or-r').value || $('#or-r').value < sd)
        $('#or-r').value = sd;
    const st = +$('#or-st').value, retBad = rd => h => isPast(rd, h) || (rd === sd && h <= st);
    mark($('#or-rt'), retBad($('#or-r').value));
    if (!$('#or-rt').value) {
        // pick-up at the last hour: the return moves to the next day
        $('#or-r').value = nextDay($('#or-r').value);
        mark($('#or-rt'), retBad($('#or-r').value));
    }
}

const onsiteHours = () => {
    const sd = $('#or-sd').value, rd = $('#or-r').value;
    if (!sd || !rd)
        return null;
    const h = (new Date(manilaTS(rd, +$('#or-rt').value)) - new Date(manilaTS(sd, +$('#or-st').value))) / 36e5;
    return h > 0 ? h : null;
};

function orTot() {
    const m = $('#or-m').value;
    // outside: the price covers 8 hours (an earlier return costs the same), each extra hour adds price / 8
    const len = m === 'o' ? onsiteHours() : null, hrs = m === 'o' ? Math.max(8, Math.ceil(len || 8)) : 8;
    if (m === 'o' && $('#or-dur'))
        $('#or-dur').textContent = len === null ? 'The return must be after the start.' : len < 8 ? `${len} hours. The 8-hour base price applies.` : `${len} hours billed${len > 8 ? ' (8 hours base + extra hours)' : ''}.`;
    let total = 0;
    const lines = orCart.map(x => {
        const e = STK.find(y => y.equipment_id === x.equipment_id);
        const line = num(m === 'a' ? e.add_on_rate : e.outside_rate) * x.quantity * (m === 'o' ? hrs / 8 : 1);
        total += line;
        const label = m === 'o' ? `${esc(e.name)} x ${x.quantity} (${hrs} hrs)` : `${esc(e.name)} x ${x.quantity}`;
        return `<li><span>${label} <button type="button" class="lk" data-rm="${x.equipment_id}" aria-label="Remove ${esc(e.name)}">Remove</button></span><span>${money(line)}</span></li>`;
    });
    $('#or-cart').innerHTML = lines.join('') || '<li><span class="mut">Nothing added yet</span><span></span></li>';
    // outside rental picked up on a later day: the customer can pay 50% now and the rest at pick-up
    const later = m === 'o' && !!$('#or-sd').value && $('#or-sd').value > manilaDay(0);
    $('#or-pow').hidden = !later;
    if (!later)
        $('#or-po').value = 'full';
    const half = later && $('#or-po').value === 'down';
    $('#or-tot').textContent = half ? `${money(Math.round(total * 50) / 100)} now, ${money(total - Math.round(total * 50) / 100)} at pick-up (total ${money(total)})` : money(total);
    return total;
}

$('#or-cart').addEventListener('click', e => {
    const rm = e.target.closest('[data-rm]');
    if (!rm)
        return;
    orCart = orCart.filter(x => x.equipment_id !== +rm.dataset.rm);
    orTot();
});

/* ---- Browse equipment window (same layout as the customer's "Add equipment to your booking" window) ----
   Filter by category, see the photo and description, pick a quantity for each item you want. */
const eqPrev = $('#eqprev');

let eqCat = 'All';

function eqCard(e, m) {
    const max = Math.min(e.available, 10), q = inCart(e.equipment_id);
    const info = e.description ? `<p>${esc(e.description)}</p>` : '<p class="mut">No description yet.</p>';
    const unit = m === 'a' ? 'per session' : 'per 8 hours, then 1/8 per extra hour';
    return `<div class="eqcard">
      ${equipmentImage({ img: e.image, name: e.name })}
      <p class="cat">${esc(e.category_name || '')}</p>
      <h3>${esc(e.name)}</h3>
      ${info}
      <p class="mut" style="margin-top:6px">${e.available} available</p>
      <div class="row" style="margin-top:8px">
        <b>${money(m === 'a' ? e.add_on_rate : e.outside_rate)} <span class="mut" style="font-weight:400">${unit}</span></b>
        <label class="qtyl">Qty <select data-aq="${e.equipment_id}" aria-label="Quantity of ${esc(e.name)}">${Array.from({ length: max + 1 }, (_, n) => `<option value="${n}" ${n === q ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      </div>
    </div>`;
}

function eqCount() {
    const n = orCart.length, el = $('#eqd-n');
    if (el)
        el.textContent = n ? `${n} item${n === 1 ? '' : 's'} selected` : 'Nothing selected yet';
}

function drawBrowse() {
    const m = $('#or-m').value;
    const list = STK.filter(e => offered(e, m) && e.available > 0);
    const cats = ['All', ...new Set(list.map(e => e.category_name).filter(Boolean))];
    if (!cats.includes(eqCat))
        eqCat = 'All';
    const shown = list.filter(e => eqCat === 'All' || e.category_name === eqCat);
    eqPrev.innerHTML = `<div class="in">
    <div class="row"><h2 style="margin:0">Add equipment to the rental</h2><button type="button" class="btn sm line" data-close>Close</button></div>
    <p class="mut" style="margin-top:4px">${m === 'a' ? 'Used inside the studio during the customer\'s session.' : 'Taken out of the studio by the customer.'} Choose a quantity for each item you want.</p>
    <div class="tabs" style="margin-top:10px">${cats.map(c => `<button type="button" data-cat="${esc(c)}" class="${c === eqCat ? 'on' : ''}">${esc(c)}</button>`).join('')}</div>
    <div class="eqgrid">${shown.map(e => eqCard(e, m)).join('') || '<p class="mut">Nothing available in this category.</p>'}</div>
    <div class="acts"><span class="mut" id="eqd-n" style="margin-right:auto"></span><button type="button" class="btn gold" data-close>Done</button></div>
  </div>`;
    eqCount();
}

$('#or-browse').addEventListener('click', () => {
    eqCat = 'All';
    drawBrowse();
    eqPrev.showModal();
});

eqPrev.addEventListener('click', e => {
    const cat = e.target.closest('[data-cat]');
    if (cat) {
        eqCat = cat.dataset.cat;
        drawBrowse();
    }
    else if (e.target === eqPrev || e.target.closest('[data-close]'))
        eqPrev.close();
});

eqPrev.addEventListener('change', e => {
    const s = e.target.closest('[data-aq]');
    if (!s)
        return;
    const id = +s.dataset.aq, q = +s.value;
    orCart = orCart.filter(x => x.equipment_id !== id);
    if (q > 0)
        orCart.push({ equipment_id: id, quantity: q });
    $('#or-e').hidden = true;
    orTot();      // the list and the total behind the window update right away
    eqCount();
});

['or-m', 'or-r', 'or-pm', 'or-po', 'or-sd', 'or-st', 'or-rt'].forEach(x => $('#' + x).addEventListener('change', () => {
    if (x === 'or-m')
        orCart = [];   // the items and prices differ between add-on and outside rent, so start the list again
    if (x === 'or-m' || x === 'or-pm')
        return orForm();
    if (['or-sd', 'or-st', 'or-r', 'or-rt'].includes(x))
        syncRentalTimes(true);
    orTot();
}));

$('#onr').onsubmit = async e => {
    e.preventDefault();
    const m = $('#or-m').value,
        pm = $('#or-pm').value,
        g = $('#or-g').value.trim();
    const er = x => {
        $('#or-e').textContent = x;
        $('#or-e').hidden = !x;
    };
    if (!orCart.length)
        return er('Add at least one item to the rental first. Press Browse equipment and choose a quantity.');
    for (const x of orCart) {
        const eq = STK.find(y => y.equipment_id === x.equipment_id);
        if (!eq || x.quantity > eq.available)
            return er(`Only ${eq ? eq.available : 0} of ${eq ? eq.name : 'that item'} available.`);
    }
    // the GCash reference is optional for onsite rentals
    const args = {
        p_type: m === 'a' ? 'Add-on' : 'Outside',
        p_items: orCart.map(x => ({
            equipment_id: x.equipment_id,
            quantity: x.quantity
        })),
        p_booking_ref: null,
        p_first_name: null,
        p_last_name: null,
        p_number: null,
        p_return_date: null,
        p_id_type: null,
        p_id_checked: false,
        p_payment_method: pm,
        p_gcash_reference: pm === 'GCash' && g ? g : null,
        p_pay_option: 'full'
    };
    const email = m === 'a' ? '' : normalizeEmail($('#or-em').value);
    if (email && !isEmail(email))
        return er('Enter a valid email address, like name@gmail.com, or leave it blank.');
    if (m === 'a') {
        args.p_booking_ref = $('#or-b').value;
        if (!args.p_booking_ref)
            return er('Choose a confirmed booking.');
    } else {
        const n = $('#or-n').value.trim(), ret = $('#or-r').value, sd = $('#or-sd').value;
        if (!n)
            return er('Enter the customer name.');
        if (!isName(n))
            return er('The customer name can only contain letters.');
        if (!sd || sd < firstDay()) {
            syncRentalTimes();
            orTot();
            return er(pastDateMsg());
        }
        if (isPast(sd, +$('#or-st').value)) {
            syncRentalTimes();
            orTot();
            return er('That pick-up time has already passed. Pick a later time.');
        }
        if (!ret || onsiteHours() === null)
            return er('The return must be after the start.');
        if (isPast(ret, +$('#or-rt').value))
            return er('That return time has already passed.');
        if (!$('#or-id').checked)
            return er('Confirm that you checked a valid ID.');
        [args.p_first_name, args.p_last_name] = nameParts(n);
        args.p_pickup_date = manilaTS(sd, +$('#or-st').value);
        args.p_return_date = manilaTS(ret, +$('#or-rt').value);
        args.p_id_type = $('#or-t').value;
        args.p_id_checked = true;
        if (!$('#or-pow').hidden)
            args.p_pay_option = $('#or-po').value;   // 'down' only for a pick-up on a later day
    }
    const what = orCart.map(x => `${STK.find(y => y.equipment_id === x.equipment_id).name} x${x.quantity}`).join(', '),
        who = m === 'a' ? `for booking ${args.p_booking_ref}` : `for ${$('#or-n').value.trim()}, pick-up ${longDate($('#or-sd').value)} ${tlabel(+$('#or-st').value)}, return ${longDate($('#or-r').value)} ${tlabel(+$('#or-rt').value)}`;
    const yes = await askConfirm({
        title: 'Record this rental?',
        message: `${what} ${who}. Received now: ${$('#or-tot').textContent}, paid by ${pm}.${email ? ` The receipt is emailed to ${email}.` : ''}`,
        ok: 'Yes, record rental'
    });
    if (!yes)
        return;
    const r = await run(sb.rpc('staff_create_onsite_rental', args));
    if (!r)
        return er('Could not record the rental. See the message above.');
    er('');
    const row = Array.isArray(r.data) ? r.data[0] : r.data;
    orCart = [];
    await loadCatalog();
    $('#onr').reset();
    $('#or-r').value = '';
    $('#or-sd').value = '';
    await refresh();
    // an add-on without a typed address uses the address saved with its onsite booking (if any)
    const sent = row && row.rental_ref && (email || m === 'a') ? await sendOnsiteReceipt('rental', row.rental_ref, email) : false;
    toast(`Rental ${row && row.rental_ref ? row.rental_ref : ''} saved as Verified. It goes In Use when its start time arrives, or press Issue to start it earlier.${sent ? ' Receipt emailed.' : email ? ' The receipt email could not be sent.' : ''}`);
};
