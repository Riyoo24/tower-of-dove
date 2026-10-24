/* =====================================================================
   admin/rentals.js - Rentals tab
   DB: rental tables (approve, issue, return, reject), signed ID image links.
   ===================================================================== */

import { afterAction, closeOverlays } from './bookings.js';
import { PAY, RL, refresh } from './data.js';
import { ACT, CONFIRM, btn, dOf, dayDiff, money, num, rnStatus, run, tOf, tbl } from './helpers.js';
import { dueToday } from './overview.js';
import { sb } from '../config/supabaseClient.js';
import { loadCatalog } from '../shared/catalog.js';
import { $, badge, esc, pl, shortDate, sum, toast } from '../shared/utils.js';

/* ============================ 7. RENTALS ============================ */

let rf = 'All';

const RF = ['All', 'Pending', 'Verified', 'In Use', 'Due today', 'Overdue', 'Returned', 'Rejected'];

export const TYB = { 'Add-on': '<span class="b addon">Add-on</span>', 'Outside': '<span class="b out">Outside</span>' };

export const lateDays = l => (l.line_returned_at && l.due_at) ? Math.max(0, dayDiff(dOf(l.line_returned_at), dOf(l.due_at))) : 0;

/* ---- overdue is measured in HOURS (a started hour counts as a full hour, like the late fee) ----
   hours_overdue comes from the v_rental_lines view (supabase/13_...sql). If the view has not been
   updated yet, the same number is worked out here from due_at, so the page still works. */
export function overdueHours(l) {
  if (l.hours_overdue !== undefined && l.hours_overdue !== null) return num(l.hours_overdue);
  if (l.status !== 'Active' || l.line_returned_at || !l.due_at) return 0;
  const late = Date.now() - new Date(l.due_at).getTime();
  return late > 0 ? Math.max(1, Math.ceil(late / 36e5)) : 0;
}

/* hours a returned item was late (0 = on time) */
export const lateHours = l => {
  if (!l.line_returned_at || !l.due_at) return 0;
  const late = new Date(l.line_returned_at).getTime() - new Date(l.due_at).getTime();
  return late > 0 ? Math.max(1, Math.ceil(late / 36e5)) : 0;
};

/* A rental that is in use but past its due time shows as Overdue instead of In Use. */
export const lineStatus = l => (l.status === 'Active' && overdueHours(l) > 0) ? 'Overdue' : rnStatus(l.status);
export const groupStatus = g => (g.status === 'Active' && g.lines.some(l => overdueHours(l) > 0)) ? 'Overdue' : rnStatus(g.status);

export function dueB(l) {
  if (overdueHours(l) > 0) return `<span class="b overdue">${pl(overdueHours(l), 'hour')} overdue</span>`;
  if (l.line_returned_at) return lateHours(l) ? `<span class="b out">Returned ${pl(lateHours(l), 'hour')} late</span>` : '<span class="mut">Returned on time</span>';
  if (l.status === 'Active' && dueToday(l)) return '<span class="b duetoday">Due today</span>';
  return '<span class="mut">-</span>';
}

export const dueLabel = l => !l.due_at ? '-' : shortDate(dOf(l.due_at)) + ', ' + tOf(l.due_at);

export function groups() {
  const map = new Map();
  RL.forEach(l => {
    if (!map.has(l.rental_ref)) map.set(l.rental_ref, { ref: l.rental_ref, type: l.rental_type, source: l.source, status: l.status, customer: l.customer_name, phone: l.customer_number, booking: l.booking_ref, reason: l.rejected_reason, lines: [] });
    map.get(l.rental_ref).lines.push(l);
  });
  return [...map.values()];
}

const gMatch = (g, f) => f === 'All' || (f === 'Overdue' ? groupStatus(g) === 'Overdue' : f === 'Due today' ? g.lines.some(l => l.status === 'Active' && dueToday(l)) : groupStatus(g) === f);

/* Verify is shown only while something still has to be verified: the rental itself is Pending,
   or its payment (an add-on rides on its booking's payment) is Pending. After that it is a Details button. */
function needsVerify(g) {
  if (g.status === 'Pending') return true;
  const own = PAY.find(p => p.reference === g.ref);
  if (own && own.status === 'Pending') return true;
  if (g.type === 'Add-on' && g.booking) { const bp = PAY.find(p => p.reference === g.booking && p.kind === 'Booking'); if (bp && bp.status === 'Pending') return true; }
  return false;
}

function rnActions(g) {
  if (needsVerify(g)) return btn('rn-verify', g.ref, 'Verify');            // opens the Verify window in the Payments tab
  if (g.status === 'Approved') return btn('rn-issue', g.ref, 'Issue') + btn('rn-det', g.ref, 'Details', 1);
  if (g.status === 'Active') return btn('rn-ret', g.ref, 'Process return') + btn('rn-det', g.ref, 'Details', 1);
  return btn('rn-det', g.ref, 'Details', 1);
}

let rsrc = '';

export function renderRentals() {
  const gs = groups();
  const list = gs.filter(g => gMatch(g, rf) && (!rsrc || g.source === rsrc));
  if (rf === 'Overdue') list.sort((a, b) => Math.max(...b.lines.map(overdueHours)) - Math.max(...a.lines.map(overdueHours)));
  const cnt = f => f === 'Overdue' ? ' (' + gs.filter(g => gMatch(g, 'Overdue')).length + ')' : f === 'Pending' ? ' (' + gs.filter(g => g.status === 'Pending').length + ')' : '';
  $('#arn').innerHTML = `<div class="row" style="margin-bottom:10px;justify-content:flex-start"><select id="rn-src" style="max-width:190px" aria-label="Rental source"><option value="">Online and onsite</option><option value="Online" ${rsrc === 'Online' ? 'selected' : ''}>Online rentals</option><option value="Onsite" ${rsrc === 'Onsite' ? 'selected' : ''}>Onsite rentals</option></select></div><div class="tabs">${RF.map(x => `<button data-rf="${x}" class="${x === rf ? 'on' : ''}">${x}${cnt(x)}</button>`).join('')}</div>` +
    '<div class="card"><div class="tw">' + tbl(['Order', 'Customer', 'Items', 'Rent type', 'Status', 'Actions'],
      list.map(g => [`<button class="lk" data-act="${needsVerify(g) ? 'rn-verify' : 'rn-det'}" data-id="${esc(g.ref)}">${esc(g.type === 'Add-on' ? (g.booking || g.ref) : g.ref)}</button>`,
        esc(g.customer), g.lines.length === 1 ? esc(g.lines[0].equipment_name) + ' x' + g.lines[0].quantity : g.lines.length + ' items',
        TYB[g.type], badge(groupStatus(g)), rnActions(g)])) + '</div></div>';
}

$('#arn').addEventListener('click', e => { const t = e.target.closest('[data-rf]'); if (t) { rf = t.dataset.rf; renderRentals(); } });

$('#arn').addEventListener('change', e => { if (e.target.id === 'rn-src') { rsrc = e.target.value; renderRentals(); } });

export const setRental = async (ref, status, reason) => {
  const patch = { status }; if (reason) patch.rejected_reason = reason;
  if (await run(sb.from('rental_order').update(patch).eq('rental_ref', ref))) {
    await loadCatalog();
    afterAction({ Approved: `${ref} approved.`, Active: `${ref} issued.`, Rejected: `${ref} rejected. The customer will see: ${reason}.` }[status]);
  }
};

const rnWho = ref => { const g = groups().find(x => x.ref === ref); return g ? `${ref} (${g.customer})` : ref; };

CONFIRM['rn-ok'] = ref => ({ title: 'Approve this rental?', message: `${rnWho(ref)} will be marked as Verified.`, ok: 'Yes, approve' });
CONFIRM['rn-issue'] = ref => ({ title: 'Issue the equipment?', message: `Hand over the equipment for ${rnWho(ref)} now? The rental will be marked In Use.`, ok: 'Yes, issue equipment' });
CONFIRM['rn-ret'] = ref => ({ title: 'Process the return?', message: `All equipment in ${rnWho(ref)} will be marked as returned and put back in stock. Any late fee is worked out now.`, ok: 'Yes, process return' });
CONFIRM['rn-retline'] = id => {
  const [ref, eid] = id.split(':'), l = RL.find(x => x.rental_ref === ref && x.equipment_id === +eid);
  return { title: 'Return this item?', message: `${l ? l.equipment_name + ' from ' : ''}${rnWho(ref)} will be marked as returned and put back in stock.`, ok: 'Yes, return item' };
};
CONFIRM['rn-reject-go'] = ref => ({ title: 'Reject this rental?', message: `${rnWho(ref)} will be rejected and the customer will see the reason.`, ok: 'Yes, reject', danger: true });

ACT['rn-ok'] = ref => setRental(ref, 'Approved');

ACT['rn-issue'] = ref => setRental(ref, 'Active');

const lateFeeOf = (ref, eid) => sum(RL.filter(l => l.rental_ref === ref && (!eid || l.equipment_id === eid)).map(l => num(l.late_fee)));

const returnedMsg = (ref, eid, what) => lateFeeOf(ref, eid) > 0
  ? `${what} returned late. Collect the late fee of ${money(lateFeeOf(ref, eid))} from the customer.` : `${what} returned. Stock updated.`;

ACT['rn-ret'] = async ref => {
  if (!(await run(sb.rpc('staff_return_rental', { p_rental_ref: ref, p_equipment_id: null })))) return;
  await loadCatalog(); await refresh(); closeOverlays();
  toast(returnedMsg(ref, null, ref));
};

ACT['rn-retline'] = async id => {
  const [ref, eid] = id.split(':');
  if (!(await run(sb.rpc('staff_return_rental', { p_rental_ref: ref, p_equipment_id: +eid })))) return;
  await loadCatalog(); await refresh(); closeOverlays();
  toast(returnedMsg(ref, +eid, 'Item'));
};

ACT['rn-reject-go'] = ref => {
  let reason = $('#rrs').value;
  if (reason === 'Other') reason = $('#rrs-other').value.trim() || 'Other';
  return setRental(ref, 'Rejected', reason);
};

/* The customer's ID photo is stored in the private rental-ids bucket; only staff can open it.
   A temporary link (10 minutes) is made each time the dialog opens. */
export async function loadRentalId(ref, boxId = 'rn-id') {
  const box = $('#' + boxId);
  if (!box) return;
  const { data: o, error } = await sb.from('rental_order')
    .select('id_type, id_image_path, contact_number, backup_contact, source').eq('rental_ref', ref).maybeSingle();
  if (error || !o) { box.innerHTML = '<p class="mut">Could not load the ID details.</p>'; return; }
  const meta = `<dl class="dl"><dt>ID type</dt><dd>${esc(o.id_type || 'Not recorded')}</dd><dt>Contact</dt><dd>${esc(o.contact_number || '-')}</dd>` +
    (o.backup_contact ? `<dt>Backup contact</dt><dd>${esc(o.backup_contact)}</dd>` : '') + '</dl>';
  if (!o.id_image_path) {
    box.innerHTML = meta + `<p class="mut">${o.source === 'Onsite' ? 'The ID was checked in person at the studio.' : 'No ID photo was attached.'}</p>`;
    return;
  }
  const { data: s, error: e2 } = await sb.storage.from('rental-ids').createSignedUrl(o.id_image_path, 600);
  if (e2 || !s) { box.innerHTML = meta + `<p class="mut">Could not open the ID file${e2 ? ': ' + esc(e2.message) : ''}.</p>`; return; }
  box.innerHTML = meta + (/\.pdf$/i.test(o.id_image_path)
    ? `<a class="btn line sm" href="${s.signedUrl}" target="_blank" rel="noopener">Open ID (PDF)</a>`
    : `<a href="${s.signedUrl}" target="_blank" rel="noopener" title="Open full size"><img class="idimg" src="${s.signedUrl}" alt="Customer ID photo"></a><p class="mut">Click the photo to open it full size.</p>`);
}
