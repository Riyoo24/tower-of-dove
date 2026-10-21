/* =====================================================================
   admin/onsite.js - Onsite booking and Onsite rental tabs
   DB: onsite booking / rental rpc functions.
   ===================================================================== */

import { BK, STK, refresh } from './data.js';
import { money, num, run, setOpts, tlabel } from './helpers.js';
import { sb } from '../config/supabaseClient.js';
import { loadBusy, takenSlots } from '../shared/availability.js';
import { STUDIOS, loadCatalog } from '../shared/catalog.js';
import { $, SLOTS, TODAY, esc, manilaDay, manilaParts, manilaTS, toast } from '../shared/utils.js';

/* ============================ 10. ONSITE BOOKING & RENTAL ============================ */

const nameParts = n => { const [first, ...rest] = n.trim().split(/\s+/); return [first, rest.join(' ')]; };

export function renderForms() {
  setOpts($('#ob-s'), STUDIOS.map((s, i) => ['Maintenance', 'Unavailable'].includes(s.status) ? '' : `<option value="${i}">Studio ${esc(s.id)}, ${money(s.rate)}/hr</option>`).join(''));
  if (!$('#ob-d').value) $('#ob-d').value = TODAY;
  onbFree();
  orForm();
}

async function onbFree() {
  const si = +$('#ob-s').value, d = $('#ob-d').value, h = +$('#ob-h').value;
  if (!STUDIOS[si] || !d) { $('#ob-t').innerHTML = '<option value="">No free time</option>'; return; }
  await loadBusy(si, d, d);
  const taken = takenSlots(si, d), nowH = manilaParts(new Date()).hour;
  const free = SLOTS.map((_, i) => i).filter(i => i + h <= SLOTS.length && (d !== TODAY || 10 + i >= nowH) && Array.from({ length: h }, (_, j) => !taken.has(i + j)).every(Boolean));
  const cur = $('#ob-t').value;
  $('#ob-t').innerHTML = free.length ? free.map(i => `<option value="${i}">${SLOTS[i]}</option>`).join('') : '<option value="">No free time</option>';
  if (free.map(String).includes(cur)) $('#ob-t').value = cur;
  $('#ob-tot').textContent = money(STUDIOS[si].rate * h);
  $('#ob-gw').hidden = $('#ob-m').value !== 'GCash';
}

['ob-s', 'ob-d', 'ob-h', 'ob-m'].forEach(x => $('#' + x).addEventListener('change', onbFree));

$('#onb').onsubmit = async e => {
  e.preventDefault();
  const si = +$('#ob-s').value, d = $('#ob-d').value, h = +$('#ob-h').value, t = $('#ob-t').value;
  const n = $('#ob-n').value.trim(), m = $('#ob-m').value, g = $('#ob-g').value.trim();
  const er = x => { $('#ob-e').textContent = x; $('#ob-e').hidden = !x; };
  if (!n) return er('Enter the customer name.');
  if (!d) return er('Pick a date.');
  if (t === '') return er('No free time for that studio and date.');
  if (m === 'GCash' && !g) return er('Enter the GCash reference.');
  const [first, last] = nameParts(n);
  const r = await run(sb.rpc('staff_create_onsite_booking', {
    p_studio_id: STUDIOS[si].dbId, p_start_at: manilaTS(d, 10 + +t), p_end_at: manilaTS(d, 10 + +t + h),
    p_first_name: first, p_last_name: last, p_number: $('#ob-p').value.trim() || null,
    p_payment_method: m, p_gcash_reference: m === 'GCash' ? g : null }));
  if (!r) return er('Could not record the booking. See the message above.');
  er('');
  const row = Array.isArray(r.data) ? r.data[0] : r.data;
  $('#onb').reset(); $('#ob-d').value = TODAY;
  await refresh();
  toast(`Onsite booking ${row && row.booking_ref ? row.booking_ref : ''} recorded.`);
};

function orForm() {
  const m = $('#or-m').value;
  const eqs = STK.filter(e => (m === 'a' ? e.allow_addon : e.allow_outside) && e.available > 0 && e.stock_status !== 'Unavailable');
  setOpts($('#or-eq'), eqs.map(e => `<option value="${e.equipment_id}">${esc(e.name)} (${e.available} left, ${money(m === 'a' ? e.add_on_rate : e.outside_rate)})</option>`).join('') || '<option value="">Nothing available</option>');
  ['or-aw'].forEach(x => { $('#' + x).hidden = m !== 'a'; });
  ['or-ow', 'or-rw', 'or-tw', 'or-cw'].forEach(x => { $('#' + x).hidden = m !== 'o'; });
  $('#or-gw').hidden = $('#or-pm').value !== 'GCash';
  setOpts($('#or-b'), BK.filter(b => ['Approved', 'In Progress'].includes(b.status)).map(b => `<option value="${b.booking_ref}">${b.booking_ref}, ${esc(b.customer_name)}</option>`).join('') || '<option value="">No confirmed bookings</option>');
  // start and return choices (studio hours), with sensible defaults: start now, return 8 hours later
  const opt = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `<option value="${from + i}">${tlabel(from + i)}</option>`).join('');
  if (!$('#or-st').options.length) { $('#or-st').innerHTML = opt(10, 22); $('#or-rt').innerHTML = opt(10, 22); }
  if (!$('#or-sd').value) {
    const nowH = manilaParts(new Date()).hour, start = Math.min(22, Math.max(10, nowH)), end = Math.min(22, start + 8);
    $('#or-sd').value = manilaDay(0); $('#or-st').value = String(start);
    $('#or-r').value = manilaDay(0); $('#or-rt').value = String(end);
  }
  orTot();
}

const onsiteHours = () => {
  const sd = $('#or-sd').value, rd = $('#or-r').value;
  if (!sd || !rd) return null;
  const h = (new Date(manilaTS(rd, +$('#or-rt').value)) - new Date(manilaTS(sd, +$('#or-st').value))) / 36e5;
  return h > 0 ? h : null;
};

function orTot() {
  const id = $('#or-eq').value, m = $('#or-m').value, e = STK.find(x => x.equipment_id === +id);
  if (!e) { $('#or-tot').textContent = money(0); return 0; }
  const q = +$('#or-q').value || 1;
  // outside: the price covers 8 hours (an earlier return costs the same), each extra hour adds price / 8
  const len = m === 'o' ? onsiteHours() : null, hrs = m === 'o' ? Math.max(8, Math.ceil(len || 8)) : 8;
  if (m === 'o' && $('#or-dur')) $('#or-dur').textContent = len === null ? 'The return must be after the start.' : len < 8 ? `${len} hours. The 8-hour base price applies.` : `${len} hours billed${len > 8 ? ' (8 hours base + extra hours)' : ''}.`;
  const total = num(m === 'a' ? e.add_on_rate : e.outside_rate) * q * (m === 'o' ? hrs / 8 : 1);
  $('#or-tot').textContent = money(total);
  return total;
}

['or-m', 'or-eq', 'or-q', 'or-r', 'or-pm', 'or-sd', 'or-st', 'or-rt'].forEach(x => $('#' + x).addEventListener('change', () => (x === 'or-m' || x === 'or-pm') ? orForm() : orTot()));

$('#onr').onsubmit = async e => {
  e.preventDefault();
  const m = $('#or-m').value, id = +$('#or-eq').value, q = +$('#or-q').value, pm = $('#or-pm').value, g = $('#or-g').value.trim();
  const er = x => { $('#or-e').textContent = x; $('#or-e').hidden = !x; };
  const eq = STK.find(x => x.equipment_id === id);
  if (!eq) return er('Choose equipment.');
  if (!(q >= 1) || q > eq.available) return er(`Only ${eq.available} of ${eq.name} available.`);
  if (pm === 'GCash' && !g) return er('Enter the GCash reference.');
  const args = { p_type: m === 'a' ? 'Add-on' : 'Outside', p_items: [{ equipment_id: id, quantity: q }], p_booking_ref: null,
    p_first_name: null, p_last_name: null, p_number: null, p_return_date: null, p_id_type: null, p_id_checked: false,
    p_payment_method: pm, p_gcash_reference: pm === 'GCash' ? g : null };
  if (m === 'a') {
    args.p_booking_ref = $('#or-b').value;
    if (!args.p_booking_ref) return er('Choose a confirmed booking.');
  } else {
    const n = $('#or-n').value.trim(), ret = $('#or-r').value, sd = $('#or-sd').value;
    if (!n) return er('Enter the customer name.');
    if (!sd || sd < manilaDay(0)) return er('Choose a start date from today onward.');
    if (!ret || onsiteHours() === null) return er('The return must be after the start.');
    if (!$('#or-id').checked) return er('Confirm that you checked a valid ID.');
    [args.p_first_name, args.p_last_name] = nameParts(n);
    args.p_pickup_date = manilaTS(sd, +$('#or-st').value);
    args.p_return_date = manilaTS(ret, +$('#or-rt').value); args.p_id_type = $('#or-t').value; args.p_id_checked = true;
  }
  const r = await run(sb.rpc('staff_create_onsite_rental', args));
  if (!r) return er('Could not record the rental. See the message above.');
  er('');
  const row = Array.isArray(r.data) ? r.data[0] : r.data;
  await loadCatalog();
  $('#onr').reset(); $('#or-r').value = ''; $('#or-sd').value = '';
  await refresh();
  toast(`Rental ${row && row.rental_ref ? row.rental_ref : ''} saved as Verified. It goes In Use when its start time arrives, or press Issue to start it earlier.`);
};
