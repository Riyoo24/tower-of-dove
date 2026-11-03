/* =====================================================================
   customer/ui.js - tab switching, table builder, details dialog, success pop-up
   Small UI pieces shared by every customer tab.
   ===================================================================== */

import { okDlg } from './book.js';
import { setActiveNav } from '../shared/layout.js';
import { $, $$, esc } from '../shared/utils.js';

/* The sidebar links use #book, #rent, #my-bookings and #my-rentals. */
const TABS = {
    'book': 'c-book',
    'rent': 'c-rent',
    'my-bookings': 'c-bk',
    'my-rentals': 'c-rental'
};

const NAV_KEY = {
    'book': 'book',
    'rent': 'rent',
    'my-bookings': 'mybook',
    'my-rentals': 'myrent'
};

export function showTab() {
    const name = TABS[location.hash.slice(1)] ? location.hash.slice(1) : 'book';
    $$('.pg').forEach(p => p.classList.toggle('on', p.id === TABS[name]));
    setActiveNav(NAV_KEY[name]);
    scrollTo(0, 0);
}

/* The staff's reason for a rejected booking or rental, shown on its own line under the row. */
export const whyRejected = (status, reason) =>
    status === 'Rejected' ? `<b>Reason for rejection:</b> ${esc(reason || 'No reason was given. Please contact the studio.')}` : '';

/* Like table(), but a row may also carry a note that is shown full width right under it. rows = [{ cells, note }] */
export const tableNotes = (head, rows) =>
    `<table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>` +
    rows.map(r => {
        const cells = r.cells, note = r.note;
        return `<tr class="${note ? 'has-why' : ''}">${cells.map(c => `<td>${c}</td>`).join('')}</tr>` +
            (note ? `<tr class="why-row"><td colspan="${head.length}">${note}</td></tr>` : '');
    }).join('')
    + '</tbody></table>';

/* A table split into titled groups (Upcoming, In progress, Past...). groups = [{ title, toggle, collapsed, rows }],
   rows = [{ cells, note, subs, dim }]. subs = HTML lines shown indented under the row (for example the add-ons of a booking).
   A group with a toggle name gets a button (data-toggle) that shows or hides its rows. */
export const tableGrouped = (head, groups) => {
    const n = head.length;
    const body = groups.map(g => {
        const label = `<span class="grp-t">${g.title}</span><span class="grp-n">${g.rows.length}</span>`;
        const top = `<tr class="grp-row"><td colspan="${n}">${g.toggle
            ? `<button type="button" class="grp-btn" data-toggle="${g.toggle}" aria-expanded="${!g.collapsed}">${label}<span class="grp-chev" aria-hidden="true">${g.collapsed ? '&#9656;' : '&#9662;'}</span></button>`
            : `<span class="grp-btn">${label}</span>`}</td></tr>`;
        if (g.collapsed)
            return top;
        return top + g.rows.map(r =>
            `<tr class="${[r.note ? 'has-why' : '', r.dim ? 'dim' : ''].join(' ').trim()}">${r.cells.map(c => `<td>${c}</td>`).join('')}</tr>`
            + (r.note ? `<tr class="why-row"><td colspan="${n}">${r.note}</td></tr>` : '')
            + (r.subs || []).map(s => `<tr class="sub-row"><td></td><td colspan="${n - 1}">${s}</td></tr>`).join('')
        ).join('');
    }).join('');
    return `<table class="grouped"><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`;
};

export const table = (head, rows) =>
    `<table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead>` +
    `<tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

/* Shared dialog for details, reschedule and cancel */
export const dlg = $('#dlg');

export function showDialog(html) {
    dlg.innerHTML = `<div class="in">${html}</div>`;
    dlg.showModal();
}

dlg.addEventListener('click', e => {
    if (e.target === dlg || e.target.closest('[data-close]'))
        dlg.close();   // backdrop or any [data-close] button
});

/* "Are you sure?" window. askConfirm({ title, message, ok, cancel }) resolves true (Yes) or false (cancel, Esc, click outside). */
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
});

export function askConfirm({ title = 'Are you sure?', message = '', ok = 'Yes, confirm', cancel = 'Cancel' } = {}) {
    cfClose(false);
    return new Promise(resolve => {
        cfDone = resolve;
        cf.innerHTML = `<div class="in"><h2 style="margin:0 0 8px">${esc(title)}</h2>${message ? `<p class="mut">${esc(message)}</p>` : ''}
      <div class="acts"><button type="button" class="btn line" data-cf="no">${esc(cancel)}</button><button type="button" class="btn gold" data-cf="yes">${esc(ok)}</button></div></div>`;
        cf.showModal();
        cf.querySelector('[data-cf="no"]').focus();
    });
}

/* Stock alert: shown when the customer tries to take more than the total stock.
   Tells them where the item's stock is held (Studio Add-ons / Outside Rent). */
const sa = document.createElement('dialog');
sa.className = 'dlg confirm';
sa.setAttribute('role', 'alertdialog');
sa.setAttribute('aria-label', 'Maximum stock reached');
document.body.appendChild(sa);
sa.addEventListener('click', e => {
    if (e.target === sa || e.target.closest('[data-sa-close]'))
        sa.close();
});

export function showStockAlert({ name, stock, addon, book = 0, out, text }) {
    sa.innerHTML = `<div class="in"><h2 style="margin:0 0 8px">Maximum stock reached</h2>
      <p><b>${esc(name)}</b></p>
      <p class="mut" style="margin-top:6px">${esc(text)}</p>
      <dl class="dl" style="margin-top:12px"><dt>Total stock</dt><dd>${stock}</dd><dt>In Studio Add-ons</dt><dd>${addon}</dd>${book ? `<dt>In booking form add-ons</dt><dd>${book}</dd>` : ''}<dt>In Outside Rent</dt><dd>${out}</dd></dl>
      <p class="mut" style="margin-top:8px">Remove some from one list if you want to move them to the other.</p>
      <div class="acts"><button type="button" class="btn gold" data-sa-close>OK</button></div></div>`;
    sa.showModal();
    sa.querySelector('[data-sa-close]').focus();
}

/* Larger view of a valid ID (the file just picked, or the one already sent with a rental). */
export function showIdViewer({ url, pdf, title }) {
    const u = esc(url);
    showDialog(`
    <h2>${esc(title || 'Valid ID')}</h2>
    ${pdf ? `<iframe class="idframe" src="${u}" title="Valid ID (PDF)"></iframe>`
            : `<img class="idfull" src="${u}" alt="Valid ID">`}
    <div class="acts">
      <a class="btn line" href="${u}" target="_blank" rel="noopener">Open in new tab</a>
      <button type="button" class="btn gold" data-close>Close</button>
    </div>`);
}

export const stampLabel = ts => new Date(ts).toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
});

const ICON_OK = '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';

const ICON_RECEIPT = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h12v20l-3-2-3 2-3-2-3 2z"/><path d="M9 7h6M9 11h6M9 15h4"/></svg>';

/* Success pop-up and booking receipt. Stays open until the customer presses the button (no timer).
   shot = the sentence shown after "Take a screenshot of this page." (it is the official receipt).
   lines = [[label, value, optionalElementId]]. extraActions = [{ label, className, onClick }] buttons shown before the closing button (for example "Cancel rental"). */
export function showSuccess({ title, label, ref, lines, note, shot, icon, status, doneLabel, extraActions = [] }) {
    okDlg.innerHTML = `
    <div class="in ok">
      <div class="okic" aria-hidden="true">${icon === 'receipt' ? ICON_RECEIPT : ICON_OK}</div>
      <h2>${esc(title)}</h2>
      ${status ? `<div style="margin:4px 0">${status}</div>` : ''}
      <p class="mut">${esc(label)}</p>
      <div class="okref" id="ok-ref">${esc(ref)}</div>
      <button type="button" class="btn line sm" id="ok-copy">Copy code</button>
      ${(lines && lines.length) ? `<dl class="dl" style="text-align:left;margin-top:14px">${lines.map(l => `<dt>${esc(l[0])}</dt><dd${l[2] ? ` id="${esc(l[2])}"` : ''}>${esc(l[1])}</dd>`).join('')}</dl>` : ''}
      ${shot ? `<div class="shot"><b>Take a screenshot of this page.</b> ${esc(shot)}</div>` : ''}
      ${note ? `<p class="mut" style="margin-top:12px">${esc(note)}</p>` : ''}
      <div class="acts" style="justify-content:center">
        ${extraActions.map((action, actionIndex) => `<button type="button" class="btn ${esc(action.className || 'line')}" data-extra-action="${actionIndex}">${esc(action.label)}</button>`).join('')}
        <button type="button" class="btn gold" id="ok-done">${esc(doneLabel || 'Done')}</button>
      </div>
    </div>`;
    okDlg.querySelectorAll('[data-extra-action]').forEach(actionButton => {
        actionButton.onclick = () => extraActions[Number(actionButton.dataset.extraAction)].onClick();
    });
    $('#ok-done').onclick = () => okDlg.close();
    $('#ok-copy').onclick = async e => {
        try {
            await navigator.clipboard.writeText(ref);
            e.target.textContent = 'Copied';
        }
        catch (err) {
            e.target.textContent = 'Select the code above to copy';
        }
    };
    okDlg.showModal();
    $('#ok-done').focus();
}

/* ---- booking form (modal) ---- */
export const bkDlg = $('#bkdlg');
