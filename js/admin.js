/* =====================================================================
   Tower of Dove Music Studio: owner and staff dashboard (pages/admin.html)
   Connected to Supabase. Helpers (sb, $, esc, peso, toast, badge, STUDIOS,
   loadBusy ...) come from shared.js and supabase-config.js.
   ---------------------------------------------------------------------
   1. SETUP & HELPERS     4. SESSIONS          7. RENTALS      10. ONSITE
   2. LOAD DATA           5. STUDIOS           8. CUSTOMERS    11. REPORTS
   3. OVERVIEW, BOOKINGS, PAYMENTS   6. EQUIPMENT   9. SETTINGS    12. START
   ===================================================================== */
(function () {

/* ============================ 1. SETUP & HELPERS ============================ */

const who = getUser();
if (!who || (who.role !== 'owner' && who.role !== 'staff')) { location.replace(ROOT + 'pages/login.html#login'); return; }
const OWNER = who.role === 'owner';

// pending-request badge next to "Rentals" in the sidebar
(() => { const l = document.querySelector('[data-side="a-rent"] .lbl');
  if (l) l.insertAdjacentHTML('beforeend', '<span class="cnt" id="rcnt" hidden></span>'); })();

const num = n => Number(n) || 0;
const sum = a => a.reduce((x, y) => x + y, 0);
const pl = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
const money = n => peso(Math.round(num(n) * 100) / 100);
const P = ts => manilaParts(ts);
const dOf = ts => P(ts).date;
const tlabel = h => (h % 12 || 12) + ':00 ' + (h < 12 ? 'AM' : 'PM');
const tOf = ts => tlabel(P(ts).hour);
const stampLabel = ts => new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const dayDiff = (a, b) => Math.round((new Date(a + 'T00:00') - new Date(b + 'T00:00')) / 864e5);

// database status -> label shown on screen
const bkStatus = s => ({ 'Approved': 'Confirmed', 'In Progress': 'Active' }[s] || s);
const rnStatus = s => ({ 'Active': 'In Use' }[s] || s);

const tbl = (head, rows) =>
  `<table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>` +
  (rows.length ? rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')
               : `<tr><td colspan="${head.length}" class="mut">Nothing to show.</td></tr>`) + '</tbody></table>';
const tb = (id, head, rows) => { $('#' + id).innerHTML = tbl(head, rows); };
const btn = (act, id, text, line) => `<button class="btn sm ${line ? 'line' : ''}" data-act="${act}" data-id="${esc(id)}">${text}</button>`;
const tabsHtml = (list, cur, key) => `<div class="tabs">${list.map(x => `<button data-${key}="${x}" class="${x === cur ? 'on' : ''}">${x}</button>`).join('')}</div>`;
const KPI = (l, v, color, sub) => `<div class="card kpi"><span class="mut">${l}</span><div class="num" ${color ? `style="color:${color}"` : ''}>${v}</div>${sub ? `<span class="mut">${sub}</span>` : ''}</div>`;
const hbs = (id, rows) => {
  const m = Math.max(...rows.map(r => r[2]), 1);
  $('#' + id).innerHTML = rows.map(r => `<div class="hb"><div class="row" style="background:none;height:auto;margin:0"><span>${esc(r[0])}</span><b>${r[1]}</b></div><div><i style="width:${Math.round(r[2] / m * 100)}%"></i></div></div>`).join('') || '<p class="mut">Nothing in this period.</p>';
};
const setOpts = (sel, html) => {
  const cur = sel.value; sel.innerHTML = html;
  if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
};

/* run a Supabase call; show the error as a message and return null if it failed */
async function run(p) {
  const r = await p;
  if (r.error) { toast(r.error.message); console.error(r.error); return null; }
  return r;
}
async function uploadPublic(bucket, file) {
  const ext = ((file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '')) || 'jpg';
  const path = `${crypto.randomUUID()}.${ext}`;
  const up = await sb.storage.from(bucket).upload(path, file, { contentType: file.type });
  if (up.error) throw new Error(up.error.message);
  return sb.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}
const PHICON = '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-8 8"/></svg>';

/* shared dialog */
const dlg = $('#rdlg');
function showDlg(html) { dlg.innerHTML = `<div class="in">${html}</div>`; dlg.showModal(); }
dlg.addEventListener('click', e => { if (e.target === dlg || e.target.closest('[data-close]')) dlg.close(); });
$('#eqdlg').addEventListener('click', e => { if (e.target.id === 'eqdlg') $('#eqdlg').close(); });

/* every button with data-act runs ACT[name](id) */
const ACT = {};
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b || !ACT[b.dataset.act] || b.dataset.busy) return;
  b.dataset.busy = '1';
  Promise.resolve(ACT[b.dataset.act](b.dataset.id, b)).catch(err => { console.error(err); toast(err.message); }).finally(() => { delete b.dataset.busy; });
});


/* ============================ 2. LOAD DATA ============================ */

let BK = [], PAY = [], RL = [], STK = [], CUS = [], REV = [], CNT = {}, STAFF = [], CATS = [], STU = [];

async function loadAll() {
  const q = t => sb.from(t).select('*');
  const res = await Promise.all([
    q('v_booking_summary').order('start_at', { ascending: false }),
    q('v_payment_queue').order('created_at', { ascending: false }),
    q('v_rental_lines').order('created_at', { ascending: false }),
    q('v_equipment_stock').order('equipment_id'),
    q('v_customer_spending').order('total_spent', { ascending: false }),
    q('v_revenue_daily'),
    q('v_dashboard_counts').maybeSingle(),
    q('app_user').order('user_id'),
    q('equipment_category').order('category_id'),
    q('studio').order('studio_id')
  ]);
  const bad = res.find(r => r.error);
  if (bad) { console.error(bad.error); toast('Could not load dashboard data: ' + bad.error.message); return false; }
  [BK, PAY, RL, STK, CUS, REV, , STAFF, CATS, STU] = res.map(r => r.data);
  CNT = res[6].data || {};
  return true;
}

let polling = false;
async function refresh(poll) {
  if (polling) return;
  polling = true;
  try {
    if (!(await loadAll())) return;
    renderAll(poll);
    if (!poll) renderForms();
  } finally { polling = false; }
}


/* ============================ 3. OVERVIEW, BOOKINGS, PAYMENTS ============================ */

const openLines = () => RL.filter(l => l.status === 'Active' && !l.line_returned_at);
const dueToday = l => l.due_at && dOf(l.due_at) === TODAY && !(l.days_overdue > 0);
const itemCount = a => pl(sum(a.map(l => l.quantity)), 'item');

function renderOverview() {
  $('#a-over .sub').textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) + '. Here is what is happening right now.';
  $('#ovk').innerHTML = KPI('Total bookings', num(CNT.total_bookings)) + KPI("Today's bookings", num(CNT.todays_bookings)) +
                        KPI('Confirmed', num(CNT.confirmed_bookings)) + KPI('Pending', num(CNT.pending_bookings));

  const days = Array.from({ length: 7 }, (_, i) => dayOffset(i - 6));
  const counts = days.map(d => BK.filter(b => dOf(b.start_at) === d && !['Cancelled', 'Rejected'].includes(b.status)).length);
  const max = Math.max(...counts, 1);
  $('#bars').innerHTML = counts.map((v, i) => `<div><i class="${i === 6 ? 'hi' : ''}" style="height:${Math.max(4, Math.round(v / max * 100))}px"></i>${v}<br>${shortDate(days[i])}</div>`).join('');

  const open = openLines();
  const overdue = open.filter(l => l.days_overdue > 0), due = open.filter(dueToday);
  const back = RL.filter(l => l.line_returned_at && dOf(l.line_returned_at) === TODAY);
  $('#rkpi').innerHTML =
    KPI('Overdue rentals', overdue.length, 'var(--bad)', itemCount(overdue) + ' past return date') +
    KPI('To return today', due.length, 'var(--warn)', itemCount(due) + ' still to come back') +
    KPI('Returned today', back.length, 'var(--ok)', itemCount(back) + ' checked in');

  const now = Date.now();
  $('#ost').innerHTML = STU.map(s => {
    const live = BK.find(b => b.studio_id === s.studio_id && b.status === 'In Progress');
    const next = BK.filter(b => b.studio_id === s.studio_id && b.status === 'Approved' && new Date(b.start_at) > now)
                   .sort((a, b) => new Date(a.start_at) - new Date(b.start_at))[0];
    const status = live ? 'Occupied' : s.status;
    const text = live ? `${esc(live.customer_name)}, until ${tOf(live.end_at)}`
      : s.status !== 'Available' ? 'Not taking bookings'
      : next ? `Next: ${dOf(next.start_at) === TODAY ? '' : shortDate(dOf(next.start_at)) + ', '}${tOf(next.start_at)}, ${esc(next.customer_name)}` : 'No upcoming bookings';
    return `<div class="card"><div class="row"><h3><i class="lamp ${live ? 'live' : ''}"></i>${esc(s.name)}</h3>${badge(status)}</div><p class="mut" style="margin-top:6px">${text}</p></div>`;
  }).join('');

  const low = STK.filter(e => e.stock_status === 'Low' || e.stock_status === 'In Use').map(e => e.name + (e.stock_status === 'In Use' ? ' (none left)' : ''));
  $('#ovl').innerHTML =
    `<li><span>Pending payments</span><b>${num(CNT.pending_payments)}</b></li>` +
    `<li><span>Rental requests to review</span><b>${num(CNT.rental_requests)}</b></li>` +
    `<li><span>Active sessions</span><b>${num(CNT.active_sessions)}</b></li>` +
    `<li><span>Equipment currently rented</span><b>${itemCount(open)}</b></li>` +
    `<li><span>Overdue rentals</span><b style="color:var(--bad)">${new Set(overdue.map(l => l.rental_ref)).size}</b></li>` +
    `<li><span>Low-stock equipment</span><b>${esc(low.join(', ') || 'None')}</b></li>`;

  const pn = num(CNT.rental_requests), c = $('#rcnt');
  if (c) { c.textContent = pn; c.hidden = !pn; }
}

/* ---- Bookings ---- */
let bkF = 'All';
const BK_TABS = ['All', 'Pending', 'Confirmed', 'Active', 'Completed', 'Cancelled', 'Rejected'];
const findBk = ref => BK.find(b => b.booking_ref === ref);

function bkActions(b) {
  const id = b.booking_ref;
  if (b.status === 'Pending') return btn('bk-ok', id, 'Confirm') + btn('bk-no', id, 'Reject', 1);
  if (b.status === 'Approved') return btn('bk-go', id, 'Start session') + btn('bk-det', id, 'Details', 1) + btn('bk-cx', id, 'Cancel', 1);
  if (b.status === 'In Progress') return btn('bk-done', id, 'Mark completed') + btn('bk-det', id, 'Details', 1);
  return btn('bk-det', id, 'Details', 1);
}
function renderBookings() {
  const q = ($('#bk-q').value || '').toLowerCase(), sid = $('#bk-s').value, d = $('#bk-d').value;
  const rows = BK.filter(b =>
    (bkF === 'All' || bkStatus(b.status) === bkF) &&
    (!q || `${b.booking_ref} ${b.customer_name} ${b.customer_number || ''}`.toLowerCase().includes(q)) &&
    (!sid || String(b.studio_id) === sid) && (!d || dOf(b.start_at) === d));
  $('#abk').innerHTML = tabsHtml(BK_TABS, bkF, 'bf') + '<div class="tw">' + tbl(
    ['Reference', 'Customer', 'Studio', 'Date', 'Time', 'Duration', 'Status', 'Payment', 'Actions'],
    rows.map(b => [b.booking_ref, esc(b.customer_name) + (b.is_guest ? ' <span class="mut">(guest)</span>' : ''), esc(b.studio_name),
      shortDate(dOf(b.start_at)), tOf(b.start_at), pl(Math.round(num(b.hours)), 'hr'),
      badge(bkStatus(b.status)), badge(b.payment_status || 'Pending'), bkActions(b)])) + '</div>';
}
$('#abk').addEventListener('click', e => { const t = e.target.closest('[data-bf]'); if (t) { bkF = t.dataset.bf; renderBookings(); } });
['#bk-q', '#bk-s', '#bk-d'].forEach(s => $(s).addEventListener('input', renderBookings));

const afterAction = async msg => { await refresh(); if (dlg.open) dlg.close(); if (msg) toast(msg); };
const setBooking = (b, status, extra) => run(sb.from('booking').update({ status, ...(extra || {}) }).eq('booking_id', b.booking_id));

ACT['bk-ok'] = async ref => {
  const b = findBk(ref);
  const r = b.payment_id ? await run(sb.from('payment').update({ status: 'Verified' }).eq('payment_id', b.payment_id)) : await setBooking(b, 'Approved');
  if (r) afterAction(`${ref} confirmed. Payment verified.`);
};
ACT['bk-no'] = async ref => {
  const b = findBk(ref);
  const r = b.payment_id ? await run(sb.from('payment').update({ status: 'Rejected' }).eq('payment_id', b.payment_id)) : await setBooking(b, 'Rejected', { rejected_reason: 'Rejected by staff' });
  if (r) afterAction(`${ref} rejected.`);
};
ACT['bk-go'] = async ref => { if (await setBooking(findBk(ref), 'In Progress')) afterAction(`${ref} started.`); };
ACT['bk-done'] = async ref => { if (await setBooking(findBk(ref), 'Completed')) afterAction(`${ref} marked completed.`); };
ACT['bk-cx'] = async ref => {
  if (!confirm(`Cancel booking ${ref}? The time slot is released.`)) return;
  if (await run(sb.rpc('cancel_booking', { p_booking_ref: ref }))) afterAction(`${ref} cancelled.`);
};
ACT['bk-det'] = ref => {
  const b = findBk(ref);
  showDlg(`<div class="row"><h2 style="margin:0">${esc(b.booking_ref)}</h2>${badge(bkStatus(b.status))}</div>
    <dl class="dl"><dt>Customer</dt><dd>${esc(b.customer_name)}${b.is_guest ? ' (guest)' : ''}</dd><dt>Phone</dt><dd>${esc(b.customer_number || 'Not on file')}</dd>
    <dt>Studio</dt><dd>${esc(b.studio_name)}</dd><dt>Date</dt><dd>${longDate(dOf(b.start_at))}</dd>
    <dt>Time</dt><dd>${tOf(b.start_at)} to ${tOf(b.end_at)} (${pl(Math.round(num(b.hours)), 'hr')})</dd>
    <dt>Total</dt><dd>${money(b.total_amount)}</dd><dt>Payment</dt><dd>${badge(b.payment_status || 'Pending')} ${esc(b.payment_method || '')}${b.gcash_reference ? ', ref ' + esc(b.gcash_reference) : ''}</dd>
    <dt>Source</dt><dd>${esc(b.source)}</dd></dl><div class="acts"><button class="btn line" data-close>Close</button></div>`);
};

/* ---- Payments ---- */
let payF = 'All';
function renderPayments() {
  const rows = PAY.filter(p => payF === 'All' || p.status === payF);
  $('#apy').innerHTML = tabsHtml(['All', 'Pending', 'Verified', 'Rejected'], payF, 'pf') + '<div class="tw">' + tbl(
    ['Reference', 'Customer', 'Amount', 'Method', 'Payment reference', 'Status', 'Actions'],
    rows.map(p => [esc(p.reference) + ` <span class="mut">${p.kind}</span>`, esc(p.customer_name), money(p.amount), esc(p.method),
      p.method === 'GCash' ? esc(p.gcash_reference || '') : 'Pay at studio', badge(p.status),
      p.status === 'Pending' ? btn('pay-ok', p.payment_id, 'Verify') + btn('pay-no', p.payment_id, 'Reject', 1) : '-'])) + '</div>';
}
$('#apy').addEventListener('click', e => { const t = e.target.closest('[data-pf]'); if (t) { payF = t.dataset.pf; renderPayments(); } });
const setPay = async (id, status) => { if (await run(sb.from('payment').update({ status }).eq('payment_id', +id))) afterAction('Payment ' + status.toLowerCase() + '.'); };
ACT['pay-ok'] = id => setPay(id, 'Verified');
ACT['pay-no'] = id => setPay(id, 'Rejected');


/* ============================ 4. SESSIONS ============================ */

function renderSessions() {
  const live = BK.filter(b => b.status === 'In Progress');
  const soon = BK.filter(b => b.status === 'Approved' && dOf(b.start_at) === TODAY).sort((a, b) => new Date(a.start_at) - new Date(b.start_at));
  const now = Date.now();
  const liveHtml = live.map(b => {
    const s = new Date(b.start_at).getTime(), e = new Date(b.end_at).getTime(), left = e - now;
    const pct = Math.min(100, Math.max(0, Math.round((now - s) / (e - s) * 100)));
    const lt = left > 0 ? `${Math.floor(left / 36e5)}h ${Math.floor(left / 6e4) % 60}m left` : `Over time by ${Math.ceil(-left / 6e4)} min`;
    return `<div class="card"><div class="row"><h3><i class="lamp live"></i>${esc(b.studio_name)}</h3><span class="b active">Active</span></div>
      <p style="margin:8px 0">${esc(b.customer_name)}</p><p class="mut">${tOf(b.start_at)} to ${tOf(b.end_at)}</p>
      <div class="hb"><b>${lt}</b><div><i style="width:${pct}%"></i></div></div>${btn('bk-done', b.booking_ref, 'Mark completed', 1)}</div>`;
  }).join('');
  const soonHtml = soon.map(b => `<div class="card"><div class="row"><h3>${esc(b.studio_name)}</h3>${badge('Confirmed')}</div>
      <p style="margin:8px 0">${esc(b.customer_name)}</p><p class="mut">${tOf(b.start_at)} to ${tOf(b.end_at)}, today</p>${btn('bk-go', b.booking_ref, 'Start session')}</div>`).join('');
  $('#asess').innerHTML = `<div class="grid ge">${liveHtml || '<div class="card"><p class="mut">No sessions in progress.</p></div>'}</div>` +
    (soonHtml ? `<h2 style="margin:24px 0 12px">Confirmed for today</h2><div class="grid ge">${soonHtml}</div>` : '');
}


/* ============================ 5. STUDIOS ============================ */

function renderStudios() {
  $('#ast').innerHTML = STU.map((s, i) => {
    const c = STUDIO_COLORS[i % STUDIO_COLORS.length], letter = s.name.replace(/^studio\s*/i, '');
    const ph = s.image ? `<div class="ph has"><img src="${esc(s.image)}" alt="${esc(s.name)}"></div>`
                       : `<div class="ph" style="background:linear-gradient(135deg,${c[0]},${c[1]})">${esc(letter)}</div>`;
    return `<div class="card">${ph}<div class="row"><h3>${esc(s.name)}</h3>${badge(s.status)}</div><p class="mut">${esc(s.description || '')}</p>
      <div class="row" style="margin-top:8px"><b>${money(s.hourly_rate)}/hr</b><span>${btn('st-edit', s.studio_id, 'Edit')}${btn('st-tog', s.studio_id, s.status === 'Available' ? 'Disable' : 'Enable', 1)}</span></div></div>`;
  }).join('');
}
const afterStudio = async msg => { await loadCatalog(); await refresh(); if (dlg.open) dlg.close(); toast(msg); };

ACT['st-tog'] = async id => {
  const s = STU.find(x => x.studio_id === +id);
  if (await run(sb.from('studio').update({ status: s.status === 'Available' ? 'Unavailable' : 'Available' }).eq('studio_id', s.studio_id))) afterStudio(`${s.name} updated.`);
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


/* ============================ 6. EQUIPMENT ============================ */

let eqLow = false;
const eqThumb = c => c.image ? `<div class="eqthumb has"><img src="${esc(c.image)}" alt="${esc(c.name)}"></div>` : `<div class="eqthumb" role="img" aria-label="No image yet">${PHICON}</div>`;
const priceTxt = (c, m) => (m === 'a' ? !c.allow_addon : !c.allow_outside) ? 'Not offered' : money(m === 'a' ? c.add_on_rate : c.outside_rate) + (c.is_drum_set ? '/rental' : m === 'a' ? '/session' : '/day');

function renderEquipmentTab() {
  const list = STK.filter(c => !eqLow || c.stock_status === 'Low' || c.stock_status === 'In Use');
  $('#aeq').innerHTML = tbl(['Equipment', 'Category', 'Total', 'Avail.', 'In use', 'Add-on price', 'Outside price', 'Rent options', 'Status', ''],
    list.map(c => {
      const sub = c.is_drum_set ? esc((c.drum_kit || '').replace(/ drum set.*/i, '')) + ', ' + (c.is_vip ? 'VIP' : 'Basic') + ' set-up, 8 hrs minimum' : (c.description ? esc(c.description) : '');
      const chips = OWNER
        ? `<div class="stk"><button class="chip ${c.allow_addon ? 'on' : ''}" data-act="eq-chip" data-id="${c.equipment_id}:allow_addon">Add-on</button><button class="chip ${c.allow_outside ? 'on' : ''}" data-act="eq-chip" data-id="${c.equipment_id}:allow_outside">Outside</button></div>`
        : `${c.allow_addon ? '<span class="b addon">Add-on</span> ' : ''}${c.allow_outside ? '<span class="b out">Outside</span>' : ''}`;
      return ['<div class="eqc">' + eqThumb(c) + '<div>' + (c.is_drum_set ? '<b>' + esc(c.name) + '</b>' : esc(c.name)) + (sub ? '<div class="mut eqd">' + sub + '</div>' : '') + '</div></div>',
        esc(c.category_name), String(c.total_quantity), String(c.available), String(c.in_use), priceTxt(c, 'a'), priceTxt(c, 'o'), chips,
        badge(c.stock_status), OWNER ? btn('eq-edit', c.equipment_id, 'Edit') : ''];
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
    <p class="mut" style="margin-top:6px">${drum ? 'Priced per rental.' : 'Add-on is per session. Outside is per day.'} The 8-hour minimum applies to outside rentals and drum sets.</p>
    <label>Rent options</label><div><button type="button" class="chip ${ad ? 'on' : ''}" id="eqx-ad">Add-on</button><button type="button" class="chip ${ou ? 'on' : ''}" id="eqx-ou">Outside</button></div>
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
  $('#eqx-ad').onclick = ev => { ad = !ad; ev.target.classList.toggle('on', ad); };
  $('#eqx-ou').onclick = ev => { ou = !ou; ev.target.classList.toggle('on', ou); };
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
    const row = { description: $('#eqd').value.trim() || null, category_id: cat, total_quantity: t,
      add_on_rate: ad ? a : null, outside_rate: ou ? o : null, allow_addon: ad, allow_outside: ou, min_hours: (ou || drum) ? 8 : 0, image: img || null };
    try { if (file) row.image = await uploadPublic('equipment-images', file); } catch (x) { return err('Image upload failed: ' + x.message); }
    const r = isNew ? await run(sb.from('equipment').insert({ ...row, name })) : await run(sb.from('equipment').update(row).eq('equipment_id', c.equipment_id));
    if (r) { d.close(); await loadCatalog(); await refresh(); toast(isNew ? name + ' added.' : name + ' updated.'); }
  };
  d.showModal();
}


/* ============================ 7. RENTALS ============================ */

let rf = 'All';
const RF = ['All', 'Pending', 'Approved', 'In Use', 'Due today', 'Overdue', 'Returned', 'Rejected'];
const TYB = { 'Add-on': '<span class="b addon">Add-on</span>', 'Outside': '<span class="b out">Outside</span>' };
const lateDays = l => (l.line_returned_at && l.due_at) ? Math.max(0, dayDiff(dOf(l.line_returned_at), dOf(l.due_at))) : 0;

function dueB(l) {
  if (l.days_overdue > 0) return `<span class="b overdue">${pl(l.days_overdue, 'day')} overdue</span>`;
  if (l.line_returned_at) return lateDays(l) ? `<span class="b out">Returned ${pl(lateDays(l), 'day')} late</span>` : '<span class="mut">Returned on time</span>';
  if (l.status === 'Active' && dueToday(l)) return '<span class="b duetoday">Due today</span>';
  return '<span class="mut">-</span>';
}
const dueLabel = l => !l.due_at ? '-' : l.rental_type === 'Outside' ? shortDate(dOf(l.due_at)) : shortDate(dOf(l.due_at)) + ', ' + tOf(l.due_at);

function groups() {
  const map = new Map();
  RL.forEach(l => {
    if (!map.has(l.rental_ref)) map.set(l.rental_ref, { ref: l.rental_ref, type: l.rental_type, status: l.status, customer: l.customer_name, phone: l.customer_number, booking: l.booking_ref, reason: l.rejected_reason, lines: [] });
    map.get(l.rental_ref).lines.push(l);
  });
  return [...map.values()];
}
const gMatch = (g, f) => f === 'All' || (f === 'Overdue' ? g.lines.some(l => l.days_overdue > 0) : f === 'Due today' ? g.lines.some(l => l.status === 'Active' && dueToday(l)) : rnStatus(g.status) === f);

function rnActions(g) {
  if (g.status === 'Pending') return btn('rn-ok', g.ref, 'Approve') + btn('rn-no', g.ref, 'Reject', 1);
  if (g.status === 'Approved') return btn('rn-issue', g.ref, 'Issue') + btn('rn-det', g.ref, 'Details', 1);
  if (g.status === 'Active') return btn('rn-ret', g.ref, 'Process return') + btn('rn-det', g.ref, 'Details', 1);
  return btn('rn-det', g.ref, 'Details', 1);
}
function renderRentals() {
  const gs = groups();
  const list = gs.filter(g => gMatch(g, rf));
  if (rf === 'Overdue') list.sort((a, b) => Math.max(...b.lines.map(l => l.days_overdue)) - Math.max(...a.lines.map(l => l.days_overdue)));
  const cnt = f => f === 'Overdue' ? ' (' + gs.filter(g => gMatch(g, 'Overdue')).length + ')' : f === 'Pending' ? ' (' + gs.filter(g => g.status === 'Pending').length + ')' : '';
  $('#arn').innerHTML = `<div class="tabs">${RF.map(x => `<button data-rf="${x}" class="${x === rf ? 'on' : ''}">${x}${cnt(x)}</button>`).join('')}</div>` +
    '<div class="card"><div class="tw">' + tbl(['Order', 'Customer', 'Items', 'Rent type', 'Status', 'Actions'],
      list.map(g => [`<button class="lk" data-act="rn-det" data-id="${esc(g.ref)}">${esc(g.type === 'Add-on' ? (g.booking || g.ref) : g.ref)}</button>`,
        esc(g.customer), g.lines.length === 1 ? esc(g.lines[0].equipment_name) + ' x' + g.lines[0].quantity : g.lines.length + ' items',
        TYB[g.type], badge(rnStatus(g.status)), rnActions(g)])) + '</div></div>';
}
$('#arn').addEventListener('click', e => { const t = e.target.closest('[data-rf]'); if (t) { rf = t.dataset.rf; renderRentals(); } });

const setRental = async (ref, status, reason) => {
  const patch = { status }; if (reason) patch.rejected_reason = reason;
  if (await run(sb.from('rental_order').update(patch).eq('rental_ref', ref))) {
    await loadCatalog();
    afterAction({ Approved: `${ref} approved.`, Active: `${ref} issued.`, Rejected: `${ref} rejected. The customer will see: ${reason}.` }[status]);
  }
};
ACT['rn-ok'] = ref => setRental(ref, 'Approved');
ACT['rn-issue'] = ref => setRental(ref, 'Active');
ACT['rn-no'] = ref => rentalDialog(ref, true);
ACT['rn-det'] = ref => rentalDialog(ref);
ACT['rn-ret'] = async ref => { if (await run(sb.rpc('staff_return_rental', { p_rental_ref: ref, p_equipment_id: null }))) { await loadCatalog(); afterAction(`${ref} returned. Stock updated.`); } };
ACT['rn-retline'] = async id => {
  const [ref, eid] = id.split(':');
  if (await run(sb.rpc('staff_return_rental', { p_rental_ref: ref, p_equipment_id: +eid }))) { await loadCatalog(); afterAction('Item returned. Stock updated.'); }
};
ACT['rn-reject-go'] = ref => {
  let reason = $('#rrs').value;
  if (reason === 'Other') reason = $('#rrs-other').value.trim() || 'Other';
  return setRental(ref, 'Rejected', reason);
};

function rentalDialog(ref, focusReject) {
  const g = groups().find(x => x.ref === ref); if (!g) return;
  const st = rnStatus(g.status);
  const short = g.lines.filter(l => { const s = STK.find(x => x.equipment_id === l.equipment_id); return !s || s.available < l.quantity; });
  let h = `<div class="row"><h2 style="margin:0">Rental ${esc(g.ref)}</h2>${badge(st)}</div>
    <dl class="dl"><dt>Customer</dt><dd>${esc(g.customer)}</dd><dt>Phone</dt><dd>${esc(g.phone || 'Not on file')}</dd>
    <dt>Rent type</dt><dd>${TYB[g.type]}</dd><dt>${g.type === 'Add-on' ? 'Booking' : 'Rental ID'}</dt><dd>${esc(g.type === 'Add-on' ? (g.booking || '-') : g.ref)}</dd>
    ${g.reason ? `<dt>Reason</dt><dd>${esc(g.reason)}</dd>` : ''}</dl>
    <div class="tw">${tbl(['Equipment', 'Qty', 'Return by', 'Overdue', ''], g.lines.map(l => [esc(l.equipment_name), String(l.quantity), dueLabel(l), dueB(l),
      g.status === 'Active' && !l.line_returned_at ? btn('rn-retline', g.ref + ':' + l.equipment_id, 'Return', 1) : l.line_returned_at ? 'Returned' : '']))}</div>`;
  if (g.lines.some(l => l.days_overdue > 0)) h += '<div class="alert">This order is overdue. Contact the customer to arrange the return.</div>';
  if (g.status === 'Pending') {
    if (short.length) h += `<div class="alert">Not enough stock for: ${short.map(l => esc(l.equipment_name)).join(', ')}. It can't be approved until stock comes back.</div>`;
    h += `<label for="rrs">Reason if rejecting (the customer sees this)</label><select id="rrs"><option>Equipment not available</option><option>Studio booking not confirmed</option><option>Incomplete or unclear request</option><option>Other</option></select>
      <div id="rrs-other-wrap" hidden><label for="rrs-other">Message to customer</label><input id="rrs-other" maxlength="300" placeholder="Describe the reason"></div>
      <div class="acts"><button class="btn line" data-close>Close</button>${btn('rn-reject-go', g.ref, 'Reject rental').replace('btn sm', 'btn bad')}${btn('rn-ok', g.ref, 'Approve rental').replace('btn sm', 'btn gold')}</div>`;
  } else if (g.status === 'Approved') h += `<div class="acts"><button class="btn line" data-close>Close</button>${btn('rn-issue', g.ref, 'Issue equipment').replace('btn sm', 'btn gold')}</div>`;
  else if (g.status === 'Active') h += `<div class="acts"><button class="btn line" data-close>Close</button>${btn('rn-ret', g.ref, 'Return everything').replace('btn sm', 'btn gold')}</div>`;
  else h += '<div class="acts"><button class="btn line" data-close>Close</button></div>';
  showDlg(h);
  const sel = $('#rrs');
  if (sel) { sel.onchange = () => { $('#rrs-other-wrap').hidden = sel.value !== 'Other'; }; if (focusReject) sel.focus(); }
}


/* ============================ 8. CUSTOMERS ============================ */

function renderCustomers() {
  const q = ($('#cu-q').value || '').toLowerCase();
  tb('acu', ['Name', 'Phone', 'Account', 'Bookings', 'Rentals', 'Total spent', 'Status', ''],
    CUS.filter(c => !q || `${c.customer_name} ${c.number}`.toLowerCase().includes(q))
       .map(c => [esc(c.customer_name), esc(c.number || ''), c.account_type, String(c.bookings), String(c.rentals), money(c.total_spent), esc(c.status || 'Active'), btn('cu-hist', c.customer_id, 'History', 1)]));
}
$('#cu-q').addEventListener('input', renderCustomers);
ACT['cu-hist'] = id => {
  const c = CUS.find(x => x.customer_id === +id);
  const bks = BK.filter(b => b.customer_id === c.customer_id), lines = RL.filter(l => l.customer_id === c.customer_id);
  showDlg(`<div class="row"><h2 style="margin:0">${esc(c.customer_name)}</h2><span class="mut">${c.account_type}</span></div>
    <p class="mut" style="margin:4px 0 12px">${esc(c.number || '')}. Total spent (verified payments): <b>${money(c.total_spent)}</b></p>
    <h3 style="font-size:14px">Studio bookings</h3><div class="tw">${tbl(['Booking', 'Studio', 'Date', 'Hours', 'Amount', 'Status'], bks.map(b => [b.booking_ref, esc(b.studio_name), shortDate(dOf(b.start_at)), String(Math.round(num(b.hours))), money(b.total_amount), badge(bkStatus(b.status))]))}</div>
    <h3 style="font-size:14px;margin-top:14px">Equipment rented</h3><div class="tw">${tbl(['Order', 'Equipment', 'Qty', 'Date', 'Status'], lines.map(l => [l.rental_ref, esc(l.equipment_name), String(l.quantity), shortDate(dOf(l.created_at)), badge(rnStatus(l.status))]))}</div>
    <div class="acts"><button class="btn line" data-close>Close</button></div>`);
};


/* ============================ 9. SETTINGS & STAFF ============================ */

function renderStaff() {
  const head = OWNER ? ['Name', 'Username', 'Role', 'Status', 'Actions'] : ['Name', 'Role', 'Status'];
  tb('stf', head, STAFF.map(u => {
    const name = esc(((u.first_name || '') + ' ' + (u.last_name || '')).trim() || u.username);
    const role = u.role === 'Owner' ? 'Owner/Admin' : 'Staff/Caretaker', status = esc(u.status || 'Active');
    if (!OWNER) return [name, role, status];
    const acts = u.role === 'Staff' ? btn('sf-pw', u.user_id, 'Reset password', 1) + btn('sf-tog', u.user_id, u.status === 'Active' ? 'Deactivate' : 'Activate', 1) : '-';
    return [name, esc(u.username), role, status, acts];
  }));
}

/* Staff accounts are created by the create-staff Edge Function (it holds the service_role key). */
async function fnCall(body) {
  const { data, error } = await sb.functions.invoke('create-staff', { body });
  if (error) {
    let msg = error.message || 'Something went wrong.';
    try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch (e) { /* no body */ }
    if (/failed to send|fetch|not found|404/i.test(msg)) msg = 'Could not reach the create-staff function. Deploy it first (see supabase/README.md).';
    throw new Error(msg);
  }
  if (data && data.error) throw new Error(data.error);
  return data;
}
function staffForm() {
  showDlg(`<form id="sf-f" novalidate><h2 style="margin:0 0 4px">Add staff account</h2>
    <p class="mut">The staff member logs in with this username and password. Give them the temporary password in person.</p>
    <div class="fg" style="grid-template-columns:1fr 1fr"><div><label for="sf-fn">First name</label><input id="sf-fn" autocomplete="off"></div><div><label for="sf-ln">Last name</label><input id="sf-ln" autocomplete="off"></div></div>
    <label for="sf-u">Username</label><input id="sf-u" autocomplete="off" placeholder="e.g. maria.staff">
    <label for="sf-p">Phone (optional)</label><input id="sf-p" autocomplete="off">
    <label for="sf-pw">Temporary password</label><input id="sf-pw" autocomplete="off" placeholder="At least 8 characters">
    <div class="alert" id="sf-e" hidden></div>
    <div class="acts"><button type="button" class="btn line" data-close>Cancel</button><button class="btn gold" id="sf-go">Create account</button></div></form>`);
  $('#sf-f').onsubmit = async ev => {
    ev.preventDefault();
    const err = m => { $('#sf-e').textContent = m; $('#sf-e').hidden = !m; };
    const v = { action: 'create', first_name: $('#sf-fn').value.trim(), last_name: $('#sf-ln').value.trim(), username: $('#sf-u').value.trim().toLowerCase(), number: $('#sf-p').value.trim(), password: $('#sf-pw').value };
    if (!v.first_name || !v.last_name) return err('Enter the first and last name.');
    if (!/^[a-z0-9_.]{3,30}$/.test(v.username)) return err('Username: 3 to 30 letters, numbers, dots or underscores, no spaces.');
    if (v.password.length < 8) return err('The password must be at least 8 characters.');
    $('#sf-go').disabled = true; err('');
    try { await fnCall(v); await afterAction(`Staff account "${v.username}" created.`); }
    catch (x) { err(x.message); $('#sf-go').disabled = false; }
  };
}
ACT['sf-pw'] = id => {
  const u = STAFF.find(x => x.user_id === +id);
  showDlg(`<form id="sp-f" novalidate><h2 style="margin:0 0 4px">Reset password</h2><p class="mut">Set a new temporary password for ${esc(u.username)}.</p>
    <label for="sp-pw">New password</label><input id="sp-pw" autocomplete="off" placeholder="At least 8 characters">
    <div class="alert" id="sp-e" hidden></div>
    <div class="acts"><button type="button" class="btn line" data-close>Cancel</button><button class="btn gold" id="sp-go">Save password</button></div></form>`);
  $('#sp-f').onsubmit = async ev => {
    ev.preventDefault();
    const err = m => { $('#sp-e').textContent = m; $('#sp-e').hidden = !m; }, pw = $('#sp-pw').value;
    if (pw.length < 8) return err('The password must be at least 8 characters.');
    $('#sp-go').disabled = true; err('');
    try { await fnCall({ action: 'reset_password', user_id: u.user_id, password: pw }); dlg.close(); toast(`Password for ${u.username} changed.`); }
    catch (x) { err(x.message); $('#sp-go').disabled = false; }
  };
};
ACT['sf-tog'] = async id => {
  const u = STAFF.find(x => x.user_id === +id), next = u.status === 'Active' ? 'Inactive' : 'Active';
  if (next === 'Inactive' && !confirm(`Deactivate ${u.username}? They can no longer use the dashboard.`)) return;
  if (await run(sb.from('app_user').update({ status: next }).eq('user_id', u.user_id))) afterAction(`${u.username} ${next === 'Active' ? 'activated' : 'deactivated'}.`);
};

async function fillProfile() {
  const { data } = await sb.auth.getUser();
  const me = data && data.user && STAFF.find(u => u.auth_user_id === data.user.id);
  if (!me) return;
  if ($('#an')) $('#an').value = ((me.first_name || '') + ' ' + (me.last_name || '')).trim();
  if ($('#ae')) $('#ae').value = me.username || '';
}
$('#ap-btn').onclick = async () => {
  const pw = $('#ap').value;
  if (pw.length < 8) return toast('Use a password of at least 8 characters.');
  if (await run(sb.auth.updateUser({ password: pw }))) { $('#ap').value = ''; toast('Password changed.'); }
};
const addStaffBtn = $('#st-add');
if (addStaffBtn) addStaffBtn.onclick = () => { if (OWNER) staffForm(); else toast('Only the owner can add staff accounts.'); };


/* ============================ 10. ONSITE BOOKING & RENTAL ============================ */

const nameParts = n => { const [first, ...rest] = n.trim().split(/\s+/); return [first, rest.join(' ')]; };

function renderOnsiteLog() {
  const payBy = {}; PAY.forEach(p => { payBy[p.reference] = p; });
  const rows = [];
  BK.filter(b => b.source === 'Onsite').forEach(b => rows.push([b.created_at, 'Studio booking', b.booking_ref, esc(b.customer_name),
    `${esc(b.studio_name)}, ${shortDate(dOf(b.start_at))} ${tOf(b.start_at)} (${pl(Math.round(num(b.hours)), 'hr')})`, money(b.total_amount), esc(b.payment_method || '')]));
  groups().filter(g => RL.find(l => l.rental_ref === g.ref).source === 'Onsite').forEach(g => {
    const p = payBy[g.ref];
    rows.push([g.lines[0].created_at, g.type === 'Add-on' ? 'Rental (add-on)' : 'Rental (outside)', g.type === 'Add-on' ? (g.booking || g.ref) : g.ref, esc(g.customer),
      g.lines.map(l => esc(l.equipment_name) + ' x' + l.quantity).join(', ') + ', return ' + dueLabel(g.lines[0]), p ? money(p.amount) : '-', p ? esc(p.method) : '']);
  });
  rows.sort((a, b) => new Date(b[0]) - new Date(a[0]));
  const out = rows.slice(0, 40).map(r => [stampLabel(r[0]), ...r.slice(1)]);
  ['ob-log', 'or-log'].forEach(id => tb(id, ['Time', 'Type', 'Ref', 'Customer', 'Details', 'Amount', 'Payment'], out));
}

function renderForms() {
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
  if (!$('#or-r').value) $('#or-r').value = dayOffset(1);
  orTot();
}
function orTot() {
  const id = $('#or-eq').value, m = $('#or-m').value, e = STK.find(x => x.equipment_id === +id);
  if (!e) { $('#or-tot').textContent = money(0); return 0; }
  const q = +$('#or-q').value || 1;
  const days = m === 'o' && !e.is_drum_set ? Math.max(1, dayDiff($('#or-r').value || TODAY, TODAY)) : 1;
  const total = num(m === 'a' ? e.add_on_rate : e.outside_rate) * q * days;
  $('#or-tot').textContent = money(total);
  return total;
}
['or-m', 'or-eq', 'or-q', 'or-r', 'or-pm'].forEach(x => $('#' + x).addEventListener('change', () => (x === 'or-m' || x === 'or-pm') ? orForm() : orTot()));

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
    const n = $('#or-n').value.trim(), ret = $('#or-r').value;
    if (!n) return er('Enter the customer name.');
    if (!ret || ret < TODAY) return er('Choose a valid return date.');
    if (!$('#or-id').checked) return er('Confirm that you checked a valid ID.');
    [args.p_first_name, args.p_last_name] = nameParts(n);
    args.p_return_date = manilaTS(ret, 22); args.p_id_type = $('#or-t').value; args.p_id_checked = true;
  }
  const r = await run(sb.rpc('staff_create_onsite_rental', args));
  if (!r) return er('Could not record the rental. See the message above.');
  er('');
  const row = Array.isArray(r.data) ? r.data[0] : r.data;
  await loadCatalog();
  $('#onr').reset(); $('#or-r').value = '';
  await refresh();
  toast(`Rental ${row && row.rental_ref ? row.rental_ref : ''} issued. Stock updated.`);
};


/* ============================ 11. REPORTS ============================ */

let rp = 'Month', rt = 'Booking', cFrom = dayOffset(-30), cTo = TODAY, hc = null;
const RT = {
  Booking: 'Total bookings, how many are confirmed, pending, completed or cancelled, and bookings per studio.',
  Sales: 'Verified payments for studio bookings and equipment, split by studio and by equipment.',
  Rental: 'How often each item was rented and the income it earned (estimated from rental lines).',
  Customer: 'Customers who spent in this period and how much. Use View history for the details.',
  Inventory: 'Current stock for each item: available, in use and low stock. This is a snapshot, so the period filter does not apply.',
  Returns: 'Rentals returned on time or late, and equipment that is overdue right now.'
};
function rangeOf() {
  if (rp === 'Today') return [TODAY, TODAY];
  if (rp === 'Week') return [dayOffset(-6), TODAY];
  if (rp === 'Month') { const y = +TODAY.slice(0, 4), m = +TODAY.slice(5, 7); return [`${y}-${pad(m)}-01`, `${y}-${pad(m)}-${pad(new Date(y, m, 0).getDate())}`]; }
  return [cFrom <= cTo ? cFrom : cTo, cFrom <= cTo ? cTo : cFrom];
}
/* estimated income of one rental line: outside rentals are per day (drum sets per rental) */
function lineIncome(l) {
  const e = STK.find(x => x.equipment_id === l.equipment_id);
  const days = l.rental_type === 'Outside' && !(e && e.is_drum_set) ? Math.max(1, Math.ceil(num(l.rental_hours) / 24)) : 1;
  return num(l.unit_price_at_request) * l.quantity * days;
}

function renderReports() {
  const [lo, hi] = rangeOf(), inR = d => d >= lo && d <= hi, inv = rt === 'Inventory';
  const bks = BK.filter(b => inR(dOf(b.start_at)));
  const lines = RL.filter(l => !['Rejected', 'Cancelled'].includes(l.status) && inR(dOf(l.created_at)));
  const revs = REV.filter(r => inR(r.day));
  const label = lo === hi ? shortDate(lo) : shortDate(lo) + ' to ' + shortDate(hi);
  const card = (x, y) => `<div class="grid ge" style="margin-top:16px"><div class="card"><h3>${x}</h3><div id="h1"></div></div><div class="card"><h3>${y}</h3><div id="h2"></div></div></div>`;
  const wide = h => `<div class="card tw" style="margin-top:16px"><h3 style="margin-bottom:8px">${h}</h3><div id="h1"></div></div>`;
  let k = [], body = '', post = () => {};

  if (rt === 'Booking') {
    const c = s => bks.filter(b => bkStatus(b.status) === s).length;
    const st = [['Completed', c('Completed')], ['Confirmed', c('Confirmed') + c('Active')], ['Pending', c('Pending')], ['Cancelled', c('Cancelled') + c('Rejected')]];
    k = [['Total bookings', bks.length], ['Confirmed', st[1][1]], ['Pending', st[2][1]], ['Completed', st[0][1]], ['Cancelled', st[3][1]]];
    body = card('Bookings by status', 'Bookings by studio');
    post = () => { hbs('h1', st.map(x => [x[0], x[1], x[1]])); hbs('h2', STU.map(s => { const n = bks.filter(b => b.studio_id === s.studio_id).length; return [s.name, n, n]; })); };
  } else if (rt === 'Sales') {
    const sv = sum(revs.filter(r => r.kind === 'Studio').map(r => num(r.amount))), ev = sum(revs.filter(r => r.kind === 'Equipment').map(r => num(r.amount)));
    k = [['Studio revenue', money(sv)], ['Equipment revenue', money(ev)], ['Total revenue', money(sv + ev)]];
    body = card('Revenue by studio', 'Estimated rental income by equipment');
    post = () => {
      hbs('h1', STU.map(s => { const v = sum(revs.filter(r => r.kind === 'Studio' && r.studio_name === s.name).map(r => num(r.amount))); return [s.name, money(v), v]; }));
      hbs('h2', STK.map(e => { const v = sum(lines.filter(l => l.equipment_id === e.equipment_id).map(lineIncome)); return [e.name, money(v), v]; }).filter(x => x[2] > 0));
    };
  } else if (rt === 'Rental') {
    const by = STK.map(e => { const ls = lines.filter(l => l.equipment_id === e.equipment_id); return { n: e.name, times: sum(ls.map(l => l.quantity)), income: sum(ls.map(lineIncome)) }; }).filter(x => x.times > 0).sort((a, b) => b.times - a.times);
    k = [['Items rented', sum(by.map(x => x.times))], ['Rental income', money(sum(by.map(x => x.income)))], ['Most rented', by.length ? by[0].n : 'None']];
    body = wide('Rental activity');
    post = () => tb('h1', ['Equipment', 'Times rented', 'Income'], by.map(x => [esc(x.n), String(x.times), money(x.income)]));
  } else if (rt === 'Customer') {
    const sp = {};
    const get = (id, n) => (sp[id] = sp[id] || { id, n, s: [], q: [], ss: 0, qs: 0 });
    bks.filter(b => b.payment_status === 'Verified').forEach(b => { const c = get(b.customer_id, b.customer_name); c.s.push(b); c.ss += num(b.total_amount); });
    lines.forEach(l => { const c = get(l.customer_id, l.customer_name); c.q.push(l); c.qs += lineIncome(l); });
    const cu = Object.values(sp).map(c => ({ ...c, t: c.ss + c.qs })).filter(c => c.t > 0).sort((a, b) => b.t - a.t);
    if (hc && !cu.find(x => x.id === hc)) hc = null;
    const acct = id => (CUS.find(c => c.customer_id === id) || {}).account_type;
    k = [['Customers who spent', cu.length], ['Registered', cu.filter(c => acct(c.id) === 'Registered').length], ['Guests', cu.filter(c => acct(c.id) === 'Guest').length], ['Total spent', money(sum(cu.map(c => c.t)))]];
    body = wide('Customer spending') + '<div id="h2"></div>';
    post = () => {
      tb('h1', ['Customer', 'Total spent', ''], cu.map(x => [esc(x.n), money(x.t), `<button class="btn sm ${x.id === hc ? '' : 'line'}" data-h="${x.id}">View history</button>`]));
      const x = cu.find(y => y.id === hc);
      if (x) $('#h2').innerHTML = `<div class="card" style="margin-top:16px"><div class="row"><h3>Spending history: ${esc(x.n)}</h3><button class="btn sm line" data-x="1">Close</button></div><p class="mut" style="margin:4px 0 12px">${label}</p>
        <h3 style="font-size:14px">Studio rooms booked</h3><div class="tw">${tbl(['Booking', 'Studio', 'Date', 'Hours', 'Amount'], x.s.map(y => [y.booking_ref, esc(y.studio_name), shortDate(dOf(y.start_at)), String(Math.round(num(y.hours))), money(y.total_amount)]))}</div>
        <h3 style="font-size:14px;margin-top:14px">Equipment rented</h3><div class="tw">${tbl(['Equipment', 'Qty', 'Date', 'Amount'], x.q.map(y => [esc(y.equipment_name), String(y.quantity), shortDate(dOf(y.created_at)), money(lineIncome(y))]))}</div>
        <div class="tot"><span>Total spent</span><span>${money(x.t)}</span></div></div>`;
    };
  } else if (rt === 'Returns') {
    const done = RL.filter(l => l.line_returned_at && inR(dOf(l.line_returned_at)));
    const late = done.filter(l => lateDays(l) > 0).length, ontime = done.length - late;
    const ov = openLines().filter(l => l.days_overdue > 0);
    k = [['Returned on time', ontime], ['Returned late', late], ['Currently overdue', ov.length], ['On-time rate', done.length ? Math.round(ontime / done.length * 100) + '%' : '-']];
    body = card('Return status', 'Overdue days by equipment') + '<div class="card tw" style="margin-top:16px"><h3 style="margin-bottom:8px">Overdue rentals right now</h3><div id="h3"></div></div>';
    post = () => {
      hbs('h1', [['Returned on time', ontime, ontime], ['Returned late', late, late], ['Overdue now', ov.length, ov.length]]);
      const g = {}; ov.forEach(l => { g[l.equipment_name] = (g[l.equipment_name] || 0) + l.days_overdue * l.quantity; });
      hbs('h2', Object.entries(g).map(x => [x[0], pl(x[1], 'day'), x[1]]));
      tb('h3', ['Order', 'Customer', 'Equipment', 'Return by', 'Overdue'], ov.map(l => [esc(l.rental_type === 'Add-on' ? (l.booking_ref || l.rental_ref) : l.rental_ref), esc(l.customer_name), esc(l.equipment_name), dueLabel(l), dueB(l)]));
    };
  } else {
    k = [['Items in stock', sum(STK.map(e => e.total_quantity))], ['Available', sum(STK.map(e => e.available))], ['In use', sum(STK.map(e => e.in_use))], ['Low stock', STK.filter(e => e.stock_status === 'Low' || e.stock_status === 'In Use').length]];
    body = wide('Stock by equipment');
    post = () => tb('h1', ['Equipment', 'Total', 'Available', 'In use', 'Status'], STK.map(e => [esc(e.name), String(e.total_quantity), String(e.available), String(e.in_use), badge(e.stock_status)]));
  }

  $('#rp-p').style.opacity = inv ? .45 : 1;
  $('#rp-p').innerHTML = '<span class="mut" style="align-self:center;margin-right:4px">Period</span>' + ['Today', 'Week', 'Month', 'Custom'].map(x => `<button data-p="${x}" class="${x === rp ? 'on' : ''}">${x === 'Custom' ? 'Custom range' : x}</button>`).join('');
  $('#rp-t').innerHTML = '<span class="mut" style="align-self:center;margin-right:4px">Report</span>' + Object.keys(RT).map(x => `<button data-r="${x}" class="${x === rt ? 'on' : ''}">${x}</button>`).join('');
  $('#rp').innerHTML = `<div class="card" style="margin-bottom:16px"><h2>${rt} report</h2><p class="mut">${inv ? 'Current stock' : 'Showing ' + label}. ${RT[rt]}</p></div>` +
    (rp === 'Custom' && !inv ? `<div class="row" style="justify-content:flex-start;margin-bottom:16px"><input type="date" id="rp-from" value="${cFrom}" aria-label="From" style="max-width:170px"><input type="date" id="rp-to" value="${cTo}" aria-label="To" style="max-width:170px"><button class="btn sm" id="rp-apply">Apply</button></div>` : '') +
    `<div class="grid g4">${k.map(x => KPI(x[0], x[1])).join('')}</div>` + body;
  post();
}
$('#a-rep').addEventListener('click', e => {
  const x = e.target.closest('button'); if (!x) return;
  if (x.dataset.p) rp = x.dataset.p;
  else if (x.dataset.r) { rt = x.dataset.r; hc = null; }
  else if (x.dataset.h !== undefined) hc = +x.dataset.h;
  else if (x.dataset.x !== undefined) hc = null;
  else if (x.id === 'rp-apply') { cFrom = $('#rp-from').value || cFrom; cTo = $('#rp-to').value || cTo; }
  else return;
  renderReports();
});


/* ============================ 12. START ============================ */

function renderAll(poll) {
  setOpts($('#bk-s'), '<option value="">All studios</option>' + STU.map(s => `<option value="${s.studio_id}">${esc(s.name)}</option>`).join(''));
  renderOverview(); renderBookings(); renderPayments(); renderSessions(); renderStudios();
  renderEquipmentTab(); renderRentals(); renderCustomers(); renderStaff(); renderOnsiteLog();
  if (!poll || location.hash === '#a-rep') renderReports();
}

function showTab(id) {
  const tabs = $$('.pg');
  const key = tabs.some(p => p.id === id) ? id : 'a-over';
  tabs.forEach(p => p.classList.toggle('on', p.id === key));
  if (typeof setActiveNav === 'function') setActiveNav(key);
  if (key === 'a-rep') renderReports();
  scrollTo(0, 0);
}
window.addEventListener('hashchange', () => showTab(location.hash.slice(1)));

(async function start() {
  await dataReady;
  showTab(location.hash.slice(1));
  await refresh(false);
  fillProfile();
  setInterval(() => { if (!document.hidden) refresh(true); }, 30000);   // new bookings appear on their own
  setInterval(renderSessions, 60000);                                  // remaining session time
})();

})();
