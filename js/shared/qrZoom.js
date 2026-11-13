/* =====================================================================
   js/shared/qrZoom.js - tap the GCash QR code to see it bigger
   Works for every QR in a ".gq" box: booking form, extend/pay-balance, outside rental and add-on
   rental. One shared full-screen viewer (a <dialog>, so it sits above the checkout window).
   Click the image, or focus it and press Enter / Space. Click anywhere, the X, or Esc to close.
   ===================================================================== */

let viewer = null;

function buildViewer() {
    const d = document.createElement('dialog');
    d.className = 'qr-zoom';
    d.setAttribute('aria-label', 'GCash QR code, enlarged');
    d.innerHTML = `
        <button type="button" class="qr-zoom-x" aria-label="Close">&times;</button>
        <img alt="GCash QR code to scan">
        <p>Scan this code with GCash. Tap anywhere to close.</p>`;
    d.addEventListener('click', () => d.close());
    document.body.appendChild(d);
    return d;
}

function openZoom(src, alt) {
    if (!src)
        return;
    viewer = viewer || buildViewer();
    const img = viewer.querySelector('img');
    img.src = src;
    img.alt = alt || 'GCash QR code to scan';
    if (!viewer.open)
        viewer.showModal();
}

/* make each QR image look and behave like a button */
function enhance(root) {
    root.querySelectorAll('.gq img:not([data-qrz])').forEach(img => {
        img.dataset.qrz = '1';
        img.tabIndex = 0;
        img.setAttribute('role', 'button');
        img.title = 'Tap to enlarge';
    });
}

document.addEventListener('click', e => {
    const img = e.target.closest && e.target.closest('.gq img');
    if (img && !img.hidden)
        openZoom(img.currentSrc || img.src, img.alt);
});

document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ')
        return;
    const img = e.target.closest && e.target.closest('.gq img');
    if (img && !img.hidden) {
        e.preventDefault();
        openZoom(img.currentSrc || img.src, img.alt);
    }
});

enhance(document);
new MutationObserver(() => enhance(document)).observe(document.body, { childList: true, subtree: true });
