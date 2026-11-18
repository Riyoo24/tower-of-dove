/* =====================================================================
   js/shared/qrZoom.js - the GCash QR code: tap it to see it bigger, and (customer page) pay from the same phone
   Works for every QR in a ".gq" box: booking form, extend/pay-balance, outside rental and add-on
   rental. One shared full-screen viewer (a <dialog>, so it sits above the checkout window).
   Click the image, or focus it and press Enter / Space. Click anywhere, the X, or Esc to close.

   On the customer page the enlarged view also helps someone paying on the SAME phone, who cannot scan a QR that is on
   their own screen:
     - "Save QR image": saves the picture (iPhone: the share sheet, where "Save Image" puts it in Photos; others:
       a normal download) so it can be uploaded in the GCash app (Pay QR > Upload QR).
     - the studio's GCash account name and number (with a Copy button), as another way to pay.
   The name and number are set by the owner in Dashboard > Settings (supabase/97_gcash_account_details.sql).
   ===================================================================== */

import { RULES } from './availability.js';
import { btnBusy, btnReset } from './btnState.js';
import { toast } from './utils.js';

const onCustomerPage = () => !!document.querySelector('main#customer');

let viewer = null;

function buildViewer() {
    const d = document.createElement('dialog');
    d.className = 'qr-zoom';
    d.setAttribute('aria-label', 'GCash QR code, enlarged');
    const customer = onCustomerPage();
    d.innerHTML = `
        <button type="button" class="qr-zoom-x" aria-label="Close">&times;</button>
        <img alt="GCash QR code to scan">
        <p>${customer ? 'Scan this code with another device, or save it and upload it in GCash.' : 'Scan this code with GCash.'} Tap anywhere to close.</p>
        ${customer ? `<button type="button" class="btn gold sm gq-save qr-zoom-save">Save QR image</button>
        <div class="gq-acct" hidden>
            <p class="gq-acct-t">Or send the payment to this GCash account:</p>
            <dl>
                <div><dt>GCash name</dt><dd class="gq-an"></dd></div>
                <div><dt>GCash number</dt><dd><span class="gq-num"></span> <button type="button" class="btn line sm gq-copy">Copy</button></dd></div>
            </dl>
        </div>` : ''}`;
    // a tap anywhere closes the viewer, except on its buttons
    d.addEventListener('click', e => {
        if (!e.target.closest('.gq-save, .gq-copy'))
            d.close();
    });
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
    fillAccount(viewer);
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


/* ============================ paying on the same phone ============================ */

const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const setHidden = (el, v) => {
    if (el && el.hidden !== v)
        el.hidden = v;
};
const setText = (el, v) => {
    if (el && el.textContent !== v)
        el.textContent = v;
};

/* The studio's GCash account name and number, shown in the enlarged QR view only (customer page). */
function fillAccount(viewerEl) {
    const acct = viewerEl.querySelector('.gq-acct');
    if (!acct)
        return;
    const has = !!(RULES.gcashName || RULES.gcashNumber);
    setHidden(acct, !has);
    if (!has)
        return;
    setText(acct.querySelector('.gq-an'), RULES.gcashName || '-');
    setText(acct.querySelector('.gq-num'), RULES.gcashNumber || '-');
    setHidden(acct.querySelector('.gq-copy'), !RULES.gcashNumber);
}

/* The QR image shown in the enlarged view that the pressed button belongs to. */
function qrFor(btn) {
    const viewerEl = btn.closest('dialog.qr-zoom');
    return viewerEl && viewerEl.querySelector('img');
}

async function saveQr(btn) {
    const img = qrFor(btn);
    const src = img && (img.currentSrc || img.src);
    if (!src)
        return;
    btnBusy(btn, 'Saving…');
    try {
        const res = await fetch(src, { mode: 'cors' });
        if (!res.ok)
            throw new Error('download failed');
        const blob = await res.blob();
        const type = blob.type && blob.type.startsWith('image/') ? blob.type : 'image/png';
        const file = new File([blob], 'tower-of-dove-gcash-qr.' + (type.split('/')[1] || 'png').replace('jpeg', 'jpg'), { type });
        // iPhone and iPad: the share sheet has "Save Image", which puts it in Photos (a plain download goes to Files)
        if (isIOS() && navigator.canShare && navigator.canShare({ files: [file] })) {
            try {
                await navigator.share({ files: [file], title: 'Tower of Dove GCash QR' });
                toast('In GCash, tap Pay QR, then Upload QR, and pick the saved image.');
                return;
            } catch (err) {
                if (err && err.name === 'AbortError')
                    return;   // they closed the share sheet
                /* the share failed: fall back to a download below */
            }
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = file.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        toast('QR image saved. In GCash, tap Pay QR, then Upload QR, and pick it from your photos.');
    } catch (err) {
        // could not fetch the picture (offline, blocked): open it big so it can be pressed and held to save
        openZoom(src, img.alt);
        toast('Could not save it automatically. Press and hold the QR image, then choose Save Image.');
    } finally {
        btnReset(btn);
    }
}

async function copyNumber(btn) {
    const number = (RULES.gcashNumber || '').trim();
    if (!number)
        return;
    try {
        await navigator.clipboard.writeText(number);
        toast('GCash number copied.');
    } catch (err) {
        toast('Could not copy. The number is ' + number + '.');
    }
}

document.addEventListener('click', e => {
    const save = e.target.closest && e.target.closest('.gq-save');
    if (save) {
        e.preventDefault();
        saveQr(save);
        return;
    }
    const copy = e.target.closest && e.target.closest('.gq-copy');
    if (copy) {
        e.preventDefault();
        copyNumber(copy);
    }
});