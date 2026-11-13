/* =====================================================================
   admin/swapOffer.js - "Let customer choose" a replacement item
   Next to "Swap item" (rentals.js, staff pick the replacement alone), staff can offer the customer 1 to 5 equivalent
   items and a deadline. The customer picks one in My rental (customer/swapChoice.js). While the offer is open the
   offered items are held for the rental's hours. At the deadline the database swaps in the first choice (if staff
   allowed it) or flags the rental for follow-up. Needs supabase/71_customer_swap_choice.sql.
   DB: rpc staff_swap_options, staff_create_swap_offer, staff_cancel_swap_offer; table rental_swap_offer (+ _option).
   ===================================================================== */

import { closeOverlays } from './bookings.js';
import { BK, OFR, PAY, RL, SHORT, SWP, refresh } from './data.js';
import { ACT, askConfirm, notifyReplacement, stampLabel } from './helpers.js';
import { sb } from '../config/supabaseClient.js';
import { btnBusy, btnReset, btnSuccess } from '../shared/btnState.js';
import { esc, toast } from '../shared/utils.js';

const dbMsg = 'Letting the customer choose needs the database update. Run supabase/71_customer_swap_choice.sql in the Supabase SQL Editor, then reload this page.';
const isMissingFn = e => e && (e.code === 'PGRST202' || /schema cache|could not find/i.test(e.message || ''));

/* ---------------- what the rest of the dashboard asks ---------------- */

/* the offer still waiting for the customer for this rental line (or null) */
export const openOfferFor = detailId => OFR.find(o => String(o.rental_detail_id) === String(detailId) && o.status === 'Open') || null;

/* the customer already picked a replacement for this rental line, so offering a choice again makes no sense */
export const customerChose = detailId => OFR.some(o => String(o.rental_detail_id) === String(detailId) && o.status === 'Swapped' && o.resolved_by === 'customer');

/* ---- shared by the Let customer choose and Swap item windows: pictures and category groups ---- */

/* equipment pictures (public URLs), read straight from the table because the options list carries none */
export async function equipmentImages(ids) {
    const imgs = {};
    try {
        const r = await sb.from('equipment').select('equipment_id, image').in('equipment_id', ids);
        (r.data || []).forEach(x => { imgs[x.equipment_id] = x.image; });
    } catch (e) { console.error(e); }
    return imgs;
}

const PH = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="11" r="2"/><path d="m21 16-5-5-8 8"/></svg>';
export const picHtml = (o, imgs) => imgs[o.equipment_id]
    ? `<span class="so-pic has"><img src="${esc(imgs[o.equipment_id])}" alt="${esc(o.name)}" loading="lazy" decoding="async"></span>`
    : `<span class="so-pic" role="img" aria-label="No image yet">${PH}</span>`;

/* one group per category: the category of the item being replaced first, then the others A to Z.
   Returns [{ name, same, list }] */
export function groupByCategory(options) {
    const groups = new Map();
    options.forEach(o => {
        const c = o.category_name || 'Other';
        if (!groups.has(c))
            groups.set(c, { name: c, same: false, list: [] });
        const gr = groups.get(c);
        gr.same = gr.same || !!o.same_category;
        gr.list.push(o);
    });
    return [...groups.values()].sort((a, b) => (b.same - a.same) || a.name.localeCompare(b.name));
}
export const groupHeading = gr => `<div class="so-grp mut">${esc(gr.name)}${gr.same ? ' <b class="so-same">same kind as the item</b>' : ''} <span>(${gr.list.length})</span></div>`;

/* A replacement is still unsettled for this rental: an offer waits for the customer's answer, or the customer declined /
   did not answer and staff have not swapped the item yet. The equipment must not be handed over until this is sorted out. */
export const replacementPending = ref => RL.some(l => l.rental_ref === ref && !l.line_returned_at
    && (!!openOfferFor(l.rental_detail_id) || !!followUpOffer(l.rental_detail_id)));

/* A Pending rental that cannot be given as booked any more: the item went out of stock (damaged, out of service,
   removed) after the customer booked and paid, so there is not enough left for its hours. Gone once the line is swapped. */
export const outOfStockPending = ref => SHORT.some(r => r.rental_ref === ref && r.order_status === 'Pending');

/* The payment of a rental (for an add-on that rides on its booking: the booking's payment) is still waiting for staff
   to check it. Staff verify the payment BEFORE they swap an out-of-stock item, so a fake booking never costs them a swap. */
export function paymentUnchecked(ref) {
    const l = RL.find(x => x.rental_ref === ref);
    if (!l)
        return false;
    const own = PAY.find(p => p.reference === ref);
    if (own && own.status === 'Pending')
        return true;
    const bp = l.rental_type === 'Add-on' && l.booking_ref ? PAY.find(p => p.reference === l.booking_ref && p.kind === 'Booking') : null;
    return !!(bp && bp.status === 'Pending');
}

/* Any rental (Pending or Approved) that the shortage check lists: its item cannot be given as booked */
export const shortOf = ref => SHORT.some(r => r.rental_ref === ref);

/* every open offer of a rental order */
export const openOffersOfRental = ref => OFR.filter(o => o.rental_ref === ref && o.status === 'Open');

/* The newest offer for a line that ended without a swap and still needs staff: the customer did not answer in time
   (and nothing could be assigned automatically), or said none of the items suit them. Gone as soon as staff swap the line. */
export function followUpOffer(detailId) {
    const last = OFR.filter(o => String(o.rental_detail_id) === String(detailId))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    if (!last || !['Expired', 'Declined'].includes(last.status))
        return null;
    const at = new Date(last.resolved_at || last.created_at).getTime();
    return SWP.some(s => String(s.rental_detail_id) === String(detailId) && new Date(s.created_at).getTime() >= at) ? null : last;
}

const optionNames = o => (o.rental_swap_offer_option || []).slice().sort((a, b) => a.sort_order - b.sort_order).map(x => x.name);
export const offerOptionNames = optionNames;

/* One line of a shortage list or a Details window: what is going on with this rental line, and the buttons for it.
   d = rental_detail_id, ref = rental reference, orderStatus = Pending | Approved | ... */
export function swapActions(ref, d, orderStatus) {
    if (!d || !['Pending', 'Approved'].includes(orderStatus))
        return '';
    if (orderStatus === 'Pending' && paymentUnchecked(ref))
        return ' <span class="mut">(verify the payment first, then swap)</span>';   // not before: it may be a fake booking
    const id = `${esc(ref)}:${d}`, open = openOfferFor(d), fu = open ? null : followUpOffer(d);
    const swapBtn = `<button type="button" class="btn sm line" data-act="rn-swap" data-id="${id}">Swap item</button>`;
    const chose = !open && customerChose(d);
    if (chose)
        return `<br><span class="b confirmed">Customer chose a replacement</span> ${swapBtn}`;
    if (open)
        return `<br><span class="b pending">Awaiting customer choice</span> <span class="mut">until ${esc(stampLabel(open.deadline_at))}: ${esc(optionNames(open).join(', '))}</span> `
            + `<button type="button" class="btn sm line" data-act="rn-offer-cancel" data-id="${open.offer_id}">Cancel offer</button> ${swapBtn}`;
    const why = !fu ? '' : fu.status === 'Declined'
        ? `<span class="b overdue">Customer said none of the items suit them: follow up</span>${fu.note ? ` <span class="mut">"${esc(fu.note)}"</span>` : ''} `
        : '<span class="b overdue">Customer did not answer: follow up</span> ';
    if (fu)
        return `<br>${why}<button type="button" class="btn sm line" data-act="rn-offer" data-id="${id}">Let customer choose</button> ${swapBtn}`;   // the customer declined or did not answer: staff offer other items or swap the item themselves
    return ` <button type="button" class="btn sm line" data-act="rn-offer" data-id="${id}">Let customer choose</button> ${swapBtn}`;
}

/* ---------------- the "Let customer choose" window ---------------- */

/* when the rental's hours begin: outside rental = pick-up, add-on = the booking's session start */
function startOf(lines) {
    const l = lines[0];
    if (l.rental_type === 'Add-on') {
        const b = BK.find(x => x.booking_ref === l.booking_ref);
        return b ? new Date(b.start_at).getTime() : null;
    }
    return l.pickup_date ? new Date(l.pickup_date).getTime() : null;
}

const HOURS = [1, 2, 3, 6, 12, 24, 48];
const MARGIN = 30 * 60e3;   // the customer's answer must be in at least 30 minutes before the rental starts
const hrsLabel = h => h === 1 ? '1 hour' : h < 24 ? h + ' hours' : h / 24 === 1 ? '1 day' : h / 24 + ' days';

function openOfferModal(ref, detailId) {
    const lines = RL.filter(l => l.rental_ref === ref && !l.line_returned_at && !customerChose(l.rental_detail_id));
    const g = lines[0];
    if (!g || !['Pending', 'Approved'].includes(g.status))
        return toast('Only a rental that has not been issued yet can be offered a replacement.');
    const first = lines.find(l => l.rental_detail_id === detailId) || lines[0];
    const startMs = startOf(lines);

    const md = document.createElement('dialog');
    md.className = 'dlg balance';
    md.setAttribute('role', 'dialog');
    md.setAttribute('aria-label', 'Let customer choose');
    md.innerHTML = `<div class="in">
      <h2 style="margin:0 0 4px">Let the customer choose</h2>
      <p class="mut" style="margin:0 0 10px">${esc(ref)} — ${esc(g.customer_name)}${startMs ? ` · starts ${esc(stampLabel(startMs))}` : ''}</p>
      <p class="mut" style="margin:0 0 10px;font-size:13px">Pick 1 to 5 equivalent items. The customer chooses one in <b>My rental</b>; the item is swapped at once and <b>nothing extra is charged and nothing is refunded</b>. The items you offer are held for this rental's hours until the customer answers.</p>
      <label for="so-line">Item to replace</label>
      <select id="so-line">${lines.map(l => `<option value="${l.rental_detail_id}" ${l === first ? 'selected' : ''}>${esc(l.equipment_name)} x${l.quantity}</option>`).join('')}</select>
      <div class="so-curcat" id="so-curcat" hidden></div>
      <label>Items the customer can choose from <span class="req" aria-hidden="true">*</span></label>
      <div id="so-opts" class="so-opts" role="group" aria-label="Items to offer"><p class="mut">Loading…</p></div>
      <p class="mut" id="so-rank" style="margin:4px 0 0;font-size:13px"></p>
      <label for="so-hours">The customer has to answer within</label>
      <select id="so-hours"></select>
      <label class="so-auto"><input type="checkbox" id="so-auto" checked> <span>If they do not answer in time, swap to my <b>first choice</b> automatically. (Untick it to follow up with the customer yourself.)</span></label>
      <div class="alert" id="so-err" role="alert" hidden></div>
      <div class="acts" style="margin-top:14px">
        <button type="button" class="btn line" id="so-cancel">Cancel</button>
        <button type="button" class="btn gold" id="so-ok" disabled>Send to customer</button>
      </div>
    </div>`;
    document.body.appendChild(md);

    const lineSel = md.querySelector('#so-line'), optBox = md.querySelector('#so-opts'), rank = md.querySelector('#so-rank');
    const hoursSel = md.querySelector('#so-hours'), autoBox = md.querySelector('#so-auto');
    const errBox = md.querySelector('#so-err'), okBtn = md.querySelector('#so-ok');
    const showErr = m => {
        errBox.textContent = m;
        errBox.hidden = !m;
    };
    const lineNow = () => lines.find(l => String(l.rental_detail_id) === lineSel.value);
    // category of each line's item (the rental lines carry no category, so read it from the stock view)
    const cats = {};
    const curCat = md.querySelector('#so-curcat');
    const showCat = () => {
        const l = lineNow(), c = l && cats[l.equipment_id];
        curCat.hidden = !c;
        curCat.innerHTML = c ? `<span class="so-cat">${esc(c)}</span>` : '';
    };
    lineSel.addEventListener('change', showCat);
    (async () => {
        try {
            const r = await sb.from('v_equipment_stock').select('equipment_id, category_name').in('equipment_id', [...new Set(lines.map(l => l.equipment_id))]);
            (r.data || []).forEach(x => { cats[x.equipment_id] = x.category_name; });
            [...lineSel.options].forEach(op => {
                const l = lines.find(x => String(x.rental_detail_id) === op.value), c = l && cats[l.equipment_id];
                if (c)
                    op.textContent += ' \u2014 ' + c;
            });
            showCat();
        } catch (e) { console.error(e); }
    })();
    let options = [], picked = [], seq = 0;   // picked = equipment ids in the order staff ticked them

    // deadlines that still leave the customer time before the rental starts
    const allowed = () => HOURS.filter(h => !startMs || Date.now() + h * 36e5 <= startMs - MARGIN);
    function loadHours() {
        const ok = allowed();
        if (!ok.length) {
            hoursSel.innerHTML = '<option value="">Too close to the start time</option>';
            hoursSel.disabled = true;
            return;
        }
        const def = ok.includes(6) ? 6 : ok[ok.length - 1];
        hoursSel.innerHTML = ok.map(h => `<option value="${h}" ${h === def ? 'selected' : ''}>${hrsLabel(h)}</option>`).join('');
        hoursSel.disabled = false;
    }

    const ord = n => n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th');
    function syncPicks() {
        optBox.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            const i = picked.indexOf(+cb.value);
            cb.checked = i >= 0;
            cb.disabled = i < 0 && picked.length >= 5;
            cb.closest('label').querySelector('.so-n').textContent = i >= 0 ? ord(i + 1) + ' choice' : '';
        });
        rank.textContent = picked.length
            ? 'In the order you ticked them: ' + picked.map(id => (options.find(o => o.equipment_id === id) || {}).name).join(', ') + '.'
            : '';
        okBtn.disabled = !picked.length || hoursSel.disabled;
    }

    async function loadOptions() {
        const mine = ++seq;
        picked = [];
        okBtn.disabled = true;
        optBox.innerHTML = '<p class="mut">Loading…</p>';
        rank.textContent = '';
        showErr('');
        const { data, error } = await sb.rpc('staff_swap_options', { p_rental_detail_id: +lineSel.value });
        if (mine !== seq)
            return;
        if (error) {
            console.error(error);
            optBox.innerHTML = '<p class="mut">Could not load.</p>';
            return showErr(isMissingFn(error) ? dbMsg : error.message);
        }
        options = data || [];
        if (!options.length) {
            optBox.innerHTML = '<p class="mut">No other item is free for these hours. Try moving the rental to another date, or put a unit back in service in Equipment.</p>';
            return;
        }
        // the options list has no picture, so read the equipment images straight from the table (public URLs)
        const imgs = await equipmentImages(options.map(o => o.equipment_id));
        if (mine !== seq)
            return;
        const thumb = o => picHtml(o, imgs);
        const row = o => `<label class="so-opt"><input type="checkbox" value="${o.equipment_id}"> ${thumb(o)}<span class="so-name">${esc(o.name)} <span class="mut">(${o.free} free)</span>${o.category_name ? `<span class="so-cat">${esc(o.category_name)}</span>` : ''}</span> <b class="so-n"></b></label>`;
        optBox.innerHTML = groupByCategory(options).map(gr => groupHeading(gr) + gr.list.map(row).join('')).join('');
        syncPicks();
    }

    optBox.addEventListener('change', e => {
        const cb = e.target.closest('input[type="checkbox"]');
        if (!cb)
            return;
        const id = +cb.value;
        picked = cb.checked ? [...picked.filter(x => x !== id), id].slice(0, 5) : picked.filter(x => x !== id);
        syncPicks();
    });
    lineSel.addEventListener('change', loadOptions);
    loadHours();
    if (hoursSel.disabled)
        showErr('This rental starts too soon for the customer to choose. Use Swap item instead.');
    loadOptions();

    const close = () => {
        md.close();
        md.remove();
    };
    md.querySelector('#so-cancel').addEventListener('click', close);
    md.addEventListener('click', e => {
        if (e.target === md)
            close();
    });

    okBtn.addEventListener('click', async () => {
        showErr('');
        const l = lineNow();
        if (!l || !picked.length)
            return showErr('Tick at least one item to offer.');
        const hrs = +hoursSel.value;
        if (!hrs)
            return showErr('This rental starts too soon for the customer to choose. Use Swap item instead.');
        const deadline = new Date(Date.now() + hrs * 36e5);
        const names = picked.map(id => (options.find(o => o.equipment_id === id) || {}).name);
        const auto = autoBox.checked;
        const yes = await askConfirm({
            title: 'Send these choices to the customer?',
            message: `${g.customer_name} can choose ${names.join(', ')} to replace ${l.quantity} x ${l.equipment_name} (no extra charge). They have until ${stampLabel(deadline)}. `
                + (auto ? `If they do not answer, ${names[0]} is swapped in automatically.` : 'If they do not answer, you will need to follow up.'),
            ok: 'Yes, send choices'
        });
        if (!yes)
            return;
        btnBusy(okBtn, 'Sending…');
        const { data: offerId, error } = await sb.rpc('staff_create_swap_offer', {
            p_rental_detail_id: l.rental_detail_id,
            p_equipment_ids: picked,
            p_deadline_at: deadline.toISOString(),
            p_auto_assign: auto
        });
        if (error) {
            console.error(error);
            showErr(isMissingFn(error) ? dbMsg : error.message);
            btnReset(okBtn);
            return;
        }
        await btnSuccess(okBtn, 'Sent', { keep: true });
        await refresh();
        close();
        closeOverlays();
        document.dispatchEvent(new Event('tod:swapped'));   // the return window's shortage list is worked out again
        const mail = offerId ? await notifyReplacement('offer', offerId) : 'failed';   // the customer is emailed the choices, prices, deadline and default item
        toast(`${ref}: choices sent to ${g.customer_name}. Waiting for their answer.`
            + (mail === 'sent' ? ' Email sent.' : mail === 'noemail' ? ' No email on file, so no email was sent.' : ' The email could not be sent.'));
    });

    md.showModal();
}

// id = "REF" (from the Actions menu) or "REF:rental_detail_id" (from a shortage list)
ACT['rn-offer'] = id => {
    const [ref, did] = String(id).split(':');
    openOfferModal(ref, did ? +did : null);
};

ACT['rn-offer-cancel'] = async id => {
    const o = OFR.find(x => String(x.offer_id) === String(id));
    if (!o)
        return toast('That offer could not be found.');
    const yes = await askConfirm({
        title: 'Cancel this offer?',
        message: `${o.rental_ref}: the customer will no longer be able to choose a replacement for ${o.old_name}, and the held items are released. You can swap the item yourself or make a new offer.`,
        ok: 'Yes, cancel offer',
        cancel: 'Keep offer',
        danger: true
    });
    if (!yes)
        return;
    const { error } = await sb.rpc('staff_cancel_swap_offer', { p_offer_id: +id, p_note: null });
    if (error) {
        console.error(error);
        return toast(isMissingFn(error) ? dbMsg : error.message);
    }
    await refresh();
    closeOverlays();
    document.dispatchEvent(new Event('tod:swapped'));
    toast(`${o.rental_ref}: offer cancelled.`);
};

/* a short line for pop-ups: "Marvin Manzo chose Peavey Bandit 112 for OUT-5C44E70F" */
export const offerAnswerText = o => {
    const r = RL.find(l => l.rental_ref === o.rental_ref) || {};
    const who = r.customer_name || o.rental_ref;
    if (o.status === 'Swapped')
        return o.resolved_by === 'customer'
            ? `${who} chose ${o.chosen_name} for ${o.rental_ref}`
            : `${o.rental_ref}: no answer, so ${o.chosen_name} was assigned to ${who}`;
    if (o.status === 'Declined')
        return `${who} (${o.rental_ref}) said none of the items suit them`;
    return `${who} (${o.rental_ref}) did not answer: ${o.old_name} still needs a replacement`;
};
