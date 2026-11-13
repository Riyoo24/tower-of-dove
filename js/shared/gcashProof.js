/* =====================================================================
   shared/gcashProof.js - "Attach GCash Screenshot" field
   Used by every GCash payment form (studio booking, extension, add-on rental, outside rental).
   - Same look and behaviour as the "Attach valid ID" field of the outside rental form
     (file picker, small preview, View and Remove buttons).
   - Reads the GCash reference number out of the picked screenshot (OCR, runs in the browser with
     Tesseract.js) and fills the reference number field. The customer can still correct it.
   - The file goes to the private storage bucket "gcash-screenshots" at <reference>/<file>.
     Staff open it from the Verify drawer (see listGcashProofs).
   DB: storage bucket gcash-screenshots (run supabase/38_gcash_screenshots.sql).
   ===================================================================== */

import { sb } from '../config/supabaseClient.js';
import { $, esc } from './utils.js';
import { clearFieldError, setFieldError } from './fieldCheck.js';

export const PROOF_BUCKET = 'gcash-screenshots';
const MAX_BYTES = 5 * 1024 * 1024;                       // same 5 MB limit as the bucket
const OK_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

/* ---------- reading the reference number from the OCR text (pure, easy to test) ---------- */

/* OCR often mixes digits up with look-alike letters inside a number. */
const DIGIT_FIX = { O: '0', o: '0', Q: '0', D: '0', I: '1', l: '1', '|': '1', i: '1', S: '5', s: '5', B: '8', Z: '2', z: '2', G: '6' };
const toDigits = s => [...s].map(c => (/\d/.test(c) ? c : (DIGIT_FIX[c] || ''))).join('');

/* Returns the 13-digit GCash reference number found in the text, or '' when there is none.
   GCash prints it as "Ref No. 1234 567 890123". */
export function extractGcashRef(text) {
    if (!text)
        return '';
    const flat = String(text).replace(/\r/g, '\n');

    // 1. right after the "Ref No." label (letters that look like digits are fixed)
    const labelled = /ref(?:erence)?\.?\s*(?:no|number|num|#)?\s*[.:#]?\s*([0-9OoQDIil|SsBZzG][0-9OoQDIil|SsBZzG \t-]{10,24})/gi;
    let m;
    while ((m = labelled.exec(flat))) {
        const d = toDigits(m[1]);
        if (d.length >= 13 && (m[1].match(/\d/g) || []).length >= 9)
            return d.slice(0, 13);
    }

    // 2. any number written as 13 digits, with or without spaces (4-3-6 is the GCash layout)
    const grouped = flat.match(/\b\d{4}[ \t-]?\d{3}[ \t-]?\d{6}\b/);
    if (grouped)
        return grouped[0].replace(/\D/g, '');
    const runs = flat.match(/\d[\d \t-]{11,}\d/g) || [];
    for (const r of runs) {
        const d = r.replace(/\D/g, '');
        if (d.length === 13)
            return d;
    }
    return '';
}

/* ---------- OCR engine: loaded the first time a screenshot is picked ---------- */
let engine = null;
function loadEngine() {
    if (window.Tesseract)
        return Promise.resolve(window.Tesseract);
    if (!engine)
        engine = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = TESSERACT_URL;
            s.async = true;
            s.onload = () => (window.Tesseract ? resolve(window.Tesseract) : reject(new Error('OCR library missing')));
            s.onerror = () => {
                engine = null;                 // allow a retry on the next screenshot
                reject(new Error('OCR library could not load'));
            };
            document.head.appendChild(s);
        });
    return engine;
}

/* Scale the picture to a size the reader likes (screenshots of 1080 px are enlarged, huge photos shrunk). */
async function toCanvas(file) {
    const bmp = await createImageBitmap(file);
    const scale = bmp.width < 1500 ? 1500 / bmp.width : bmp.width > 2600 ? 2600 / bmp.width : 1;
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(bmp, 0, 0, c.width, c.height);
    if (bmp.close)
        bmp.close();
    return c;
}

async function readReference(file) {
    const T = await loadEngine();
    const canvas = await toCanvas(file);
    const { data } = await T.recognize(canvas, 'eng');
    return extractGcashRef(data && data.text);
}

/* ---------- the field ---------- */

/* HTML of the field. p = id prefix ('bk', 'ex', 'ag', 'og'). Put it right under the GCash QR code. */
export function gcashProofHtml(p) {
    return `<label for="${p}-ss">Attach GCash Screenshot <span class="req" aria-hidden="true">*</span></label>
    <input id="${p}-ss" type="file" accept="image/png,image/jpeg,image/webp" required aria-required="true">
    <p class="mut" style="margin-top:4px">Required. Upload a clear screenshot of your GCash payment receipt (JPG, PNG or WEBP, up to 5 MB). We read the reference number from it for you.</p>
    <div class="idprev" id="${p}-ss-prev" hidden>
      <img id="${p}-ss-img" alt="Preview of your GCash screenshot">
      <span class="nm" id="${p}-ss-name"></span>
      <button type="button" class="btn line sm" id="${p}-ss-view">View screenshot</button>
      <button type="button" class="btn line sm" id="${p}-ss-clear">Remove</button>
    </div>
    <p class="mut" id="${p}-ss-ocr" role="status" aria-live="polite" hidden></p>`;
}

/* A viewer of its own, so it also works on top of the booking and extension windows. */
let viewer = null;
function showViewer(url) {
    if (!viewer) {
        viewer = document.createElement('dialog');
        viewer.className = 'dlg';
        viewer.setAttribute('aria-label', 'GCash screenshot');
        viewer.addEventListener('click', e => {
            if (e.target === viewer || e.target.closest('[data-close]'))
                viewer.close();
        });
        document.body.appendChild(viewer);
    }
    const u = esc(url);
    viewer.innerHTML = `<div class="in"><h2>Your GCash screenshot</h2>
    <img class="idfull" src="${u}" alt="GCash screenshot" loading="lazy" decoding="async">
    <div class="acts"><a class="btn line" href="${u}" target="_blank" rel="noopener">Open in new tab</a>
    <button type="button" class="btn gold" data-close>Close</button></div></div>`;
    viewer.showModal();
}

/* Wires the field. opts.ref = the reference number input to fill, opts.onChange = called when the file changes.
   A wrong file type or size is shown under the file box (opts.onError is no longer needed and is ignored).
   Returns { file(), reset() }. */
export function initGcashProof(p, { ref, onChange } = {}) {
    const input = $(`#${p}-ss`);
    if (!input)
        return { file: () => null, reset() {} };
    const refInput = typeof ref === 'string' ? $(ref) : ref;
    let objUrl = null, run = 0, autoValue = '';

    const status = (msg, kind) => {
        const el = $(`#${p}-ss-ocr`);
        el.hidden = !msg;
        el.textContent = '';
        if (msg && kind === 'busy') {                // spinner while the number is being detected
            const spin = document.createElement('span');
            spin.className = 'ocr-spin';
            spin.setAttribute('aria-hidden', 'true');
            el.append(spin, msg);
        }
        else
            el.textContent = msg || '';
        el.style.color = kind === 'ok' ? 'var(--ok, #1f8a4c)' : kind === 'warn' ? 'var(--warn, #b26a00)' : '';
        el.classList.toggle('ocr-busy-msg', kind === 'busy');
    };

    /* the reference number box shimmers while the number is being read */
    const busy = on => {
        if (!refInput)
            return;
        refInput.classList.toggle('ocr-busy', on);
        refInput.setAttribute('aria-busy', on ? 'true' : 'false');
    };

    const clearAuto = () => {                       // remove a number we filled in ourselves, never one the customer typed
        if (refInput && autoValue && refInput.value.replace(/\s/g, '') === autoValue) {
            refInput.value = '';
            refInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
        autoValue = '';
    };

    const drawPreview = () => {
        const f = input.files[0];
        if (objUrl) {
            URL.revokeObjectURL(objUrl);
            objUrl = null;
        }
        $(`#${p}-ss-prev`).hidden = !f;
        if (!f) {
            $(`#${p}-ss-img`).removeAttribute('src');
            return;
        }
        objUrl = URL.createObjectURL(f);
        $(`#${p}-ss-img`).src = objUrl;
        $(`#${p}-ss-name`).textContent = f.name;
    };

    const view = () => {
        if (input.files[0] && objUrl)
            showViewer(objUrl);
    };

    const reset = () => {
        run++;
        input.value = '';
        clearAuto();
        drawPreview();
        status('');
        busy(false);
        if (onChange)
            onChange();
    };

    input.addEventListener('change', async () => {
        const f = input.files[0];
        const mine = ++run;
        clearAuto();
        busy(false);
        if (f && (!OK_TYPES.includes(f.type) || f.size > MAX_BYTES)) {
            input.value = '';
            drawPreview();
            status('');
            const msg = !OK_TYPES.includes(f.type) ? 'The GCash screenshot must be a JPG, PNG or WEBP picture.' : 'The GCash screenshot is too big. Choose a picture under 5 MB.';
            setFieldError(input, msg);   // shown right under the file box
            if (onChange)
                onChange();
            return;
        }
        if (f)
            clearFieldError(input);
        drawPreview();
        if (onChange)
            onChange();
        if (!f) {
            status('');
            return;
        }
        status('Detecting the reference number from your screenshot...', 'busy');
        busy(true);
        try {
            const found = await readReference(f);
            if (mine !== run)
                return;                              // another file was picked meanwhile
            busy(false);
            if (found && refInput) {
                refInput.value = found;
                autoValue = found;
                refInput.dispatchEvent(new Event('input', { bubbles: true }));
                status('Reference number filled in from your screenshot. Please check that it is correct.', 'ok');
            }
            else
                status('We could not read the reference number. Please type the 13-digit number from your receipt.', 'warn');
        }
        catch (e) {
            if (mine === run) {
                busy(false);
                status('Automatic reading is not available right now. Please type the 13-digit reference number.', 'warn');
            }
        }
    });
    $(`#${p}-ss-view`).addEventListener('click', view);
    $(`#${p}-ss-img`).addEventListener('click', view);
    $(`#${p}-ss-clear`).addEventListener('click', reset);

    return { file: () => input.files[0] || null, reset };
}

/* Sends the screenshot to the private bucket. Call it after the form is validated, with the final reference number. */
export async function uploadGcashProof(file, reference) {
    const ext = ((file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '')) || 'png';
    const path = `${reference}/${Date.now()}-${crypto.randomUUID()}.${ext}`;
    const up = await sb.storage.from(PROOF_BUCKET).upload(path, file, { contentType: file.type });
    return { error: up.error || null, path };
}

/* Staff: short-lived links to the screenshot(s) sent with a GCash reference (newest first). */
export async function listGcashProofs(reference) {
    if (!reference)
        return [];
    const bucket = sb.storage.from(PROOF_BUCKET);
    const { data: files, error } = await bucket.list(reference, { limit: 10, sortBy: { column: 'created_at', order: 'desc' } });
    if (error || !files || !files.length)
        return [];
    const out = [];
    for (const f of files.filter(x => x.name)) {
        const { data: s } = await bucket.createSignedUrl(`${reference}/${f.name}`, 600);
        if (s)
            out.push(s.signedUrl);
    }
    return out;
}
