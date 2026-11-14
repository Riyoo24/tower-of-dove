/* =====================================================================
   admin/helpers.js - setup and helpers for the dashboard
   Who is logged in (OWNER?), number/date formatting, table and button builders,
   run() for Supabase calls, the shared dialog and the data-act click dispatcher (ACT).
   ===================================================================== */

import { sb } from '../config/supabaseClient.js';
import { getUser } from '../shared/session.js';
import { $, esc, manilaParts, peso, toast } from '../shared/utils.js';

/* ============================ 1. SETUP & HELPERS ============================ */

export const who = getUser();

export const OWNER = !!who && who.role === 'owner';

export const num = n => Number(n) || 0;

export const money = n => peso(Math.round(num(n) * 100) / 100);

/* how the customer paid online: 'full' = full payment (100%), anything else = 50% down payment */
export const isFull = opt => opt === 'full';
export const payLabel = opt => isFull(opt) ? 'Full payment' : 'Down payment (50%)';
export const payWord = opt => isFull(opt) ? 'full payment' : 'down payment';

const P = ts => manilaParts(ts);

export const dOf = ts => P(ts).date;

export const tlabel = h => (h % 12 || 12) + ':00 ' + (h < 12 ? 'AM' : 'PM');

export const tOf = ts => tlabel(P(ts).hour);

/* the exact clock time, minutes included ("1:52 PM"), for moments that are not on the hour such as a check-in */
export const tExact = ts => {
    const p = P(ts);
    return (p.hour % 12 || 12) + ':' + String(p.minute).padStart(2, '0') + ' ' + (p.hour < 12 ? 'AM' : 'PM');
};

export const stampLabel = ts => new Date(ts).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
});

export const dayDiff = (a, b) => Math.round((new Date(a + 'T00:00') - new Date(b + 'T00:00')) / 864e5);

// database status -> label shown on screen
export const bkStatus = s => ({
    'Approved': 'Confirmed',
    'In Progress': 'Active'
}[s] || s);

export const rnStatus = s => ({
    'Active': 'In Use',
    'Approved': 'Verified'
}[s] || s);   // a rental that staff verified shows as Verified

/* Every table is returned inside a .tw box. On a narrow screen the box scrolls sideways
   instead of the table squeezing its text or pushing the whole page wider.
   cls (optional) adds a class to the <table>, e.g. "bk-tbl" for the Bookings table. */
/* Every table is returned inside a .tw box. On a narrow screen the box scrolls sideways
   instead of the table squeezing its text or pushing the whole page wider.
   cls (optional) adds a class to the <table>, e.g. "bk-tbl" for the Bookings table.
   empty (optional) is HTML shown when there are no rows, built with emptyState(); the default is "Nothing to show." */
export const tbl = (head, rows, cls, empty) =>
    `<div class="tw"><table${cls ? ` class="${cls}"` : ''}><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>` +
    (rows.length ? rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')
        : `<tr${empty ? ' class="empty-row"' : ''}><td colspan="${head.length}"${empty ? '' : ' class="mut"'}>${empty || 'Nothing to show.'}</td></tr>`)
    + '</tbody></table></div>';

/* A friendly "nothing here" block: title, a short hint and an optional button or link (action = ready HTML). */
export const emptyState = ({ title, hint = '', action = '' }) =>
    `<div class="empty"><b>${title}</b>${hint ? `<p class="mut">${hint}</p>` : ''}${action ? `<div class="empty-acts">${action}</div>` : ''}</div>`;

/* Like tbl(), but the rows are split into titled groups, the same way the customer's My bookings / My rental tables work.
   groups = [{ title, toggle, collapsed, rows, dimmed }]. rows = arrays of cells (like tbl).
   A group with a toggle name gets a button (data-toggle) that shows or hides its rows; a collapsed group
   shows only its heading and how many rows it holds. dimmed = (row index) => true greys that row out. */
export const tblGrouped = (head, groups, cls, empty) => {
    const n = head.length, shown = groups.filter(g => g.rows.length);
    const body = shown.map(g => {
        const label = `<span class="grp-t">${g.title}</span><span class="grp-n">${g.rows.length}</span>`;
        const top = `<tr class="grp-row"><td colspan="${n}">${g.toggle
            ? `<button type="button" class="grp-btn" data-toggle="${g.toggle}" aria-expanded="${!g.collapsed}">${label}<span class="grp-chev" aria-hidden="true">${g.collapsed ? '&#9656;' : '&#9662;'}</span></button>`
            : `<span class="grp-btn">${label}</span>`}</td></tr>`;
        if (g.collapsed)
            return top;
        return top + g.rows.map((r, i) => `<tr${g.dimmed && g.dimmed(i) ? ' class="dim"' : ''}>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
    }).join('');
    // while a "Past and closed" group is open the box gets a height limit and scrolls inside itself (the page stays put)
    const scroll = shown.some(g => g.toggle && !g.collapsed);
    return `<div class="tw${scroll ? ' tw-scroll' : ''}"><table class="grouped${cls ? ' ' + cls : ''}"><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>` +
        (shown.length ? body : `<tr${empty ? ' class="empty-row"' : ''}><td colspan="${n}"${empty ? '' : ' class="mut"'}>${empty || 'Nothing to show.'}</td></tr>`)
        + '</tbody></table></div>';
};

export const tb = (id, head, rows, empty) => {
    $('#' + id).innerHTML = tbl(head, rows, undefined, empty);
};

export const dbtn = (act, id, text) => `<button class="btn sm bad" data-act="${act}" data-id="${esc(id)}">${text}</button>`;

export const btn = (act, id, text, line) => `<button class="btn sm ${line ? 'line' : ''}" data-act="${act}" data-id="${esc(id)}">${text}</button>`;

export const tabsHtml = (list, cur, key) => `<div class="tabs">${list.map(x => `<button data-${key}="${x}" class="${x === cur ? 'on' : ''}">${x}</button>`).join('')}</div>`;

export const KPI = (l, v, color, sub, go) => `<div class="card kpi${go ? ' go' : ''}"${go ? ` data-go="${esc(go)}" role="link" tabindex="0" aria-label="${esc(l)}: ${v}. Click to view"` : ''}><span class="mut">${l}</span><div class="num" ${color ? `style="color:${color}"` : ''}>${v}</div>${sub ? `<span class="mut">${sub}</span>` : ''}</div>`;

export const hbs = (id, rows) => {
    const m = Math.max(...rows.map(r => r[2]), 1);
    $('#' + id).innerHTML = rows.map(r => `<div class="hb"><div class="row" style="background:none;height:auto;margin:0"><span>${esc(r[0])}</span><b>${r[1]}</b></div><div><i style="width:${Math.round(r[2] / m * 100)}%"></i></div></div>`).join('')
        || '<p class="mut">Nothing in this period.</p>';
};

export const setOpts = (sel, html) => {
    const cur = sel.value;
    sel.innerHTML = html;
    if ([...sel.options].some(o => o.value === cur))
        sel.value = cur;
};

/* run a Supabase call; show the error as a message and return null if it failed */
export async function run(p) {
    const r = await p;
    if (r.error) {
        toast(r.error.message);
        console.error(r.error);
        return null;
    }
    return r;
}

/* After staff verify a payment: ask the send-receipt Edge Function to email the customer that their booking,
   rental or extension is verified. The function checks that the caller is staff, finds the customer's address in
   the database and sends once per payment. A failed email never undoes the verification. */
export async function notifyVerified(paymentId, quiet) {
    if (!paymentId)
        return false;
    try {
        const { data, error } = await sb.functions.invoke('send-receipt', { body: { kind: 'verified', paymentId: +paymentId } });
        if (error)
            throw error;
        if (data && data.ok === false && data.reason === 'no_email' && !quiet)
            toast('Payment verified. This customer has no email on file, so no email was sent.');
        return !!(data && data.ok);   // true when the email went out
    }
    catch (err) {
        console.warn('Verified email failed:', err);
        if (!quiet)
            toast('Payment verified, but the email to the customer could not be sent.');
        return false;
    }
}

/* After staff collect the remaining balance of a booking or rental: ask the send-receipt Edge Function to email the
   customer a "fully paid" receipt. The function checks that the caller is staff, finds the customer's address in the
   database and sends once per collection. Resolves to 'sent', 'noemail' or 'failed'; a failed email never undoes the
   collection. */
export async function notifyBalancePaid(target, ref) {
    try {
        const { data, error } = await sb.functions.invoke('send-receipt', { body: { kind: 'balance', target, ref } });
        if (error)
            throw error;
        if (data && data.ok)
            return 'sent';
        if (data && data.reason === 'no_email')
            return 'noemail';
        return 'failed';
    }
    catch (err) {
        console.warn('Fully paid receipt email failed:', err);
        return 'failed';
    }
}

/* The booked item became unavailable (for example it came back damaged) and staff dealt with it: ask the send-receipt Edge
   Function to email the customer. event 'offer' (Let customer choose, id = the offer) lists the offered items with prices, the
   deadline and the default item; event 'swap' (Swap item, id = the rental line) says which item replaced it and its price.
   Resolves to 'sent', 'noemail' or 'failed'; a failed email never undoes the replacement. */
export async function notifyReplacement(event, id) {
    try {
        const { data, error } = await sb.functions.invoke('send-receipt', { body: event === 'offer' ? { kind: 'replacement', event, offerId: +id } : { kind: 'replacement', event, detailId: +id } });
        if (error)
            throw error;
        if (data && data.ok)
            return 'sent';
        if (data && data.reason === 'no_email')
            return 'noemail';
        return 'failed';
    }
    catch (err) {
        console.warn('Replacement email failed:', err);
        return 'failed';
    }
}

/* After a damage fee is paid (staff collected it, accepted the customer's GCash payment, or collected it at the return): ask
   the send-receipt Edge Function to email the customer the same fully paid receipt. The function checks that the caller is
   staff, finds the customer's address in the database and sends once per payment. Resolves to 'sent', 'noemail' or
   'failed'; a failed email never undoes the payment. */
export async function notifyDamagePaid(ref) {
    try {
        const { data, error } = await sb.functions.invoke('send-receipt', { body: { kind: 'damage', ref } });
        if (error)
            throw error;
        if (data && data.ok)
            return 'sent';
        if (data && data.reason === 'no_email')
            return 'noemail';
        return 'failed';
    }
    catch (err) {
        console.warn('Damage fee receipt email failed:', err);
        return 'failed';
    }
}

/* The same for a LATE FEE (kind latefee in send-receipt, 83_late_fee_collection.sql): call it after a late fee was paid (at the return, or later). */
export async function notifyLateFeePaid(ref) {
    try {
        const { data, error } = await sb.functions.invoke('send-receipt', { body: { kind: 'latefee', ref } });
        if (error)
            throw error;
        if (data && data.ok)
            return 'sent';
        if (data && data.reason === 'no_email')
            return 'noemail';
        return 'failed';
    }
    catch (err) {
        console.warn('Late fee receipt email failed:', err);
        return 'failed';
    }
}

/* the sentence added to the toast after a paid-receipt email */
export const mailNoteOf = mail => mail === 'sent' ? ' Fully paid receipt emailed to the customer.'
    : mail === 'noemail' ? ' No email on file, so no receipt was emailed.'
        : mail === 'failed' ? ' The receipt email could not be sent.' : '';

/* Shrinks a photo before it is uploaded: at most 1600 px on the longest side, saved as WebP (JPEG where the
   browser cannot write WebP). A 2 MB phone photo becomes about 100-250 KB, so the website loads much faster.
   Small files, GIF and SVG are uploaded as they are, and so is any file the browser cannot decode. */
const MAX_SIDE = 1600, SKIP_BELOW = 200 * 1024;

async function shrinkImage(file) {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < SKIP_BELOW)
        return file;
    try {
        const bmp = await createImageBitmap(file);
        const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
        const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
        bmp.close && bmp.close();
        for (const type of ['image/webp', 'image/jpeg']) {
            const blob = await new Promise(res => canvas.toBlob(res, type, 0.82));
            if (blob && blob.type === type)
                return blob.size < file.size ? blob : file;   // never make a file bigger
        }
    }
    catch (e) {
        console.warn('Image not shrunk:', e);
    }
    return file;
}

export async function uploadPublic(bucket, original) {
    const file = await shrinkImage(original);
    const ext = file.type === 'image/webp' ? 'webp' : file.type === 'image/jpeg' ? 'jpg'
        : ((original.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '')) || 'jpg';
    const path = `${crypto.randomUUID()}.${ext}`;   // a new random name per upload, so the browser may cache it for a year
    const up = await sb.storage.from(bucket).upload(path, file, { contentType: file.type, cacheControl: '31536000' });
    if (up.error)
        throw new Error(up.error.message);
    return sb.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

export const PHICON = '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-8 8"/></svg>';

/* shared dialog */
export const dlg = $('#rdlg');

export function showDlg(html) {
    dlg.classList.remove('hist');   // only the customer history window is wide; it adds this class itself
    dlg.innerHTML = `<div class="in">${html}</div>`;
    dlg.showModal();
}

dlg.addEventListener('click', e => {
    if (dlg.dataset.locked && e.target === dlg)
        return;   // a required-action pop-up: only its own button closes it
    if (e.target === dlg || e.target.closest('[data-close]'))
        dlg.close();
});
dlg.addEventListener('cancel', e => {
    if (dlg.dataset.locked)
        e.preventDefault();   // Esc does nothing while an action is required
});
dlg.addEventListener('close', () => {
    dlg.classList.remove('hist');
    delete dlg.dataset.locked;
});

$('#eqdlg').addEventListener('click', e => {
    if (e.target.id === 'eqdlg')
        $('#eqdlg').close();
});

/* ---- "Are you sure?" window ----
   askConfirm({ title, message, ok, cancel, danger }) resolves true (confirmed) or false (cancelled, Esc or click outside).
   It opens on top of every other window, so it also works inside the Verify drawer. */
const cf = document.createElement('dialog');
cf.className = 'dlg confirm';
cf.setAttribute('role', 'alertdialog');
cf.setAttribute('aria-label', 'Please confirm');
document.body.appendChild(cf);

let cfDone = null;

const cfClose = v => {
    if (!cfDone)
        return;
    const d = cfDone;
    cfDone = null;
    if (cf.open)
        cf.close();
    d(v);
};

cf.addEventListener('click', e => {
    if (e.target === cf)
        return cfClose(false);
    const b = e.target.closest('[data-cf]');
    if (b)
        cfClose(b.dataset.cf === 'yes');
});

cf.addEventListener('cancel', e => {
    e.preventDefault();
    cfClose(false);
});   // Esc key

export function askConfirm({ title = 'Are you sure?', message = '', ok = 'Yes, confirm', cancel = 'Cancel', danger = false } = {}) {
    cfClose(false);
    return new Promise(resolve => {
        cfDone = resolve;
        cf.innerHTML = `<div class="in"><h2 style="margin:0 0 8px">${esc(title)}</h2>${message ? `<p class="mut">${esc(message)}</p>` : ''}
      <div class="acts"><button type="button" class="btn line" data-cf="no">${esc(cancel)}</button><button type="button" class="btn ${danger ? 'bad' : 'gold'}" data-cf="yes">${esc(ok)}</button></div></div>`;
        cf.showModal();
        cf.querySelector('[data-cf="no"]').focus();   // Cancel has the focus, so Enter never confirms by accident
    });
}

/* every button with data-act runs ACT[name](id).
   If CONFIRM[name] exists, it gives the "Are you sure?" text first and the action only runs after a Yes.
   CONFIRM[name](id, button) returns { title, message, ok, cancel, danger }, or nothing to skip the question. */
export const ACT = {};

export const CONFIRM = {};

document.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b || !ACT[b.dataset.act] || b.dataset.busy)
        return;
    b.dataset.busy = '1';
    Promise.resolve()
        .then(() => {
            const spec = CONFIRM[b.dataset.act] && CONFIRM[b.dataset.act](b.dataset.id, b);
            return spec ? askConfirm(spec) : true;
        })
        .then(yes => yes ? ACT[b.dataset.act](b.dataset.id, b) : null)
        .catch(err => {
            console.error(err);
            toast(err.message);
        })
        .finally(() => {
            delete b.dataset.busy;
        });
});
