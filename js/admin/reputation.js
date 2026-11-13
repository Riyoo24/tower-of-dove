/* =====================================================================
   admin/reputation.js - customer reputation flags and unpaid-damage blocks (staff and owner only)
   DB: rpc staff_customer_reputation, staff_customer_incidents, staff_review_incident, staff_damage_overrides,
       owner_waive_damage_fee, owner_defer_damage_fee, owner_lift_damage_block, owner_revoke_damage_override
       (64_damage_block_reputation.sql). Customers can never read any of this: the database refuses them.
   If migration 64 has not been run yet the flags are simply not shown.
   ===================================================================== */

import { NSC, REP, refresh } from './data.js';
import { ACT, OWNER, btn, dbtn, dlg, money, num, run, showDlg } from './helpers.js';
import { sb } from '../config/supabaseClient.js';
import { $, esc, toast } from '../shared/utils.js';

const repOf = cid => REP.find(r => r.customer_id === +cid) || null;

const FLAG_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 3v18h2v-7h11l-2-4 2-4H7V3z"/></svg>';

const when = ts => ts ? new Date(ts).toLocaleString('en-US', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
const dayOnly = ts => ts ? new Date(ts).toLocaleDateString('en-US', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric' }) : '';

/* The flag shown next to a customer's name. Hover shows the facts, click opens the details. No flag = empty string. Optional scope: see below.
   No-shows (78_no_show_release.sql) are part of the same flag: one no-show makes it yellow, two or more red (display only; it never blocks anyone). */
export function repFlag(cid, scope) {
    const r = repOf(cid), n = NSC.find(x => x.customer_id === +cid);
    const repFlagColor = r && (r.flag === 'red' || r.flag === 'yellow') ? r.flag : null;
    const nsFlagColor = n && n.no_shows ? (n.no_shows >= 2 ? 'red' : 'yellow') : null;
    /* scope 'booking' (Bookings, Studio Sessions): a flag made only of late returns / damage fees is not shown there.
       scope 'rental' (Rentals): a flag made only of no-shows is not shown there. A flag with both kinds shows in both tables. */
    if (scope === 'booking' && !nsFlagColor)
        return '';
    if (scope === 'rental' && !repFlagColor)
        return '';
    const flag = repFlagColor === 'red' || nsFlagColor === 'red' ? 'red' : (repFlagColor || nsFlagColor);
    if (!flag)
        return '';
    const parts = [];
    if (repFlagColor)
        parts.push(`${repFlagColor === 'red' ? 'Red' : 'Yellow'} flag: ${r.summary}${r.blocked ? '. Blocked from booking and renting' : ''}`);
    if (nsFlagColor)
        parts.push(`${n.no_shows} no-show${n.no_shows > 1 ? 's' : ''} in the last 12 months`);
    const text = parts.join('. ');
    return ` <button type="button" class="rep-flag ${flag}" data-act="rep-open" data-id="${cid}" title="${esc(text)}" aria-label="${esc(text)}">${FLAG_ICON}</button>`;
}

const flagChip = r => !r || r.flag === 'none' ? '<span class="b approved">No flag</span>'
    : `<span class="b ${r.flag === 'red' ? 'rejected' : 'pending'}">${r.flag === 'red' ? 'Red flag' : 'Yellow flag'}</span>`;

/* Unpaid-fee banner at the top of the window: says plainly whether the customer is blocked and why, with the owner's actions beside each fee. */
const blockPanel = (r, cid) => {
    if (!r || (!r.blocked && !r.lifted && !(r.block_fees || []).length))
        return '';
    const fees = r.block_fees || [];
    const rows = fees.map(f => {
        const deferred = f.deferred_until ? `<span class="mut">Deferred until ${esc(dayOnly(f.deferred_until))}</span>` : '';
        const owner = OWNER ? btn('blk-waive', `${f.ref}|${cid}`, 'Waive', 1) + (f.deferred_until || num(f.pending) > 0 ? '' : btn('blk-defer', `${f.ref}|${cid}`, 'Defer', 1)) : '';
        return `<li class="rep-fee"><span class="rep-ref">${esc(f.ref)}</span><b>${money(num(f.unpaid) + num(f.pending))}</b>
          <span class="mut">${num(f.pending) > 0 ? 'GCash sent, waiting for a check' : 'Unpaid'}</span>${deferred}<span class="rep-fee-acts">${owner}</span></li>`;
    }).join('');
    const tone = r.lifted ? 'ok' : r.blocked ? 'bad' : 'warn';
    const head = r.lifted ? `Block lifted ${r.lift_until ? 'until ' + esc(dayOnly(r.lift_until)) : 'until the owner cancels it'}`
        : r.blocked ? 'Blocked from booking and renting'
            : 'Fee deferred';
    const body = r.lifted ? 'The fees are still owed. The customer can book and rent for now.'
        : r.blocked ? `This customer, and anyone using the same phone number, cannot make a new booking or rental until ${money(r.block_amount)} is paid.`
            : 'The fee is still owed but is not blocking for now.';
    const lift = OWNER && r.blocked && !r.lifted ? `<div class="rep-block-acts">${btn('blk-lift', cid, 'Lift the block', 1)}</div>` : '';
    return `<section class="rep-block ${tone}" aria-label="Unpaid fees">
      <h3>${head}</h3><p>${body}</p>
      ${rows ? `<ul class="rep-fees">${rows}</ul>` : ''}
      ${lift}${OWNER ? '' : '<p class="mut">Only the owner can waive or defer a fee, or lift the block.</p>'}</section>`;
};

/* ---- the details window (opened from a flag) ---- */
const KIND = {
    late: { label: 'Late return', cls: 'pending', many: 'Late returns' },
    damage: { label: 'Damage fee', cls: 'rejected', many: 'Damage fees' },
    noshow: { label: 'No-show', cls: 'out', many: 'No-shows' }
};

const noteBlock = (note, by, at) => note
    ? `<div class="rep-note"><p>${esc(note)}</p><span class="mut">Staff note by ${esc(by || 'staff')}${at ? ', ' + esc(dayOnly(at)) : ''}</span></div>` : '';

/* one incident = one card: what it is, when, what happened in full, the staff note, and the actions underneath */
const incidentCard = x => {
    const k = KIND[x.kind] || KIND.late;
    const status = x.dismissed ? '<span class="b cancelled">Dismissed</span>' : (x.counts ? '' : '<span class="b">Not counted</span>');
    return `<article class="rep-item${x.dismissed || !x.counts ? ' dim' : ''}" data-kind="${x.kind}">
      <div class="rep-top"><span class="b ${k.cls}">${k.label}</span><span class="rep-ref">${esc(x.ref || '')}</span>${status}<time class="rep-date">${esc(dayOnly(x.at))}</time></div>
      <p class="rep-what">${x.what}</p>
      ${noteBlock(x.note, x.by, x.noteAt)}
      ${x.acts ? `<div class="rep-acts">${x.acts}</div>` : ''}</article>`;
};

ACT['rep-open'] = async id => {
    const cid = +id;
    const [inc, ovr, nsr] = await Promise.all([
        sb.rpc('staff_customer_incidents', { p_customer_id: cid }),
        sb.rpc('staff_damage_overrides', { p_customer_id: cid }),
        sb.rpc('staff_no_show_list', { p_customer_id: cid })   // 82_no_show_in_flag.sql; without it the section is just empty
    ]);
    if (inc.error)
        return toast(inc.error.message);
    const r = repOf(cid), list = inc.data || [], log = ovr.error ? [] : (ovr.data || []);
    const nsList = nsr.error ? [] : (nsr.data || []);
    const name = list.length ? list[0].customer_name : (nsList.length ? nsList[0].customer_name : 'Customer');
    const hasFlag = r && (r.flag === 'red' || r.flag === 'yellow');

    /* every incident, newest first, in one list */
    const items = [
        ...list.map(i => ({
            kind: i.incident_kind === 'late' ? 'late' : 'damage', ref: i.rental_ref, at: i.occurred_at,
            what: esc(i.detail || 'No details recorded') + (i.amount != null && i.incident_kind === 'damage' ? ` <span class="rep-amt">${money(i.amount)} &middot; ${esc(i.status)}</span>` : ''),
            dismissed: !!i.dismissed, counts: !!i.counts, note: i.note, by: i.reviewed_by, noteAt: i.reviewed_at,
            acts: btn('rep-note', `${i.incident_kind}|${i.ref_id}|${cid}`, i.note ? 'Edit note' : 'Add note', 1)
                + (i.dismissed ? btn('rep-restore', `${i.incident_kind}|${i.ref_id}|${cid}`, 'Count again', 1)
                    : (i.counts && !(i.incident_kind === 'damage' && ['Unpaid', 'Pending'].includes(i.status)) ? btn('rep-note', `${i.incident_kind}|${i.ref_id}|${cid}|d`, 'Dismiss', 1) : ''))
        })),
        ...nsList.map(x => ({
            kind: 'noshow', ref: x.booking_ref, at: x.occurred_at,
            what: esc(x.what ?? x.note ?? 'Released as a no-show') + (x.by_name ? ` <span class="mut">(${esc(x.by_name)})</span>` : ''),   // x.note: the older version of 82
            dismissed: !!x.dismissed, counts: !x.dismissed, note: x.review_note, by: x.reviewed_by, noteAt: x.reviewed_at,
            acts: x.event_id == null ? '' : btn('rep-note', `noshow|${x.event_id}|${cid}`, x.review_note ? 'Edit note' : 'Add note', 1)   // no event_id = the old 82 is still in the database: run the new 82
                + (x.dismissed ? btn('rep-restore', `noshow|${x.event_id}|${cid}`, 'Count again', 1) : btn('rep-note', `noshow|${x.event_id}|${cid}|d`, 'Dismiss', 1))
        }))
    ].sort((a, b) => new Date(b.at) - new Date(a.at));

    const counting = k => items.filter(x => x.kind === k && x.counts && !x.dismissed).length;
    const nLate = counting('late'), nDmg = counting('damage'), nNs = counting('noshow');
    const level = (hasFlag && r.flag === 'red') || nNs >= 2 ? 'red' : (hasFlag || nNs ? 'yellow' : 'none');
    const chip = level === 'red' ? '<span class="b rejected">Red flag</span>' : level === 'yellow' ? '<span class="b pending">Yellow flag</span>' : '<span class="b approved">No flag</span>';
    const stat = (k, n) => `<button type="button" class="rep-stat${n ? ' has ' + k : ''}" data-repf="${k}" aria-pressed="false"><b>${n}</b><span>${KIND[k].many}</span></button>`;

    const logRows = log.map(o => `<li class="rep-item">
      <div class="rep-top"><span class="b ${o.kind === 'waive' ? 'rejected' : o.kind === 'defer' ? 'pending' : 'approved'}">${esc({ waive: 'Waived', defer: 'Deferred', lift: 'Block lifted' }[o.kind] || o.kind)}</span>
        <span class="rep-ref">${esc(o.rental_ref || '')}</span>${o.amount != null ? `<b>${money(o.amount)}</b>` : ''}
        <time class="rep-date">${esc(dayOnly(o.created_at))}</time></div>
      <p class="rep-what">${esc(o.reason)}</p>
      <p class="mut">${esc(o.by_name || 'Owner')}, ${esc(when(o.created_at))}${o.until_at ? ` &middot; until ${esc(dayOnly(o.until_at))}` : (o.kind === 'lift' ? ' &middot; until cancelled' : '')}</p>
      ${o.revoked_at ? `<p class="mut">Cancelled by ${esc(o.revoked_by_name || '')}, ${esc(when(o.revoked_at))}: ${esc(o.revoke_reason || '')}</p>`
        : (OWNER && o.active ? `<div class="rep-acts">${btn('blk-revoke', `${o.override_id}|${cid}`, 'Cancel override', 1)}</div>` : '')}</li>`).join('');

    dlg.classList.add('rep');
    showDlg(`<header class="rep-head">
      <div class="rep-title"><h2>${esc(name)}</h2>${chip}</div>
      <button type="button" class="rep-x" data-close aria-label="Close">&times;</button>
      ${hasFlag && r.summary ? `<p class="rep-why">Why flagged: ${esc(r.summary)}</p>` : ''}
    </header>
    <div class="rep-body" tabindex="-1" autofocus>
      ${blockPanel(r, cid)}
      <div class="rep-stats" role="group" aria-label="Filter incidents">${stat('late', nLate)}${stat('damage', nDmg)}${stat('noshow', nNs)}</div>
      <p class="mut rep-hint">Last 12 months, shared phone numbers counted together. Unpaid damage fees always count. Customers cannot see this. Tap a count to filter the list.</p>
      <div class="rep-list">${items.length ? items.map(incidentCard).join('') : '<p class="rep-empty">No late returns, damage fees or no-shows in the last 12 months.</p>'}
        <p class="rep-empty" id="rep-none" hidden>Nothing of this type.</p></div>
      ${logRows ? `<details class="rep-log"><summary>Owner overrides (${log.length})</summary><ul>${logRows}</ul></details>` : ''}
    </div>
    <footer class="rep-foot"><button class="btn line" data-close>Close</button></footer>`);
};

/* tap a count to show only that kind of incident; tap it again to show all */
dlg.addEventListener('click', e => {
    const f = e.target.closest('[data-repf]');
    if (!f)
        return;
    const k = f.getAttribute('aria-pressed') === 'true' ? 'all' : f.dataset.repf;
    dlg.querySelectorAll('[data-repf]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.repf === k)));
    let shown = 0;
    dlg.querySelectorAll('.rep-item[data-kind]').forEach(it => {
        it.hidden = k !== 'all' && it.dataset.kind !== k;
        if (!it.hidden)
            shown++;
    });
    const none = dlg.querySelector('#rep-none');
    if (none)
        none.hidden = shown > 0;
});
dlg.addEventListener('close', () => dlg.classList.remove('rep'));

/* ---- small form window with a required text box (and an optional date) ---- */
function form({ title, intro, cid, field, date, go, goId, goText, danger }) {
    dlg.classList.remove('rep');
    showDlg(`<h2 style="margin:0 0 8px">${esc(title)}</h2>
    ${intro ? `<p class="mut">${esc(intro)}</p>` : ''}
    ${date ? `<div class="fld" style="margin-top:10px"><label for="rp-date">${esc(date.label)}</label><input type="date" id="rp-date" min="${date.min}" max="${date.max}" ${date.value ? `value="${date.value}"` : ''}>${date.hint ? `<p class="mut" style="margin:4px 0 0">${esc(date.hint)}</p>` : ''}</div>` : ''}
    <div class="fld" style="margin-top:10px"><label for="rp-text">${esc(field.label)}</label>
      <textarea id="rp-text" rows="3" style="width:100%;resize:vertical" placeholder="${esc(field.placeholder || '')}">${esc(field.value || '')}</textarea></div>
    ${field.dismiss ? `<label class="chk" style="display:flex;gap:8px;align-items:center;margin-top:10px"><input type="checkbox" id="rp-dis" ${field.dismissOn ? 'checked' : ''}> Dismiss this incident (it stops counting toward the flag)</label>` : ''}
    <div class="acts"><button class="btn line" data-back="${cid}">Back</button>${(danger ? dbtn : btn)(go, goId, goText)}</div>`);
}
dlg.addEventListener('click', e => {
    const b = e.target.closest('[data-back]');
    if (b)
        ACT['rep-open'](b.dataset.back);
});

const text = () => ($('#rp-text').value || '').trim();
const dayEnd = v => v ? new Date(v + 'T23:59:59+08:00').toISOString() : null;   // end of that day, Manila time
const ymd = (plusDays) => new Date(Date.now() + 8 * 36e5 + plusDays * 864e5).toISOString().slice(0, 10);

async function done(msg, cid) {
    await refresh();
    toast(msg);
    return ACT['rep-open'](cid);
}

/* ---- staff: note / dismiss ---- */
ACT['rep-note'] = id => {
    const [kind, ref, cid, d] = id.split('|');
    form({
        title: d ? 'Dismiss this incident' : 'Note on this incident', cid,
        intro: d ? 'A dismissed incident stops counting toward the flag. Say why, for example the lateness was the studio\'s fault. Your name and the time are saved.'
            : 'The note is for staff only. Your name and the time are saved.',
        field: { label: d ? 'Why is it dismissed? (required)' : 'Note', placeholder: d ? 'For example: we were closed at pick-up time' : 'For example: customer called ahead and we agreed to a later return', dismiss: false },
        go: 'rep-note-go', goId: `${kind}|${ref}|${cid}|${d ? 'd' : ''}`, goText: d ? 'Dismiss incident' : 'Save note', danger: !!d
    });
};
ACT['rep-note-go'] = async id => {
    const [kind, ref, cid, d] = id.split('|');
    const note = text();
    if (!note)
        return toast(d ? 'Write a note saying why you are dismissing this incident.' : 'Write a note first.');
    if (!await run(sb.rpc('staff_review_incident', { p_kind: kind, p_ref_id: +ref, p_note: note, p_dismiss: d ? true : null })))
        return;
    return done(d ? 'Incident dismissed.' : 'Note saved.', cid);
};
ACT['rep-restore'] = async id => {
    const [kind, ref, cid] = id.split('|');
    if (!await run(sb.rpc('staff_review_incident', { p_kind: kind, p_ref_id: +ref, p_note: null, p_dismiss: false })))
        return;
    return done('The incident counts again.', cid);
};

/* ---- owner: waive / defer / lift / cancel (a reason is always required and every action is logged) ---- */
ACT['blk-waive'] = id => {
    const [ref, cid] = id.split('|');
    form({ title: `Waive the unpaid fees on ${ref}?`, cid, intro: 'The fee is set to 0 and the customer is no longer blocked by it. This cannot be undone.',
        field: { label: 'Reason (required)', placeholder: 'For example: the item was already damaged at hand-over' }, go: 'blk-waive-go', goId: `${ref}|${cid}`, goText: 'Waive fee', danger: true });
};
ACT['blk-waive-go'] = async id => {
    const [ref, cid] = id.split('|');
    if (!text())
        return toast('Write the reason for waiving this damage fee.');
    if (!await run(sb.rpc('owner_waive_damage_fee', { p_rental_ref: ref, p_reason: text() })))
        return;
    return done(`The unpaid fees on ${ref} were waived.`, cid);
};

ACT['blk-defer'] = id => {
    const [ref, cid] = id.split('|');
    form({ title: `Defer the damage fee on ${ref}`, cid, intro: 'The fee stays owed and the customer stays flagged, but can book and rent until the date you choose. After that the block comes back.',
        date: { label: 'Block starts again on (last free day)', min: ymd(1), max: ymd(365), value: ymd(14) },
        field: { label: 'Reason (required)', placeholder: 'For example: customer will pay on payday' }, go: 'blk-defer-go', goId: `${ref}|${cid}`, goText: 'Defer fee' });
};
ACT['blk-defer-go'] = async id => {
    const [ref, cid] = id.split('|');
    if (!$('#rp-date').value)
        return toast('Choose a date.');
    if (!text())
        return toast('Write the reason for deferring this damage fee.');
    if (!await run(sb.rpc('owner_defer_damage_fee', { p_rental_ref: ref, p_until: dayEnd($('#rp-date').value), p_reason: text() })))
        return;
    return done(`The damage fee on ${ref} is deferred.`, cid);
};

ACT['blk-lift'] = cid => {
    form({ title: 'Lift the block for this customer', cid, intro: 'They can book and rent again. The fees stay owed and the red flag stays. Leave the date empty to lift it until you cancel it.',
        date: { label: 'Lift until (optional)', min: ymd(1), max: ymd(365), value: '', hint: 'Empty = until you cancel it.' },
        field: { label: 'Reason (required)', placeholder: 'For example: regular customer, agreed to pay on the 15th' }, go: 'blk-lift-go', goId: cid, goText: 'Lift block' });
};
ACT['blk-lift-go'] = async cid => {
    if (!text())
        return toast('Write the reason for lifting the block.');
    if (!await run(sb.rpc('owner_lift_damage_block', { p_customer_id: +cid, p_until: dayEnd($('#rp-date').value), p_reason: text() })))
        return;
    return done('The block was lifted.', cid);
};

ACT['blk-revoke'] = id => {
    const [oid, cid] = id.split('|');
    form({ title: 'Cancel this override?', cid, intro: 'The block (or the fee) applies again straight away.',
        field: { label: 'Reason (required)', placeholder: 'For example: customer did not keep the agreement' }, go: 'blk-revoke-go', goId: `${oid}|${cid}`, goText: 'Cancel override', danger: true });
};
ACT['blk-revoke-go'] = async id => {
    const [oid, cid] = id.split('|');
    if (!text())
        return toast('Write the reason for cancelling this override.');
    if (!await run(sb.rpc('owner_revoke_damage_override', { p_override_id: +oid, p_reason: text() })))
        return;
    return done('The override was cancelled.', cid);
};
