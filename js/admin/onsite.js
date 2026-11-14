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
import { browseHtml, noteHtml, paintBrowse, stockLine, suggestionBlock } from '../shared/eqBrowse.js';
import { matchesSearch } from '../shared/eqFilter.js';
import { changeMessage, modalToast } from '../shared/eqModal.js';
import { STUDIOS, gcashQrUrl, loadCatalog } from '../shared/catalog.js';
import { gcashProofHtml, initGcashProof, uploadGcashProof } from '../shared/gcashProof.js';
import '../shared/qrZoom.js';   // tap the GCash QR to enlarge it
import { check } from '../shared/fieldCheck.js';
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

/* ---- Cash payment block: the amount tendered (cash given), quick-cash chips and the change to return ----
   Same behaviour as the balance window: the cash must cover the amount received now. The amount is saved with the
   payment (supabase/75_onsite_cash_tendered.sql) and printed on the receipt email as "Cash received" and "Change". */
const centsOf = n => Math.round(n * 100);
const peso = n => '\u20B1' + (Math.round(n * 100) / 100).toLocaleString('en-PH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
function cashBox(box, getDue) {
    const id = box.id;
    box.innerHTML = `<label for="${id}-t">Amount tendered (cash given) <span class="req" aria-hidden="true">*</span></label>
      <div class="money-in"><span aria-hidden="true">\u20B1</span><input type="text" id="${id}-t" inputmode="decimal" autocomplete="off" placeholder="0.00" aria-describedby="${id}-c"></div>
      <div class="quick-cash" role="group" aria-label="Quick cash amounts"><button type="button" class="chip" data-quick="exact">Exact</button>${[200, 500, 1000].map(q => `<button type="button" class="chip" data-quick="${q}">\u20B1${q.toLocaleString('en-US')}</button>`).join('')}</div>
      <div class="bal-calc" id="${id}-c" role="status" aria-live="polite"></div>`;
    const input = box.querySelector('input'), calc = box.querySelector('.bal-calc');
    const tendered = () => {
        const v = input.value.replace(/,/g, '');
        return v === '' || v === '.' ? null : Number(v);
    };
    const sync = () => {
        const due = getDue(), t = tendered();
        calc.className = 'bal-calc';
        if (t === null)
            calc.textContent = 'Enter the cash received from the customer.';
        else if (centsOf(t) < centsOf(due)) {
            calc.classList.add('short');
            calc.innerHTML = `Short by <b>${peso((centsOf(due) - centsOf(t)) / 100)}</b>`;
        } else {
            calc.classList.add('ok');
            calc.innerHTML = `Change to return: <b>${peso((centsOf(t) - centsOf(due)) / 100)}</b>`;
        }
        box.querySelectorAll('[data-quick]').forEach(c => {
            const v = c.dataset.quick === 'exact' ? due : Number(c.dataset.quick);
            c.classList.toggle('on', t !== null && centsOf(t) === centsOf(v));
        });
    };
    input.addEventListener('input', () => {   // digits and one dot, 2 decimals
        let v = input.value.replace(/[^\d.]/g, '');
        const dot = v.indexOf('.');
        v = dot >= 0 ? v.slice(0, dot).slice(0, 7) + '.' + v.slice(dot + 1).replace(/\./g, '').slice(0, 2) : v.slice(0, 7);
        if (v !== input.value)
            input.value = v;
        sync();
    });
    box.querySelectorAll('[data-quick]').forEach(c => c.addEventListener('click', () => {
        const due = getDue();
        input.value = c.dataset.quick === 'exact' ? String(Number.isInteger(due) ? due : due.toFixed(2)) : c.dataset.quick;
        sync();
        input.focus();
    }));
    sync();
    return {
        tendered, sync, focus: () => input.focus(),
        reset: () => { input.value = ''; sync(); },
        /* null when fine, otherwise the message to show */
        problem: () => {
            const t = tendered();
            return t === null ? 'Enter the cash received (amount tendered).' : centsOf(t) < centsOf(getDue()) ? 'The cash tendered is less than the amount received.' : null;
        }
    };
}
let obDue = 0, orDue = 0;   // what is received right now (the whole total, or the 50% down payment)
let obCash = null, orCash = null;

/* ---- GCash payment block (same as the customer booking window) ----
   The studio's GCash QR, "Attach GCash Screenshot" (the 13-digit reference number is read from the picture by OCR and
   filled in, staff can still correct it) and the reference number box. p = 'ob' (onsite booking) or 'or' (onsite rental). */
function gcashBlock(p) {
    $(`#${p}-gw`).innerHTML = `<div class="gq">
      <img id="${p}-qr" alt="GCash QR code to scan" hidden>
      <p class="mut" id="${p}-qn">Ask the customer to scan this QR code with GCash and pay the Total received shown below.</p>
    </div>
    ${gcashProofHtml(p)}
    <label for="${p}-g">GCash reference number <span class="req" aria-hidden="true">*</span></label>
    <input id="${p}-g" data-gcash-ref inputmode="numeric" required aria-required="true" placeholder="13-digit reference" autocomplete="off">`;
    const qr = $(`#${p}-qr`);
    qr.onload = () => {
        qr.hidden = false;
    };
    qr.onerror = () => {
        qr.hidden = true;
        $(`#${p}-qn`).textContent = 'The studio GCash QR code is not set yet (Settings). Ask the customer to pay to the studio\'s GCash account.';
    };
    qr.src = gcashQrUrl();
    return initGcashProof(p, { ref: `#${p}-g` });
}
const obProof = gcashBlock('ob');
const orProof = gcashBlock('or');

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
    const total = h ? STUDIOS[si].rate * h : 0, later = !!d && d > manilaDay(0);
    $('#ob-pow').hidden = !later;
    if (!later)
        $('#ob-po').value = 'full';
    const now = Math.round(total * 50) / 100;
    $('#ob-tot').textContent = !h ? '-' : later && $('#ob-po').value === 'down' ? `${money(now)} now, ${money(total - now)} at the studio (total ${money(total)})` : money(total);
    obDue = later && $('#ob-po').value === 'down' ? now : total;
    if (obCash)
        obCash.sync();
}
$('#ob-po').addEventListener('change', onbTot);
obCash = cashBox($('#ob-cash'), () => obDue);

async function onbFree(takeHold = false) {
    const si = +$('#ob-s').value, d = $('#ob-d').value, h = +$('#ob-h').value;
    $('#ob-gw').hidden = $('#ob-m').value !== 'GCash';
    $('#ob-cash').hidden = $('#ob-m').value !== 'Cash';
    if (!STUDIOS[si] || !d) {
        $('#ob-t').innerHTML = '<option value="">No free time</option>';
        return;
    }
    if (!h) {   // no duration chosen yet: nothing to list, nothing to hold
        $('#ob-t').innerHTML = '<option value="">Choose a duration first</option>';
        onbTot();
        if (held)
            onbRelease();
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
    $('#ob-cash').hidden = $('#ob-m').value !== 'Cash';
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

/* The receipt email of the onsite forms. Saves the address on the new onsite booking / rental and asks the
   send-receipt Edge Function (the same "verified" email staff already send) to email the customer.
   Resolves true when the email went out. A failed email never undoes the booking or rental. */
async function sendOnsiteReceipt(kind, ref, email, tendered = null) {
    let r = null;
    if (tendered !== null) {   // a cash payment: the amount tendered is saved first so the email can show the cash received and the change
        const t = await sb.rpc('staff_set_receipt_email', { p_kind: kind, p_ref: ref, p_email: email || null, p_tendered: tendered });
        if (t.error)
            console.warn('Cash tendered was not saved (run supabase/75_onsite_cash_tendered.sql):', t.error.message);
        else
            r = t;
    }
    if (!r)
        r = await run(sb.rpc('staff_set_receipt_email', { p_kind: kind, p_ref: ref, p_email: email || null }));
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
        return er('Enter a valid phone number, like 0917 123 4567.');
    const email = normalizeEmail($('#ob-em').value);
    if (!email)
        return er('Enter the customer\'s email address for the receipt.');
    if (!isEmail(email))
        return er('Enter a valid email address, like name@gmail.com.');
    if (!d)
        return er('Pick a date.');
    if (d < firstDay()) {
        $('#ob-d').value = firstDay();
        onbFree();
        return er(pastDateMsg());
    }
    if (!h) {
        $('#ob-h').focus();
        return er('Choose how long the booking is (duration).');
    }
    if (t === '')
        return er('No free time for that studio and date.');
    if (isPast(d, 10 + +t)) {
        onbFree();
        return er('That start time has already passed. Pick a later time.');
    }
    // GCash: the payment screenshot and the reference number (13 digits) are required
    if (m === 'GCash') {
        const sm = check.file(obProof.file(), 'Attach a screenshot of the GCash payment.');
        if (sm) {
            $('#ob-ss').focus();
            return er(sm);
        }
        const gm = check.gcashRef(g);
        if (gm) {
            $('#ob-g').focus();
            return er(gm);
        }
    }
    if (m === 'Cash') {
        const cm = obCash.problem();
        if (cm) {
            obCash.focus();
            return er(cm);
        }
    }
    const yes = await askConfirm({
        title: 'Record this onsite booking?',
        message: `${n}, Studio ${STUDIOS[si].id}, ${longDate(d)}, ${SLOTS[+t]} for ${h} hour${h > 1 ? 's' : ''}. Received now: ${$('#ob-tot').textContent}, paid by ${m}${m === 'Cash' ? ` (cash given ${peso(obCash.tendered())}, change ${peso(obCash.tendered() - obDue)})` : ''}.${email ? ` The receipt is emailed to ${email}.` : ''}`,
        ok: 'Yes, record booking'
    });
    if (!yes)
        return;
    if (m === 'GCash') {
        const up = await uploadGcashProof(obProof.file(), g.replace(/\s/g, ''));   // the screenshot goes first, filed under its reference number
        if (up.error)
            return er('Could not upload the GCash screenshot: ' + up.error.message);
    }
    const [first, last] = nameParts(n);
    const r = await run(sb.rpc('staff_create_onsite_booking', {
        p_studio_id: STUDIOS[si].dbId,
        p_start_at: manilaTS(d, 10 + +t),
        p_end_at: manilaTS(d, 10 + +t + h),
        p_first_name: first,
        p_last_name: last,
        p_number: $('#ob-p').value.trim(),
        p_payment_method: m,
        p_gcash_reference: m === 'GCash' ? g.replace(/\s/g, '') : null,
        p_pay_option: $('#ob-pow').hidden ? 'full' : $('#ob-po').value,   // 'down' only for a booking on a later day
        p_token: HOLD_TOKEN
    }));
    if (!r)
        return er('Could not record the booking. See the message above.');
    er('');
    const row = Array.isArray(r.data) ? r.data[0] : r.data;
    held = false;   // the database removed the hold when it saved the booking
    holdNote();
    const obGiven = m === 'Cash' ? obCash.tendered() : null;
    $('#onb').reset();
    obProof.reset();
    obCash.reset();
    $('#ob-cash').hidden = false;   // the form is back on Cash
    $('#ob-d').value = firstDay();
    onbFree();   // the duration is empty again: the start times wait for it
    await refresh();
    const sent = email && row && row.booking_ref ? await sendOnsiteReceipt('booking', row.booking_ref, email, obGiven) : false;
    toast(`Onsite booking ${row && row.booking_ref ? row.booking_ref : ''} recorded.${sent ? ' Receipt emailed.' : email ? ' The receipt email could not be sent.' : ''}`);
};

/* ---- items chosen for this rental (several items can go in one rental, like the customer Rent page) ---- */
let orCart = [];   // [{ equipment_id, quantity }]

const inCart = id => (orCart.find(x => x.equipment_id === id) || { quantity: 0 }).quantity;

/* How many are free for the HOURS of this rental (equipment_available_between, file 51): a studio add-on needs the item
   during its booking, an outside rental from pick-up to return. Two orders only compete when their hours overlap.
   Until the hours are known (or if file 51 is not installed) the stock right now is used. */
let winAvail = null, winErr = false, winSeq = 0, winKey = '', winAt = 0;
let pendingItem = null;   // an item the calendar asked for: added to the rental as soon as the stock for its hours is known

const availOf = e => winAvail && winAvail[e.equipment_id] !== undefined ? winAvail[e.equipment_id] : e.available;

function onsiteWindow() {
    if ($('#or-m').value === 'a') {
        const b = BK.find(x => x.booking_ref === $('#or-b').value);
        return b && b.start_at && b.end_at ? [b.start_at, b.end_at] : null;
    }
    const sd = $('#or-sd').value, rd = $('#or-r').value;
    if (!sd || !rd)
        return null;
    const a = manilaTS(sd, +$('#or-st').value), z = manilaTS(rd, +$('#or-rt').value);
    return new Date(z) > new Date(a) ? [a, z] : null;
}

async function refreshOnsiteStock() {
    const w = onsiteWindow(), key = JSON.stringify([$('#or-m').value, w]);
    if (key === winKey && Date.now() - winAt < 30000)
        return;
    winKey = key;
    winAt = Date.now();
    const seq = ++winSeq;
    let map = null, failed = false;
    if (w) {
        const { data, error } = await sb.rpc('equipment_available_between', { p_from: w[0], p_to: w[1] });
        if (!error && data)
            map = Object.fromEntries(data.map(r => [r.equipment_id, r.available]));
        else
            failed = true;
    }
    if (seq !== winSeq)
        return;   // the hours changed again while asking
    if (failed)   // do not quietly fall back to today's stock: staff would trust a number that is not for these hours
        toast("Couldn't check stock for these hours, so the numbers shown are today's stock. The system still checks when you save.");
    winAvail = map;
    winErr = failed;
    const m = $('#or-m').value;
    const asked = pendingItem;
    if (asked) {   // started from the calendar: the clicked item goes in the list first
        orCart = [asked];
        pendingItem = null;
    }
    orCart = orCart.map(x => {   // cut the chosen quantities to what is free for these hours
        const e = STK.find(y => y.equipment_id === x.equipment_id);
        return e && offered(e, m) ? { ...x, quantity: Math.min(x.quantity, availOf(e)) } : null;
    }).filter(x => x && x.quantity >= 1);
    if (asked && !orCart.length)
        toast('That item is no longer free for those hours. Press Browse equipment to pick another.');
    orTot();
    if (eqPrev.open)
        drawBrowse();
}

const offered = (e, m) => (m === 'a' ? e.allow_addon : e.allow_outside) && e.stock_status !== 'Unavailable';

function orForm() {
    const m = $('#or-m').value;
    // drop cart items that can no longer be rented (stock changed, or no longer offered for this kind of rent)
    orCart = orCart.map(x => {
        const e = STK.find(y => y.equipment_id === x.equipment_id);
        return e && offered(e, m) ? { ...x, quantity: Math.min(x.quantity, availOf(e)) } : null;
    }).filter(x => x && x.quantity >= 1);

    ['or-aw'].forEach(x => {
        $('#' + x).hidden = m !== 'a';
    });
    ['or-ow', 'or-rw', 'or-tw', 'or-cw', 'or-emw'].forEach(x => {   // or-emw: the receipt email is asked for outside rentals only (an add-on uses its booking's email)
        $('#' + x).hidden = m !== 'o';
    });
    $('#or-gw').hidden = $('#or-pm').value !== 'GCash';
    $('#or-cash').hidden = $('#or-pm').value !== 'Cash';
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
    refreshOnsiteStock();
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
    orDue = half ? Math.round(total * 50) / 100 : total;
    if (orCash)
        orCash.sync();
    $('#or-tot').textContent = half ? `${money(Math.round(total * 50) / 100)} now, ${money(total - Math.round(total * 50) / 100)} at pick-up (total ${money(total)})` : money(total);
    return total;
}

orCash = cashBox($('#or-cash'), () => orDue);

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
let eqQuery = '';   // text typed in the window's search box (cleared each time the window opens)

/* The window is drawn by shared/eqBrowse.js, the same layout the customer's booking window uses. */
const eqItem = (e, m) => ({
    id: e.equipment_id,
    name: e.name,
    category: e.category_name,
    desc: e.description,
    img: e.image,
    price: money(num(m === 'a' ? e.add_on_rate : e.outside_rate))
});

/* the studio of the booking the add-on is for (used for "Frequently added with Studio X") */
function bookingStudio() {
    if ($('#or-m').value !== 'a')
        return null;
    const b = BK.find(x => x.booking_ref === $('#or-b').value);
    const letter = b ? String(b.studio_name || '').replace(/^studio\s*/i, '') : '';
    return STUDIOS.find(s => s.id === letter) || null;
}

function drawBrowse() {
    const m = $('#or-m').value;
    const all = STK.filter(e => offered(e, m));
    const list = all.filter(e => availOf(e) > 0);
    const hidden = winAvail ? all.length - list.length : 0;
    const cats = ['All', ...new Set(list.map(e => e.category_name).filter(Boolean))];
    if (!cats.includes(eqCat))
        eqCat = 'All';
    const shown = list.filter(e => (eqCat === 'All' || e.category_name === eqCat) && matchesSearch(eqItem(e, m), eqQuery));
    const unit = m === 'a' ? 'per session' : 'per 8 hours, then 1/8 per extra hour';
    const chosen = orCart.map(x => STK.find(y => y.equipment_id === x.equipment_id)).filter(Boolean).map(e => eqItem(e, m));
    const st = bookingStudio();
    paintBrowse(eqPrev, browseHtml({
        title: 'Add equipment to the rental',
        intro: m === 'a' ? 'Used inside the studio during the customer\'s session.' : 'Taken out of the studio by the customer.',
        note: noteHtml(winErr ? 'error' : winAvail ? 'hours' : 'today', {
            forWhat: 'the rental hours',
            hidden,
            tail: winErr ? 'The system checks again when you save.' : 'Availability is checked again when you save.'
        }),
        query: eqQuery,
        cats,
        cat: eqCat,
        cards: shown.map(e => ({
            ...eqItem(e, m),
            unit,
            qty: inCart(e.equipment_id),
            max: Math.min(availOf(e), 10),
            inLabel: 'In the rental',
            stockText: stockLine(availOf(e), !!winAvail, Math.max(0, availOf(e) - inCart(e.equipment_id)))
        })),
        sugg: suggestionBlock({
            studio: st,
            chosen,
            pool: list.filter(e => !inCart(e.equipment_id)).map(e => eqItem(e, m)),
            query: eqQuery,
            unit: m === 'a' ? 'per session' : 'per 8 hours'
        }),
        selRows: orCart.map(x => {
            const e = STK.find(y => y.equipment_id === x.equipment_id);
            return e ? { id: e.equipment_id, name: e.name, qty: x.quantity, price: money(num(m === 'a' ? e.add_on_rate : e.outside_rate) * x.quantity) } : null;
        }).filter(Boolean),
        selTitle: 'Added to the rental'
    }), q => {
        eqQuery = q;
        drawBrowse();
    });
}

$('#or-browse').addEventListener('click', () => {
    eqCat = 'All';
    eqQuery = '';
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

/* + / - on a card, and "Remove" in the Added list: change the quantity, redraw, and say what happened */
function changeQty(id, delta) {
    const eq = STK.find(y => y.equipment_id === id);
    if (!eq)
        return;
    const before = inCart(id), q = Math.max(0, Math.min(Math.min(availOf(eq), 10), delta === null ? 0 : before + delta));
    orCart = orCart.filter(x => x.equipment_id !== id);
    if (q > 0)
        orCart.push({ equipment_id: id, quantity: q });
    $('#or-e').hidden = true;
    orTot();      // the list and the total behind the window update right away
    const sc = eqPrev.querySelector('.in'), top = sc ? sc.scrollTop : 0;
    drawBrowse();
    if (sc) eqPrev.querySelector('.in').scrollTop = top;
    const msg = changeMessage(eq.name, before, q);
    if (msg)
        modalToast(msg[0], msg[1]);
}

eqPrev.addEventListener('click', e => {
    const rm = e.target.closest('[data-sel-rm]');
    if (rm)
        return changeQty(+rm.dataset.selRm, null);
    const sg = e.target.closest('[data-sadd]');   // a suggestion's "+ Add" adds one
    if (sg)
        return changeQty(+sg.dataset.sadd, 1);
    const b = e.target.closest('[data-qstep]');
    if (!b || b.disabled)
        return;
    changeQty(+b.dataset.id, +b.dataset.qstep);
});

['or-m', 'or-r', 'or-pm', 'or-po', 'or-sd', 'or-st', 'or-rt'].forEach(x => $('#' + x).addEventListener('change', () => {
    if (x === 'or-m')
        orCart = [];   // the items and prices differ between add-on and outside rent, so start the list again
    if (x === 'or-m' || x === 'or-pm')
        return orForm();
    if (['or-sd', 'or-st', 'or-r', 'or-rt'].includes(x))
        syncRentalTimes(true);
    orTot();
    if (['or-sd', 'or-st', 'or-r', 'or-rt'].includes(x))
        refreshOnsiteStock();
}));
$('#or-b').addEventListener('change', refreshOnsiteStock);

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
        if (!eq || x.quantity > availOf(eq))
            return er(`Only ${eq ? availOf(eq) : 0} of ${eq ? eq.name : 'that item'} available.`);
    }
    // GCash: the payment screenshot and the reference number (13 digits) are required
    if (pm === 'GCash') {
        const sm = check.file(orProof.file(), 'Attach a screenshot of the GCash payment.');
        if (sm) {
            $('#or-ss').focus();
            return er(sm);
        }
        const gm = check.gcashRef(g);
        if (gm) {
            $('#or-g').focus();
            return er(gm);
        }
    }
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
        p_gcash_reference: pm === 'GCash' ? g.replace(/\s/g, '') : null,
        p_pay_option: 'full'
    };
    const email = m === 'a' ? '' : normalizeEmail($('#or-em').value);
    if (m !== 'a' && !email)
        return er('Enter the customer\'s email address for the receipt.');
    if (email && !isEmail(email))
        return er('Enter a valid email address, like name@gmail.com.');
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
    if (pm === 'Cash') {
        const cm = orCash.problem();
        if (cm) {
            orCash.focus();
            return er(cm);
        }
    }
    const what = orCart.map(x => `${STK.find(y => y.equipment_id === x.equipment_id).name} x${x.quantity}`).join(', '),
        who = m === 'a' ? `for booking ${args.p_booking_ref}` : `for ${$('#or-n').value.trim()}, pick-up ${longDate($('#or-sd').value)} ${tlabel(+$('#or-st').value)}, return ${longDate($('#or-r').value)} ${tlabel(+$('#or-rt').value)}`;
    const yes = await askConfirm({
        title: 'Record this rental?',
        message: `${what} ${who}. Received now: ${$('#or-tot').textContent}, paid by ${pm}${pm === 'Cash' ? ` (cash given ${peso(orCash.tendered())}, change ${peso(orCash.tendered() - orDue)})` : ''}.${email ? ` The receipt is emailed to ${email}.` : ''}`,
        ok: 'Yes, record rental'
    });
    if (!yes)
        return;
    if (pm === 'GCash') {
        const up = await uploadGcashProof(orProof.file(), g.replace(/\s/g, ''));   // the screenshot goes first, filed under its reference number
        if (up.error)
            return er('Could not upload the GCash screenshot: ' + up.error.message);
    }
    const r = await run(sb.rpc('staff_create_onsite_rental', args));
    if (!r)
        return er('Could not record the rental. See the message above.');
    er('');
    const row = Array.isArray(r.data) ? r.data[0] : r.data;
    const orGiven = pm === 'Cash' ? orCash.tendered() : null;
    orCart = [];
    await loadCatalog();
    $('#onr').reset();
    orProof.reset();
    orCash.reset();
    $('#or-cash').hidden = false;   // the form is back on Cash
    $('#or-r').value = '';
    $('#or-sd').value = '';
    await refresh();
    // an add-on without a typed address uses the address saved with its onsite booking (if any)
    const sent = row && row.rental_ref && (email || m === 'a') ? await sendOnsiteReceipt('rental', row.rental_ref, email, orGiven) : false;
    toast(`Rental ${row && row.rental_ref ? row.rental_ref : ''} saved as Verified. It goes In Use when its start time arrives, or press Issue to start it earlier.${sent ? ' Receipt emailed.' : email ? ' The receipt email could not be sent.' : ''}`);
};

/* ============================ STARTED FROM THE CALENDAR ============================
   admin/calendar.js and admin/equipCalendar.js call these when staff click or drag on a free stretch of the grid.
   Both open the form with the details filled in, so staff only add the customer and confirm. */

/* Manila day and hour of a moment in milliseconds (UTC+8, no daylight saving) */
const mDay = ms => new Date(ms + 288e5).toISOString().slice(0, 10);
const mHour = ms => new Date(ms + 288e5).getUTCHours();

/* Onsite booking: { studioId, studioName, date: 'YYYY-MM-DD', hour: first hour, hours: how many } */
export async function startBooking({ studioId, studioName, date, hour, hours }) {
    const letter = String(studioName || '').replace(/^studio\s*/i, '');
    const byId = STUDIOS.findIndex(s => String(s.dbId) === String(studioId));
    const idx = byId >= 0 ? byId : STUDIOS.findIndex(s => String(s.id) === letter);
    if (idx < 0)
        return toast('That studio is not set up for onsite booking.');
    if (date < firstDay())
        return toast(pastDateMsg());
    location.hash = 'a-onb';
    $('#ob-s').value = String(idx);
    if ($('#ob-s').value !== String(idx))
        return toast('That studio is under maintenance, so it cannot be booked.');
    $('#ob-d').value = date;
    $('#ob-h').value = String(hours);
    await onbFree();   // lists the free start times for that studio, date and duration
    const t = String(hour - 10);
    if (![...$('#ob-t').options].some(o => o.value === t))
        return toast('That time was just taken. Pick another start time.');
    $('#ob-t').value = t;
    await onbHold();   // held for 2 minutes like any onsite booking
    if (!matchMedia('(pointer: coarse)').matches)
        setTimeout(() => $('#ob-n').focus(), 80);
}

/* Onsite rental. mode 'o' = outside rental (from, to = moments in ms, to may be left out for the usual 8 hours),
   mode 'a' = add-on to the booking bookingRef. equipmentId goes in the list with qty units. */
export function startRental({ mode, equipmentId, bookingRef, qty = 1, from, to }) {
    location.hash = 'a-onr';
    orCart = [];
    $('#or-m').value = mode === 'a' ? 'a' : 'o';
    if (mode !== 'a' && from) {
        const sd = mDay(from), st = Math.min(22, Math.max(10, mHour(from)));
        $('#or-sd').value = sd;
        $('#or-st').value = String(st);
        $('#or-r').value = to ? mDay(to) : sd;
        $('#or-rt').value = String(Math.min(22, Math.max(10, to ? mHour(to) : st + 8)));
    }
    pendingItem = { equipment_id: equipmentId, quantity: qty };
    orForm();
    if (mode === 'a' && bookingRef)
        $('#or-b').value = bookingRef;
    $('#or-e').hidden = true;
    winKey = '';   // ask for the stock again with the hours that were just set
    refreshOnsiteStock();
    toast('Filled in from the calendar. Add the customer details, then record it.');
}