/* =====================================================================
   customer/myBookings.js - "My bookings" tab
   Table, details, reschedule, cancel and guest reference lookup.
   ===================================================================== */

import { state } from './state.js';
import { SUPABASE_ANON_KEY, SUPABASE_URL, sb } from '../config/supabaseClient.js';
import { refreshBook } from './book.js';
import { noShowSentence, releaseNote, runningLate, clock as releaseClock } from './noShow.js';
import { BK_STATUS, loadMyBookings } from './data.js';
import {
    askConfirm,
    dlg,
    showDialog,
    showSuccess,
    stampLabel,
    tableGrouped,
    whyRejected
} from './ui.js';
import { addonSubRows, pastOpen } from './myRentals.js';
import { calendarEvent, downloadIcs } from '../shared/calendar.js';
import { closeActionMenu, openActionMenu } from '../shared/actionMenu.js';
import { BOOKINGS, firstBookableDate, isPastSlot, lastBookableDate, loadBusy, takenSlots } from '../shared/availability.js';
import { HOLD_TOKEN, holdRescheduleSlots, releaseHold } from '../shared/holds.js';
import { holdCountdown } from '../shared/holdTimer.js';
import { PAY_DOWN, dueNow, onPayOption, optName, payOptionHtml, readPayOption } from '../shared/payOption.js';
import { STUDIOS, gcashQrUrl, studioIndex } from '../shared/catalog.js';
import { gcashProofHtml, initGcashProof, uploadGcashProof } from '../shared/gcashProof.js';
import { isMember } from '../shared/session.js';
import { btnBusy, btnReset, btnSuccess } from '../shared/btnState.js';
import { applyChecks, check, liveCheck } from '../shared/fieldCheck.js';
import { emptyState } from '../shared/emptyState.js';
import {
    $,
    SLOTS,
    badge,
    endTime,
    esc,
    longDate,
    manilaParts,
    manilaTS,
    pad,
    peso,
    shortDate,
    toast
} from '../shared/utils.js';

/* ============================ 4. MY BOOKINGS ============================ */

export const startsAt = b => new Date(`${b.date}T${pad(10 + SLOTS.indexOf(b.start))}:00`);

const insideCutoff = b => startsAt(b) - Date.now() < 24 * 60 * 60 * 1000;

const findBooking = ref => BOOKINGS.find(b => b.ref === ref);

export const normRef = v => v.trim().toUpperCase().replace(/\s+/g, '');

export const notFound = (ref, what) =>
    `<div class="alert">No ${what} found for <b>${esc(ref)}</b>. Check the code and try again. If you booked with an account, log in to see it. Or email us.</div>`;

const CUTOFF_MSG = 'Changes and cancellations close 24 hours before your session.';

/* the extension request of a booking that is waiting for staff (or the last one if it was rejected), as a note under the row */
const pendingExt = ref => (state.EXT[ref] || []).find(x => x.status === 'Pending');

function extNote(b) {
    const list = state.EXT[b.ref] || [], x = list[0];
    if (!x)
        return '';
    if (x.status === 'Pending')
        return `<b>Extension request:</b> +${hrs(x.hours)} (until ${endTime(b.start, b.hours + x.hours)}). Your down payment of ${peso(x.down)} is waiting for staff to verify. The extra time and cost are added to your booking once it is verified.`;
    if (x.status === 'Rejected')
        return `<b>Extension request rejected:</b> +${hrs(x.hours)}. Reason: ${esc(x.reason || 'No reason was given. Please contact the studio.')}`;
    return '';
}

/* My bookings: Upcoming (Pending, Confirmed; next session first) > In progress (Active) > Past and closed (newest first, closed by default).
   The add-on equipment of a booking is listed indented right under it. */
/* The choices in a booking's Actions menu. Details always; Extend for a verified booking (50% or full GCash payment, verified by staff);
   Reschedule and Cancel while it is Pending or Confirmed. */
function bookingMenuItems(b) {
    const items = [{ act: 'details', label: 'Details' }];
    if ((b.status === 'Confirmed' || b.status === 'Active') && isMember())
        items.push(pendingExt(b.ref) ? { label: 'Extension pending', disabled: true } : { act: 'extend', label: 'Extend' });
    if (b.status === 'Confirmed' || b.status === 'Pending') {
        items.push({ act: 'cal', label: 'Add to calendar' });
        items.push({ act: 'resched', label: 'Reschedule' });
        items.push({ act: 'cancel', label: 'Cancel booking', danger: true });
    }
    return items;
}

function openMenu(btn) {
    const b = findBooking(btn.dataset.menu);
    if (b)
        openActionMenu(btn, bookingMenuItems(b), act => runBookingAction(act, b.ref));
}

function runBookingAction(act, ref) {
    const b = findBooking(ref);
    if (!b)
        return;
    if (act === 'details')
        return showDetails(b);
    if (act === 'extend')
        return openExtend(b);
    if (act === 'cal') {
        downloadIcs(bookingEvent(b));
        return toast('Calendar file saved. Open it to add the booking to your calendar.');
    }
    if (insideCutoff(b))
        return toast(CUTOFF_MSG);
    if (act === 'resched')
        openReschedule(b);
    else if (act === 'cancel')
        confirmCancel(b);
}

export function renderMyBookings() {
    closeActionMenu();
    const mine = BOOKINGS.filter(b => b.mine);
    if (!mine.length) {
        $('#mybk').innerHTML = emptyState({
            icon: 'calendar',
            title: 'No bookings yet',
            text: 'Pick a studio and a time. Your bookings will show up here.',
            action: { label: 'Book a studio', href: '#book' }
        });
        return;
    }
    const row = (b, closed = false) => {
        // one "Actions" button; its menu lists Details, Extend, Reschedule and Cancel (see bookingMenuItems)
        const actions = `<button type="button" class="btn sm line menu-btn" data-menu="${esc(b.ref)}" aria-haspopup="menu" aria-expanded="false">Actions <span aria-hidden="true">&#9662;</span></button>`;
        return {
            cells: [
                shortDate(b.date),
                b.start,
                'Studio ' + b.studio,
                b.hours + (b.hours > 1 ? ' hrs' : ' hr'),
                `<span class="ref-static">${esc(b.ref)}</span>`,
                badge(b.status),
                badge(b.payment),
                actions
            ],
            note: [whyRejected(b.status, b.reason), extNote(b), releaseNote(b)].filter(Boolean).join('<br>'),
            subs: addonSubRows(b.ref, closed),
            dim: ['Cancelled', 'Rejected'].includes(b.status)
        };
    };
    const soonest = (x, y) => startsAt(x) - startsAt(y);
    const upcoming = mine.filter(b => ['Pending', 'Confirmed'].includes(b.status)).sort(soonest);
    const active = mine.filter(b => b.status === 'Active').sort(soonest);
    const past = mine.filter(b => !['Pending', 'Confirmed', 'Active'].includes(b.status)).sort((x, y) => soonest(y, x));
    const groups = [
        { title: 'Upcoming', rows: upcoming.map(b => row(b)) },
        { title: 'In progress', rows: active.map(b => row(b)) },
        { title: 'Past and closed', toggle: 'bk', collapsed: !pastOpen.bk, rows: past.map(b => row(b, true)) }
    ].filter(g => g.rows.length);
    $('#mybk').innerHTML = tableGrouped(['Date', 'Time', 'Studio', 'Duration', 'Reference', 'Status', 'Payment', ''], groups);
    // while "Past and closed" is open the table scrolls inside its box (like the admin page); the page itself stays put
    $('#mybk').classList.toggle('tw-scroll', groups.some(g => g.toggle && !g.collapsed));
}

/* The calendar entry of a booking (shared/calendar.js). Pending bookings are marked tentative. */
const bookingEvent = b => calendarEvent({ ref: b.ref, studio: b.studio, date: b.date, start: b.start, hours: b.hours, pending: b.status === 'Pending' });

/* The booking receipt: the same layout as the success pop-up, so a customer can screenshot it. */
function showDetails(b) {
    const s = STUDIOS[studioIndex(b.studio)], ad = state.ADDONS[b.ref] || [];
    const computed = s.rate * b.hours + ad.reduce((n, a) => n + a.price * a.qty, 0);
    const total = !isMember() && b.total != null ? b.total : computed;   // guests keep the total saved with the booking
    const down = Number(b.down) || 0, hasDown = down > 0;                // older bookings were paid in full (no down payment)
    // extension requests: a verified one is already inside the total (the end time moved); a pending one is not yet
    const exts = state.EXT[b.ref] || [], okExt = exts.filter(x => x.status === 'Approved'), waitExt = exts.find(x => x.status === 'Pending');
    const extDown = okExt.reduce((n, x) => n + x.down, 0), extCost = okExt.reduce((n, x) => n + x.cost, 0);
    const baseDown = Math.max(0, down - extDown);                        // the payment made when booking (50% or full)
    const addPaidMap = state.ADDPAID[b.ref] || {}, addPaid = Object.values(addPaidMap).reduce((n, v) => n + v, 0);   // add-ons added later, paid separately
    const bookFull = (b.payOpt || (baseDown >= total - extCost - addPaid - 0.01 ? 'full' : 'down')) === 'full';
    const paidFull = baseDown > 0 && baseDown >= total - extCost - 0.01;  // an older booking that was paid in full before it was extended
    const atStudio = Number(b.atStudio) || 0;                             // balance staff already collected
    const balance = Math.max(0, total - down - addPaid - atStudio);
    // a booking paid in full at the studio (no down payment): equipment added later with a 50% payment can still owe a balance.
    // Only add-ons whose payment staff verified (Approved / In Use) count; the database uses the same rule (booking_balance_due).
    const owedPer = {};
    state.RENTALS.filter(r => r.type === 'addon' && r.ref === b.ref && r.down > 0 && ['Approved', 'Active'].includes(r.rawStatus))
        .forEach(r => {
            owedPer[r.rentalRef] = owedPer[r.rentalRef] || { total: 0, paid: r.down + (r.atPickup || 0) };
            owedPer[r.rentalRef].total += r.unit * r.qty;
        });
    const addonOwed = hasDown ? 0 : Object.values(owedPer).reduce((n, x) => n + Math.max(0, x.total - x.paid), 0);
    const lines = [
        ['Name', b.name || (state.PROFILE ? `${state.PROFILE.first} ${state.PROFILE.last}`.trim() : '')],
        ['Studio', `Studio ${b.studio}`],
        ['Date', longDate(b.date)],
        ['Time', `${b.start} to ${endTime(b.start, b.hours)} (${b.hours} hr${b.hours > 1 ? 's' : ''})`],
        ...ad.map(a => ['Add-on', `${a.name} x${a.qty} (${peso(a.price * a.qty)})`]),
        ...okExt.map(x => ['Extension', `+${hrs(x.hours)} (${peso(x.cost)}), added to the total`]),
        ['Total', peso(total)],
        ...(hasDown ? [
            ['Payment option', optName(bookFull ? 'full' : 'down')],
            ...(baseDown > 0 ? [[paidFull ? 'Paid before the extension' : (bookFull ? 'Full payment' : 'Down payment (50%)'), `${peso(baseDown)}, ${b.payment}`]] : []),
            ...okExt.map(x => [x.opt === 'full' ? 'Extension full payment' : 'Extension down payment (50%)', `${peso(x.down)}, Verified`]),
            ...(addPaid > 0 ? [['Equipment added later, paid', peso(addPaid)]] : []),
            ...(atStudio > 0 ? [['Balance paid at the studio', peso(atStudio)]] : []),
            ['Balance at the studio', balance > 0.005 ? peso(balance) : 'Paid in full'],
            ['Pick-up', balance > 0.005 ? `Studio ${b.studio}, ${shortDate(b.date)}, ${b.start}. Pay the balance on arrival`
                : `Studio ${b.studio}, ${shortDate(b.date)}, ${b.start}. Nothing left to pay`]
        ] : []),
        ...(addonOwed > 0.005 ? [
            ['Equipment added later, paid', peso(addPaid)],
            ['Equipment balance at the studio', peso(addonOwed)]
        ] : []),
        ...(waitExt ? [['Extension request (pending)', `+${hrs(waitExt.hours)} (${peso(waitExt.cost)}). ${waitExt.opt === 'full' ? 'Full payment' : 'Down payment'} ${peso(waitExt.down)} is waiting for staff to verify. Not in the total yet`]] : []),
        ...(hasDown ? [] : [['Payment', `${b.method || 'Payment'}, ${b.payment}`]])
    ].filter(l => l[1]);
    if (b.status === 'Rejected')
        lines.push(['Reason for rejection', b.reason || 'No reason was given. Please contact the studio.']);
    if (b.created)
        lines.push(['Booked on', stampLabel(b.created)]);
    showSuccess({
        title: 'Booking receipt',
        label: 'Reference code',
        ref: b.ref,
        lines,
        icon: 'receipt',
        status: badge(b.status),
        calendar: ['Pending', 'Confirmed'].includes(b.status) ? bookingEvent(b) : null,
        doneLabel: 'Close',
        shot: 'It is your official receipt. Show it to our staff when you arrive so we can verify your reservation.',
        note: hasDown ? (bookFull && balance <= 0.005
            ? 'Bookings are confirmed after staff verify your payment. Nothing is left to pay at the studio. The payment is non-refundable if the booking is cancelled.'
            : 'Bookings are confirmed after staff verify your down payment. Pay the balance at the studio when you arrive. The down payment is non-refundable if the booking is cancelled. ' + noShowSentence())
            : addonOwed > 0.005 ? 'Bookings are confirmed after staff verify your payment. Pay the equipment balance at the studio when you arrive.'
                : 'Bookings are confirmed after staff verify your payment.'
    });
}

/* ---- Extend a verified booking (50% down payment, verified by staff) ----
   The database checks the hours after the current end time (next booking, someone holding them, 10:00 PM
   closing) and says how many extra hours are free. While this window is open those hours are HELD for 2 minutes
   (renewed every minute), so nobody else can book or extend them.
   Paying works like a booking: the customer pays 50% of the extension cost by GCash and enters the reference
   number. The request stays Pending, and the hours stay reserved, until staff verify the payment. When they do,
   the booking's end time, total and down payment update by themselves. The other 50% is paid at the studio. */
const hrs = h => `${h} hour${h > 1 ? 's' : ''}`;

let extToken = null;

window.addEventListener('pagehide', () => {
    if (!extToken)
        return;
    try {
        fetch(SUPABASE_URL + '/rest/v1/rpc/release_hold', {
            method: 'POST',
            keepalive: true,
            headers: {
                'Content-Type': 'application/json',
                apikey: SUPABASE_ANON_KEY,
                Authorization: 'Bearer ' + SUPABASE_ANON_KEY
            },
            body: JSON.stringify({ p_token: extToken })
        });
    } catch (e) {
        /* ignore */
    }
});

async function openExtend(b) {
    if (pendingExt(b.ref))
        return toast('You already have an extension request waiting for staff to verify its down payment.');
    const token = 'x' + crypto.randomUUID();
    showDialog(`<h2>Extend ${esc(b.ref)}</h2><p class="mut">Checking the schedule...</p>`);
    const { data, error } = await sb.rpc('staff_extension_info', {
        p_booking_ref: b.ref,
        p_token: token
    });
    const info = Array.isArray(data) ? data[0] : data;
    if (error || !info) {
        dlg.close();
        return toast(error ? error.message : 'Could not check the schedule. Try again.');
    }
    const rate = +info.hourly_rate || 0, lo = info.min_hours, hi = info.max_hours;
    // extra hours the add-on equipment of this booking is free for (file 55); longer extensions are still possible, without the add-on
    const addonHi = info.addon_max_hours == null ? hi : info.addon_max_hours;
    const summary = `<dl class="dl"><dt>Studio</dt><dd>Studio ${esc(b.studio)}</dd><dt>Date</dt><dd>${longDate(b.date)}</dd>
    <dt>Current time</dt><dd>${esc(b.start)} to ${endTime(b.start, b.hours)} (${hrs(b.hours)})</dd><dt>Rate</dt><dd>${peso(rate)} per hour</dd></dl>`;

    if (hi < lo) {
        // blocked: say why
        showDialog(`<h2>Extend ${esc(b.ref)}</h2>${summary}
      <div class="alert" role="alert"><b>${esc(info.message || 'Cannot extend this booking.')}</b></div>
      <div class="acts"><button type="button" class="btn line" data-close>Close</button></div>`);
        return;
    }

    const opts = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
    showDialog(`<div class="row"><h2 style="margin:0">Extend ${esc(b.ref)}</h2><span class="mut" id="hold-left" hidden></span></div>
    <div class="bk-grid">
      <div class="bk-gl">
        <div class="bk-dc">
          <h3 class="co-h">Extension details</h3>
          ${summary}
          ${info.message ? `<div class="alert" style="background:var(--warn-bg);color:var(--warn)">${esc(info.message)}</div>` : ''}
          <div class="alert" id="ex-addon" role="status" style="background:var(--warn-bg);color:var(--warn)" hidden></div>
          <label for="ex-h">Extra time</label>
          <select id="ex-h">${opts.map(h => `<option value="${h}">+${hrs(h)} (${peso(rate * h)})</option>`).join('')}</select>
          <dl class="dl" style="margin-top:10px"><dt>New end time</dt><dd id="ex-end"></dd><dt>Studio total after extension</dt><dd id="ex-tot"></dd></dl>
          <p class="mut" id="ex-hold" style="margin:6px 0">Holding the time for you...</p>
        </div>
        <section class="bk-sumcol" aria-label="Order summary">
          <h3 class="co-h">Order summary</h3>
          <div class="co-sum bk-sum">
            <div class="tot"><span>Extra cost</span><span id="ex-cost"></span></div>
            <div class="co-due">
              <div class="co-due-main"><span id="ex-dpl">Down payment due now (50%)</span><b id="ex-dp"></b></div>
              <div class="co-due-rest" id="ex-balrow"><span>Balance of the extension, paid at the studio</span><span id="ex-bal"></span></div>
            </div>
          </div>
        </section>
      </div>
      <div class="bk-gr">
        <section class="bk-pay" aria-label="Payment">
          <div>
            <h3 class="co-h">Payment</h3>
            <div class="pay-step">
              <p class="step-t"><span class="step-n" aria-hidden="true">1</span>Choose how much to pay now</p>
              ${payOptionHtml('ex', 'at the studio')}
            </div>
            <div class="pay-step">
              <p class="step-t"><span class="step-n" aria-hidden="true">2</span>Scan and pay with GCash</p>
              <div class="gq">
                <img id="ex-qr" alt="GCash QR code to scan" hidden>
                <p class="mut" id="ex-qn">Scan this QR code with GCash and pay the <span class="ex-kind">down payment</span> of <b class="ex-qa"></b>. Then enter the reference number from your GCash receipt below.</p>
              </div>
            </div>
            <div class="pay-step">
              <p class="step-t"><span class="step-n" aria-hidden="true">3</span>Confirm your payment</p>
              ${gcashProofHtml('ex')}
              <label for="ex-g" id="ex-gl">GCash reference number (down payment) <span class="req" aria-hidden="true">*</span></label>
              <input id="ex-g" data-gcash-ref placeholder="13-digit reference" inputmode="numeric" required aria-required="true">
            </div>
          </div>
        </section>
      </div>
    </div>
    <label class="terms" id="ex-terms">
      <input type="checkbox" id="ex-agree">
      <span id="ex-agreetxt">I understand and agree that the <b>50% down payment is non-refundable</b>, and that I pay the <b>remaining balance at the studio</b>.</span>
    </label>
    <div class="alert" id="ex-e" role="alert" hidden></div>
    <p class="hold">Staff verify your payment first. Your end time and total change only after it is verified. Until then the extra hours stay reserved for you.</p>
    <div class="co-foot bk-foot">
      <div class="co-foot-due">
        <span id="ex-foot-lbl">Pay now (50%)</span>
        <b id="ex-foot-amt"></b>
      </div>
      <button type="button" class="btn line" data-close>Cancel</button>
      <button type="button" class="btn gold" id="ex-go" disabled>Submit extension request</button>
    </div>`);
    dlg.classList.add('bookwide');   // same wide window as the booking form

    const sel = $('#ex-h'), err = m => {
        $('#ex-e').textContent = m;
        $('#ex-e').hidden = !m;
    };
    let chain = Promise.resolve(), done = false;
    const queue = fn => {
        const p = chain.then(fn);
        chain = p.catch(() => {
        });
        return p;
    };   // hold calls run one after another

    const hold = () => queue(async () => {
        if (done)
            return;
        const h = +sel.value;
        const { error: e } = await sb.rpc('staff_hold_extension', {
            p_booking_ref: b.ref,
            p_extra_hours: h,
            p_token: token
        });
        if (done)
            return;
        $('#ex-go').disabled = !!e || $('#ex-go').classList.contains('is-busy');
        if (e) {
            err(e.message);
            $('#ex-hold').textContent = 'The time is not held.';
            return;
        }
        err('');
        $('#ex-hold').textContent = `These hours are held for you while this window is open: ${endTime(b.start, b.hours)} to ${endTime(b.start, b.hours + h)}.`;
    });

    const addonNote = () => {
        const box = $('#ex-addon'), h = +sel.value;
        box.hidden = !(h > addonHi);
        if (!box.hidden)
            box.innerHTML = `<b>Your add-on equipment is not free for the extra time.</b> ${esc(info.addon_message || '')} You can still extend the session, but the add-on will <b>not</b> be included in the extra hours. You will be asked to confirm.`;
    };

    const preview = () => {
        addonNote();
        const h = +sel.value, cost = rate * h, opt = readPayOption('ex') || PAY_DOWN, dp = dueNow(cost, opt), full = opt === 'full';
        $('#ex-end').textContent = endTime(b.start, b.hours + h);
        $('#ex-cost').textContent = peso(cost);
        $('#ex-tot').textContent = peso(rate * (b.hours + h));
        $('#ex-dp').textContent = peso(dp);
        $('#ex-foot-lbl').textContent = full ? 'Pay now' : 'Pay now (50%)';
        $('#ex-foot-amt').textContent = peso(dp);
        $('#ex-bal').textContent = peso(cost - dp);
        $('#ex-balrow').hidden = full;
        $('#ex-dpl').textContent = full ? 'Full payment due now (100%)' : 'Down payment due now (50%)';
        $('#ex-gl').firstChild.textContent = `GCash reference number (${full ? 'full payment' : 'down payment'}) `;
        $('#ex-agreetxt').innerHTML = full
            ? 'I understand and agree that the <b>full payment is non-refundable</b>.'
            : 'I understand and agree that the <b>50% down payment is non-refundable</b>, and that I pay the <b>remaining balance at the studio</b>.';
        document.querySelectorAll('.ex-qa').forEach(n => {
            n.textContent = peso(dp);
        });
        document.querySelectorAll('.ex-kind').forEach(n => {
            n.textContent = full ? 'full payment' : 'down payment';
        });
    };

    // the studio's GCash QR (uploaded by the owner in Settings), shown above the reference number
    const qr = $('#ex-qr');
    qr.onload = () => {
        qr.hidden = false;
    };
    qr.onerror = () => {
        qr.hidden = true;
        $('#ex-qn').innerHTML = 'Pay the down payment of <b class="ex-qa"></b> using the studio\'s GCash account, then enter the reference number from your receipt below. Ask staff if you need the account details.';
        preview();
    };
    qr.src = gcashQrUrl();

    extToken = token;
    const timer = setInterval(hold, 60000);
    // same 2-minute idle rule as the booking form: no activity = the window closes and the hours are released
    const stopIdle = holdCountdown(dlg, {
        label: $('#hold-left'),
        onExpire: () => {
            dlg.close();
            toast('Extension window closed after 2 minutes of inactivity. The hours were released.');
        }
    });
    dlg.addEventListener('close', () => {
        // any way of closing the window frees the hold
        dlg.classList.remove('bookwide');
        done = true;
        clearInterval(timer);
        stopIdle();
        extToken = null;
        queue(async () => {
            try {
                await sb.rpc('release_hold', { p_token: token });
            } catch (e) {
                /* ignore */
            }
        });
    }, { once: true });

    const proof = initGcashProof('ex', { ref: '#ex-g' });
    const fieldRules = () => [
        ['#ex-ss', () => check.file(proof.file(), 'Attach a screenshot of your GCash payment.')],
        ['#ex-g', () => check.gcashRef($('#ex-g').value)],
        ['#ex-terms', () => $('#ex-agree').checked ? '' : 'Please tick the box to confirm you understand the no-refund policy.']
    ];
    liveCheck(fieldRules());   // each field is checked when it is left, and again while a mistake is being fixed
    onPayOption('ex', preview);
    sel.addEventListener('change', () => {
        preview();
        $('#ex-go').disabled = true;
        hold();
    });
    $('#ex-agree').onchange = e => {
        if (e.target.checked) {
            $('#ex-terms').classList.remove('err');
            err('');
        }
    };
    preview();
    hold();

    $('#ex-go').addEventListener('click', async () => {
        const payOpt = readPayOption('ex');
        const h = +sel.value, cost = rate * h, dp = dueNow(cost, payOpt || PAY_DOWN), gcash = $('#ex-g').value.replace(/\s/g, '');
        err('');
        if (!payOpt)
            return err('Choose 50% Downpayment or Full Payment.');
        if (!applyChecks(fieldRules().map(([t, rule]) => [t, rule()])))
            return;   // the wrong fields are marked under themselves
        // the equipment added to this booking is not free for the extra hours: extend the booking only, without the add-on
        const noAddon = h > addonHi;
        if (noAddon) {
            const okAddon = await askConfirm({
                title: 'Extend without your add-on?',
                message: `The equipment added to ${b.ref} is not available for the extra time. If you continue, only the studio session is extended, until ${endTime(b.start, b.hours + h)}. Your add-on is NOT included in the extra hours and must be returned when your current time ends (${endTime(b.start, b.hours)}).`,
                ok: 'Yes, extend without add-on',
                cancel: 'No, keep my add-on'
            });
            if (!okAddon)
                return;
        }
        const yes = await askConfirm({
            title: 'Send your extension request?',
            message: `${b.ref} will be extended by ${hrs(h)}, until ${endTime(b.start, b.hours + h)}, once staff verify your GCash ${payOpt === 'full' ? 'full payment' : 'down payment'} of ${peso(dp)}.${payOpt === 'full' ? '' : ` The remaining ${peso(cost - dp)} is paid at the studio.`}`,
            ok: 'Yes, send request',
            cancel: 'Not now'
        });
        if (!yes)
            return;
        const exGo = $('#ex-go');
        btnBusy(exGo, 'Sending…');
        const up = await uploadGcashProof(proof.file(), gcash);
        if (up.error) {
            btnReset(exGo);
            return err('Could not upload your GCash screenshot: ' + up.error.message);
        }
        const { data: res, error: e } = await sb.rpc('customer_request_extension', {
            p_booking_ref: b.ref,
            p_extra_hours: h,
            p_token: token,
            p_gcash_reference: gcash,
            p_pay_option: payOpt,
            p_without_addons: noAddon
        });
        if (e) {
            btnReset(exGo, false);   // hold() below enables it again when the hours are still held
            err(e.message);
            hold();
            return;
        }       // for example someone booked the hour first, or the GCash reference was already used
        const row = Array.isArray(res) ? res[0] : res;
        const full = (row.pay_option || payOpt) === 'full';
        await btnSuccess(exGo, 'Sent', { keep: true });   // brief check mark before the window closes
        dlg.close();
        await loadMyBookings();
        await refreshBook();
        showSuccess({
            title: 'Extension request sent!',
            label: 'Booking reference code',
            ref: b.ref,
            icon: 'receipt',
            lines: [
                ['Studio', `Studio ${b.studio}`],
                ['Date', longDate(b.date)],
                ['Current time', `${b.start} to ${endTime(b.start, b.hours)}`],
                ['Extension', `+${hrs(h)}, until ${endTime(b.start, b.hours + h)}`],
                ['Extension cost', peso(Number(row.extra_cost) || cost)],
                ['Payment option', optName(full ? 'full' : 'down')],
                [full ? 'Full payment sent' : 'Down payment sent (50%)', peso(Number(row.down_payment) || dp)],
                ['Balance at the studio', full ? 'Paid in full' : peso(row.balance_due != null ? Number(row.balance_due) : cost - dp)],
                ['Payment', `GCash ${full ? 'full payment' : 'down payment'}, waiting for staff to verify`],
                ['Requested on', stampLabel(new Date())]
            ],
            shot: 'Keep it as proof of your extension payment.',
            note: (full ? 'Your end time and total change after staff verify the payment. The extra hours are reserved for you until then. Nothing is left to pay for the extension.'
                : 'Your end time and total change after staff verify the down payment. The extra hours are reserved for you until then. Pay the balance of the extension at the studio.')
                + (row.without_addons ? ` Your add-on equipment is not included in the extra hours: return it when your current time ends (${endTime(b.start, b.hours)}).` : '')
        });
    });
}

function confirmCancel(b) {
    showDialog(`
    <h2>Cancel ${b.ref}?</h2>
    <p class="mut">Studio ${b.studio}, ${longDate(b.date)} at ${b.start}. The time slot is released for other customers.</p>
    ${b.down > 0 ? `<p class="mut" style="margin-top:8px">Your ${b.payOpt === 'full' ? 'full payment' : '50% down payment'} of <b>${peso(b.down)}</b> is <b>non-refundable</b> once the booking is cancelled.</p>` : ''}
    <div class="acts">
      <button class="btn line" data-close>Keep booking</button>
      <button class="btn bad" id="do-cancel">Cancel booking</button>
    </div>`);
    $('#do-cancel').onclick = async () => {
        const { error } = await sb.rpc('cancel_booking', { p_booking_ref: b.ref });
        if (error)
            return toast(error.message);
        dlg.close();
        await loadMyBookings();
        await refreshBook();
        toast(`${b.ref} cancelled.`);
    };
}

/* Start times (slot index -> reason) on a day where the equipment added to this booking is not free for the whole
   session (rpc reschedule_blocked_slots, file 54). Empty when the booking has no equipment or the call fails:
   the server still refuses a conflicting time when the customer saves, so nothing is lost. */
async function loadEquipmentBlocked(ref, dateISO) {
    const { data, error } = await sb.rpc('reschedule_blocked_slots', { p_booking_ref: ref, p_date: dateISO });
    if (error || !data)
        return new Map();
    return new Map(data.map(r => [r.slot, r.reason]));
}

/* ---- Reschedule ----
   * The current start time cannot be picked again (only on the booking's own date).
   * Only start times that have enough free hours in a row for the booking are enabled.
   * Picking a start time HOLDS those hours for 2 minutes (renewed every minute while this window is open),
     so nobody else can take them. Closing the window, changing the date or saving frees the hold. */
function openReschedule(b) {
    const si = studioIndex(b.studio), cur = SLOTS.indexOf(b.start), pick = {
        date: b.date,
        t: -1
    };
    showDialog(`
    <div class="row"><h2 style="margin:0">Reschedule ${b.ref}</h2><span class="mut" id="hold-left" hidden></span></div>
    <p class="mut">Studio ${b.studio}, ${b.hours} hr${b.hours > 1 ? 's' : ''}. Pick a new date and start time. Only start times with ${b.hours} free hour${b.hours > 1 ? 's' : ''} in a row are shown as available.</p>
    <label for="rs-d">New date</label>
    <input id="rs-d" type="date" min="${firstBookableDate()}" max="${lastBookableDate()}" value="${b.date}">
    <label>New start time</label>
    <div class="slots" id="rs-slots"></div>
    <p class="mut" id="rs-eqnote" style="margin:6px 0" hidden>Times marked <b>No equipment</b> are not available because the equipment added to this booking is already reserved by another booking or rental at that time.</p>
    <p class="mut" id="rs-hold" style="margin:6px 0" hidden></p>
    <div class="acts">
      <button class="btn line" data-close>Keep current time</button>
      <button class="btn gold" id="rs-save" disabled>Save new time</button>
    </div>`);

    let done = false, drawing = 0;
    const note = m => {
        $('#rs-hold').textContent = m || '';
        $('#rs-hold').hidden = !m;
    };

    const draw = async () => {
        const my = ++drawing;
        await loadBusy(si, pick.date, pick.date);
        if (done || my !== drawing)
            return;
        const taken = takenSlots(si, pick.date, b.ref);
        // start times where the equipment added to this booking is not free (reschedule_blocked_slots, file 54)
        const eqBlocked = await loadEquipmentBlocked(b.ref, pick.date);
        if (done || my !== drawing)
            return;
        // the picked time just became unavailable for equipment: drop the pick and free the hold
        if (pick.t >= 0 && eqBlocked.has(pick.t)) {
            pick.t = -1;
            note('');
            releaseHold();
            toast('The equipment added to this booking is no longer free at that time. Pick another time.');
        }
        $('#rs-slots').innerHTML = SLOTS.map((t, i) => {
            const isCurrent = pick.date === b.date && i === cur;
            const fits = i + b.hours <= SLOTS.length && !isPastSlot(pick.date, i)
                && Array.from({ length: b.hours }, (_, j) => !taken.has(i + j)).every(Boolean);
            const noEq = fits && !isCurrent && eqBlocked.has(i);
            const ok = fits && !isCurrent && !noEq;
            if (noEq)
                return `<button type="button" data-i="${i}" class="staff" disabled title="${esc(eqBlocked.get(i))}">${t}<span class="sh">No equipment</span></button>`;
            return `<button type="button" data-i="${i}" class="${i === pick.t ? 'sel' : ''}" ${ok ? '' : 'disabled'}${isCurrent ? ' title="Your current start time"' : ''}>${t}</button>`;
        }).join('');
        $('#rs-eqnote').hidden = ![...eqBlocked.keys()].some(i => i + b.hours <= SLOTS.length && !isPastSlot(pick.date, i));
        $('#rs-save').disabled = pick.t < 0;
    };
    draw();

    // take (or renew) the hold on the picked time; false = somebody else got there first
    const hold = async () => {
        if (pick.t < 0)
            return true;
        const ok = await holdRescheduleSlots(b.ref, si, pick.date, pick.t, b.hours);
        if (done)
            return ok;
        if (!ok) {
            pick.t = -1;
            note('');
            toast('Those hours were just taken by another customer. Pick another time.');
            await draw();
        }
        return ok;
    };

    const timer = setInterval(() => {
        if (pick.t >= 0)
            hold();
    }, 60000);

    // timer runs only while hours are actually held (a start time is picked)
    const stopIdle = holdCountdown(dlg, {
        label: $('#hold-left'),
        active: () => pick.t >= 0,
        onExpire: () => {
            dlg.close();
            toast('Reschedule window closed after 2 minutes of inactivity. The hours were released.');
        }
    });

    dlg.addEventListener('close', () => {
        // any way of closing the window frees the hold
        done = true;
        clearInterval(timer);
        stopIdle();
        releaseHold();
    }, { once: true });

    $('#rs-d').onchange = async e => {
        if (e.target.value > lastBookableDate()) {
            e.target.value = lastBookableDate();   // typed a date more than 4 weeks ahead
            toast('Bookings can only be made up to 4 weeks ahead.');
        }
        pick.date = e.target.value || b.date;
        pick.t = -1;
        note('');
        releaseHold();
        draw();
    };
    $('#rs-slots').onclick = async e => {
        const btn = e.target.closest('button');
        if (!btn || btn.disabled)
            return;
        pick.t = +btn.dataset.i;
        $('#rs-save').disabled = true;
        if (await hold()) {
            note(`These hours are held for you while this window is open: ${SLOTS[pick.t]} to ${endTime(SLOTS[pick.t], b.hours)}.`);
            draw();
        }
    };
    $('#rs-save').onclick = async () => {
        const date = pick.date, t = pick.t;
        if (t < 0)
            return;
        const save = $('#rs-save');
        btnBusy(save, 'Saving…');
        await hold();   // make sure the hold is still ours right before saving
        if (pick.t < 0) {
            btnReset(save, false);   // the hours were taken: draw() has already refreshed the button
            return;
        }
        const { error } = await sb.rpc('reschedule_booking', {
            p_booking_ref: b.ref,
            p_start_at: manilaTS(date, 10 + t),
            p_end_at: manilaTS(date, 10 + t + b.hours),
            p_token: HOLD_TOKEN
        });
        if (error) {
            btnReset(save);
            toast(error.message);
            return draw();
        }
        await btnSuccess(save, 'Moved', { keep: true });   // brief check mark before the window closes
        dlg.close();
        await loadMyBookings();
        await refreshBook();
        toast(`${b.ref} moved to ${shortDate(date)} at ${SLOTS[t]}. Add it to your calendar again to replace the old entry.`);
    };
}

/* "I'm running late": one extra 15 minutes (database: customer_running_late). The session still ends at its booked time. */
async function confirmRunningLate(btn) {
    const ref = btn.dataset.late;
    if (btn.dataset.busy)
        return;
    const ok = await askConfirm({
        title: 'Tell the studio you are running late?',
        message: `${ref} will be held for 15 more minutes. You can do this once. Your session still ends at its booked time, so a late start means less time in the studio. Pay the balance when you arrive.`,
        ok: 'Yes, I am running late',
        cancel: 'Never mind'
    });
    if (!ok)
        return;
    btn.dataset.busy = '1';
    try {
        const until = await runningLate(ref);
        await loadMyBookings();
        toast(`Thank you. We will hold your slot until ${releaseClock(until)}.`);
    } catch (err) {
        toast(err.message);
    } finally {
        delete btn.dataset.busy;
    }
}

/* "Book again" on a released (no-show) booking: opens the Book tab on the same studio */
async function bookAgain(ref) {
    const b = findBooking(ref);
    if (b && b.studio)
        state.selStudio = studioIndex(b.studio);
    await refreshBook();
    location.hash = 'book';
}

export function initBookingsTab() {
    $('#mybk').addEventListener('click', e => {
        if (e.target.closest('[data-toggle="bk"]')) {
            pastOpen.bk = !pastOpen.bk;
            return renderMyBookings();
        }
        const menu = e.target.closest('[data-menu]');
        if (menu)
            return openMenu(menu);
        const late = e.target.closest('[data-late]');
        if (late)
            return confirmRunningLate(late);
        const again = e.target.closest('[data-rebook]');
        if (again)
            bookAgain(again.dataset.rebook);
    });

    /* Guest lookup by reference code. */
    $('#gb-form').addEventListener('submit', async e => {
        e.preventDefault();
        const ref = normRef($('#gb-ref').value), box = $('#gb-res');
        box.hidden = false;
        const { data, error } = await sb.rpc('lookup_booking', { p_ref: ref });
        if (error || !data) {
            box.innerHTML = notFound(ref, 'booking');
            return;
        }
        const a = manilaParts(data.start_at), z = manilaParts(data.end_at), hrs = z.hour - a.hour;
        const status = BK_STATUS[data.status] || data.status;
        box.innerHTML = `
      <div class="row"><h3>${esc(data.booking_ref)}</h3>${badge(status)}</div>
      <dl class="dl">
        <dt>Studio</dt><dd>${esc(data.studio)}${data.studio_description ? ', ' + esc(data.studio_description) : ''}</dd>
        <dt>Date</dt><dd>${longDate(a.date)}</dd>
        <dt>Time</dt><dd>${SLOTS[a.hour - 10]} to ${endTime(SLOTS[a.hour - 10], hrs)} (${hrs} hr${hrs > 1 ? 's' : ''})</dd>
        <dt>Studio price</dt><dd>${peso(+(data.studio_total ?? data.total))}</dd>
        ${(data.addons || []).map(a => `<dt>Add-on</dt><dd>${esc(a.equipment)} x${a.quantity} (${peso(+a.price)})</dd>`).join('')}
        <dt>Total</dt><dd><b>${peso(+(data.grand_total ?? data.total))}</b></dd>
        ${+data.down_payment > 0 ? `<dt>Payment option</dt><dd>${data.payment_option === 'full' ? 'Full payment (100%)' : '50% down payment'}</dd>
          <dt>${data.payment_option === 'full' ? 'Full payment' : 'Down payment (50%)'}</dt><dd>${peso(+data.down_payment)}</dd>
          ${+data.addons_paid > 0 ? `<dt>Equipment added later, paid</dt><dd>${peso(+data.addons_paid)}</dd>` : ''}
          ${+data.balance_paid > 0 ? `<dt>Balance paid at the studio</dt><dd>${peso(+data.balance_paid)}</dd>` : ''}
          <dt>Balance at the studio</dt><dd>${+data.balance_due > 0.005 ? peso(+data.balance_due) : 'Paid in full'}</dd>
          <dt>Pick-up</dt><dd>Studio ${esc(data.studio.replace(/^Studio\s*/i, ''))}, ${shortDate(a.date)}, ${SLOTS[a.hour - 10]}. ${+data.balance_due > 0.005 ? 'Pay the balance on arrival' : 'Nothing left to pay'}</dd>` : ''}
        ${!(+data.down_payment > 0) && +data.addon_balance > 0.005 ? `<dt>Equipment balance at the studio</dt><dd>${peso(+data.addon_balance)}</dd>` : ''}
        <dt>${+data.down_payment > 0 ? (data.payment_option === 'full' ? 'Payment status' : 'Down payment status') : 'Payment'}</dt><dd>${badge(data.payment_status || 'Pending')}</dd>
        ${status === 'Rejected' ? `<dt>Reason for rejection</dt><dd>${esc(data.rejected_reason || 'No reason was given. Please contact the studio.')}</dd>` : ''}
      </dl>
      <p class="mut">${+data.down_payment > 0 ? (+data.balance_due > 0.005 ? 'Bookings are confirmed after staff verify your down payment. Pay the balance at the studio when you arrive.' : 'Bookings are confirmed after staff verify your payment. Nothing is left to pay at the studio.') : 'Bookings are confirmed after staff verify your payment.'}</p>`;
    });
}
