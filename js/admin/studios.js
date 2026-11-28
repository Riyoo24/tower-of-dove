/* =====================================================================
   admin/studios.js - Studio management tab (owner only)
   DB: tables studio and studio_photo (105_studio_room_details.sql), storage bucket studio-images.
   Everything a customer sees about a room is edited here: photos, name, short description, capacity,
   room size, rate, status, location, about text and the included gear (studio.room_specs).
   ===================================================================== */

import { closeOverlays } from './bookings.js';
import { BK, PHO, STU, refresh } from './data.js';
import {
    ACT,
    OWNER,
    askConfirm,
    btn,
    dlg,
    money,
    num,
    run,
    showDlg,
    uploadPublic
} from './helpers.js';
import { sb } from '../config/supabaseClient.js';
import { STUDIO_COLORS, loadCatalog } from '../shared/catalog.js';
import { $, badge, esc, pl, specsOf, toast } from '../shared/utils.js';

/* ============================ 5. STUDIOS ============================ */

const STATUSES = ['Available', 'Unavailable', 'Maintenance'];

/* a room's photos, main photo first */
const photosOf = id => PHO.filter(p => p.studio_id === id).sort((a, b) => a.sort_order - b.sort_order || a.photo_id - b.photo_id);

const colorOf = i => STUDIO_COLORS[i % STUDIO_COLORS.length];

/* the coloured letter tile shown for a room without a photo */
const tile = (name, i, big) => {
    const c = colorOf(i);
    return `<div class="ph" style="background:linear-gradient(135deg,${c[0]},${c[1]})">${big ? esc(name.replace(/^studio\s*/i, '')) : ''}</div>`;
};

const photoBox = (url, name, i) => url
    ? `<div class="ph has"><img src="${esc(url)}" alt="${esc(name)}" width="320" height="104" loading="lazy" decoding="async"></div>`
    : tile(name, i, true);

/* "Fits 6 · 28 sqm", or "Size not set" when both are empty */
const sizeLine = (cap, sqm) => [cap ? `Fits ${cap}` : '', sqm ? `${+sqm} sqm` : ''].filter(Boolean).join(' · ') || 'Size not set';

export function renderStudios() {
    $('#ast').innerHTML = STU.map((s, i) => {
        const photos = photosOf(s.studio_id), gear = specsOf('', s.room_specs).items.length;
        const id = esc(s.studio_id), nm = esc(s.name);
        return `<div class="card">${photoBox(photos[0]?.url || s.image, s.name, i)}<div class="row"><h3>${nm}</h3>${badge(s.status)}</div><p class="mut" style="white-space:pre-line">${esc(s.description || '')}</p>
      <div class="mut sx-meta"><span>${sizeLine(s.capacity, s.room_size_sqm)}</span><span>${pl(gear, 'gear item')} · ${pl(photos.length, 'photo')}</span></div>
      <div class="sx-foot">
        <div class="sx-top"><b>${money(s.hourly_rate)}/hr</b><span class="sx-seg" role="group" aria-label="Change order"><button type="button" data-act="st-up" data-id="${id}" aria-label="Move ${nm} up"${i ? '' : ' disabled'}>↑</button><button type="button" data-act="st-dn" data-id="${id}" aria-label="Move ${nm} down"${i < STU.length - 1 ? '' : ' disabled'}>↓</button></span></div>
        <div class="sx-act"><button type="button" class="btn" data-act="st-edit" data-id="${id}">Edit</button>${btn('st-tog', s.studio_id, s.status === 'Available' ? 'Disable' : 'Enable', 1).replace('btn sm', 'btn')}<button type="button" class="btn line sx-dng" data-act="st-del" data-id="${id}">Delete</button></div>
      </div></div>`;
    }).join('');
}

const afterStudio = async msg => {
    await loadCatalog();
    await refresh();
    closeOverlays();
    toast(msg);
};

ACT['st-tog'] = async id => {
    const s = STU.find(x => x.studio_id === +id);
    if (await run(sb.from('studio').update({ status: s.status === 'Available' ? 'Unavailable' : 'Available' }).eq('studio_id', s.studio_id)))
        afterStudio(`${s.name} updated.`);
};

/* the arrows: swap two neighbours and save the whole order as 1, 2, 3... (only rows that changed are written) */
const move = async (id, dir) => {
    const list = [...STU], i = list.findIndex(x => x.studio_id === +id), j = i + dir;
    if (i < 0 || j < 0 || j >= list.length)
        return;
    [list[i], list[j]] = [list[j], list[i]];
    const changes = list.map((x, k) => [x, k + 1]).filter(([x, v]) => x.sort_order !== v);
    const res = await Promise.all(changes.map(([x, v]) => sb.from('studio').update({ sort_order: v }).eq('studio_id', x.studio_id)));
    const bad = res.find(r => r.error);
    if (bad)
        return toast(bad.error.message);
    afterStudio('Order saved. Customers see it in this order.');
};

ACT['st-up'] = id => move(id, -1);

ACT['st-dn'] = id => move(id, 1);

ACT['st-del'] = async id => {
    const s = STU.find(x => x.studio_id === +id), n = BK.filter(b => b.studio_id === s.studio_id).length;
    if (n > 0) {
        showDlg(`<h2 style="margin:0 0 8px">${esc(s.name)} can't be deleted</h2>
      <p class="mut">It has ${pl(n, 'booking')} on record, and deleting the studio would erase that history. Disable it instead: customers can no longer book it, and your records stay intact.</p>
      <div class="acts"><button class="btn line" data-close>Close</button>${s.status === 'Available' ? btn('st-tog', s.studio_id, 'Disable ' + esc(s.name)) : ''}</div>`);
        return;
    }
    // no bookings: it can be deleted, but only after an "Are you sure?"
    const yes = await askConfirm({
        title: `Delete ${s.name}?`,
        message: 'The studio and its photos are removed from the system. It has no bookings. This can\'t be undone.',
        ok: 'Yes, delete studio',
        cancel: 'No, keep it',
        danger: true
    });
    if (!yes)
        return;
    const r = await sb.from('studio').delete().eq('studio_id', s.studio_id);
    if (r.error)
        return toast(r.error.code === '23503' ? `${s.name} has bookings on record, so it can't be deleted. Disable it instead.` : r.error.message);
    afterStudio(`${s.name} deleted.`);
};

/* ---- the Edit window: form on the left, live "Customer view" on the right ---- */

const field = (id, label, value, type, extra = '') => `<div><label for="${id}">${label}</label><input id="${id}" type="${type || 'text'}" value="${esc(value ?? '')}" ${extra}></div>`;

ACT['st-edit'] = id => {
    const s = STU.find(x => x.studio_id === +id), idx = STU.indexOf(s);
    // photos in the window: { id, url, order } for saved ones, { url (blob preview), file } for new ones; removed saved ids are kept apart
    const E = { items: photosOf(s.studio_id).map(p => ({ id: p.photo_id, url: p.url, order: p.sort_order })), removed: [] };
    showDlg(`<form id="se-f" novalidate><h2 style="margin:0 0 12px">Edit ${esc(s.name)}</h2>
    <div class="sx-grid"><div>
      <label>Photos <span class="mut">(the first one is the main view)</span></label>
      <div class="sx-photos" id="se-ph"></div>
      <label for="se-up" style="margin-top:10px">Add photos</label><input id="se-up" type="file" accept="image/jpeg,image/png,image/webp" multiple>
      <div class="sx-two">
        ${field('se-n', 'Name', s.name)}
        ${field('se-r', 'Hourly rate (₱)', num(s.hourly_rate), 'number', 'min="0"')}
        <div class="sx-full"><label for="se-d">Short description</label><textarea id="se-d" rows="2" maxlength="200" style="resize:vertical" placeholder="Short line about the room, e.g. Mid-size band room">${esc(s.description || '')}</textarea></div>
        ${field('se-c', 'Fits up to (players)', s.capacity ?? '', 'number', 'min="1" step="1"')}
        ${field('se-q', 'Room size (sqm)', s.room_size_sqm ?? '', 'number', 'min="0" step="any"')}
        <div><label for="se-s">Status</label><select id="se-s">${STATUSES.map(x => `<option ${x === s.status ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
        ${field('se-l', 'Location', s.location || '')}
      </div>
      <label for="se-a">About this room</label><textarea id="se-a" rows="3" style="resize:vertical" placeholder="Two or three sentences about the sound, the space and what it suits best.">${esc(s.about || '')}</textarea>
      <label for="se-g">Included gear</label><textarea id="se-g" rows="6" style="resize:vertical;min-height:120px" placeholder="One item per line, e.g.&#10;Drum set with cymbals&#10;1 Guitar amp, 4x10 cab&#10;2 Mics with stand&#10;Electric guitars not included">${esc(s.room_specs || '')}</textarea>
      <p class="mut sx-m">One item per line. A line that says “not included” is shown as a note. Opening hours are set in Settings.</p>
    </div>
    <div class="card sx-pv" id="se-pv" aria-live="polite"></div></div>
    <div class="alert" id="se-e" hidden></div>
    <div class="acts"><button type="button" class="btn line" data-close>Cancel</button><button class="btn gold">Save changes</button></div></form>`);
    dlg.classList.add('wide', 'sx-dlg');
    dlg.addEventListener('close', () => {
        dlg.classList.remove('wide', 'sx-dlg');
        E.items.forEach(it => it.file && URL.revokeObjectURL(it.url));   // free the preview of photos that were never saved
    }, { once: true });

    const pv = () => {
        const name = $('#se-n').value.trim() || 'Studio', d = $('#se-d').value.trim(), st = $('#se-s').value;
        const { items, notes } = specsOf('', $('#se-g').value);
        const meta = [$('#se-c').value ? `Fits up to ${esc($('#se-c').value)} players` : '', $('#se-q').value ? `${esc($('#se-q').value)} sqm` : '', esc($('#se-l').value.trim())].filter(Boolean).join(' · ');
        const about = $('#se-a').value.trim();
        $('#se-pv').innerHTML = `<h3>Customer view</h3><p class="mut sx-m">Updates as you type.</p>
      <div style="margin:10px 0 8px">${photoBox(E.items[0]?.url, name, idx)}</div>
      <h3>${esc(name)}${d ? ` · ${esc(d)}` : ''}${st !== 'Available' ? ` ${badge(st)}` : ''}</h3>
      ${meta ? `<p class="mut sx-m">${meta}</p>` : ''}
      <p style="margin:8px 0"><b class="sx-price">${money($('#se-r').value || 0)}</b> <span class="mut">/ hour</span></p>
      ${about ? `<p class="mut sx-m" style="white-space:pre-line">${esc(about)}</p>` : ''}
      ${items.length ? `<ul>${items.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
      ${notes.length ? `<p class="mut sx-m">${notes.map(esc).join('<br>')}</p>` : ''}`;
    };

    const photos = () => {
        const last = E.items.length - 1;
        $('#se-ph').innerHTML = E.items.map((it, k) => `<div class="sx-pi"><div class="ph has"><img src="${esc(it.url)}" alt="Photo ${k + 1}" width="120" height="84" decoding="async">${k ? '' : '<span class="tag">Main</span>'}</div>
      <span class="sx-pt">${k ? `<button type="button" data-pa="main" data-k="${k}">Make main</button>` : ''}<button type="button" data-pa="left" data-k="${k}" aria-label="Move photo ${k + 1} earlier"${k ? '' : ' disabled'}>‹</button><button type="button" data-pa="right" data-k="${k}" aria-label="Move photo ${k + 1} later"${k < last ? '' : ' disabled'}>›</button><button type="button" data-pa="rm" data-k="${k}" aria-label="Remove photo ${k + 1}">Remove</button></span></div>`).join('')
            || '<p class="mut sx-m" style="grid-column:1/-1">No photos yet. Customers see a coloured tile until you add one.</p>';
        pv();
    };
    photos();

    $('#se-f').addEventListener('input', pv);
    $('#se-f').addEventListener('click', e => {
        const b = e.target.closest('[data-pa]');
        if (!b)
            return;
        const k = +b.dataset.k, a = b.dataset.pa, it = E.items;
        if (a === 'main')
            it.unshift(it.splice(k, 1)[0]);
        else if (a === 'left' && k > 0)
            [it[k - 1], it[k]] = [it[k], it[k - 1]];
        else if (a === 'right' && k < it.length - 1)
            [it[k + 1], it[k]] = [it[k], it[k + 1]];
        else if (a === 'rm') {
            const [gone] = it.splice(k, 1);
            if (gone.id)
                E.removed.push(gone.id);
            else
                URL.revokeObjectURL(gone.url);
        }
        photos();
    });
    $('#se-up').onchange = e => {
        [...e.target.files].forEach(file => E.items.push({ file, url: URL.createObjectURL(file) }));
        e.target.value = '';
        photos();
    };

    $('#se-f').onsubmit = async ev => {
        ev.preventDefault();
        const err = m => {
            $('#se-e').textContent = m;
            $('#se-e').hidden = !m;
        };
        const name = $('#se-n').value.trim(), rate = Number($('#se-r').value);
        const cap = $('#se-c').value.trim(), sqm = $('#se-q').value.trim();
        if (!name)
            return err('Enter a name.');
        if (!(rate >= 0))
            return err('Enter a valid hourly rate.');
        if (cap !== '' && !(Number.isInteger(Number(cap)) && Number(cap) > 0))
            return err('Enter how many players fit as a whole number, 1 or more, or leave it empty.');
        if (sqm !== '' && !(Number(sqm) > 0))
            return err('Enter the room size in sqm, or leave it empty.');
        err('');
        const save = $('#se-f .btn.gold');
        save.disabled = true;
        try {
            // 1. upload new photos first, so a failed upload changes nothing
            try {
                for (const it of E.items)
                    if (it.file)
                        it.fresh = await uploadPublic('studio-images', it.file);
            } catch (x) {
                return err('Photo upload failed: ' + x.message);
            }
            // 2. the room itself (studio.image is kept equal to the main photo by the database)
            const patch = {
                name,
                description: $('#se-d').value.trim() || null,
                room_specs: $('#se-g').value.trim() || null,
                hourly_rate: rate,
                status: $('#se-s').value,
                capacity: cap === '' ? null : Number(cap),
                room_size_sqm: sqm === '' ? null : Number(sqm),
                location: $('#se-l').value.trim() || null,
                about: $('#se-a').value.trim() || null
            };
            if (!await run(sb.from('studio').update(patch).eq('studio_id', s.studio_id)))
                return;
            // 3. photos: removals, then new order of the saved ones, then the new ones
            let ok = true;
            if (E.removed.length)
                ok = !!await run(sb.from('studio_photo').delete().in('photo_id', E.removed));
            for (const [k, it] of E.items.entries()) {
                if (!ok)
                    break;
                if (it.id && it.order !== k)
                    ok = !!await run(sb.from('studio_photo').update({ sort_order: k }).eq('photo_id', it.id));
            }
            const fresh = E.items.map((it, k) => it.file ? { studio_id: s.studio_id, url: it.fresh, sort_order: k } : null).filter(Boolean);
            if (ok && fresh.length)
                ok = !!await run(sb.from('studio_photo').insert(fresh));
            if (!ok) {
                await refresh();   // show what did get saved
                return;
            }
            afterStudio(`${name} saved.`);
        } finally {
            save.disabled = false;
        }
    };
};

$('#sbtn').addEventListener('click', async () => {
    if (!OWNER)
        return toast('Only the owner can add studios.');
    const name = $('#sn').value.trim(), rate = Number($('#sr').value);
    const cap = $('#sc').value.trim(), sqm = $('#sq').value.trim();
    if (!name)
        return toast('Enter a studio name.');
    if (!(rate >= 0) || $('#sr').value === '')
        return toast('Enter an hourly rate.');
    if (cap !== '' && !(Number.isInteger(Number(cap)) && Number(cap) > 0))
        return toast('Enter how many players fit as a whole number, 1 or more, or leave it empty.');
    if (sqm !== '' && !(Number(sqm) > 0))
        return toast('Enter the room size in sqm, or leave it empty.');
    const row = {
        name,
        description: $('#sd').value.trim() || null,
        hourly_rate: rate,
        status: $('#ss').value,
        capacity: cap === '' ? null : Number(cap),
        room_size_sqm: sqm === '' ? null : Number(sqm)
    };   // photos, gear and the About text are added with Edit; the database puts a new studio last in the order
    if (await run(sb.from('studio').insert(row))) {
        ['#sn', '#sd', '#sc', '#sq', '#sr'].forEach(s => {
            $(s).value = '';
        });
        afterStudio(`${name} added.`);
    }
});