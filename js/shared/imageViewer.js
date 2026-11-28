/* =====================================================================
   shared/imageViewer.js - larger view of one picture (for example a GCash screenshot) inside the website.
   openImageViewer({ url, title }) opens a pop-up on top of whatever is open, with an "Open in new tab" link.
   Add gallery (a list of addresses) and index to get previous / next arrows (room photos on the home page).
   ===================================================================== */

import { esc } from './utils.js';

let viewer, gal = null;   // gal: { list, i, title } while a photo gallery is open (room photos on the home page)

function getViewer() {
    if (viewer)
        return viewer;
    viewer = document.createElement('dialog');
    viewer.className = 'dlg imgviewer';
    viewer.addEventListener('click', e => {
        if (e.target === viewer || e.target.closest('[data-iv-close]'))
            viewer.close();
        const go = e.target.closest('[data-iv-go]');
        if (go && gal)
            step(+go.dataset.ivGo);
    });
    viewer.addEventListener('keydown', e => {
        if (gal && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
            e.preventDefault();
            step(e.key === 'ArrowRight' ? 1 : -1);
        }
    });
    viewer.addEventListener('close', () => {
        viewer.innerHTML = '';
        gal = null;
    });
    document.body.appendChild(viewer);
    return viewer;
}

/* gallery: show the next or previous picture (wraps around) and keep the focus on the arrow that was used */
function step(d) {
    gal.i = (gal.i + d + gal.list.length) % gal.list.length;
    paintGallery(viewer);
    viewer.querySelector(`[data-iv-go="${d}"]`)?.focus();
}

function paintGallery(v) {
    const u = esc(gal.list[gal.i]), t = esc(`${gal.title} (${gal.i + 1} of ${gal.list.length})`);
    v.setAttribute('aria-label', t);
    v.innerHTML = `<div class="in">
      <h2>${t}</h2>
      <div class="iv-gal">
        <button type="button" class="iv-go" data-iv-go="-1" aria-label="Previous photo">&#8249;</button>
        <img class="idfull" src="${u}" alt="${t}" decoding="async">
        <button type="button" class="iv-go" data-iv-go="1" aria-label="Next photo">&#8250;</button>
      </div>
      <div class="acts">
        <a class="btn line" href="${u}" target="_blank" rel="noopener">Open in new tab</a>
        <button type="button" class="btn gold" data-iv-close>Close</button>
      </div>
    </div>`;
}

/* 1234567890123 -> "1234 567 890123", the way GCash prints it on the receipt */
const fmtRef = r => {
    const d = String(r || '').replace(/\s/g, '');
    return /^\d{13}$/.test(d) ? `${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7)}` : d;
};

/* info (optional) = { ref, amount }: the reference number the customer typed and the amount recorded, shown right above
   the picture so staff can compare them with the screenshot without closing it. */
export function openImageViewer({ url, title, ref, amount, gallery, index = 0 }) {
    const v = getViewer();
    // gallery (optional): a list of picture addresses; the viewer then has previous / next arrows and starts at `index`
    if (gallery && gallery.length > 1) {
        gal = { list: gallery, i: Math.min(Math.max(index, 0), gallery.length - 1), title: title || 'Picture' };
        paintGallery(v);
        if (!v.open)
            v.showModal();
        v.querySelector('[data-iv-close]').focus();
        return;
    }
    gal = null;
    const u = esc(url), t = esc(title || 'Picture');
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