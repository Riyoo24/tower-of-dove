/* =====================================================================
   admin/balance.js - "Verify the balance" step before a session starts or equipment is issued
   When a customer paid a 50% down payment online, the remaining balance is collected at the studio.
   Start session / Issue equipment open this window first. It shows the exact amount to collect,
   asks HOW it was paid and, on confirmation, ONE database call
   (staff_collect_balance_proof -> staff_collect_balance, supabase/56_balance_payment_proof.sql + 32/45):
     Cash  : staff type the Amount Tendered, the window shows the Change to Return (or \"Short by\") and quick-cash chips;
             the button stays disabled until Amount Tendered >= Balance to Collect.
     GCash : the cash fields are hidden, the amount is fixed to the balance and a 13-digit Reference Number is required.
     1) records the balance and changes the payment from down payment to full payment,
     2) moves the booking to Active (database: In Progress) or the rental to In Use (database: Active).
   Mark completed on an Active session that still owes a balance (for example staff extended it, so the extra hours are
   unpaid) opens the same window: balance, Cash with amount tendered and change, or GCash with its reference. It records the
   balance (start = false, needs supabase/85_collect_balance_on_complete.sql) and then marks the booking Completed.
   Bookings and rentals without a balance keep the normal "Are you sure?" question.
   DB: rpc staff_collect_balance_proof; views v_booking_summary / v_rental_lines (balance_due).
   ===================================================================== */

import { afterAction, addonPaidOf, balanceOf, closeOverlays, findBk, owesOnComplete, setBookingFilter } from './bookings.js';
import { needsCheckIn } from './checkInInfo.js';
import { RL, refresh } from './data.js';
import { ACT, CONFIRM, askConfirm, dOf, isFull, money, notifyBalancePaid, num, run, tOf } from './helpers.js';
import { replacementPending } from './swapOffer.js';
import { addonWaitingBooking, groups, rentalBalance, rentalTotal, renderBeforePhotoSection, renderHandoverSection } from './rentals.js';
import { sb } from '../config/supabaseClient.js';
import { loadCatalog } from '../shared/catalog.js';
import { btnBusy, btnReset, btnSuccess } from '../shared/btnState.js';
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
        return 'The database is not updated yet. Run supabase/56_balance_payment_proof.sql in the Supabase SQL Editor (after 32 and 45), then reload this page.';
    if (/is In Progress now\. Only a Confirmed booking/i.test(m))
        return 'The database is not updated yet. Run supabase/85_collect_balance_on_complete.sql in the Supabase SQL Editor, then reload this page.';
    return m;
}

const cents = n => Math.round(n * 100);
/* ₱120, ₱80.50 (whole pesos without decimals, like the rest of the dashboard) */
const fmt = n => '₱' + n.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
const QUICK = [200, 500, 1000];   // quick-cash chips next to [Exact]
const GCASH_LEN = 13;             // a GCash reference number has 13 digits

/* 1234567890123 -> "1234 567 890123" */
const groupRef = d => [d.slice(0, 4), d.slice(4, 7), d.slice(7)].filter(Boolean).join(' ');

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
    ${cfg.photoRef ? '<h3 style="font-size:14px;margin:14px 0 6px">Before-rental photos (required to issue)</h3><div id="bal-photos"></div><h3 style="font-size:14px;margin:14px 0 6px">Handover proof photo (required to issue)</h3><p class="mut" style="margin:0 0 6px;font-size:13px">A photo of the equipment being handed over to the customer. The customer can see it in My rentals.</p><div id="bal-handover"></div>' : ''}
    <div class="alert warn" role="note"><b>Please verify:</b> ${cfg.optionLabel} Check that you have received the remaining balance of <b>${money(bal)}</b> from the customer before you continue.</div>
    <label for="bal-m">Balance was paid by</label>
    <select id="bal-m"><option value="Cash">Cash</option><option value="GCash">GCash</option></select>
    <div id="bal-cash">
      <label for="bal-tend">Amount tendered (cash given)</label>
      <div class="money-in"><span aria-hidden="true">₱</span><input type="text" id="bal-tend" inputmode="decimal" autocomplete="off" placeholder="0.00" aria-describedby="bal-calc"></div>
      <div class="quick-cash" role="group" aria-label="Quick cash amounts">
        <button type="button" class="chip" data-quick="exact">Exact</button>${QUICK.map(q => `<button type="button" class="chip" data-quick="${q}">₱${q.toLocaleString('en-US')}</button>`).join('')}</div>
      <div class="bal-calc" id="bal-calc" role="status" aria-live="polite"></div>
    </div>
    <div id="bal-gc" hidden>
      <div class="dr-sum"><div><span>GCash payment amount</span><b>${money(bal)}</b></div></div>
      <label for="bal-ref">GCash reference number</label>
      <input type="text" id="bal-ref" inputmode="numeric" autocomplete="off" placeholder="0000 000 000000" aria-describedby="bal-ref-hint">
      <p class="mut" id="bal-ref-hint" style="margin:4px 0 0"></p>
    </div>
    <div class="alert" id="bal-err" role="alert" hidden></div>
    <div class="acts"><button type="button" class="btn line" data-bal-close>Not received yet</button>
      <button type="button" class="btn gold" id="bal-ok" disabled>${esc(cfg.confirmLabel)}</button></div>
    <p class="mut" style="margin:10px 0 0">${cfg.footNote}</p></div>`;
    md.showModal();

    const ok = $('#bal-ok'), tend = $('#bal-tend'), ref = $('#bal-ref'), calc = $('#bal-calc'), hint = $('#bal-ref-hint'),
        err = t => {
            const box = $('#bal-err');
            box.textContent = t;
            box.hidden = !t;
        };
    const isGcash = () => $('#bal-m').value === 'GCash';
    const tendered = () => {   // null while nothing (or just a dot) is typed
        const v = tend.value.replace(/,/g, '');
        return v === '' || v === '.' ? null : Number(v);
    };
    const refDigits = () => ref.value.replace(/\D/g, '');
    const photosOk = () => !cfg.photoRef || (missingBefore(cfg.photoRef).length === 0 && !missingHandover(cfg.photoRef));
    const payOk = () => isGcash() ? refDigits().length === GCASH_LEN : tendered() !== null && cents(tendered()) >= cents(bal);

    const sync = () => {
        const gc = isGcash();
        $('#bal-cash').hidden = gc;
        $('#bal-gc').hidden = !gc;
        if (gc) {
            const n = refDigits().length;
            hint.textContent = n === 0 ? `Required. ${GCASH_LEN} digits from the customer's GCash receipt.`
                : n < GCASH_LEN ? `${n} of ${GCASH_LEN} digits.` : 'Reference number complete.';
            hint.style.color = n === GCASH_LEN ? 'var(--ok)' : '';
        } else {
            const t = tendered();
            calc.className = 'bal-calc';
            if (t === null) {
                calc.textContent = 'Enter the cash received from the customer.';
            } else if (cents(t) < cents(bal)) {
                calc.classList.add('short');
                calc.innerHTML = `Short by <b>${fmt((cents(bal) - cents(t)) / 100)}</b>`;
            } else {
                calc.classList.add('ok');
                calc.innerHTML = `Change to return: <b>${fmt((cents(t) - cents(bal)) / 100)}</b>`;
            }
            md.querySelectorAll('[data-quick]').forEach(c => {
                const v = c.dataset.quick === 'exact' ? bal : Number(c.dataset.quick);
                c.classList.toggle('on', t !== null && cents(t) === cents(v));
            });
        }
        ok.disabled = !payOk() || busy || !photosOk();
    };

    $('#bal-m').addEventListener('change', () => {
        err('');
        sync();
    });

    /* cash: digits and one dot, 2 decimals; the chips fill the field */
    tend.addEventListener('input', () => {
        let v = tend.value.replace(/[^\d.]/g, '');
        const dot = v.indexOf('.');
        if (dot >= 0)
            v = v.slice(0, dot).slice(0, 7) + '.' + v.slice(dot + 1).replace(/\./g, '').slice(0, 2);
        else
            v = v.slice(0, 7);
        if (v !== tend.value)
            tend.value = v;
        err('');
        sync();
    });
    md.querySelectorAll('[data-quick]').forEach(c => c.addEventListener('click', () => {
        const q = c.dataset.quick;
        tend.value = String(q === 'exact' ? (Number.isInteger(bal) ? bal : bal.toFixed(2)) : q);
        err('');
        sync();
        tend.focus();
    }));

    /* GCash: digits only, at most 13, shown as 1234 567 890123 (the caret stays after the same digit) */
    ref.addEventListener('input', () => {
        const caret = ref.selectionStart ?? ref.value.length;
        const before = ref.value.slice(0, caret).replace(/\D/g, '').length;
        const d = ref.value.replace(/\D/g, '').slice(0, GCASH_LEN), shown = groupRef(d);
        if (shown !== ref.value) {
            ref.value = shown;
            let pos = 0, seen = 0;
            while (pos < shown.length && seen < Math.min(before, d.length))
                if (/\d/.test(shown[pos++]))
                    seen++;
            try {
                ref.setSelectionRange(pos, pos);
            } catch (e) {
                /* no caret on this input type */
            }
        }
        err('');
        sync();
    });

    if (cfg.photoRef) {
        const box = $('#bal-photos');
        box.addEventListener('bph-render', sync);   // after every upload the section redraws: re-check the button
        renderBeforePhotoSection(cfg.photoRef, box);
        const hbox = $('#bal-handover');
        hbox.addEventListener('bph-render', sync);
        renderHandoverSection(cfg.photoRef, hbox);
    }
    sync();
    tend.focus();   // Cash is the default: type the amount straight away (the button stays disabled until it is enough)

    ok.addEventListener('click', async () => {
        if (busy || !payOk() || !photosOk())
            return;
        busy = true;
        btnBusy(ok, 'Saving…');
        err('');
        const method = $('#bal-m').value, gcash = method === 'GCash';
        const given = gcash ? null : tendered();
        const { data, error } = await sb.rpc('staff_collect_balance_proof', {
            p_kind: cfg.kind,
            p_ref: cfg.ref,
            p_method: method,
            p_expected: bal,
            p_start: cfg.start !== false,
            p_reference: gcash ? refDigits() : null,
            p_tendered: given
        });
        busy = false;
        if (error) {
            console.error(error);
            err(friendly(error));
            btnReset(ok, false);
            ok.textContent = cfg.confirmLabel;
            sync();
            if (/balance changed/i.test(error.message || ''))
                refresh();   // the dashboard shows the new amount when the window is opened again
            return;
        }
        await btnSuccess(ok, 'Saved', { keep: true, ms: 250 });
        const row = Array.isArray(data) ? data[0] : data;
        const collected = row ? num(row.collected) : bal;
        // The balance is already saved, so close the window right away. The receipt email (a slow call to an Edge
        // Function) and the dashboard reload used to run one after another BEFORE the window closed, which was the long pause.
        closeAll();
        const change = given === null ? 0 : (cents(given) - cents(bal)) / 100;
        const mailText = m => m === 'sent' ? ' Fully paid receipt emailed to the customer.'
            : m === 'noemail' ? ' No email on file, so no receipt was emailed.'
            : m === 'failed' ? ' The receipt email could not be sent.' : '';
        // email the customer the fully paid receipt in the background (a failed email never undoes the collection)
        let mail = null, mailDone = false, shown = false;
        const mailP = collected > EPS ? notifyBalancePaid(cfg.kind, cfg.ref) : Promise.resolve(null);
        mailP.then(m => {
            mail = m;
            mailDone = true;
            if (shown && m)
                toast(mailText(m).trim());   // the main message was already shown without the email result
        });
        // the dashboard catches up while the email is being sent
        (async () => {
            let worked = true;
            if (cfg.after)
                worked = await cfg.after();
            if (cfg.kind === 'rental' || cfg.after)
                await loadCatalog();
            await refresh();
            if (worked) {
                toast(cfg.doneMessage(collected, method) + (change > 0 ? ` Change returned: ${fmt(change)}.` : '') + (mailDone ? mailText(mail) : ''));
                shown = true;
            }
        })();
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
    if (!b || balanceOf(b) > EPS || needsCheckIn(ref))
        return undefined;   // the balance window asks instead (or, before check-in, ACT 'bk-go' says to check in first)
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
    // the customer must have arrived first: Check in, then Start session / Collect balance & start
    if (needsCheckIn(ref))
        return toast(`Check ${b.customer_name} in first (Actions > Check in). Then you can start the session and collect the balance.`);
    if (balanceOf(b) > EPS)
        return openBalanceModal(bookingCfg(b));
    if (await run(sb.from('booking').update({ status: 'In Progress' }).eq('booking_id', b.booking_id)))
        afterAction(`${ref} started.`);
};

/* =========================== studio booking: Mark completed =========================== */

/* The same window as Start session, for an Active session with a balance left (extra hours added by an extension, or a later
   add-on). The balance is recorded without changing the status (start = false); `after` then marks the booking Completed. */
function completeCfg(b) {
    const ad = RL.filter(l => l.booking_ref === b.booking_ref && l.rental_type === 'Add-on' && !['Rejected', 'Cancelled'].includes(l.status));
    const adTotal = sum(ad.map(l => num(l.unit_price_at_request) * l.quantity)),
        studio = num(b.total_amount),   // the database works it out from the current start and end time, so extra hours are included
        bal = balanceOf(b);
    return {
        kind: 'booking',
        ref: b.booking_ref,
        start: false,
        heading: 'Collect the balance and complete',
        who: `${b.customer_name} (${b.booking_ref})`,
        detail: [
            ['Studio', esc(b.studio_name)],
            ['Session', `${esc(longDate(dOf(b.start_at)))}, ${tOf(b.start_at)} to ${tOf(b.end_at)} (${pl(Math.round(num(b.hours)), 'hr')})`]
        ],
        rows: [
            ['Studio session (with any extra hours)', money(studio)],
            ...(adTotal > 0 ? [['Add-on equipment', money(adTotal)]] : []),
            ['Booking total', `<b>${money(studio + adTotal)}</b>`],
            ['Already paid', money(Math.max(0, studio + adTotal - bal))]
        ],
        balance: bal,
        optionLabel: 'The extra time or equipment added during this session is not paid yet.',
        confirmLabel: 'Balance received. Mark completed',
        footNote: 'Confirming records the payment as <b>fully paid</b> and marks the session <b>Completed</b>.',
        after: async () => !!(await run(sb.from('booking').update({ status: 'Completed' }).eq('booking_id', b.booking_id))),
        doneMessage: (c, m) => `${b.booking_ref} marked completed. ${money(c)} balance collected (${m}). Payment is now fully paid.`
    };
}

/* Mark completed (Bookings tab, Studio sessions tab, Verify window). bookings.js asks "Are you sure?"; when a balance is
   left the window above collects it instead. */
const doneConfirm = CONFIRM['bk-done'], doneAct = ACT['bk-done'];

CONFIRM['bk-done'] = ref => owesOnComplete(findBk(ref)) ? undefined : doneConfirm && doneConfirm(ref);

ACT['bk-done'] = async ref => {
    const b = findBk(ref);
    if (owesOnComplete(b))
        return openBalanceModal(completeCfg(b));
    return doneAct(ref);
};

/* =========================== rental: Issue equipment =========================== */

function rentalCfg(g) {
    const l0 = g.lines[0], out = g.type === 'Outside', total = rentalTotal(g);
    const items = g.lines.length === 1 ? `${esc(l0.equipment_name)} x${l0.quantity}` : pl(sum(g.lines.map(l => l.quantity)), 'item');
    return {
        kind: 'rental',
        ref: g.ref,
        photoRef: out ? g.ref : null,   // outside rental: the before photos are attached in this window
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

/* lines of an outside rental that still have no before photo */
/* an outside rental that still has no handover proof photo */
const missingHandover = ref => {
    const l = RL.find(x => x.rental_ref === ref && x.rental_type === 'Outside');
    return !!l && !l.handover_photo_path;
};

const missingBefore = ref => RL.filter(l => l.rental_ref === ref && l.rental_type === 'Outside' && !l.line_returned_at && !l.before_photo_path);

CONFIRM['rn-issue'] = ref => {
    const g = groupOf(ref);
    if (g && replacementPending(ref))
        return undefined;   // ACT below says why it cannot be issued yet
    if (g && addonWaitingBooking(g))
        return undefined;   // add-on: ACT below opens the booking in the Bookings tab and asks there
    if (!g || rentalBalance(g) > EPS || g.type === 'Outside')
        return undefined;   // the balance window (or the before-photo window of an outside rental) asks instead
    return {
        title: 'Issue the equipment?',
        message: `Hand over the equipment for ${ref} (${g.customer}) now? The rental will be marked In Use.`,
        ok: 'Yes, issue equipment'
    };
};

/* Issue window of an outside rental WITHOUT a balance: staff attach the before photo of every item here,
   then the button issues the rental (it is disabled until every item has its photo). */
function openBeforePhotoGate(g) {
    const dlg = document.createElement('dialog');
    dlg.className = 'dlg balance';
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-label', 'Issue equipment');
    document.body.appendChild(dlg);

    dlg.innerHTML = `<div class="in">
      <h2 style="margin:0 0 4px">Issue the equipment</h2>
      <p class="mut" style="margin:0 0 10px">${esc(g.customer)} (${esc(g.ref)}). Attach a before photo of every item and the handover proof photo, then hand the equipment to the customer.</p>
      <div id="bph-gate-content"></div>
      <h3 style="font-size:14px;margin:14px 0 6px">Handover proof photo (required to issue)</h3>
      <div id="bph-gate-handover"></div>
      <div class="alert" id="bph-gate-err" role="alert" hidden style="margin-top:8px"></div>
      <div class="acts" style="margin-top:14px">
        <button type="button" class="btn line" id="bph-gate-cancel">Cancel</button>
        <button type="button" class="btn gold" id="bph-gate-proceed" disabled>Yes, issue equipment</button>
      </div>
    </div>`;
    dlg.showModal();

    const container = dlg.querySelector('#bph-gate-content');
    const errBox = dlg.querySelector('#bph-gate-err');
    const go = dlg.querySelector('#bph-gate-proceed');
    const sync = () => { go.disabled = missingBefore(g.ref).length > 0 || missingHandover(g.ref); };
    const done = () => { dlg.close(); dlg.remove(); };

    container.addEventListener('bph-render', sync);
    renderBeforePhotoSection(g.ref, container);
    const hContainer = dlg.querySelector('#bph-gate-handover');
    hContainer.addEventListener('bph-render', sync);
    renderHandoverSection(g.ref, hContainer);

    dlg.querySelector('#bph-gate-cancel').addEventListener('click', done);
    dlg.addEventListener('click', e => { if (e.target === dlg) done(); });

    go.addEventListener('click', async () => {
        errBox.hidden = true;
        const missing = missingBefore(g.ref);
        if (!missing.length && missingHandover(g.ref)) {
            errBox.textContent = 'The handover proof photo is missing. Upload it first.';
            errBox.hidden = false;
            return;
        }
        if (missing.length) {
            errBox.textContent = `Before photo missing for: ${missing.map(l => l.equipment_name).join(', ')}. Upload all photos first.`;
            errBox.hidden = false;
            return;
        }
        go.disabled = true;
        if (await run(sb.from('rental_order').update({ status: 'Active' }).eq('rental_ref', g.ref))) {
            done();
            await loadCatalog();
            afterAction(`${g.ref} issued.`);
        } else {
            sync();
        }
    });
}

ACT['rn-issue'] = async ref => {
    const g = groupOf(ref);
    if (!g)
        return toast('That rental could not be found.');
    if (replacementPending(ref))
        return toast('A replacement item is not settled yet. Swap the item first, or wait for the customer\'s answer.');
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

    // Outside rental: the before photos are attached in the Issue window itself
    if (g.type === 'Outside' && rentalBalance(g) <= EPS)
        return openBeforePhotoGate(g);

    if (rentalBalance(g) > EPS) {
        return openBalanceModal(rentalCfg(g));   // an outside rental, or an add-on with its own down payment
    }
    if (await run(sb.from('rental_order').update({ status: 'Active' }).eq('rental_ref', ref))) {
        await loadCatalog();
        afterAction(`${ref} issued.`);
    }
};
