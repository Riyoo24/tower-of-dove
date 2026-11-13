/* =====================================================================
   shared/imageViewer.js - larger view of one picture (for example a GCash screenshot) inside the website.
   openImageViewer({ url, title }) opens a pop-up on top of whatever is open, with an "Open in new tab" link.
   ===================================================================== */

import { esc } from './utils.js';

let viewer;

function getViewer() {
    if (viewer)
        return viewer;
    viewer = document.createElement('dialog');
    viewer.className = 'dlg imgviewer';
    viewer.addEventListener('click', e => {
        if (e.target === viewer || e.target.closest('[data-iv-close]'))
            viewer.close();
    });
    viewer.addEventListener('close', () => {
        viewer.innerHTML = '';
    });
    document.body.appendChild(viewer);
    return viewer;
}

/* 1234567890123 -> "1234 567 890123", the way GCash prints it on the receipt */
const fmtRef = r => {
    const d = String(r || '').replace(/\s/g, '');
    return /^\d{13}$/.test(d) ? `${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7)}` : d;
};

/* info (optional) = { ref, amount }: the reference number the customer typed and the amount recorded, shown right above
   the picture so staff can compare them with the screenshot without closing it. */
export function openImageViewer({ url, title, ref, amount }) {
    const v = getViewer(), u = esc(url), t = esc(title || 'Picture');
    v.setAttribute('aria-label', t);
    const info = ref || amount ? `<div class="iv-info" role="group" aria-label="Details to compare with the screenshot">
        ${ref ? `<div><span class="mut">Reference number entered by the customer</span><b class="iv-ref">${esc(fmtRef(ref))}</b></div>` : ''}
        ${amount ? `<div><span class="mut">Amount recorded</span><b>${esc(amount)}</b></div>` : ''}
      </div>` : '';
    v.innerHTML = `<div class="in">
      <h2>${t}</h2>
      ${info}
      <img class="idfull" src="${u}" alt="${t}" decoding="async">
      <div class="acts">
        <a class="btn line" href="${u}" target="_blank" rel="noopener">Open in new tab</a>
        <button type="button" class="btn gold" data-iv-close>Close</button>
      </div>
    </div>`;
    if (!v.open)
        v.showModal();
    v.querySelector('[data-iv-close]').focus();
}

/* A "View photo" button. Any button with data-view-photo opens the picture in the viewer (one listener for the whole page),
   so windows can hide their pictures behind a button instead of showing them. */
export const photoBtn = (url, title, label, info = {}) =>
    `<button type="button" class="btn sm line" data-view-photo="${esc(url)}" data-title="${esc(title)}"${info.ref ? ` data-ref="${esc(info.ref)}"` : ''}${info.amount ? ` data-amount="${esc(info.amount)}"` : ''}>${esc(label || 'View photo')}</button>`;

document.addEventListener('click', e => {
    const b = e.target.closest('[data-view-photo]');
    if (b)
        openImageViewer({ url: b.dataset.viewPhoto, title: b.dataset.title, ref: b.dataset.ref, amount: b.dataset.amount });
});
