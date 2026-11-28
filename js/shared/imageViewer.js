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
        const to = e.target.closest('[data-iv-to]');
        if (to && gal)
            show(+to.dataset.ivTo);
    });
    viewer.addEventListener('keydown', e => {
        if (gal && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
            e.preventDefault();
            step(e.key === 'ArrowRight' ? 1 : -1);
        }
    });
    viewer.addEventListener('close', () => {
        gal = null;
        setTimeout(() => {   // wait for the 160ms fade-out (css/motion.css); skip if the viewer was opened again meanwhile
            if (viewer.open)
                return;
            viewer.innerHTML = '';
            viewer.classList.remove('iv-wide');
        }, 200);
    });
    document.body.appendChild(viewer);
    return viewer;
}

/* gallery: show the next or previous picture (wraps around) and keep the focus on the arrow that was used */
function step(d) {
    show(gal.i + d);
    viewer.querySelector(`[data-iv-go="${d}"]`)?.focus();
}

function show(i) {
    gal.i = (i + gal.list.length) % gal.list.length;
    paintGallery(viewer);
}

/* Room photos: a big picture with the arrows on its sides, a header with the counter, and a strip of thumbnails.
   The first call builds the window; later calls only swap the picture, so nothing jumps or flashes. */
function paintGallery(v) {
    const n = gal.list.length, u = esc(gal.list[gal.i]), t = esc(`${gal.title} (${gal.i + 1} of ${n})`);
    v.setAttribute('aria-label', t);
    v.classList.add('iv-wide');
    if (!v.querySelector('.ivg')) {
        v.innerHTML = `<div class="in ivg">
      <header class="ivg-head">
        <h2>${esc(gal.title)}</h2>
        <span class="ivg-count" aria-hidden="true"></span>
        <a class="ivg-open" target="_blank" rel="noopener">Open in new tab &#8599;</a>
        <button type="button" class="ivg-x" data-iv-close aria-label="Close">&times;</button>
      </header>
      <div class="ivg-stage">
        <button type="button" class="iv-go" data-iv-go="-1" aria-label="Previous photo">&#8249;</button>
        <div class="ivg-pic"><img class="idfull" alt="" decoding="async"></div>
        <button type="button" class="iv-go" data-iv-go="1" aria-label="Next photo">&#8250;</button>
      </div>
      <div class="ivg-thumbs" role="group" aria-label="All photos">${gal.list.map((src, k) => `<button type="button" class="ivg-th" data-iv-to="${k}" aria-label="Show photo ${k + 1} of ${n}"><img src="${esc(src)}" alt="" loading="lazy" decoding="async"></button>`).join('')}</div>
    </div>`;
    }
    v.querySelector('.ivg-count').textContent = `${gal.i + 1} / ${n}`;
    v.querySelector('.ivg-open').href = gal.list[gal.i];
    const img = v.querySelector('.ivg-pic img');
    img.alt = t;
    img.classList.add('loading');   // fades in once the new picture has arrived
    img.onload = img.onerror = () => img.classList.remove('loading');
    img.src = gal.list[gal.i];
    if (img.complete)
        img.classList.remove('loading');
    v.querySelectorAll('.ivg-th').forEach((b, k) => {
        b.classList.toggle('on', k === gal.i);
        b.setAttribute('aria-current', String(k === gal.i));
    });
    v.querySelector('.ivg-th.on')?.scrollIntoView({ block: 'nearest', inline: 'center' });
    [1, -1].forEach(d => { new Image().src = gal.list[(gal.i + d + n) % n]; });   // the next and previous pictures download in advance
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
    v.classList.remove('iv-wide');
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