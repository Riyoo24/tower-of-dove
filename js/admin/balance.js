/* =====================================================================
   admin/balance.js - "Verify the balance" step before a session starts or equipment is issued
   When a customer paid a 50% down payment online, the remaining balance is collected at the studio.
   Start session / Issue equipment open this window first. It shows the exact amount to collect,
   reminds staff to check they really received it and, on confirmation, ONE database call
   (staff_collect_balance, supabase/32_balance_collection.sql):
     1) records the balance and changes the payment from down payment to full payment,
     2) moves the booking to Active (database: In Progress) or the rental to In Use (database: Active).
   Bookings and rentals without a balance keep the normal "Are you sure?" question.
   DB: rpc staff_collect_balance; views v_booking_summary / v_rental_lines (balance_due).
   ===================================================================== */

import { afterAction, addonPaidOf, balanceOf, closeOverlays, findBk, setBookingFilter } from './bookings.js';
import { RL, refresh } from './data.js';
import { ACT, CONFIRM, askConfirm, dOf, isFull, money, num, run, tOf } from './helpers.js';
import { addonWaitingBooking, groups, rentalBalance, rentalTotal } from './rentals.js';
import { sb } from '../config/supabaseClient.js';
import { loadCatalog } from '../shared/catalog.js';
import { $, esc, longDate, pl, shortDate, sum, toast } from '../shared/utils.js';

const EPS = 0.005;

/* ---- the window (created once, opens on top of the Verify drawer and every other window) ---- */
const md = document.createElement('dialog');
md.className = 'dlg balance';
md.setAttribute('role', 'alertdialog');
md.setAttribute('aria-label', 'Verify the remaining balance');
document.body.appendChild(md);

let busy = false;   // true while the database call runs: the window cannot be closed

md.addEventListener('click', e => {
    if (busy)
        return;
    if (e.target === md || e.target.closest('[data-bal-close]'))
        md.close();
});

md.addEventListener('cancel', e => {
    if (busy)
        e.preventDefault();   // Esc does nothing while saving
});

const closeAll = () => {
    if (md.open)
        md.close();
    const drawer = $('#vdr'), small = $('#rdlg');
    if (drawer && drawer.open)
        drawer.close();
    if (small && small.open)
        small.close();
};

/* the database says what is wrong; a missing function means 32_balance_collection.sql was not run yet */
function friendly(error) {
    const m = error.message || 'Something went wrong.';
    if (error.code === 'PGRST202' || (/staff_collect_balance/i.test(m) && /schema cache|does not exist|could not find/i.test(m)))
        return 'The database is not updated yet. Run supabase/32_balance_collection.sql in the Supabase SQL Editor, then reload this page.';
    return m;
}

/* cfg = {
     kind 'booking' | 'rental', ref, start (false = only record the balance),
     heading, who, detail [[label, value]], rows [[label, value]], balance, optionLabel,
     confirmLabel, doneMessage(collected, method), after (optional async step, returns true when it worked) } */
function openBalanceModal(cfg) {
    const bal = Math.round(cfg.balance * 100) / 100;
    md.innerHTML = `<div class="in">
    <h2 style="margin:0 0 4px">${esc(cfg.heading)}</h2>
    <p class="mut" style="margin:0">${esc(cfg.who)}</p>
    <dl class="dl">${cfg.detail.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>
    <div class="dr-sum">${cfg.rows.map(([k, v]) => `<div><span>${esc(k)}</span><span>${v}</span></div>`).join('')}
      <div class="tot-line"><b>Balance to collect now</b><b class="bal-amt" id="bal-amt">${money(bal)}</b></div></div>
    <div class="alert warn" role="note"><b>Please verify:</b> ${cfg.optionLabel} Check that you have received the remaining balance of <b>${money(bal)}</b> from the customer before you continue.</div>
    <label for="bal-m">Balance was paid by</label>
    <select id="bal-m"><option value="Cash">Cash</option><option value="GCash">GCash</option></select>
    <label class="terms"><input type="checkbox" id="bal-chk"><span>Yes, I received <b>${money(bal)}</b> from <b>${esc(cfg.who.split(' (')[0])}</b>.</span></label>
    <div class="alert" id="bal-err" role="alert" hidden></div>
    <div class="acts"><button type="button" class="btn line" data-bal-close>Not received yet</button>
      <button type="button" class="btn gold" id="bal-ok" disabled>${esc(cfg.confirmLabel)}</button></div>
    <p class="mut" style="margin:10px 0 0">${cfg.footNote}</p></div>`;
    md.showModal();

    const chk = $('#bal-chk'), ok = $('#bal-ok'), err = t => {
        const box = $('#bal-err');
        box.textContent = t;
        box.hidden = !t;
    };
    chk.addEventListener('change', () => {
        ok.disabled = !chk.checked || busy;
    });
    md.querySelector('[data-bal-close]').focus();   // Cancel has the focus, so Enter never confirms by accident

    ok.addEventListener('click', async () => {
        if (busy || !chk.checked)
            return;
        busy = true;
        ok.disabled = true;
        ok.textContent = 'Saving...';
        err('');
        const method = $('#bal-m').value;
        const { data, error } = await sb.rpc('staff_collect_balance', {
            p_kind: cfg.kind,
            p_ref: cfg.ref,
            p_method: method,
            p_expected: bal,
            p_start: cfg.start !== false
        });
        busy = false;
        if (error) {
            console.error(error);
            err(friendly(error));
            ok.textContent = cfg.confirmLabel;
            ok.disabled = !chk.checked;
            if (/balance changed/i.test(error.message || ''))
                refresh();   // the dashboard shows the new amount when the window is opened again
            return;
        }
        const row = Array.isArray(data) ? data[0] : data;
        const collected = row ? num(row.collected) : bal;
        let worked = true;
        if (cfg.after)
            worked = await cfg.after();
        if (cfg.kind === 'rental' || cfg.after)
            await loadCatalog();
        await refresh();
        closeAll();
        if (worked)
            toast(cfg.doneMessage(collected, method));
    });
}

/* =========================== studio booking: Start session =========================== */

const optNote = b => num(b.down_payment) <= 0 ? 'The booking itself is paid in full. The customer paid 50% online for equipment added later.'
    : isFull(b.payment_option) ? 'The customer paid online.' : 'The customer paid a 50% down payment online.';

function bookingCfg(b) {
    const ad = RL.filter(l => l.booking_ref === b.booking_ref && l.rental_type === 'Add-on' && !['Rejected', 'Cancelled'].includes(l.status));
    const adTotal = sum(ad.map(l => num(l.unit_price_at_request) * l.quantity)),
        studio = num(b.total_amount),
        later = addonPaidOf(b.booking_ref),
        ownTotal = sum(ad.filter(l => num(l.down_payment) > 0).map(l => num(l.unit_price_at_request) * l.quantity)),   // add-ons with their own payment
        bal = balanceOf(b);
    return {
        kind: 'booking',
        ref: b.booking_ref,
        start: true,
        heading: 'Verify the remaining balance',
        who: `${b.customer_name} (${b.booking_ref})`,
        detail: [
            ['Studio', esc(b.studio_name)],
            ['Session', `${esc(longDate(dOf(b.start_at)))}, ${tOf(b.start_at)} to ${tOf(b.end_at)} (${pl(Math.round(num(b.hours)), 'hr')})`]
        ],
        rows: [
            ['Studio session', money(studio)],
            ...(adTotal > 0 ? [['Add-on equipment', money(adTotal)]] : []),
            ['Booking total', `<b>${money(studio + adTotal)}</b>`],
            ...(num(b.down_payment) > 0
                ? [[isFull(b.payment_option) ? 'Paid online (full payment)' : 'Paid online (50% down payment)', money(num(b.down_payment))]]
                : [['Paid when booked', money(Math.max(0, studio + adTotal - ownTotal))]]),
            ...(later > 0 ? [['Equipment added later, paid online', money(later)]] : [])
        ],
        balance: bal,
        optionLabel: optNote(b),
        confirmLabel: 'Balance received. Start session',
        footNote: 'Confirming changes the payment from <b>down payment</b> to <b>fully paid</b> and starts the session. The booking becomes <b>Active</b>.',
        doneMessage: (c, m) => `${b.booking_ref} is now Active. ${money(c)} balance collected (${m}). Payment is now fully paid.`
    };
}

/* Start session (Bookings tab, Studio sessions tab, Verify window).
   No balance: the usual "Are you sure?" question. Balance due: the verification window below. */
CONFIRM['bk-go'] = ref => {
    const b = findBk(ref);
    if (!b || balanceOf(b) > EPS)
        return undefined;   // the balance window asks instead
    return {
        title: 'Start this session?',
        message: `Start the session for ${b.booking_ref} (${b.customer_name}, ${b.studio_name}, ${shortDate(dOf(b.start_at))} ${tOf(b.start_at)}) now? It will be marked Active.`,
        ok: 'Yes, start session'
    };
};

ACT['bk-go'] = async ref => {
    const b = findBk(ref);
    if (!b)
        return toast('That booking could not be found.');
    if (balanceOf(b) > EPS)
        return openBalanceModal(bookingCfg(b));
    if (await run(sb.from('booking').update({ status: 'In Progress' }).eq('booking_id', b.booking_id)))
        afterAction(`${ref} started.`);
};

/* =========================== rental: Issue equipment =========================== */

function rentalCfg(g) {
    const l0 = g.lines[0], out = g.type === 'Outside', total = rentalTotal(g);
    const items = g.lines.length === 1 ? `${esc(l0.equipment_name)} x${l0.quantity}` : pl(sum(g.lines.map(l => l.quantity)), 'item');
    return {
        kind: 'rental',
        ref: g.ref,
        start: true,
        heading: 'Verify the remaining balance',
        who: `${g.customer} (${g.ref})`,
        detail: [
            ...(!out && g.booking ? [['Booking', esc(g.booking)]] : []),
            ['Items', items],
            ...(out && l0.pickup_date ? [['Pick-up', `${shortDate(dOf(l0.pickup_date))}, ${tOf(l0.pickup_date)}`]] : [])
        ],
        rows: [
            [out ? 'Rental total' : 'Add-on total', `<b>${money(total)}</b>`],
            ['Paid online (50% down payment)', money(num(l0.down_payment))]
        ],
        balance: rentalBalance(g),
        optionLabel: 'The customer paid a 50% down payment online.',
        confirmLabel: 'Balance received. Issue equipment',
        footNote: 'Confirming changes the payment from <b>down payment</b> to <b>fully paid</b> and hands the equipment over. The rental becomes <b>In Use</b>.',
        doneMessage: (c, m) => `${g.ref} issued and now In Use. ${money(c)} balance collected (${m}). Payment is now fully paid.`
    };
}

const groupOf = ref => groups().find(x => x.ref === ref);

CONFIRM['rn-issue'] = ref => {
    const g = groupOf(ref);
    if (g && addonWaitingBooking(g))
        return undefined;   // add-on: ACT below opens the booking in the Bookings tab and asks there
    if (!g || rentalBalance(g) > EPS)
        return undefined;   // the balance window asks instead
    return {
        title: 'Issue the equipment?',
        message: `Hand over the equipment for ${ref} (${g.customer}) now? The rental will be marked In Use.`,
        ok: 'Yes, issue equipment'
    };
};

ACT['rn-issue'] = async ref => {
    const g = groupOf(ref);
    if (!g)
        return toast('That rental could not be found.');
    const waiting = addonWaitingBooking(g);
    if (waiting) {
        // the booking has not started yet: go to the Bookings tab, show that booking, and run its
        // Start session / Collect balance & start there. The add-on can be issued once the booking has started.
        closeAll();
        closeOverlays();
        setBookingFilter('All');
        $('#bk-q').value = waiting.booking_ref;
        $('#bk-q').dispatchEvent(new Event('input'));
        location.hash = 'a-book';
        const spec = CONFIRM['bk-go'](waiting.booking_ref);
        if (spec && !(await askConfirm(spec)))
            return;
        return ACT['bk-go'](waiting.booking_ref);
    }
    if (rentalBalance(g) > EPS) {
        return openBalanceModal(rentalCfg(g));   // an outside rental, or an add-on with its own down payment
    }
    if (await run(sb.from('rental_order').update({ status: 'Active' }).eq('rental_ref', ref))) {
        await loadCatalog();
        afterAction(`${ref} issued.`);
    }
};
