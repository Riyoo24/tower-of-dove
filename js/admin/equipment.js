/* =====================================================================
   admin/equipment.js - Equipment tab
   DB: table equipment, storage bucket studio-images.
   ===================================================================== */

import { afterAction, closeOverlays } from './bookings.js';
import { CATS, OFR, RL, SORT_OK, STK, refresh } from './data.js';
import {
    ACT,
    OWNER,
    dlg,
    PHICON,
    btn,
    dbtn,
    money,
    num,
    run,
    showDlg,
    stampLabel,
    tbl,
    uploadPublic
} from './helpers.js';
import { customerChose, openOfferFor, paymentUnchecked, swapActions } from './swapOffer.js';
import { sb } from '../config/supabaseClient.js';
import { loadCatalog } from '../shared/catalog.js';
import { $, $$, badge, esc, pl, toast } from '../shared/utils.js';

/* ============================ 6. EQUIPMENT ============================ */

let eqLow = false;   // 'Low stock' filter on
let eqNew = false;   // 'Newest added' on: newest equipment first (highest id)
let eqCat = 'All';   // category tab picked in the Equipment list ('All' or a category name)

const eqThumb = c => c.image ? `<div class="eqthumb has"><img src="${esc(c.image)}" alt="${esc(c.name)}" width="52" height="52" loading="lazy" decoding="async"></div>` : `<div class="eqthumb" role="img" aria-label="No image yet">${PHICON}</div>`;

const priceTxt = (c, m) => (m === 'a' ? !c.allow_addon : !c.allow_outside) ? 'Not offered' : money(m === 'a' ? c.add_on_rate : c.outside_rate) + (m === 'a' ? '/session' : '/8 hrs');

// Owned = everything the studio owns. Out of service = broken / in repair. total_quantity is what can still be rented (owned - out of service).
// Before 60_out_of_service_stock.sql is run the two new columns are missing, so fall back to the old meaning.
const ownedOf = c => c.owned_quantity ?? c.total_quantity;
const migrated = () => STK.length === 0 || STK[0].owned_quantity !== undefined;
const oosOf = c => c.out_of_service ?? 0;

/* Upcoming rentals / bookings that need more of an item than can still be rented (equipment_stock_conflicts in 60_out_of_service_stock.sql) */
const shortageHtml = rows => {
    const byItem = new Map();
    rows.forEach(r => {
        if (!byItem.has(r.equipment_id))
            byItem.set(r.equipment_id, { name: r.equipment_name, rentable: r.rentable, short: r.short_by, rows: [] });
        byItem.get(r.equipment_id).rows.push(r);
    });
    return [...byItem.values()].map(it => `<div class="eq-short-item">
      <b>${esc(it.name)}</b>: ${it.rentable} can be rented, but the rentals below need up to ${it.rentable + it.short} at the same time (short by ${it.short}).
      <ul class="eq-short-list">${it.rows.map(r => `<li><b>${esc(r.rental_ref)}</b> ${esc(r.customer_name || '')} <span class="mut">${esc(r.order_status)}, ${esc(stampLabel(r.w_start))}${r.w_end ? ' to ' + esc(stampLabel(r.w_end)) : ''}, x${r.quantity}${r.booked_at ? ', booked ' + esc(stampLabel(r.booked_at)) : ''}</span>${swapActions(r.rental_ref, r.rental_detail_id, r.order_status)}</li>`).join('')}</ul>
    </div>`).join('');
};

const shortageAdvice = 'Keep the earliest bookings and replace the later ones with an equivalent item: Let customer choose (you offer up to 5 items and the customer picks one) or Swap item (you pick, best when pick-up is soon). No extra charge, no refund. If nothing can replace it, move the customer to another date. If a unit is repaired or found, lower Out of service (or raise Total owned) in Equipment, and this warning clears by itself.';

async function fetchShortages(equipmentId) {
    try {
        const { data, error } = await sb.rpc('equipment_stock_conflicts', { p_equipment_id: equipmentId ?? null });
        return error ? [] : (data || []);   // needs 60_out_of_service_stock.sql
    } catch (e) {
        return [];
    }
}

/* Pop-up shown right after a return took units out of stock and other customers are now short */
export async function showStockShortage(equipmentIds) {
    const rows = [];
    for (const id of new Set(equipmentIds))
        rows.push(...await fetchShortages(id));
    if (!rows.length)
        return false;   // nothing is short: no pop-up
    const ids = [...new Set(equipmentIds)];
    // a rental line is dealt with once an offer is waiting for the customer, the customer chose, or it was swapped (no longer short)
    const handled = (r, still) => !still.has(String(r.rental_detail_id)) || !!openOfferFor(r.rental_detail_id) || customerChose(r.rental_detail_id)
        || (r.order_status === 'Pending' && paymentUnchecked(r.rental_ref));   // payment not verified yet: no swap is allowed (it may be a fake booking), so nothing to do here; the pop-up opens again after Verify
    showDlg(`<h2 style="margin:0 0 8px">Upcoming rentals are now short of stock</h2>
      <p class="mut" style="margin:0 0 10px">The return was saved. Because of the damaged item, these rentals or bookings need more than can be rented. <b>Choose Let customer choose or Swap item for each rental below before you close this window.</b></p>
      <div id="sh-list">${shortageHtml(rows)}</div>
      <p class="mut" style="margin-top:10px">${esc(shortageAdvice)}</p>
      <label class="so-auto" id="sh-none-row" style="margin-top:12px" hidden><input type="checkbox" id="sh-none"> <span>Nothing can replace it. I will contact the customer myself.</span></label>
      <p class="mut" id="sh-left" style="margin:10px 0 0"></p>
      <div class="acts"><button class="btn gold" id="sh-ok" data-close disabled>OK</button></div>`);
    dlg.dataset.locked = '1';
    const list = dlg.querySelector('#sh-list'), none = dlg.querySelector('#sh-none'), ok = dlg.querySelector('#sh-ok'), left = dlg.querySelector('#sh-left');
    const noneRow = dlg.querySelector('#sh-none-row');
    let cur = rows, noOpt = new Set();   // noOpt = rental lines that have no free replacement at all
    const paint = () => {
        const still = new Set(cur.map(r => String(r.rental_detail_id)));
        const todo = cur.filter(r => !handled(r, still));
        const stuck = todo.filter(r => noOpt.has(String(r.rental_detail_id)));   // nothing can replace these
        const must = todo.length - stuck.length;                               // these still have something to offer or swap
        list.innerHTML = cur.length ? shortageHtml(cur) : '<p class="mut">All upcoming rentals can be covered now.</p>';
        noneRow.hidden = !stuck.length;   // the "contact the customer myself" way out only shows when there is truly nothing to offer
        if (!stuck.length)
            none.checked = false;
        const done = !must && (!stuck.length || none.checked);
        ok.disabled = !done;
        const waiting = cur.filter(r => still.has(String(r.rental_detail_id)) && r.order_status === 'Pending' && paymentUnchecked(r.rental_ref)).length;
        left.textContent = done ? (waiting ? `${pl(waiting, 'rental')} waiting for payment verification. Verify the payment in Payments, then swap or let the customer choose.` : '') : `${pl(must || stuck.length, 'rental')} still need${(must || stuck.length) === 1 ? 's' : ''} an action.`;
        return !must && !stuck.length;   // true when every rental is dealt with and nothing is left to decide
    };
    // which of the lines still to deal with have no replacement item free for their hours
    const scan = async () => {
        const still = new Set(cur.map(r => String(r.rental_detail_id)));
        const found = new Set();
        await Promise.all(cur.filter(r => !handled(r, still)).map(async r => {
            try {
                const { data, error } = await sb.rpc('staff_swap_options', { p_rental_detail_id: +r.rental_detail_id });
                if (!error && !(data || []).length)
                    found.add(String(r.rental_detail_id));
            } catch (e) { /* treat as "has options": keep the action required */ }
        }));
        noOpt = found;
    };
    const again = async () => {
        if (!dlg.isConnected || !dlg.open || !dlg.dataset.locked)
            return document.removeEventListener('tod:swapped', again);
        const next = [];
        for (const id of ids)
            next.push(...await fetchShortages(id));
        cur = next;
        await scan();
        if (dlg.open && paint())
            dlg.close();   // the last rental was just dealt with (offer sent, customer chose or swapped): no extra OK click needed
    };
    document.addEventListener('tod:swapped', again);
    none.addEventListener('change', paint);
    dlg.addEventListener('close', () => document.removeEventListener('tod:swapped', again), { once: true });
    paint();   // shown at once with every line still required, then relaxed once the replacements are known
    await scan();
    if (dlg.open)
        paint();
    return true;
}

let shortSeq = 0;
async function renderShortages() {
    const mine = ++shortSeq;
    const rows = await fetchShortages(null);
    const box = $('#eq-short');
    if (!box || mine !== shortSeq)
        return;
    box.hidden = !rows.length;
    box.innerHTML = rows.length
        ? `<b>Some upcoming rentals are short of stock.</b> ${esc(shortageAdvice)}${shortageHtml(rows)}`
        : '';
}

/* Category filter: only changes which rows the admin table shows. It is never saved and never touches the database,
   so the customer pages (shared/catalog.js) look exactly the same whichever tab is picked here. */
const byOrder = (a, b) => (a.sort_order ?? a.equipment_id) - (b.sort_order ?? b.equipment_id) || a.equipment_id - b.equipment_id;
const catItems = name => STK.filter(c => c.category_name === name);

function renderCategoryTabs() {
    const names = CATS.map(x => x.category_name);
    if (eqCat !== 'All' && !names.includes(eqCat))
        eqCat = 'All';
    const tab = (key, label, n) => `<button type="button" data-eqc="${esc(key)}" class="${key === eqCat ? 'on' : ''}">${esc(label)} <span class="mut">${n}</span></button>`;
    $('#eq-cats').innerHTML = tab('All', 'All categories', STK.length) + names.map(n => tab(n, n, catItems(n).length)).join('');
}

export function renderEquipmentTab() {
    renderCategoryTabs();
    $$('#eq-opts button').forEach(b => {
        const on = b.dataset.eqopt === 'low' ? eqLow : eqNew;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
    });
    const list = STK.filter(c => (eqCat === 'All' || c.category_name === eqCat)
        && (!eqLow || c.stock_status === 'Low' || c.stock_status === 'In Use' || c.stock_status === 'Out of Stock'));
    list.sort(eqNew ? (a, b) => b.equipment_id - a.equipment_id   // newest added first
        : byOrder);                                              // the arrangement customers see
    const canDrag = OWNER && SORT_OK && !eqNew;
    $('#aeq').innerHTML = '<div class="alert warn eq-short" id="eq-short" role="alert" hidden></div>' + tbl([
        'Equipment',
        'Category',
        'Owned',
        'Out of service',
        'Avail.',
        'In use',
        'Add-on price',
        'Outside price',
        'Rent options',
        'Status',
        ''
    ],
        list.map(c => {
            const sub = c.description ? esc(c.description) : '';
            const chips = OWNER
                ? `<div class="stk"><button class="chip ${c.allow_addon ? 'on' : ''}" data-act="eq-chip" data-id="${c.equipment_id}:allow_addon">Add-on</button><button class="chip ${c.allow_outside ? 'on' : ''}" data-act="eq-chip" data-id="${c.equipment_id}:allow_outside">Outside</button></div>`
                : `${c.allow_addon ? '<span class="b addon">Add-on</span> ' : ''}${c.allow_outside ? '<span class="b out">Outside</span>' : ''}`;
            return [
                '<div class="eqc">' + (canDrag ? '<span class="eq-grip" title="Drag to change the order customers see" aria-hidden="true">&#8942;&#8942;</span>' : '') + eqThumb(c) + '<div>' + esc(c.name) + (sub ? '<div class="mut eqd">' + sub + '</div>' : '')
                + '</div></div>',
                esc(c.category_name),
                String(ownedOf(c)),
                oosOf(c) > 0 ? `<b class="eq-oos">${oosOf(c)}</b>` : '0',
                String(c.available),
                String(c.in_use),
                priceTxt(c, 'a'),
                priceTxt(c, 'o'),
                chips,
                badge(c.stock_status),
                OWNER ? btn('eq-edit', c.equipment_id, 'Edit')
                    + btn('eq-vis', c.equipment_id, c.stock_status === 'Unavailable' ? 'Show' : 'Hide', 1)
                    + dbtn('eq-del', c.equipment_id, 'Delete') : ''
            ];
        }));
    $$('#aeq tbody tr').forEach((tr, i) => { if (list[i]) tr.dataset.eqid = list[i].equipment_id; });
    const hint = OWNER && !SORT_OK ? 'To drag equipment into a new order, run supabase/77_equipment_sort_order.sql once in the Supabase SQL Editor.'
        : canDrag ? 'Drag a row by its handle (\u22ee\u22ee) to set the order customers see on the Rent page and home page. The category and other filters here never change what customers see.'
        : OWNER && eqNew ? 'Turn off Newest added to drag and re-order.' : '';
    $('#eq-drag-hint').textContent = hint;
    renderShortages();
}

/* ---- drag and drop: the order saved here is the order customers see ---- */
let dragId = null;
const rowOf = el => el.closest && el.closest('#aeq tbody tr[data-eqid]');
const clearMarks = () => $$('#aeq tr.eq-over-top, #aeq tr.eq-over-bot, #aeq tr.eq-drag').forEach(r => r.classList.remove('eq-over-top', 'eq-over-bot', 'eq-drag'));

$('#aeq').addEventListener('mousedown', e => {
    const g = e.target.closest('.eq-grip'), tr = g && rowOf(g);
    if (tr)
        tr.draggable = true;   // only the handle starts a drag, so text in the row can still be selected
});
$('#aeq').addEventListener('dragstart', e => {
    const tr = rowOf(e.target);
    if (!tr || !tr.draggable)
        return;
    dragId = +tr.dataset.eqid;
    tr.classList.add('eq-drag');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(dragId));
});
$('#aeq').addEventListener('dragover', e => {
    const tr = rowOf(e.target);
    if (dragId === null || !tr)
        return;
    e.preventDefault();
    const r = tr.getBoundingClientRect(), top = e.clientY < r.top + r.height / 2;
    $$('#aeq tr.eq-over-top, #aeq tr.eq-over-bot').forEach(x => x.classList.remove('eq-over-top', 'eq-over-bot'));
    tr.classList.add(top ? 'eq-over-top' : 'eq-over-bot');
});
$('#aeq').addEventListener('dragend', () => {
    dragId = null;
    clearMarks();
    $$('#aeq tbody tr[draggable="true"]').forEach(r => { r.draggable = false; });
});
$('#aeq').addEventListener('drop', e => {
    const tr = rowOf(e.target);
    if (dragId === null || !tr)
        return;
    e.preventDefault();
    const r = tr.getBoundingClientRect(), before = e.clientY < r.top + r.height / 2, targetId = +tr.dataset.eqid, moved = dragId;
    dragId = null;
    clearMarks();
    if (moved !== targetId)
        saveOrder(moved, targetId, before);
});

async function saveOrder(movedId, targetId, before) {
    // the rows on screen (after the category filter), in their current order; they re-use the same set of positions,
    // so items hidden by the filter keep their place
    const shown = $$('#aeq tbody tr[data-eqid]').map(tr => STK.find(c => c.equipment_id === +tr.dataset.eqid)).filter(Boolean);
    const moving = shown.find(c => c.equipment_id === movedId);
    if (!moving)
        return;
    const rest = shown.filter(c => c !== moving), at = rest.findIndex(c => c.equipment_id === targetId);
    rest.splice(before ? at : at + 1, 0, moving);
    const slots = shown.map(c => c.sort_order).sort((a, b) => a - b), changes = [];
    rest.forEach((c, i) => {
        if (c.sort_order !== slots[i])
            changes.push([c, slots[i]]);
    });
    if (!changes.length)
        return;
    const old = changes.map(([c]) => [c, c.sort_order]);
    changes.forEach(([c, v]) => { c.sort_order = v; });
    renderEquipmentTab();   // show the new order at once
    const res = await Promise.all(changes.map(([c, v]) => sb.from('equipment').update({ sort_order: v }).eq('equipment_id', c.equipment_id)));
    const bad = res.find(r => r.error);
    if (bad) {
        old.forEach(([c, v]) => { c.sort_order = v; });
        renderEquipmentTab();
        console.error(bad.error);
        return toast('Could not save the new order: ' + bad.error.message);
    }
    await loadCatalog();
    toast('Order saved. Customers now see equipment in this order.');
}

/* Admin-only view filters (never saved, never change the customer pages) */
$('#eq-opts').addEventListener('click', e => {
    const t = e.target.closest('[data-eqopt]');
    if (!t)
        return;
    if (t.dataset.eqopt === 'low')
        eqLow = !eqLow;
    else
        eqNew = !eqNew;
    renderEquipmentTab();
});

$('#eq-cats').addEventListener('click', e => {
    const t = e.target.closest('[data-eqc]');
    if (!t)
        return;
    eqCat = t.dataset.eqc;
    renderEquipmentTab();
});

ACT['eq-chip'] = async id => {
    const [eid, field] = id.split(':'), c = STK.find(x => x.equipment_id === +eid);
    const rate = field === 'allow_addon' ? c.add_on_rate : c.outside_rate;
    if (!c[field] && (rate === null || rate === undefined || rate === ''))
        return toast(`${field === 'allow_addon' ? 'Add-on' : 'Outside'} price is not set. Click Edit and enter the price first.`);
    if (await run(sb.from('equipment').update({ [field]: !c[field] }).eq('equipment_id', c.equipment_id))) {
        await loadCatalog();
        afterAction(`${c.name}: ${field === 'allow_addon' ? 'Add-on' : 'Outside'} rentals turned ${!c[field] ? 'on' : 'off'}.`);
    }
};

ACT['eq-edit'] = id => eqForm(+id);

const afterEquip = async msg => {
    await loadCatalog();
    await refresh();
    closeOverlays();
    toast(msg);
};

ACT['eq-vis'] = async id => {
    const c = STK.find(x => x.equipment_id === +id), hide = c.stock_status !== 'Unavailable';
    if (await run(sb.from('equipment').update({ status: hide ? 'Unavailable' : 'Available' }).eq('equipment_id', c.equipment_id)))
        afterEquip(hide ? `${c.name} is now hidden from customers.` : `${c.name} is visible to customers again.`);
};

ACT['eq-del'] = id => {
    const c = STK.find(x => x.equipment_id === +id),
        n = new Set(RL.filter(l => l.equipment_id === c.equipment_id).map(l => l.rental_ref)).size;
    if (n > 0) {
        showDlg(`<h2 style="margin:0 0 8px">${esc(c.name)} can't be deleted</h2>
      <p class="mut">It appears in ${pl(n, 'rental')} on record, and deleting it would erase that history. Hide it instead: customers no longer see it, and your records stay intact.</p>
      <div class="acts"><button class="btn line" data-close>Close</button>${c.stock_status !== 'Unavailable' ? btn('eq-vis', c.equipment_id, 'Hide ' + esc(c.name)) : ''}</div>`);
        return;
    }
    showDlg(`<h2 style="margin:0 0 8px">Delete ${esc(c.name)}?</h2>
    <p class="mut">The equipment is removed from the system. It has never been rented. This can't be undone.</p>
    <div class="acts"><button class="btn line" data-close>Cancel</button>${dbtn('eq-del-go', c.equipment_id, 'Delete equipment')}</div>`);
};

ACT['eq-del-go'] = async id => {
    const c = STK.find(x => x.equipment_id === +id);
    const r = await sb.from('equipment').delete().eq('equipment_id', c.equipment_id);
    if (r.error)
        return toast(r.error.code === '23503' ? `${c.name} has rentals on record, so it can't be deleted. Hide it instead.` : r.error.message);
    afterEquip(`${c.name} deleted.`);
};

$('#eq-add').onclick = () => {
    if (OWNER)
        eqForm(null); else
        toast('Only the owner can add equipment.');
};

function eqForm(id) {
    const isNew = id == null;
    const c = isNew ? {
        name: '',
        category_name: (eqCat !== 'All' && CATS.some(x => x.category_name === eqCat)) ? eqCat : '',   // pre-fill from the ticked category tab
        description: '',
        total_quantity: 1,
        owned_quantity: 1,
        out_of_service: 0,
        in_use: 0,
        add_on_rate: 0,
        outside_rate: 0,
        allow_addon: true,
        allow_outside: true,
        image: ''
    } : STK.find(x => x.equipment_id === id);
    const d = $('#eqdlg');
    let img = c.image || '', file = null, ad = !!c.allow_addon, ou = !!c.allow_outside;
    d.innerHTML = `<div class="in"><form id="eqf" novalidate>
    <h2 style="margin:0 0 4px">${isNew ? 'Add equipment' : 'Edit equipment'}</h2>
    <p class="mut">Changes show up on the landing and customer pages.</p>
    <label for="eqn">Equipment name</label><input id="eqn" value="${esc(c.name)}" placeholder="e.g. Bass guitar">
    <label for="eqc">Category</label><select id="eqc"><option value="" disabled ${c.category_name ? '' : 'selected'}>Select a category</option>${CATS.map(x => `<option value="${x.category_id}" ${x.category_name === c.category_name ? 'selected' : ''}>${esc(x.category_name)}</option>`).join('')}</select>
    <label for="eqd">Description / specification</label><textarea id="eqd" rows="3" maxlength="300" placeholder="e.g. 4-string, active pickups. For drum sets: include model and cymbal configuration.">${esc(c.description || '')}</textarea>
    <div class="fg" style="grid-template-columns:repeat(2,minmax(0,1fr))">
      <div><label for="eqt">Total owned</label><input id="eqt" type="number" min="0" step="1" value="${ownedOf(c)}"></div>
      <div><label for="eqs">Out of service</label><input id="eqs" type="number" min="0" step="1" value="${oosOf(c)}"></div>
    </div>
    <p class="mut" style="margin:6px 0 0" id="eq-rentable"></p>
    <p class="mut" style="margin:2px 0 0">Out of service = broken or being repaired. Customers can only rent the rentable quantity. When a unit is fixed, lower Out of service; if one is lost for good, lower Total owned.</p>
    <div class="fg" style="grid-template-columns:repeat(2,minmax(0,1fr))">
      <div><label for="eqa">Add-on price (₱)</label><input id="eqa" type="number" min="0" value="${num(c.add_on_rate)}"></div>
      <div><label for="eqo">Outside price (₱)</label><input id="eqo" type="number" min="0" value="${num(c.outside_rate)}"></div>
    </div>
    <p class="mut" style="margin-top:6px">Add-on is per session. Outside is per 8 hours: each extra hour adds one-eighth, and late returns add the same one-eighth per hour late.</p>
    <label>Rent options</label><div><button type="button" class="chip ${ad ? 'on' : ''}" id="eqx-ad" aria-pressed="${ad}">Add-on</button><button type="button" class="chip ${ou ? 'on' : ''}" id="eqx-ou" aria-pressed="${ou}">Outside</button></div>
    <label>Equipment image</label><div class="eqimg prev" id="eq-prev"></div>
    <input id="eq-file" type="file" accept="image/*" aria-label="Attach an image">
    <label for="eq-url" style="margin-top:14px">Or paste an image link</label><input id="eq-url" placeholder="https://example.com/photo.jpg">
    <div class="alert" id="eqerr" hidden></div>
    <div class="acts"><button type="button" class="btn line" id="eq-rm" style="margin-right:auto">Remove image</button><button type="button" class="btn line" id="eq-cancel">Cancel</button><button type="submit" class="btn gold">${isNew ? 'Add equipment' : 'Save changes'}</button></div>
  </form></div>`;
    const err = m => {
        $('#eqerr').textContent = m;
        $('#eqerr').hidden = !m;
    };
    const prev = () => {
        const p = $('#eq-prev');
        p.className = 'eqimg prev' + (img ? ' has' : '');
        p.innerHTML = img ? `<img src="${esc(img)}" alt="Image preview">` : PHICON + '<span>No image yet</span>';
    };
    prev();
    $('#eq-file').onchange = ev => {
        const f = ev.target.files[0];
        if (!f)
            return;
        if (!/^image\//.test(f.type)) {
            err('Please choose an image file.');
            ev.target.value = '';
            return;
        }
        err('');
        file = f;
        img = URL.createObjectURL(f);
        $('#eq-url').value = '';
        prev();
    };
    $('#eq-url').onchange = ev => {
        const v = ev.target.value.trim();
        if (!v)
            return;
        if (!/^https?:\/\//i.test(v))
            return err('Enter a full link starting with http:// or https://');
        err('');
        file = null;
        img = v;
        prev();
    };
    $('#eq-rm').onclick = () => {
        img = '';
        file = null;
        $('#eq-file').value = '';
        $('#eq-url').value = '';
        err('');
        prev();
    };
    // live hint: rentable = owned - out of service
    const syncRentable = () => {
        const t = Number($('#eqt').value), x = Number($('#eqs').value);
        $('#eq-rentable').textContent = Number.isInteger(t) && Number.isInteger(x) && t >= 0 && x >= 0 && x <= t
            ? `Rentable: ${t - x} (of ${t} owned).` : '';
    };
    $('#eqt').oninput = syncRentable;
    $('#eqs').oninput = syncRentable;
    syncRentable();
    // a price box is only enabled while its rent option is switched on
    const syncPrices = () => {
        $('#eqa').disabled = !ad;
        $('#eqo').disabled = !ou;
    };
    const toggle = (btnId, on) => {
        const b = $(btnId);
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
        syncPrices();
    };
    $('#eqx-ad').onclick = () => {
        ad = !ad;
        toggle('#eqx-ad', ad);
    };
    $('#eqx-ou').onclick = () => {
        ou = !ou;
        toggle('#eqx-ou', ou);
    };
    // Apply initial disabled state after the DOM is fully ready
    setTimeout(syncPrices, 0);
    $('#eq-cancel').onclick = () => d.close();
    $('#eqf').onsubmit = async ev => {
        ev.preventDefault();
        const name = $('#eqn').value.trim(),
            cat = Number($('#eqc').value),
            t = Number($('#eqt').value),
            x = Number($('#eqs').value),
            a = Number($('#eqa').value),
            o = Number($('#eqo').value);
        if (!name)
            return err('Enter a name for the equipment.');
        if (!cat)
            return err('Choose a category.');
        if (!Number.isInteger(t) || t < 0)
            return err('Total owned must be a whole number, 0 or more.');
        if (!Number.isInteger(x) || x < 0)
            return err('Out of service must be a whole number, 0 or more.');
        if (!migrated() && x > 0)
            return err('Out of service needs the database update. Run supabase/60_out_of_service_stock.sql in the Supabase SQL Editor first.');
        if (x > t)
            return err(`Out of service (${x}) can't be more than the ${t} owned.`);
        if (!isNew && t - x < num(c.in_use))
            return err(`Rentable stock (${t - x}) can't be lower than the ${c.in_use} item(s) in use right now. Wait until they are returned.`);
        if (!ad && !ou)
            return err('Pick at least one rent option.');
        if (ad && !(a > 0))
            return err('Enter an add-on price above 0.');
        if (ou && !(o > 0))
            return err('Enter an outside price above 0.');
        const row = {
            name,
            description: $('#eqd').value.trim() || null,
            category_id: cat,
            ...(migrated() ? { owned_quantity: t, out_of_service: x, total_quantity: t - x } : { total_quantity: t }),
            add_on_rate: ad ? a : null,
            outside_rate: ou ? o : null,
            allow_addon: ad,
            allow_outside: ou,
            min_hours: 0,
            image: img || null
        };
        try {
            if (file)
                row.image = await uploadPublic('equipment-images', file);
        } catch (x) {
            return err('Image upload failed: ' + x.message);
        }
        const r = isNew ? await run(sb.from('equipment').insert(row)) : await run(sb.from('equipment').update(row).eq('equipment_id', c.equipment_id));
        if (r) {
            d.close();
            await loadCatalog();
            await refresh();
            toast(isNew ? name + ' added.' : name + ' updated.');
        }
    };
    d.showModal();
}
