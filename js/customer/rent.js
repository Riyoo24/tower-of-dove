/* =====================================================================
   customer/rent.js - "Rent equipment" tab
   Equipment cards, rental summary, add-on / outside rental request.
   DB: rental request rpc and ID upload for outside rentals.
   ===================================================================== */

import { state } from './state.js';
import { sb } from '../config/supabaseClient.js';
import { loadMyBookings, loadMyRentals } from './data.js';
import { normRef } from './myBookings.js';
import { showSuccess } from './ui.js';
import { BOOKINGS } from '../shared/availability.js';
import { equipmentImage } from '../shared/cards.js';
import { EQUIPMENT, gcashQrUrl } from '../shared/catalog.js';
import { isMember } from '../shared/session.js';
import { $, $$, SLOTS, TODAY, badge, dayOffset, esc, longDate, manilaParts, manilaTS, peso, shortDate, sum, toast } from '../shared/utils.js';

/* ============================ 3. RENT EQUIPMENT ============================ */

const unitPrice = e => state.rentMode === 'addon' ? e.addonPrice : e.outsidePrice;

const hourLabel = h => `${h % 12 || 12}:00 ${h < 12 ? 'AM' : 'PM'}`;

export const fmtDT = ts => { const p = manilaParts(ts); return `${shortDate(p.date)}, ${hourLabel(p.hour)}`; };

/* Guests may add equipment to a studio booking, but outside rentals need an account. */
const outBlocked = () => state.rentMode === 'out' && !isMember();

/* Outside rentals: the price covers the first 8 hours; every extra hour adds price / 8. */
function outsideHours() {
  const pd = $('#pd').value, rd = $('#rd').value;
  if (!pd || !rd) return null;
  const h = (new Date(manilaTS(rd, +$('#rt').value)) - new Date(manilaTS(pd, +$('#pt').value))) / 3600e3;
  return h > 0 ? h : null;
}

const billedHours = () => Math.max(8, Math.ceil(outsideHours() || 8));

function lineTotal(i) {
  const e = EQUIPMENT[i], c = state.cart[i], unit = unitPrice(e);
  return state.rentMode === 'out' ? unit * c.q * billedHours() / 8 : unit * c.q;
}

/* base price, extra hours, total, down payment (50%) and balance for the current outside rental */
function rentalMoney() {
  const keys = Object.keys(state.cart), hrs = billedHours();
  const base = sum(keys.map(i => unitPrice(EQUIPMENT[i]) * state.cart[i].q));
  const extraHrs = hrs - 8, extra = base / 8 * extraHrs, total = base + extra, down = Math.round(total * 50) / 100;
  return { base, extraHrs, extra, total, down, balance: total - down };
}

function renderSummary() {
  const box = $('#rsum'), keys = Object.keys(state.cart);
  if (state.rentMode !== 'out' || !keys.length) { box.hidden = true; return; }
  const m = rentalMoney();
  box.hidden = false;
  box.innerHTML =
    `<div><span>Rental (first 8 hours)</span><span>${peso(m.base)}</span></div>` +
    (m.extraHrs ? `<div><span>Extra hours (${m.extraHrs} x ${peso(m.base / 8)})</span><span>${peso(m.extra)}</span></div>` : '') +
    `<div><b style="color:var(--ink)">Down payment due now (50%)</b><b style="color:var(--ink)">${peso(m.down)}</b></div>` +
    `<div><span>Balance to pay at pick-up</span><span>${peso(m.balance)}</span></div>`;
  if ($('#oq-amt')) $('#oq-amt').textContent = peso(m.down);
}

function renderDuration() {
  const el = $('#rdur'), h = outsideHours();
  el.textContent = h === null ? 'The return must be after the pick-up.'
    : h < 8 ? `Rental length: ${h} hour${h === 1 ? '' : 's'}. The price covers up to 8 hours, so returning early does not lower it.`
    : h === 8 ? 'Rental length: 8 hours (the full base duration, included in the price).'
    : `Rental length: ${h} hours. ${Math.ceil(h) - 8} extra hour${Math.ceil(h) - 8 === 1 ? '' : 's'} added to the price.`;
}

/* category filter above the equipment cards (same idea as the add-on equipment window) */
let rentCat = 'All';

/* Only equipment offered for the chosen kind of rent is listed:
   studio add-ons show the items allowed as add-ons, outside rent shows the items allowed to be taken out. */
const isOffered = e => state.rentMode === 'addon' ? e.addon : e.outside;

function renderCategories() {
  const cats = ['All', ...new Set(EQUIPMENT.filter(isOffered).map(e => e.category).filter(Boolean))];
  if (!cats.includes(rentCat)) rentCat = 'All';
  $('#eq-cats').innerHTML = cats.map(c => `<button type="button" data-cat="${esc(c)}" class="${c === rentCat ? 'on' : ''}">${esc(c)}</button>`).join('');
}

export function renderEquipment() {
  renderCategories();
  const shown = EQUIPMENT.filter(isOffered).filter(e => rentCat === 'All' || e.category === rentCat);
  if (!shown.length) {
    $('#eq').innerHTML = `<p class="mut">No equipment is offered ${state.rentMode === 'addon' ? 'as a studio add-on' : 'for outside rent'} right now.</p>`;
    return;
  }
  $('#eq').innerHTML = EQUIPMENT.map((e, i) => {
    if (!isOffered(e) || (rentCat !== 'All' && e.category !== rentCat)) return '';   // hidden, not shown as unavailable
    const ok = e.stock > 0 && !outBlocked();
    const unit = state.rentMode === 'addon' ? (e.drum ? 'per rental' : 'per session') : 'per 8 hours, then 1/8 per extra hour';

    const info = e.drum
      ? `<p class="mut">${esc(e.drum.kit)}, ${e.drum.vip ? 'VIP' : 'Basic'} set-up</p>
         ${e.desc ? `<p class="mut" style="margin-top:4px">${esc(e.desc)}</p>` : ''}
         <details class="dset"><summary>What's included</summary><ul>
           <li>Cymbals (Trojan B8): ${e.drum.vip ? '2 crash, 1 ride, hi-hat, splash' : '1 crash, 1 ride, hi-hat'}</li>
           <li>Hardware: stands, throne, carpet</li>
           <li>Skins: Remo and Evans</li>
           <li>Base rental: 8 hours</li>
           <li>No service</li></ul></details>`
      : `${e.desc ? `<p class="mut" style="margin-top:4px">${esc(e.desc)}</p>` : ''}<p class="mut">${e.stock} available</p>`;

    const control = e.drum
      ? '<span class="mut" style="white-space:nowrap">1 set</span>'
      : `<input class="qty" type="number" min="1" max="${e.stock}" value="1" aria-label="Quantity" data-q="${i}" ${ok ? '' : 'disabled'}>`;

    return `
      <div class="card" data-eq="${i}">
        ${equipmentImage(e)}
        <p class="cat">${esc(e.category || '')}</p>
        <div class="row"><h3>${esc(e.name)}</h3>${e.stock < 2 && !e.drum ? badge('Low') : ''}</div>
        ${info}
        <p style="margin-top:6px">${e.addon ? '<span class="b addon">Add-on</span> ' : ''}${e.outside ? '<span class="b out">Outside</span>' : ''}</p>
        <div class="row" style="margin-top:10px;flex-wrap:wrap">
          <span><b>${peso(unitPrice(e))}</b> <span class="mut">${unit}</span></span>
          <span class="row" style="margin-left:auto">${control}<button class="btn sm" data-add="${i}" ${ok ? '' : 'disabled'}>Add</button></span>
        </div>
      </div>`;
  }).join('');
}

export function renderCart() {
  const keys = Object.keys(state.cart);

  $('#bundle-tag-wrap').innerHTML = state.rentMode === 'out' && keys.length >= 2
    ? `<div class="bundle-tag">Rental bundle: ${keys.length} items</div>` : '';

  $('#cart').innerHTML = keys.length
    ? keys.map(i => {
        const e = EQUIPMENT[i], c = state.cart[i];
        const label = state.rentMode === 'out' ? `${esc(e.name)} x ${c.q} (${billedHours()} hrs)` : `${esc(e.name)} x ${c.q}`;
        return `<li><span>${label} <button class="lk" data-rm="${i}" aria-label="Remove ${esc(e.name)}">Remove</button></span><span>${peso(lineTotal(i))}</span></li>`;
      }).join('')
    : '<li><span class="mut">Nothing added yet</span><span></span></li>';

  $('#ctt').textContent = peso(keys.reduce((n, i) => n + lineTotal(i), 0));
  renderSummary();
  renderDuration();
}

/* A guest has no account, so they type the booking reference code. The booking must exist, belong to
   a guest booking (the database hides registered accounts' bookings) and still be open. */
let attachBooking = null;   // { ref, text } once the guest's code has been found

async function findGuestBooking() {
  const info = $('#lb-info'), ref = normRef($('#lb-ref').value);
  attachBooking = null;
  if (!ref) { info.className = 'mut'; info.textContent = 'Enter the booking reference code first.'; updateRequestButton(); return; }
  info.className = 'mut'; info.textContent = 'Looking for that booking...';
  const { data, error } = await sb.rpc('lookup_booking', { p_ref: ref });
  if (error || !data) {
    info.className = 'bad-text'; info.textContent = `No booking found for ${ref}. Check the code and try again. If you booked with an account, log in instead.`;
  } else if (!['Pending', 'Approved', 'In Progress'].includes(data.status)) {
    info.className = 'bad-text'; info.textContent = `${data.booking_ref} is ${data.status.toLowerCase()}, so equipment can't be added to it.`;
  } else {
    const a = manilaParts(data.start_at), z = manilaParts(data.end_at);
    attachBooking = { ref: data.booking_ref };
    info.className = 'ok-text';
    info.textContent = `Found ${data.booking_ref}: ${data.studio}, ${longDate(a.date)}, ${hourLabel(a.hour)} to ${hourLabel(z.hour)}. Current total ${peso(+(data.grand_total ?? data.total))}.`;
  }
  updateRequestButton();
}

export function renderRentMode() {
  $('#fa-member').hidden = !isMember();
  $('#fa-guest').hidden = isMember();
  $('#fa').hidden = state.rentMode !== 'addon';
  $('#fo').hidden = state.rentMode === 'addon';
  $('#fo-guest').hidden = !outBlocked();
  $('#fo-form').hidden = outBlocked();
  $('#rmh').textContent = state.rentMode === 'addon'
    ? 'Used inside the studio you booked. Tied to your booking reference. Priced per session; drum sets are priced per rental.'
    : 'Taken out of the studio, for registered customers. The price covers 8 hours and every extra hour adds one-eighth of the price. Pay a 50% down payment now and the rest at pick-up. You get an OUT reference instead of a booking reference.';
  $$('#rm button').forEach(b => b.classList.toggle('on', b.dataset.m === state.rentMode));
  renderEquipment();
  updateRequestButton();
}

/* Outside rentals need a member account and an ID file before the request button unlocks. */
function updateRequestButton() {
  $('#rq').disabled = state.rentMode === 'out' ? (outBlocked() || !$('#vf').files.length)
                                         : (!isMember() && !attachBooking);   // a guest needs a found booking first
}

/* Bookings an add-on can be attached to: upcoming and not cancelled. */
export function renderAttachOptions() {
  const usable = BOOKINGS.filter(b => b.mine && b.date >= TODAY && ['Pending', 'Confirmed', 'Active'].includes(b.status));
  $('#lb').innerHTML = usable.length
    ? usable.map(b => `<option value="${b.ref}">${b.ref} - Studio ${b.studio}, ${b.date === TODAY ? 'today' : shortDate(b.date)} ${b.start}</option>`).join('')
    : '<option value="">No upcoming booking. Book a studio first.</option>';
}

function loadRentalQr() {
  const img = $('#oq-img');
  img.onload = () => { img.hidden = false; };
  img.onerror = () => {
    img.hidden = true;
    $('#oq-note').innerHTML = 'Pay the down payment of <b id="oq-amt"></b> using the studio\'s GCash account, then enter the reference number from your receipt below. Ask staff if you need the account details.';
    renderSummary();
  };
  img.src = gcashQrUrl();
}

export function initRentTab() {
  // pick-up times: studio hours; return times also allow 10:00 PM closing
  $('#pt').innerHTML = SLOTS.map((t, i) => `<option value="${10 + i}">${t}</option>`).join('');
  $('#rt').innerHTML = SLOTS.map((t, i) => `<option value="${10 + i}">${t}</option>`).join('') + '<option value="22">10:00 PM</option>';
  $('#pd').min = $('#rd').min = TODAY;
  $('#pd').value = $('#rd').value = dayOffset(1);
  $('#pt').value = '10';
  $('#rt').value = '18';
  loadRentalQr();

  $('#rm').addEventListener('click', e => {
    const m = e.target.dataset.m;
    if (!m) return;
    state.rentMode = m;
    state.cart = {};
    renderCart();
    renderRentMode();
  });

  $('#eq-cats').addEventListener('click', e => {
    const c = e.target.closest('[data-cat]');
    if (!c) return;
    rentCat = c.dataset.cat;
    renderEquipment();
  });

  $('#eq').addEventListener('click', e => {
    const btn = e.target.closest('[data-add]');
    if (!btn) return;
    const i = btn.dataset.add, input = $(`[data-q="${i}"]`);
    state.cart[i] = { q: input ? Math.min(Math.max(+input.value || 1, 1), EQUIPMENT[i].stock) : 1 };
    renderCart();
  });

  $('#cart').addEventListener('click', e => {
    const rm = e.target.closest('[data-rm]');
    if (rm) { delete state.cart[rm.dataset.rm]; renderCart(); }
  });

  $('#pd').addEventListener('change', () => {
    $('#rd').min = $('#pd').value || TODAY;
    if ($('#rd').value < $('#pd').value) $('#rd').value = $('#pd').value;
    renderCart();
  });
  ['#rd', '#pt', '#rt'].forEach(sel => $(sel).addEventListener('change', renderCart));
  $('#or-agree').addEventListener('change', e => { if (e.target.checked) $('#or-terms').classList.remove('err'); });
  $('#vf').addEventListener('change', updateRequestButton);
  $('#rq').addEventListener('click', requestRental);
  $('#lb-find').addEventListener('click', findGuestBooking);
  $('#lb-ref').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); findGuestBooking(); } });
  $('#lb-ref').addEventListener('input', () => { attachBooking = null; updateRequestButton(); });
}

async function requestRental() {
  const keys = Object.keys(state.cart);
  if (!keys.length) return toast('Add at least one item first.');
  const items = keys.map(i => ({ equipment_id: EQUIPMENT[i].id, quantity: state.cart[i].q }));
  const btn = $('#rq');
  btn.disabled = true;

  try {
    if (state.rentMode === 'addon') {
      const ref = isMember() ? $('#lb').value : (attachBooking && attachBooking.ref);
      if (!ref) return toast(isMember() ? 'Attach the rental to a studio booking first.' : 'Find your booking with its reference code first.');
      const { error } = await sb.rpc('request_rental', { p_type: 'Add-on', p_items: items, p_booking_ref: ref });
      if (error) return toast(error.message);
      const added = items.map(x => { const e = EQUIPMENT.find(y => y.id === x.equipment_id); return ['Added', `${e.name} x${x.quantity}`]; });
      state.cart = {};
      renderCart();
      await loadMyBookings();
      await loadMyRentals();
      // the booking's total now includes the new equipment
      const { data: bk } = await sb.rpc('lookup_booking', { p_ref: ref });
      if (!isMember()) { $('#lb-ref').value = ''; attachBooking = null; $('#lb-info').className = 'mut'; $('#lb-info').textContent = 'Enter the reference code from your booking confirmation. The equipment is added to that booking and its total is updated.'; }
      showSuccess({ title: 'Equipment added to your booking!', label: 'Booking reference code', ref,
        lines: [...added, ...(bk ? [['Booking total now', peso(+(bk.grand_total ?? bk.total))]] : [])],
        shot: 'It is your official receipt. Show it to our staff when you arrive so we can verify your booking and equipment.',
        note: 'Staff review the equipment request. The new total is shown when you look up this booking.' });
      return;
    }

    /* ---- outside rental (members only, with a 50% down payment) ---- */
    if (!isMember()) return toast('Please log in to rent equipment outside the studio.');
    const pd = $('#pd').value, rd = $('#rd').value, ph = +$('#pt').value, rh = +$('#rt').value;
    const first = $('#on-fn').value.trim(), last = $('#on-ln').value.trim();
    const contact = $('#oc').value.trim(), backup = $('#sm-link').value.trim();
    const gref = $('#og').value.replace(/\s/g, ''), file = $('#vf').files[0], hours = outsideHours();

    if (!first || !last) return toast('Enter your first and last name.');
    if (!pd || !rd) return toast('Choose the pick-up and return dates.');
    if (pd < TODAY || (pd === TODAY && ph <= manilaParts(new Date()).hour)) return toast('The pick-up time must be later than now.');
    if (hours === null) return toast('The return time must be after the pick-up time.');
    if (!/^[\d\s+()-]{7,}$/.test(contact)) return toast('Enter a valid contact number.');
    if (backup && !/^[\d\s+()-]{7,}$/.test(backup)) return toast('The backup contact must be a phone number.');
    if (!file) return toast('Attach a valid ID.');
    if (!/^\d{13}$/.test(gref)) return toast('Enter the 13-digit GCash reference number of your down payment.');
    if (!$('#or-agree').checked) {
      $('#or-terms').classList.add('err');
      return toast('Please tick the box to confirm you agree to the rental terms.');
    }

    // upload the ID photo first; the request stores only its path
    const ext = ((file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '')) || 'jpg';
    const path = `${crypto.randomUUID()}/${Date.now()}.${ext}`;
    const up = await sb.storage.from('rental-ids').upload(path, file, { contentType: file.type });
    if (up.error) return toast('Could not upload your ID: ' + up.error.message);

    const money = rentalMoney();
    const { data, error } = await sb.rpc('request_outside_rental', {
      p_items: items, p_first_name: first, p_last_name: last, p_number: contact,
      p_pickup_date: manilaTS(pd, ph), p_return_date: manilaTS(rd, rh),
      p_contact_number: contact, p_backup_contact: backup || null,
      p_id_type: $('#vt').value, p_id_image_path: path, p_gcash_reference: gref
    });
    if (error) return toast(error.message);
    const row = Array.isArray(data) ? data[0] : data;

    state.cart = {};
    $('#vf').value = '';
    $('#og').value = '';
    $('#or-agree').checked = false;
    renderCart();
    await loadMyRentals();
    showSuccess({
      title: 'Rental request sent!', label: 'Your rental reference code', ref: row.rental_ref,
      lines: [
        ['Pick-up', `${shortDate(pd)}, ${hourLabel(ph)}`],
        ['Return', `${shortDate(rd)}, ${hourLabel(rh)}`],
        ['Total', peso(Number(row.total_amount) || money.total)],
        ['Down payment sent', peso(Number(row.down_payment) || money.down)],
        ['Balance at pick-up', peso((Number(row.total_amount) || money.total) - (Number(row.down_payment) || money.down))]
      ],
      shot: 'It is your official receipt. Show it to our staff when you pick up the equipment so we can verify your rental.',
      note: 'Staff will check your ID and verify your down payment. Bring the same ID when you pick up the equipment.'
    });
  } finally {
    btn.disabled = false;
    updateRequestButton();
  }
}
