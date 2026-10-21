/* =====================================================================
   admin/equipment.js - Equipment tab
   DB: table equipment, storage bucket studio-images.
   ===================================================================== */

import { afterAction, closeOverlays } from './bookings.js';
import { CATS, RL, STK, refresh } from './data.js';
import { ACT, OWNER, PHICON, btn, dbtn, money, num, run, showDlg, tbl, uploadPublic } from './helpers.js';
import { sb } from '../config/supabaseClient.js';
import { loadCatalog } from '../shared/catalog.js';
import { $, $$, badge, esc, pl, toast } from '../shared/utils.js';

/* ============================ 6. EQUIPMENT ============================ */

let eqLow = false;

const eqThumb = c => c.image ? `<div class="eqthumb has"><img src="${esc(c.image)}" alt="${esc(c.name)}"></div>` : `<div class="eqthumb" role="img" aria-label="No image yet">${PHICON}</div>`;

const priceTxt = (c, m) => (m === 'a' ? !c.allow_addon : !c.allow_outside) ? 'Not offered' : money(m === 'a' ? c.add_on_rate : c.outside_rate) + (m === 'a' ? (c.is_drum_set ? '/rental' : '/session') : '/8 hrs');

export function renderEquipmentTab() {
  const list = STK.filter(c => !eqLow || c.stock_status === 'Low' || c.stock_status === 'In Use');
  $('#aeq').innerHTML = tbl(['Equipment', 'Category', 'Total', 'Avail.', 'In use', 'Add-on price', 'Outside price', 'Rent options', 'Status', ''],
    list.map(c => {
      const sub = c.is_drum_set ? esc((c.drum_kit || '').replace(/ drum set.*/i, '')) + ', ' + (c.is_vip ? 'VIP' : 'Basic') + ' set-up, 8-hour base rental' : (c.description ? esc(c.description) : '');
      const chips = OWNER
        ? `<div class="stk"><button class="chip ${c.allow_addon ? 'on' : ''}" data-act="eq-chip" data-id="${c.equipment_id}:allow_addon">Add-on</button><button class="chip ${c.allow_outside ? 'on' : ''}" data-act="eq-chip" data-id="${c.equipment_id}:allow_outside">Outside</button></div>`
        : `${c.allow_addon ? '<span class="b addon">Add-on</span> ' : ''}${c.allow_outside ? '<span class="b out">Outside</span>' : ''}`;
      return ['<div class="eqc">' + eqThumb(c) + '<div>' + (c.is_drum_set ? '<b>' + esc(c.name) + '</b>' : esc(c.name)) + (sub ? '<div class="mut eqd">' + sub + '</div>' : '') + '</div></div>',
        esc(c.category_name), String(c.total_quantity), String(c.available), String(c.in_use), priceTxt(c, 'a'), priceTxt(c, 'o'), chips,
        badge(c.stock_status), OWNER ? btn('eq-edit', c.equipment_id, 'Edit') + btn('eq-vis', c.equipment_id, c.stock_status === 'Unavailable' ? 'Show' : 'Hide', 1) + dbtn('eq-del', c.equipment_id, 'Delete') : ''];
    }));
}

$('#a-eqp .tabs').addEventListener('click', e => {
  const t = e.target.closest('[data-eqt]'); if (!t) return;
  eqLow = t.dataset.eqt === 'low';
  $$('#a-eqp .tabs button').forEach(b => b.classList.toggle('on', b === t));
  renderEquipmentTab();
});

ACT['eq-chip'] = async id => {
  const [eid, field] = id.split(':'), c = STK.find(x => x.equipment_id === +eid);
  if (await run(sb.from('equipment').update({ [field]: !c[field] }).eq('equipment_id', c.equipment_id))) { await loadCatalog(); afterAction(`${c.name}: ${field === 'allow_addon' ? 'Add-on' : 'Outside'} rentals turned ${!c[field] ? 'on' : 'off'}.`); }
};

ACT['eq-edit'] = id => eqForm(+id);

const afterEquip = async msg => { await loadCatalog(); await refresh(); closeOverlays(); toast(msg); };

ACT['eq-vis'] = async id => {
  const c = STK.find(x => x.equipment_id === +id), hide = c.stock_status !== 'Unavailable';
  if (await run(sb.from('equipment').update({ status: hide ? 'Unavailable' : 'Available' }).eq('equipment_id', c.equipment_id))) afterEquip(hide ? `${c.name} is now hidden from customers.` : `${c.name} is visible to customers again.`);
};

ACT['eq-del'] = id => {
  const c = STK.find(x => x.equipment_id === +id), n = new Set(RL.filter(l => l.equipment_id === c.equipment_id).map(l => l.rental_ref)).size;
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
  if (r.error) return toast(r.error.code === '23503' ? `${c.name} has rentals on record, so it can't be deleted. Hide it instead.` : r.error.message);
  afterEquip(`${c.name} deleted.`);
};

$('#eq-add').onclick = () => { if (OWNER) eqForm(null); else toast('Only the owner can add equipment.'); };

function eqForm(id) {
  const isNew = id == null;
  const c = isNew ? { name: '', category_name: '', description: '', total_quantity: 1, in_use: 0, add_on_rate: 0, outside_rate: 0, allow_addon: true, allow_outside: true, is_drum_set: false, image: '' } : STK.find(x => x.equipment_id === id);
  const drum = !!c.is_drum_set, d = $('#eqdlg');
  let img = c.image || '', file = null, ad = !!c.allow_addon, ou = !!c.allow_outside;
  d.innerHTML = `<div class="in"><form id="eqf" novalidate>
    <h2 style="margin:0 0 4px">${isNew ? 'Add equipment' : 'Edit equipment'}</h2>
    <p class="mut">Changes show up on the landing and customer pages.</p>
    <label for="eqn">Equipment name</label><input id="eqn" value="${esc(c.name)}" placeholder="e.g. Bass guitar" ${isNew ? '' : 'readonly'}>
    <label for="eqc">Category</label><select id="eqc"><option value="" disabled ${c.category_name ? '' : 'selected'}>Select a category</option>${CATS.map(x => `<option value="${x.category_id}" ${x.category_name === c.category_name ? 'selected' : ''}>${esc(x.category_name)}</option>`).join('')}</select>
    <label for="eqd">Description / specification</label><textarea id="eqd" rows="3" maxlength="300" placeholder="e.g. 4-string, active pickups.">${esc(c.description || '')}</textarea>
    <div class="fg" style="grid-template-columns:repeat(${drum ? 2 : 3},minmax(0,1fr))">
      <div><label for="eqt">Total stock</label><input id="eqt" type="number" min="0" step="1" value="${c.total_quantity}"></div>
      ${drum ? `<div><label for="eqa">Price per rental (₱)</label><input id="eqa" type="number" min="0" value="${num(c.add_on_rate)}"></div>`
             : `<div><label for="eqa">Add-on price (₱)</label><input id="eqa" type="number" min="0" value="${num(c.add_on_rate)}"></div><div><label for="eqo">Outside price (₱)</label><input id="eqo" type="number" min="0" value="${num(c.outside_rate)}"></div>`}
    </div>
    <p class="mut" style="margin-top:6px">Add-on is per session (drum sets per rental). Outside is per 8 hours: each extra hour adds one-eighth, and late returns add the same one-eighth per hour late.</p>
    <label>Rent options</label><div><button type="button" class="chip ${ad ? 'on' : ''}" id="eqx-ad" aria-pressed="${ad}">Add-on</button><button type="button" class="chip ${ou ? 'on' : ''}" id="eqx-ou" aria-pressed="${ou}">Outside</button></div>
    <label>Equipment image</label><div class="eqimg prev" id="eq-prev"></div>
    <input id="eq-file" type="file" accept="image/*" aria-label="Attach an image">
    <label for="eq-url" style="margin-top:14px">Or paste an image link</label><input id="eq-url" placeholder="https://example.com/photo.jpg">
    <div class="alert" id="eqerr" hidden></div>
    <div class="acts"><button type="button" class="btn line" id="eq-rm" style="margin-right:auto">Remove image</button><button type="button" class="btn line" id="eq-cancel">Cancel</button><button type="submit" class="btn gold">${isNew ? 'Add equipment' : 'Save changes'}</button></div>
  </form></div>`;
  const err = m => { $('#eqerr').textContent = m; $('#eqerr').hidden = !m; };
  const prev = () => { const p = $('#eq-prev'); p.className = 'eqimg prev' + (img ? ' has' : ''); p.innerHTML = img ? `<img src="${esc(img)}" alt="Image preview">` : PHICON + '<span>No image yet</span>'; };
  prev();
  $('#eq-file').onchange = ev => { const f = ev.target.files[0]; if (!f) return; if (!/^image\//.test(f.type)) { err('Please choose an image file.'); ev.target.value = ''; return; } err(''); file = f; img = URL.createObjectURL(f); $('#eq-url').value = ''; prev(); };
  $('#eq-url').onchange = ev => { const v = ev.target.value.trim(); if (!v) return; if (!/^https?:\/\//i.test(v)) return err('Enter a full link starting with http:// or https://'); err(''); file = null; img = v; prev(); };
  $('#eq-rm').onclick = () => { img = ''; file = null; $('#eq-file').value = ''; $('#eq-url').value = ''; err(''); prev(); };
  // a price box is only used while its option is switched on
  const syncPrices = () => {
    if (drum) $('#eqa').disabled = !(ad || ou);
    else { $('#eqa').disabled = !ad; $('#eqo').disabled = !ou; }
  };
  const toggle = (id, on) => { const b = $(id); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); syncPrices(); };
  $('#eqx-ad').onclick = () => { ad = !ad; toggle('#eqx-ad', ad); };
  $('#eqx-ou').onclick = () => { ou = !ou; toggle('#eqx-ou', ou); };
  syncPrices();
  $('#eq-cancel').onclick = () => d.close();
  $('#eqf').onsubmit = async ev => {
    ev.preventDefault();
    const name = $('#eqn').value.trim(), cat = Number($('#eqc').value), t = Number($('#eqt').value), a = Number($('#eqa').value), o = drum ? a : Number($('#eqo').value);
    if (!name) return err('Enter a name for the equipment.');
    if (!cat) return err('Choose a category.');
    if (!Number.isInteger(t) || t < 0) return err('Total stock must be a whole number, 0 or more.');
    if (!isNew && t < num(c.in_use)) return err(`Total stock can't be lower than the ${c.in_use} item(s) in use right now.`);
    if (!(a >= 0) || !(o >= 0)) return err('Prices must be 0 or more.');
    if (!ad && !ou) return err('Pick at least one rent option.');
    if (ad && !(a > 0)) return err('Enter an add-on price above 0.');
    if (ou && !(o > 0)) return err('Enter an outside price above 0.');
    const row = { description: $('#eqd').value.trim() || null, category_id: cat, total_quantity: t,
      add_on_rate: ad ? a : null, outside_rate: ou ? o : null, allow_addon: ad, allow_outside: ou, min_hours: 0, image: img || null };
    try { if (file) row.image = await uploadPublic('equipment-images', file); } catch (x) { return err('Image upload failed: ' + x.message); }
    const r = isNew ? await run(sb.from('equipment').insert({ ...row, name })) : await run(sb.from('equipment').update(row).eq('equipment_id', c.equipment_id));
    if (r) { d.close(); await loadCatalog(); await refresh(); toast(isNew ? name + ' added.' : name + ' updated.'); }
  };
  d.showModal();
}
