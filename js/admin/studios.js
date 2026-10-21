/* =====================================================================
   admin/studios.js - Studio management tab (owner only)
   DB: table studio, storage bucket studio-images.
   ===================================================================== */

import { closeOverlays } from './bookings.js';
import { BK, STU, refresh } from './data.js';
import { ACT, OWNER, btn, dbtn, money, num, run, showDlg, uploadPublic } from './helpers.js';
import { sb } from '../config/supabaseClient.js';
import { STUDIO_COLORS, loadCatalog } from '../shared/catalog.js';
import { $, badge, esc, pl, toast } from '../shared/utils.js';

/* ============================ 5. STUDIOS ============================ */

export function renderStudios() {
  $('#ast').innerHTML = STU.map((s, i) => {
    const c = STUDIO_COLORS[i % STUDIO_COLORS.length], letter = s.name.replace(/^studio\s*/i, '');
    const ph = s.image ? `<div class="ph has"><img src="${esc(s.image)}" alt="${esc(s.name)}"></div>`
                       : `<div class="ph" style="background:linear-gradient(135deg,${c[0]},${c[1]})">${esc(letter)}</div>`;
    return `<div class="card">${ph}<div class="row"><h3>${esc(s.name)}</h3>${badge(s.status)}</div><p class="mut">${esc(s.description || '')}</p>
      <div class="row" style="margin-top:8px"><b>${money(s.hourly_rate)}/hr</b><span>${btn('st-edit', s.studio_id, 'Edit')}${btn('st-tog', s.studio_id, s.status === 'Available' ? 'Disable' : 'Enable', 1)}${dbtn('st-del', s.studio_id, 'Delete')}</span></div></div>`;
  }).join('');
}

const afterStudio = async msg => { await loadCatalog(); await refresh(); closeOverlays(); toast(msg); };

ACT['st-tog'] = async id => {
  const s = STU.find(x => x.studio_id === +id);
  if (await run(sb.from('studio').update({ status: s.status === 'Available' ? 'Unavailable' : 'Available' }).eq('studio_id', s.studio_id))) afterStudio(`${s.name} updated.`);
};

ACT['st-del'] = id => {
  const s = STU.find(x => x.studio_id === +id), n = BK.filter(b => b.studio_id === s.studio_id).length;
  if (n > 0) {
    showDlg(`<h2 style="margin:0 0 8px">${esc(s.name)} can't be deleted</h2>
      <p class="mut">It has ${pl(n, 'booking')} on record, and deleting the studio would erase that history. Disable it instead: customers can no longer book it, and your records stay intact.</p>
      <div class="acts"><button class="btn line" data-close>Close</button>${s.status === 'Available' ? btn('st-tog', s.studio_id, 'Disable ' + esc(s.name)) : ''}</div>`);
    return;
  }
  showDlg(`<h2 style="margin:0 0 8px">Delete ${esc(s.name)}?</h2>
    <p class="mut">The studio is removed from the system. It has no bookings. This can't be undone.</p>
    <div class="acts"><button class="btn line" data-close>Cancel</button>${dbtn('st-del-go', s.studio_id, 'Delete studio')}</div>`);
};

ACT['st-del-go'] = async id => {
  const s = STU.find(x => x.studio_id === +id);
  const r = await sb.from('studio').delete().eq('studio_id', s.studio_id);
  if (r.error) return toast(r.error.code === '23503' ? `${s.name} has bookings on record, so it can't be deleted. Disable it instead.` : r.error.message);
  afterStudio(`${s.name} deleted.`);
};

ACT['st-edit'] = id => {
  const s = STU.find(x => x.studio_id === +id);
  showDlg(`<form id="se-f" novalidate><h2 style="margin:0 0 4px">Edit ${esc(s.name)}</h2>
    <label for="se-n">Name</label><input id="se-n" value="${esc(s.name)}">
    <label for="se-d">Description</label><input id="se-d" value="${esc(s.description || '')}">
    <label for="se-r">Hourly rate (₱)</label><input id="se-r" type="number" min="0" value="${num(s.hourly_rate)}">
    <label for="se-s">Status</label><select id="se-s">${['Available', 'Unavailable', 'Maintenance'].map(x => `<option ${x === s.status ? 'selected' : ''}>${x}</option>`).join('')}</select>
    <label for="se-f2">New photo (optional)</label><input id="se-f2" type="file" accept="image/*">
    <div class="alert" id="se-e" hidden></div>
    <div class="acts"><button type="button" class="btn line" data-close>Cancel</button><button class="btn gold">Save changes</button></div></form>`);
  $('#se-f').onsubmit = async ev => {
    ev.preventDefault();
    const err = m => { $('#se-e').textContent = m; $('#se-e').hidden = !m; };
    const name = $('#se-n').value.trim(), rate = Number($('#se-r').value);
    if (!name) return err('Enter a name.');
    if (!(rate >= 0)) return err('Enter a valid hourly rate.');
    const patch = { name, description: $('#se-d').value.trim() || null, hourly_rate: rate, status: $('#se-s').value };
    try { const f = $('#se-f2').files[0]; if (f) patch.image = await uploadPublic('studio-images', f); } catch (x) { return err('Photo upload failed: ' + x.message); }
    if (await run(sb.from('studio').update(patch).eq('studio_id', s.studio_id))) afterStudio(`${name} saved.`);
  };
};

$('#sbtn').addEventListener('click', async () => {
  if (!OWNER) return toast('Only the owner can add studios.');
  const name = $('#sn').value.trim(), rate = Number($('#sr').value);
  if (!name) return toast('Enter a studio name.');
  if (!(rate >= 0) || $('#sr').value === '') return toast('Enter an hourly rate.');
  const row = { name, description: $('#sd').value.trim() || null, hourly_rate: rate, status: $('#ss').value };
  try { const f = $('#sf').files[0]; if (f) row.image = await uploadPublic('studio-images', f); } catch (x) { return toast('Photo upload failed: ' + x.message); }
  if (await run(sb.from('studio').insert(row))) { ['#sn', '#sd', '#sr', '#sf'].forEach(s => { $(s).value = ''; }); afterStudio(`${name} added.`); }
});
