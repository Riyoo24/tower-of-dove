/* =====================================================================
   admin/damage.js - damage fees of outside rentals
   A damage fee is money OWED by the customer, not a payment. It is kept in its own table (damage_charge, one row per
   rental item), apart from the payment table, so the balance / down payment math of rentals is never touched.
   Status: Unpaid -> Pending (customer sent GCash, staff still verify) -> Paid.   Waived = amount 0.
   This file holds: the status helpers, the "collect" fields (Cash / GCash) used by the return window and the
   collect window, and the Damage fee window (details, photos, collect, verify / reject, change / waive, audit trail).
   DB: v_damage_charge, damage_charge_log, rpc staff_collect_damage, staff_reject_damage_payment,
       staff_update_damage_charge (supabase/58_damage_charges.sql).
   ===================================================================== */

import { DMG, RL, STAFF, refresh } from './data.js';
import { ACT, askConfirm, mailNoteOf, money, notifyDamagePaid, num, stampLabel } from './helpers.js';
import { sb } from '../config/supabaseClient.js';
import { btnBusy, btnReset } from '../shared/btnState.js';
import { listGcashProofs } from '../shared/gcashProof.js';
import { openImageViewer } from '../shared/imageViewer.js';
import { signedPhotoUrl } from '../shared/inspectionPhoto.js';
import { photoBtn } from '../shared/imageViewer.js';
import { $, badge, esc, sum, toast } from '../shared/utils.js';

const cents = n => Math.round(n * 100);
const GCASH_LEN = 13;
const OPEN = ['Unpaid', 'Pending'];   // money still to receive

/* ---------------- status helpers (used by the Rentals, Payments, Overview and Reports tabs) ---------------- */
export const dmgOf = ref => DMG.filter(d => d.rental_ref === ref);
export const dmgOwed = ref => sum(dmgOf(ref).filter(d => OPEN.includes(d.status)).map(d => num(d.amount)));
export const dmgTotal = ref => sum(dmgOf(ref).map(d => num(d.amount)));
export const lateFeeOfRef = ref => sum(RL.filter(l => l.rental_ref === ref).map(l => num(l.late_fee)));

/* One status for a whole rental order: Unpaid (something not paid and nothing waiting), Pending (customer paid, staff must check),
   Paid, or Waived (every item had no charge). */
export function dmgStatus(ref) {
    const list = dmgOf(ref).filter(d => num(d.amount) > 0);
    if (!list.length)
        return dmgOf(ref).length ? 'Waived' : '';
    if (list.some(d => d.status === 'Unpaid'))
        return 'Unpaid';
    if (list.some(d => d.status === 'Pending'))
        return 'Pending';
    return 'Paid';
}

/* the people shown in the audit trail */
export const staffName = id => {
    const u = STAFF.find(x => x.user_id === id);
    return u ? `${u.first_name} ${u.last_name}`.trim() : 'Staff';
};

/* the database says what is wrong; a missing function means 58_damage_charges.sql was not run yet */
export function dmgError(error) {
    const m = (error && error.message) || 'Something went wrong.';
    if ((error && error.code === 'PGRST202') || (/damage|staff_return_rental_with_damage/i.test(m) && /schema cache|does not exist|could not find/i.test(m)))
        return 'The database is not updated yet. Run supabase/58_damage_charges.sql in the Supabase SQL Editor, then reload this page.';
    return m;
}

/* ---------------- Cash / GCash fields (return window and collect window) ----------------
   collectBox({ later }) -> HTML. later = true adds "Not now (leave unpaid)" and starts on it.
   bindCollect(root, getTotal, onChange) -> { valid(), method(), tendered(), reference(), sync() }.
   Cash: the amount tendered must cover the fee (the change is shown). GCash: the 13-digit reference is required. */
export function collectBox({ later = false, label } = {}) {
    return `<div class="dc-collect">
      <label>${esc(label || (later ? 'Collect the damage fee' : 'Damage fee was paid by'))}</label>
      <select data-dc="m">${later ? '<option value="">Not now (leave it unpaid)</option>' : ''}<option value="Cash">Cash</option><option value="GCash">GCash</option></select>
      <div data-dc="cash" hidden>
        <label>Amount tendered (cash given)</label>
        <div class="money-in"><span aria-hidden="true">&#8369;</span><input type="text" data-dc="tend" inputmode="decimal" autocomplete="off" placeholder="0.00"></div>
        <div class="bal-calc" data-dc="calc" role="status" aria-live="polite"></div>
      </div>
      <div data-dc="gc" hidden>
        <label>GCash reference number</label>
        <input type="text" data-dc="ref" inputmode="numeric" autocomplete="off" placeholder="13-digit reference">
        <p class="mut" data-dc="hint" style="margin:4px 0 0"></p>
      </div>
    </div>`;
}

export function bindCollect(root, getTotal, onChange) {
    const q = k => root.querySelector(`[data-dc="${k}"]`);
    const m = q('m'), cash = q('cash'), gc = q('gc'), tend = q('tend'), calc = q('calc'), ref = q('ref'), hint = q('hint');
    const tendered = () => {
        const v = tend.value.replace(/,/g, '');
        return v === '' || v === '.' ? null : Number(v);
    };
    const digits = () => ref.value.replace(/\D/g, '');
    const valid = () => {
        if (!m.value)
            return true;
        if (m.value === 'GCash')
            return digits().length === GCASH_LEN;
        return tendered() !== null && cents(tendered()) >= cents(getTotal());
    };
    const sync = (initial) => {
        const method = m.value, total = getTotal();
        cash.hidden = method !== 'Cash';
        gc.hidden = method !== 'GCash';
        if (method === 'Cash') {
            const t = tendered();
            calc.className = 'bal-calc';
            if (t === null)
                calc.textContent = 'Enter the cash received from the customer.';
            else if (cents(t) < cents(total)) {
                calc.classList.add('short');
                calc.innerHTML = `Short by <b>${money((cents(total) - cents(t)) / 100)}</b>`;
            } else {
                calc.classList.add('ok');
                calc.innerHTML = `Change to return: <b>${money((cents(t) - cents(total)) / 100)}</b>`;
            }
        } else if (method === 'GCash') {
            const n = digits().length;
            hint.textContent = n === 0 ? `Required. ${GCASH_LEN} digits from the customer's GCash receipt.` : n < GCASH_LEN ? `${n} of ${GCASH_LEN} digits.` : 'Reference number complete.';
            hint.style.color = n === GCASH_LEN ? 'var(--ok)' : '';
        }
        if (onChange && initial !== true)
            onChange();
    };
    m.addEventListener('change', () => sync());
    tend.addEventListener('input', () => {
        let v = tend.value.replace(/[^\d.]/g, '');
        const dot = v.indexOf('.');
        v = dot >= 0 ? v.slice(0, dot).slice(0, 7) + '.' + v.slice(dot + 1).replace(/\./g, '').slice(0, 2) : v.slice(0, 7);
        if (v !== tend.value)
            tend.value = v;
        sync();
    });
    ref.addEventListener('input', () => {
        const d = digits().slice(0, GCASH_LEN);
        ref.value = [d.slice(0, 4), d.slice(4, 7), d.slice(7)].filter(Boolean).join(' ');
        sync();
    });
    sync(true);
    return { valid, sync: () => sync(), method: () => m.value || null, tendered, reference: digits, focus: () => (m.value === 'Cash' ? tend : ref).focus() };
}

/* ---------------- the Damage fee window ---------------- */
const md = document.createElement('dialog');
md.className = 'dlg balance';
md.setAttribute('aria-label', 'Damage fee');
document.body.appendChild(md);
let busy = false;
md.addEventListener('click', e => {
    if (busy)
        return;
    if (e.target === md || e.target.closest('[data-dc-close]'))
        md.close();
});
md.addEventListener('cancel', e => {
    if (busy)
        e.preventDefault();
});

const photoCell = (url, title) => url
    ? `<figure>${photoBtn(url, title + ' photo', 'View ' + title.toLowerCase())}</figure>`
    : `<figure><div class="dc-nophoto">No ${esc(title.toLowerCase())} photo</div></figure>`;

/* A GCash screenshot, shown like the one in the Payments Verify drawer: the whole picture (not cropped).
   Click it to enlarge it in a pop-up on this page; "Open in new tab" opens it in another tab. */
const shotCell = (url, title, info) => `<div class="dc-shot">${photoBtn(url, title, 'View ' + title, info)}</div>`;

async function logOf(ids) {
    if (!ids.length)
        return [];
    const { data, error } = await sb.from('damage_charge_log').select('*').in('damage_charge_id', ids).order('log_id');
    return error ? [] : data || [];
}

const logLine = (l, byId) => {
    const who = l.by_customer ? 'Customer' : staffName(l.by_user_id);
    const amt = l.old_amount !== null && l.new_amount !== null && num(l.old_amount) !== num(l.new_amount)
        ? ` ${money(l.old_amount)} &rarr; ${money(l.new_amount)}` : l.new_amount !== null ? ` ${money(l.new_amount)}` : '';
    const item = byId[l.damage_charge_id];
    return `<li><span class="mut">${esc(stampLabel(l.created_at))}</span> <b>${esc(l.action)}</b>${amt}${item ? ` <span class="mut">(${esc(item.equipment_name)})</span>` : ''}
      <span class="mut">by ${esc(who)}</span>${l.note ? `<br><span class="dc-note">${esc(l.note)}</span>` : ''}</li>`;
};

export async function openDamageDialog(ref) {
    const list = dmgOf(ref);
    if (!list.length)
        return toast('There is no damage fee on this rental.');
    const g = RL.find(l => l.rental_ref === ref);
    const status = dmgStatus(ref), owed = dmgOwed(ref);
    const late = lateFeeOfRef(ref), dmg = dmgTotal(ref);
    const byId = Object.fromEntries(list.map(d => [d.damage_charge_id, d]));

    md.innerHTML = '<div class="in"><p class="mut">Loading…</p></div>';
    if (!md.open)
        md.showModal();

    const [logs, ...rest] = await Promise.all([logOf(list.map(d => d.damage_charge_id)),
        ...list.map(async d => [await signedPhotoUrl(d.before_photo_path), await signedPhotoUrl(d.after_photo_path), await signedPhotoUrl(d.handover_photo_path)])]);
    const photos = rest;
    const pending = list.filter(d => d.status === 'Pending');
    const proofRef = pending.length ? pending[0].gcash_reference : '';
    const shots = proofRef ? await listGcashProofs(proofRef) : [];

    const items = list.map((d, i) => {
        const [before, after, handover] = photos[i];
        const canEdit = ['Unpaid', 'Waived'].includes(d.status);
        return `<div class="dc-item">
          <div class="row"><b>${esc(d.equipment_name)} x${d.quantity}</b>${badge(d.status === 'Paid' ? 'Paid' : d.status)}</div>
          <dl class="dl"><dt>Condition</dt><dd>${esc(d.condition)}</dd>
            <dt>Damage fee</dt><dd><b>${money(d.amount)}</b>${num(d.amount) === 0 ? ' <span class="mut">(waived)</span>' : ''}</dd>
            ${d.reason ? `<dt>Reason</dt><dd>${esc(d.reason)}</dd>` : ''}
            ${d.return_description ? `<dt>Staff notes</dt><dd>${esc(d.return_description)}</dd>` : ''}
            ${d.status === 'Paid' ? `<dt>Paid</dt><dd>${esc(d.paid_method)}${d.gcash_reference ? ' (ref ' + esc(d.gcash_reference) + ')' : ''}${d.paid_at ? ', ' + esc(stampLabel(d.paid_at)) : ''}</dd>` : ''}</dl>
          <div class="dc-photos">${photoCell(before, 'Before')}${photoCell(handover, 'Handover')}${photoCell(after, 'After')}</div>
          ${canEdit ? `<button type="button" class="btn sm line" data-dc-edit="${d.damage_charge_id}">Change or waive</button>` : ''}
        </div>`;
    }).join('');

    md.innerHTML = `<div class="in">
      <h2 style="margin:0 0 4px">Damage fee</h2>
      <p class="mut" style="margin:0">${esc(ref)}${g ? ' — ' + esc(g.customer_name) : ''}</p>
      <div class="dr-sum" style="margin-top:10px">
        <div><span>Late fee (automatic, per hour)</span><span>${money(late)}</span></div>
        <div><span>Damage fee (entered by staff)</span><span>${money(dmg)}</span></div>
        <div class="tot-line"><b>Total due (late + damage)</b><b>${money(late + dmg)}</b></div>
      </div>
      <p class="mut" style="margin:6px 0 0;font-size:13px">Damage fee status: ${status ? badge(status) : ''}${owed > 0 ? ` &nbsp;Still to receive: <b>${money(owed)}</b>` : ''}</p>
      ${items}
      ${pending.length ? `<div class="alert warn" role="note"><b>The customer sent a GCash payment</b> of ${money(owed)} (reference ${esc(proofRef)}). Check it in your GCash app before you confirm.
        ${shots.length ? '<div class="dc-shots">' + shots.map((u, i) => shotCell(u, 'GCash screenshot' + (shots.length > 1 ? ' ' + (i + 1) : ''), { ref: proofRef, amount: money(pending.reduce((a, d) => a + num(d.amount), 0)) })).join('')
            + '<p class="mut dc-shothint">Press the button to view the screenshot here, or <a href="' + esc(shots[0]) + '" target="_blank" rel="noopener">open it in a new tab</a>. Check that its reference number and amount match the ones above.</p></div>' : '<br><span class="mut">No screenshot was found.</span>'}</div>` : ''}
      <div class="alert" id="dc-err" role="alert" hidden></div>
      <div id="dc-reject" hidden><label for="dc-why">Why is the payment rejected? <span class="req" aria-hidden="true">*</span></label>
        <textarea id="dc-why" rows="2" style="width:100%;resize:vertical" placeholder="For example: the reference does not match the amount"></textarea></div>
      <div class="acts" style="margin-top:12px">
        <button type="button" class="btn line" data-dc-close>Close</button>
        ${pending.length ? '<button type="button" class="btn bad" id="dc-rej">Reject payment</button><button type="button" class="btn gold" id="dc-accept">Payment received</button>'
            : owed > 0 ? '<button type="button" class="btn gold" id="dc-collect">Collect payment</button>' : ''}
      </div>
      <details class="dc-history">
        <summary>History <span class="mut">(${logs.length})</span></summary>
        <ul class="dc-log">${logs.map(l => logLine(l, byId)).join('') || '<li class="mut">No history yet.</li>'}</ul>
      </details>
    </div>`;

    const err = t => {
        const box = $('#dc-err');
        box.textContent = t;
        box.hidden = !t;
    };
    md.querySelectorAll('[data-dc-edit]').forEach(b => b.addEventListener('click', () => openEdit(ref, byId[b.dataset.dcEdit])));
    const collect = $('#dc-collect');
    if (collect)
        collect.addEventListener('click', () => openCollectDamage(ref));

    const acc = $('#dc-accept'), rej = $('#dc-rej');
    if (acc)
        acc.addEventListener('click', async () => {
            if (!(await askConfirm({ title: 'Payment received?', message: `Mark the damage fee of ${money(owed)} for ${ref} as paid by GCash (reference ${proofRef}). Only continue if you checked that the money was received.`, ok: 'Yes, payment received' })))
                return;
            busy = true;
            btnBusy(acc, 'Saving…');
            const { error } = await sb.rpc('staff_collect_damage', { p_rental_ref: ref, p_method: 'GCash', p_reference: proofRef, p_expected: owed });
            busy = false;
            if (error) {
                btnReset(acc);
                return err(dmgError(error));
            }
            // email the customer the fully paid receipt (a failed email never undoes the payment)
            const mail = await notifyDamagePaid(ref);
            await refresh();
            toast(`Damage fee of ${money(owed)} for ${ref} marked as paid.` + mailNoteOf(mail));
            openDamageDialog(ref);
        });
    if (rej)
        rej.addEventListener('click', async () => {
            const box = $('#dc-reject');
            if (box.hidden) {
                box.hidden = false;
                $('#dc-why').focus();
                rej.textContent = 'Confirm rejection';
                return;
            }
            const why = $('#dc-why').value.trim();
            if (!why)
                return err('Say why the payment is rejected. The customer will see it.');
            busy = true;
            btnBusy(rej, 'Saving…');
            const { error } = await sb.rpc('staff_reject_damage_payment', { p_rental_ref: ref, p_reason: why });
            busy = false;
            if (error) {
                btnReset(rej);
                return err(dmgError(error));
            }
            await refresh();
            toast('Payment rejected. The damage fee is unpaid again.');
            openDamageDialog(ref);
        });
}

/* ---- change or waive one fee (a reason for the change is required and written to the history) ---- */
function openEdit(ref, d) {
    md.innerHTML = `<div class="in">
      <h2 style="margin:0 0 4px">Change or waive the damage fee</h2>
      <p class="mut" style="margin:0 0 8px">${esc(ref)} — ${esc(d.equipment_name)} x${d.quantity}. Current fee: <b>${money(d.amount)}</b>. The change is saved in the history with your name.</p>
      <label for="dce-amt">New damage fee</label>
      <div class="money-in"><span aria-hidden="true">&#8369;</span><input type="text" id="dce-amt" inputmode="decimal" autocomplete="off" value="${num(d.amount) || ''}" placeholder="0.00"></div>
      <p class="mut" style="margin:4px 0 0;font-size:13px">Enter 0 to waive the fee.</p>
      <label for="dce-reason">Reason for the damage (the customer sees it)</label>
      <textarea id="dce-reason" rows="2" style="width:100%;resize:vertical">${esc(d.reason || '')}</textarea>
      <label for="dce-note">Why are you changing it? <span class="req" aria-hidden="true">*</span></label>
      <textarea id="dce-note" rows="2" style="width:100%;resize:vertical" placeholder="For example: customer agreed to a smaller charge"></textarea>
      <div class="alert" id="dce-err" role="alert" hidden></div>
      <div class="acts" style="margin-top:12px">
        <button type="button" class="btn line" id="dce-back">Back</button>
        <button type="button" class="btn gold" id="dce-save">Save change</button>
      </div></div>`;
    const amt = $('#dce-amt'), err = t => {
        const box = $('#dce-err');
        box.textContent = t;
        box.hidden = !t;
    };
    amt.addEventListener('input', () => {
        let v = amt.value.replace(/[^\d.]/g, '');
        const dot = v.indexOf('.');
        v = dot >= 0 ? v.slice(0, dot).slice(0, 7) + '.' + v.slice(dot + 1).replace(/\./g, '').slice(0, 2) : v.slice(0, 7);
        if (v !== amt.value)
            amt.value = v;
    });
    $('#dce-back').addEventListener('click', () => openDamageDialog(ref));
    $('#dce-save').addEventListener('click', async () => {
        const next = amt.value === '' || amt.value === '.' ? NaN : Number(amt.value), reason = $('#dce-reason').value.trim(), note = $('#dce-note').value.trim();
        if (Number.isNaN(next))
            return err('Enter the new amount (0 to waive).');
        if (next > 0 && !reason)
            return err('Describe the damage: a reason is required when the fee is above 0.');
        if (!note)
            return err('Write why you are changing this fee.');
        const save = $('#dce-save');
        busy = true;
        btnBusy(save, 'Saving…');
        const { error } = await sb.rpc('staff_update_damage_charge', { p_charge_id: d.damage_charge_id, p_amount: next, p_reason: reason, p_note: note });
        busy = false;
        if (error) {
            btnReset(save);
            return err(dmgError(error));
        }
        await refresh();
        toast(next === 0 ? 'Damage fee waived.' : `Damage fee changed to ${money(next)}.`);
        openDamageDialog(ref);
    });
    amt.focus();
}

/* ---- collect an unpaid fee now (Cash or GCash) ---- */
export function openCollectDamage(ref) {
    const owed = dmgOwed(ref), g = RL.find(l => l.rental_ref === ref);
    if (owed <= 0)
        return toast('There is no unpaid damage fee on this rental.');
    const names = dmgOf(ref).filter(d => OPEN.includes(d.status) && num(d.amount) > 0).map(d => `${d.equipment_name} x${d.quantity}`).join(', ');
    md.innerHTML = `<div class="in">
      <h2 style="margin:0 0 4px">Collect the damage fee</h2>
      <p class="mut" style="margin:0">${esc(ref)}${g ? ' — ' + esc(g.customer_name) : ''}</p>
      <div class="dr-sum" style="margin-top:10px"><div><span>${esc(names)}</span><span></span></div>
        <div class="tot-line"><b>Damage fee to collect now</b><b class="bal-amt">${money(owed)}</b></div></div>
      ${collectBox()}
      <div class="alert" id="dcc-err" role="alert" hidden></div>
      <div class="acts" style="margin-top:12px">
        <button type="button" class="btn line" id="dcc-back">Not received yet</button>
        <button type="button" class="btn gold" id="dcc-ok" disabled>Damage fee received</button>
      </div></div>`;
    if (!md.open)
        md.showModal();
    const ok = $('#dcc-ok'), err = t => {
        const box = $('#dcc-err');
        box.textContent = t;
        box.hidden = !t;
    };
    const box = bindCollect(md, () => owed, () => {
        ok.disabled = !box.valid() || busy;
        err('');
    });
    ok.disabled = !box.valid();
    box.focus();
    $('#dcc-back').addEventListener('click', () => openDamageDialog(ref));
    ok.addEventListener('click', async () => {
        if (!box.valid() || busy)
            return;
        busy = true;
        btnBusy(ok, 'Saving…');
        const method = box.method(), given = method === 'Cash' ? box.tendered() : null;
        const { error } = await sb.rpc('staff_collect_damage', { p_rental_ref: ref, p_method: method, p_reference: method === 'GCash' ? box.reference() : null, p_tendered: given, p_expected: owed });
        busy = false;
        if (error) {
            btnReset(ok, false);
            ok.textContent = 'Damage fee received';
            err(dmgError(error));
            if (/changed/i.test(error.message || ''))
                refresh();
            return;
        }
        // email the customer the fully paid receipt (a failed email never undoes the payment)
        const mail = await notifyDamagePaid(ref);
        await refresh();
        const change = given === null ? 0 : (cents(given) - cents(owed)) / 100;
        toast(`Damage fee of ${money(owed)} for ${ref} collected (${method}).${change > 0 ? ' Change returned: ' + money(change) + '.' : ''}` + mailNoteOf(mail));
        openDamageDialog(ref);
    });
}

/* An unpaid fee goes straight to the collect window; a paid one, or one with a customer's GCash payment to check, opens the details. */
ACT['dmg-open'] = ref => dmgStatus(ref) === 'Unpaid' ? openCollectDamage(ref) : openDamageDialog(ref);

/* From the Rentals tab (Actions > Damage fee): go to that item's row in the Payments tab, then open the same window its
   Collect / Verify button opens (collect for an unpaid fee, verify / reject for a GCash payment waiting to be checked). */
ACT['dmg-pay'] = ref => {
    if (location.hash.slice(1) !== 'a-pay')
        location.hash = 'a-pay';
    ACT['dmg-open'](ref);
};
