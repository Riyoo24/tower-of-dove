/* =====================================================================
   customer/ui.js - tab switching, table builder, details dialog, success pop-up
   Small UI pieces shared by every customer tab.
   ===================================================================== */

import { okDlg } from './book.js';
import { setActiveNav } from '../shared/layout.js';
import { $, $$, esc } from '../shared/utils.js';

/* The sidebar links use #book, #rent, #my-bookings and #my-rentals. */
const TABS = { 'book': 'c-book', 'rent': 'c-rent', 'my-bookings': 'c-bk', 'my-rentals': 'c-rental' };

const NAV_KEY = { 'book': 'book', 'rent': 'rent', 'my-bookings': 'mybook', 'my-rentals': 'myrent' };

export function showTab() {
  const name = TABS[location.hash.slice(1)] ? location.hash.slice(1) : 'book';
  $$('.pg').forEach(p => p.classList.toggle('on', p.id === TABS[name]));
  setActiveNav(NAV_KEY[name]);
  scrollTo(0, 0);
}

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
  if (e.target === dlg || e.target.closest('[data-close]')) dlg.close();   // backdrop or any [data-close] button
});

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

export const stampLabel = ts => new Date(ts).toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

const ICON_OK = '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';

const ICON_RECEIPT = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h12v20l-3-2-3 2-3-2-3 2z"/><path d="M9 7h6M9 11h6M9 15h4"/></svg>';

/* Success pop-up and booking receipt. Stays open until the customer presses the button (no timer).
   shot = the sentence shown after "Take a screenshot of this page." (it is the official receipt). */
export function showSuccess({ title, label, ref, lines, note, shot, icon, status, doneLabel }) {
  okDlg.innerHTML = `
    <div class="in ok">
      <div class="okic" aria-hidden="true">${icon === 'receipt' ? ICON_RECEIPT : ICON_OK}</div>
      <h2>${esc(title)}</h2>
      ${status ? `<div style="margin:4px 0">${status}</div>` : ''}
      <p class="mut">${esc(label)}</p>
      <div class="okref" id="ok-ref">${esc(ref)}</div>
      <button type="button" class="btn line sm" id="ok-copy">Copy code</button>
      ${(lines && lines.length) ? `<dl class="dl" style="text-align:left;margin-top:14px">${lines.map(l => `<dt>${esc(l[0])}</dt><dd>${esc(l[1])}</dd>`).join('')}</dl>` : ''}
      ${shot ? `<div class="shot"><b>Take a screenshot of this page.</b> ${esc(shot)}</div>` : ''}
      ${note ? `<p class="mut" style="margin-top:12px">${esc(note)}</p>` : ''}
      <div class="acts" style="justify-content:center"><button type="button" class="btn gold" id="ok-done">${esc(doneLabel || 'Done')}</button></div>
    </div>`;
  $('#ok-done').onclick = () => okDlg.close();
  $('#ok-copy').onclick = async e => {
    try { await navigator.clipboard.writeText(ref); e.target.textContent = 'Copied'; }
    catch (err) { e.target.textContent = 'Select the code above to copy'; }
  };
  okDlg.showModal();
  $('#ok-done').focus();
}

/* ---- booking form (modal) ---- */
export const bkDlg = $('#bkdlg');
