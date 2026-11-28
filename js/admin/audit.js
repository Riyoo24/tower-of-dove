/* =====================================================================
   admin/audit.js - Audit Trail tab (OWNER ONLY)
   What every staff member did in the dashboard. Reads public.audit_log (supabase/98_audit_log.sql).
   - The rows are written by the database only. This file only READS them (select), nothing here can add, edit or delete one.
   - Row Level Security lets only the Owner read the table, so even if someone unhides the tab, staff get an empty list.
   - Filters: staff member, date range, action type, reference. Newest first, 25 rows per page, Details per row,
     CSV of everything that matches the filters.
   - The table sits in a box of fixed height and every row has a fixed height, so filtering and paging never move the page.
   ===================================================================== */

import { sb } from '../config/supabaseClient.js';
import { ACT, OWNER, btn, emptyState, money, num } from './helpers.js';
import { csvDownload } from './export.js';
import { btnBusy, btnReset } from '../shared/btnState.js';
import { $, dayOffset, esc, reducedMotion, toast } from '../shared/utils.js';

const SEC = $('#a-audit');

/* Staff never get this tab: it is taken out of the page, so there is nothing to show even with an edited URL or cache. */
if (!OWNER && SEC)
    SEC.remove();

const PAGE = 25;
const CSV_CAP = 20000;   // most rows one CSV holds (the log keeps 12 months)

/* action code -> label, grouped by category. The database stores the code; unknown codes are shown as they are. */
const CATALOG = [
    ['Payments', [
        ['payment.verified', 'Payment verified'], ['payment.rejected', 'Payment rejected'],
        ['payment.recorded', 'Payment recorded'], ['payment.balance_collected', 'Balance collected']]],
    ['Bookings', [
        ['booking.created', 'Booking created'], ['booking.approved', 'Booking approved'], ['booking.rejected', 'Booking rejected'],
        ['booking.rescheduled', 'Booking rescheduled'], ['booking.cancelled', 'Booking cancelled'], ['booking.extended', 'Booking extended'],
        ['booking.started', 'Session started'], ['booking.completed', 'Session completed'],
        ['booking.checked_in', 'Customer checked in'], ['booking.checkin_undone', 'Check-in undone']]],
    ['Rentals', [
        ['rental.created', 'Rental created'], ['rental.approved', 'Rental approved'], ['rental.rejected', 'Rental rejected'],
        ['rental.cancelled', 'Rental cancelled'], ['rental.issued', 'Items issued'], ['rental.item_returned', 'Item returned'],
        ['rental.item_swapped', 'Item swapped']]],
    ['Money overrides', [
        ['damage.recorded', 'Damage fee recorded'], ['damage.amount_changed', 'Damage fee changed'], ['damage.waived', 'Damage fee waived'],
        ['damage.collected', 'Damage fee collected'], ['damage.payment_rejected', 'Damage payment rejected'],
        ['late_fee.left_unpaid', 'Late fee left unpaid'], ['late_fee.collected', 'Late fee collected'], ['late_fee.waived', 'Late fee waived'],
        ['late_fee.payment_rejected', 'Late fee payment rejected'],
        ['fee.deferred', 'Fee deferred'], ['fee.block_lifted', 'Booking block lifted'], ['fee.override_revoked', 'Override cancelled'],
        ['noshow.released', 'No-show released'], ['noshow.held', 'No-show held']]],
    ['Customers', [
        ['flag.note', 'Flag note added'], ['flag.dismissed', 'Flag dismissed'], ['flag.restored', 'Flag counted again']]],
    ['Settings', [
        ['studio.created', 'Studio added'], ['studio.rate_changed', 'Studio rate changed'], ['studio.updated', 'Studio updated'], ['studio.deleted', 'Studio deleted'],
        ['equipment.created', 'Equipment added'], ['equipment.price_changed', 'Equipment price changed'], ['equipment.stock_changed', 'Equipment stock changed'],
        ['equipment.updated', 'Equipment updated'], ['equipment.deleted', 'Equipment deleted'],
        ['settings.gcash_qr', 'GCash QR changed'], ['settings.gcash_account', 'GCash account changed'], ['settings.changed', 'Setting changed']]],
    ['Staff accounts', [
        ['staff.created', 'Staff account created'], ['staff.disabled', 'Staff account disabled'], ['staff.enabled', 'Staff account enabled'],
        ['staff.role_changed', 'Role changed'], ['staff.deleted', 'Staff account deleted']]],
    ['Sign-ins', [['auth.login', 'Signed in']]]
];
const LABEL = new Map(CATALOG.flatMap(([, list]) => list));
const labelOf = code => LABEL.get(code) || code;

const st = { page: 0, total: 0, rows: [], seq: 0, ready: false, started: false, error: false };

/* ---------------------------------------------------------------- formatting (all in Manila time) */

const manila = (ts, o) => new Date(ts).toLocaleString('en-US', { timeZone: 'Asia/Manila', ...o });
const dateOf = ts => manila(ts, { month: 'short', day: 'numeric', year: 'numeric' });
const timeOf = ts => manila(ts, { hour: 'numeric', minute: '2-digit' });
const fullOf = ts => manila(ts, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }) + ' (Manila)';
const csvTime = ts => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
        .formatToParts(new Date(ts)).map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
};

const nextDay = iso => {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
};

const pretty = k => {
    const s = String(k).replace(/_/g, ' ').trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
};

/* one value in the Before / After table */
function fmtValue(key, v) {
    if (v === null || v === undefined || v === '')
        return '<span class="mut">-</span>';
    if (typeof v === 'boolean')
        return v ? 'Yes' : 'No';
    if (typeof v === 'object')
        return `<code>${esc(JSON.stringify(v))}</code>`;
    const s = String(v);
    if (/^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(new Date(s).getTime()))
        return esc(manila(s, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }));
    if (/(amount|rate|price|fee|cost|total|tendered|collected|balance|paid)$/i.test(key) && s !== '' && !Number.isNaN(Number(s)) && !/(hours|reference|ref)$/i.test(key))
        return esc(money(num(s)));
    return esc(s);
}

function diffHtml(r) {
    const o = r.old_values && typeof r.old_values === 'object' ? r.old_values : {};
    const n = r.new_values && typeof r.new_values === 'object' ? r.new_values : {};
    const keys = [...new Set([...Object.keys(o), ...Object.keys(n)])];
    if (!keys.length)
        return '<p class="mut al-none">No before / after values were recorded for this action.</p>';
    const hasBefore = Object.keys(o).length > 0;
    return `<div class="tw al-dtw"><table class="al-dt"><thead><tr><th>Field</th>${hasBefore ? '<th>Before</th>' : ''}<th>After</th></tr></thead><tbody>`
        + keys.map(k => {
            const changed = hasBefore && JSON.stringify(o[k]) !== JSON.stringify(n[k]);
            return `<tr${changed ? ' class="chg"' : ''}><th scope="row">${esc(pretty(k))}</th>${hasBefore ? `<td>${fmtValue(k, o[k])}</td>` : ''}<td>${fmtValue(k, n[k])}</td></tr>`;
        }).join('') + '</tbody></table></div>';
}

/* ---------------------------------------------------------------- filters and query */

const val = id => ($('#' + id) ? $('#' + id).value : '');

const filters = () => ({ staff: val('al-staff'), from: val('al-from'), to: val('al-to'), action: val('al-act'), q: val('al-q').trim() });

const isFiltered = f => !!(f.staff || f.from || f.to || f.action || f.q);

function applyFilters(query, f) {
    if (f.staff)
        query = query.eq('actor_user_id', +f.staff);
    if (f.from)
        query = query.gte('created_at', f.from + 'T00:00:00+08:00');
    if (f.to)
        query = query.lt('created_at', nextDay(f.to) + 'T00:00:00+08:00');
    if (f.action)
        query = f.action.startsWith('cat:') ? query.eq('category', f.action.slice(4)) : query.eq('action', f.action);
    const ref = f.q.replace(/[^A-Za-z0-9_-]/g, '');   // references are letters, digits and dashes: nothing else can reach the filter
    if (ref)
        query = query.or(`entity_ref.ilike.*${ref}*,related_ref.ilike.*${ref}*`);
    return query;
}

const COLS = 'audit_id,created_at,actor_user_id,actor_name,actor_role,action,category,description,entity_type,entity_ref,related_ref,item,old_values,new_values';

/* ---------------------------------------------------------------- drawing */

const box = () => $('#aud');

const bar = (w, cls) => `<i class="sk-b${cls ? ' ' + cls : ''}" style="width:${w}"></i>`;

/* the same placeholder markup as shared/skeleton.js (table), with the same number of rows as a page */
function skeleton() {
    const W = ['62%', '78%', '48%', '70%', '56%', '84%', '44%', '66%'];
    const rows = Array.from({ length: PAGE }, (_, r) =>
        `<div class="sk-tr" aria-hidden="true">${Array.from({ length: 6 }, (__, c) => bar(W[(r * 3 + c * 5) % W.length])).join('')}</div>`).join('');
    return `<div class="sk sk-table al-sk" role="status" aria-label="Loading the audit trail"><span class="sk-sr">Loading</span>`
        + `<div class="sk-tr sk-th" aria-hidden="true">${Array.from({ length: 6 }, () => bar('52%')).join('')}</div>${rows}</div>`;
}

function stateBox(html) {
    box().innerHTML = `<div class="al-state">${html}</div>`;
}

function setPager() {
    const pages = Math.max(1, Math.ceil(st.total / PAGE));
    $('#al-prev').disabled = st.page <= 0;
    $('#al-next').disabled = st.page >= pages - 1;
    $('#al-page').textContent = st.total ? `Page ${st.page + 1} of ${pages}` : 'Page 1';
    const from = st.total ? st.page * PAGE + 1 : 0;
    $('#al-meta').textContent = st.total ? `Showing ${from} to ${from + st.rows.length - 1} of ${st.total} ${st.total === 1 ? 'entry' : 'entries'}, newest first.` : '\u00a0';
}

function rowHtml(r, i) {
    const ref = r.entity_ref ? `<b>${esc(r.entity_ref)}</b>` : '<span class="mut">-</span>';
    const sub = [r.related_ref ? `booking ${esc(r.related_ref)}` : '', r.item ? esc(r.item) : ''].filter(Boolean).join(' &middot; ');
    return `<tr class="al-r row-in" style="--ri-d:${Math.min(i, 12) * 28}ms" data-cat="${esc(r.category)}">
      <td class="c-time" data-l="Time"><time datetime="${esc(r.created_at)}" title="${esc(fullOf(r.created_at))}"><b>${esc(dateOf(r.created_at))}</b><span class="mut">${esc(timeOf(r.created_at))}</span></time></td>
      <td class="c-who" data-l="Staff"><span class="al-name" title="${esc(r.actor_name)}">${esc(r.actor_name)}</span><span class="al-role ${r.actor_role === 'Owner' ? 'own' : ''}">${esc(r.actor_role)}</span></td>
      <td class="c-act" data-l="Action"><span class="al-chip" title="${esc(r.action)}">${esc(labelOf(r.action))}</span></td>
      <td class="c-desc" data-l="Description"><span class="al-clamp" title="${esc(r.description)}">${esc(r.description)}</span></td>
      <td class="c-ref" data-l="Reference">${ref}${sub ? `<span class="mut al-sub" title="${sub.replace(/<[^>]+>/g, '')}">${sub}</span>` : ''}</td>
      <td class="c-det"><button type="button" class="btn sm line" data-act="al-det" data-id="${r.audit_id}" aria-expanded="false" aria-controls="al-d-${r.audit_id}">Details</button></td>
    </tr>
    <tr class="al-d" id="al-d-${r.audit_id}" hidden><td colspan="6"><div class="al-det-in">
      <p class="al-full">${esc(r.description)}</p>
      <dl class="al-facts">
        <div><dt>When</dt><dd>${esc(fullOf(r.created_at))}</dd></div>
        <div><dt>Staff</dt><dd>${esc(r.actor_name)} (${esc(r.actor_role)})</dd></div>
        <div><dt>Action</dt><dd>${esc(labelOf(r.action))} <span class="mut">${esc(r.action)}</span></dd></div>
        ${r.entity_ref ? `<div><dt>Reference</dt><dd>${esc(r.entity_ref)}${r.related_ref ? ` <span class="mut">(booking ${esc(r.related_ref)})</span>` : ''}</dd></div>` : ''}
        ${r.item ? `<div><dt>Item</dt><dd>${esc(r.item)}</dd></div>` : ''}
      </dl>
      ${diffHtml(r)}
    </div></td></tr>`;
}

function drawRows() {
    const f = filters();
    if (!st.rows.length) {
        const filtered = isFiltered(f);
        return stateBox(emptyState({
            title: filtered ? 'No activity matches these filters' : 'No activity recorded yet',
            hint: filtered ? 'Try a different date range, staff member, action or reference.' : 'Actions by staff, such as verifying a payment or changing a price, appear here as they happen.',
            action: filtered ? btn('al-clear', '', 'Clear filters', 1) : ''
        }));
    }
    box().innerHTML = `<div class="al-scroll"><table class="al-tbl"><thead><tr>
      <th class="c-time">Time</th><th class="c-who">Staff</th><th class="c-act">Action</th><th class="c-desc">Description</th><th class="c-ref">Reference</th><th class="c-det"><span class="al-sr">Details</span></th>
      </tr></thead><tbody>${st.rows.map(rowHtml).join('')}</tbody></table></div>`;
}

function drawError(msg) {
    st.rows = [];
    st.total = 0;
    setPager();
    stateBox(`<div class="sk-fail" role="alert"><span>${esc(msg || 'Could not load the audit trail. Check your connection.')}</span>${btn('al-retry', '', 'Try again', 1)}</div>`);
}

/* ---------------------------------------------------------------- loading */

async function load() {
    const my = ++st.seq;
    box().innerHTML = skeleton();
    box().setAttribute('aria-busy', 'true');
    $('#al-prev').disabled = true;
    $('#al-next').disabled = true;
    try {
        const f = filters();
        const from = st.page * PAGE;
        const res = await applyFilters(sb.from('audit_log').select(COLS, { count: 'exact' }), f)
            .order('created_at', { ascending: false }).order('audit_id', { ascending: false }).range(from, from + PAGE - 1);
        if (my !== st.seq)
            return;   // a newer request replaced this one
        if (res.error)
            throw res.error;
        st.total = res.count || 0;
        // a page that no longer exists (the filters changed): go to the last one
        if (!res.data.length && st.total > 0 && st.page > 0) {
            st.page = Math.max(0, Math.ceil(st.total / PAGE) - 1);
            return load();
        }
        st.rows = res.data;
        drawRows();
        setPager();
    } catch (err) {
        if (my !== st.seq)
            return;
        console.error(err);
        drawError(/42P01|does not exist/i.test(`${err.code} ${err.message}`) ? 'The audit trail is not set up yet. Run supabase/98_audit_log.sql first.' : '');
    } finally {
        if (my === st.seq)
            box().removeAttribute('aria-busy');
    }
}

function goFirstPage() {
    st.page = 0;
    return load();
}

/* ---------------------------------------------------------------- CSV */

async function exportCsv() {
    const b = $('#al-csv');
    btnBusy(b, 'Preparing…');
    try {
        const f = filters();
        const out = [];
        for (let from = 0; from < CSV_CAP; from += 1000) {
            const res = await applyFilters(sb.from('audit_log').select(COLS), f)
                .order('created_at', { ascending: false }).order('audit_id', { ascending: false }).range(from, from + 999);
            if (res.error)
                throw res.error;
            out.push(...res.data);
            if (res.data.length < 1000)
                break;
        }
        const label = f.from || f.to ? `${f.from || 'start'} to ${f.to || 'today'}` : 'All dates';
        const rows = out.map(r => [csvTime(r.created_at), r.actor_name, r.actor_role, r.category, labelOf(r.action), r.description,
            r.entity_ref || '', r.related_ref || '', r.item || '',
            r.old_values ? JSON.stringify(r.old_values) : '', r.new_values ? JSON.stringify(r.new_values) : '']);
        csvDownload(`tower-of-dove-audit-trail-${f.from || f.to ? (f.from || 'start') + '_to_' + (f.to || dayOffset(0)) : dayOffset(0)}.csv`, [{
            head: ['Time (Manila)', 'Staff', 'Role', 'Category', 'Action', 'Description', 'Reference', 'Booking reference', 'Item', 'Before', 'After'],
            rows
        }], [['Tower of Dove Music Studio'], ['Audit trail'], ['Dates', label], ['Entries', rows.length + (out.length >= CSV_CAP ? ` (first ${CSV_CAP} only: narrow the dates for the rest)` : '')],
            ['Created', new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' })]]);
    } catch (err) {
        console.error(err);
        toast('Could not download the audit trail: ' + (err.message || 'try again.'));
    } finally {
        btnReset(b);
    }
}

/* ---------------------------------------------------------------- setup (once, the first time the tab opens) */

async function loadStaff() {
    const { data } = await sb.from('app_user').select('user_id,first_name,last_name,role,status').order('user_id');
    const sel = $('#al-staff');
    (data || []).forEach(u => {
        const o = document.createElement('option');
        o.value = u.user_id;
        o.textContent = `${`${u.first_name || ''} ${u.last_name || ''}`.trim() || 'Account ' + u.user_id} (${u.role}${u.status === 'Inactive' ? ', disabled' : ''})`;
        sel.appendChild(o);
    });
}

function wire() {
    $('#al-act').innerHTML = '<option value="">All actions</option>'
        + CATALOG.map(([cat, list]) => `<optgroup label="${esc(cat)}"><option value="cat:${esc(cat)}">All ${esc(cat.toLowerCase())}</option>`
            + list.map(([code, label]) => `<option value="${esc(code)}">${esc(label)}</option>`).join('') + '</optgroup>').join('');

    ['al-staff', 'al-from', 'al-to', 'al-act'].forEach(id => $('#' + id).addEventListener('change', goFirstPage));
    let t = 0;
    $('#al-q').addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(goFirstPage, 350);
    });
    $('#al-q').addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            clearTimeout(t);
            goFirstPage();
        }
    });
    $('#al-prev').addEventListener('click', () => {
        if (st.page > 0) {
            st.page--;
            load();
        }
    });
    $('#al-next').addEventListener('click', () => {
        if (st.page < Math.ceil(st.total / PAGE) - 1) {
            st.page++;
            load();
        }
    });
    $('#al-clear').addEventListener('click', () => ACT['al-clear']());
    $('#al-refresh').addEventListener('click', load);
    $('#al-csv').addEventListener('click', exportCsv);
}

ACT['al-clear'] = () => {
    ['al-staff', 'al-from', 'al-to', 'al-act', 'al-q'].forEach(id => {
        $('#' + id).value = '';
    });
    return goFirstPage();
};

ACT['al-retry'] = () => load();

ACT['al-det'] = (id, button) => {
    const row = $('#al-d-' + id);
    if (!row)
        return;
    const open = row.hidden;
    row.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    button.textContent = open ? 'Hide' : 'Details';
    if (open && !reducedMotion())
        row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
};

/* called by index.js every time the Audit Trail tab is opened */
export async function renderAudit() {
    if (!OWNER || !SEC)
        return;
    if (!st.started) {
        st.started = true;
        wire();
        loadStaff();
    }
    box().innerHTML = skeleton();
    // the database is the judge of who is the Owner (the cached role in the browser can be edited)
    const { data: isOwner, error } = await sb.rpc('is_owner');
    if (error || !isOwner) {
        ['al-staff', 'al-from', 'al-to', 'al-act', 'al-q', 'al-csv', 'al-refresh', 'al-clear', 'al-prev', 'al-next'].forEach(id => {
            $('#' + id).disabled = true;
        });
        return error ? drawError('') : stateBox(emptyState({ title: 'Only the owner can see the audit trail', hint: 'Ask the owner if you need something from it.' }));
    }
    return load();
}