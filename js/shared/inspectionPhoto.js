/* =====================================================================
   shared/inspectionPhoto.js – Equipment inspection photo utilities
   Used by admin/rentals.js (before-photo at issue, after-photo at return)
   and customer/myRentals.js (view own rental photos).

   Storage bucket: rental-photos (private)
   Path convention: <rental_detail_id>/<before|after>.<ext>

   Staff  → can upload and read all photos (bucket policy).
   Customers → can read only their own (policy joins rental_detail → rental_order).
   ===================================================================== */

import { sb } from '../config/supabaseClient.js';

export const PHOTO_BUCKET = 'rental-photos';
const MAX_BYTES  = 10 * 1024 * 1024;   // 10 MB
const OK_TYPES   = ['image/jpeg', 'image/png', 'image/webp'];
const SIGNED_TTL = 600;                 // 10-minute signed URLs

/* ---- validation ---- */
export function validatePhoto(file) {
    if (!file) return 'Choose a photo file.';
    if (!OK_TYPES.includes(file.type)) return 'Only JPEG, PNG, or WebP photos are accepted.';
    if (file.size > MAX_BYTES) return 'The photo must be under 10 MB.';
    return null;
}

/* ---- upload ---- */
export async function uploadInspectionPhoto(rentalDetailId, role, file) {
    // role: 'before' | 'after'
    const err = validatePhoto(file);
    if (err) throw new Error(err);

    const ext  = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const path = `${rentalDetailId}/${role}.${ext}`;

    // upsert so re-uploading a corrected photo works
    const { error } = await sb.storage.from(PHOTO_BUCKET).upload(path, file, {
        contentType : file.type,
        upsert      : true
    });
    if (error) throw new Error(error.message);
    return path;   // store this in rental_detail.before_photo_path / after_photo_path
}

/* ---- upload the handover proof (one per rental order): <PHOTO_BUCKET>/order-<rental_order_id>/handover.<ext> ---- */
export async function uploadHandoverPhoto(rentalOrderId, file) {
    const err = validatePhoto(file);
    if (err) throw new Error(err);
    const ext  = (file.name.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
    const path = `order-${rentalOrderId}/handover.${ext}`;
    const { error } = await sb.storage.from(PHOTO_BUCKET).upload(path, file, { contentType: file.type, upsert: true });
    if (error) throw new Error(error.message);
    return path;   // stored in rental_order.handover_photo_path
}

/* ---- signed URL (staff or customer viewing own) ---- */
export async function signedPhotoUrl(path) {
    if (!path) return null;
    const { data, error } = await sb.storage.from(PHOTO_BUCKET).createSignedUrl(path, SIGNED_TTL);
    if (error || !data) return null;
    return data.signedUrl;
}

/* ---- small inline photo builder ---- */
export function photoThumb(signedUrl, alt, linkClass = '') {
    if (!signedUrl)
        return '<span class="mut">—</span>';
    return `<a href="${signedUrl}" target="_blank" rel="noopener" class="${linkClass}" title="Open full size">
      <img src="${signedUrl}" alt="${alt}" class="insp-thumb" loading="lazy" decoding="async">
    </a>`;
}

/* ---- photo picker widget (returns { el, getFile, reset }) ---- */
export function makePhotoPicker({ id, label, required = false, disabled = false }) {
    const wrap = document.createElement('div');
    wrap.className = 'photo-pick-wrap';
    wrap.dataset.pickerId = id;

    wrap.innerHTML = `
      <label for="${id}" class="photo-pick-label">
        ${label}${required ? ' <span class="req" aria-hidden="true">*</span>' : ''}
      </label>
      <div class="photo-pick-row">
        <label class="btn sm line photo-pick-btn${disabled ? ' disabled' : ''}" aria-disabled="${disabled}">
          <input type="file" id="${id}" accept="image/jpeg,image/png,image/webp"
            style="position:absolute;opacity:0;width:0;height:0" ${disabled ? 'disabled' : ''}>
          Attach photo
        </label>
        <span class="photo-pick-name mut" id="${id}-name">No file chosen</span>
        <a id="${id}-view" class="btn sm line" href="#" target="_blank" rel="noopener" hidden>View</a>
        <button type="button" class="btn sm line" id="${id}-rm" hidden>Remove</button>
      </div>
      <div class="photo-pick-preview" id="${id}-prev" hidden></div>`;

    let _file = null;

    function update() {
        const name  = wrap.querySelector(`#${id}-name`);
        const view  = wrap.querySelector(`#${id}-view`);
        const rm    = wrap.querySelector(`#${id}-rm`);
        const prev  = wrap.querySelector(`#${id}-prev`);
        if (_file) {
            name.textContent = _file.name;
            const url = URL.createObjectURL(_file);
            view.href = url;
            view.hidden = false;
            rm.hidden = false;
            prev.hidden = false;
            prev.innerHTML = `<img src="${url}" alt="Preview" class="insp-thumb-lg" loading="lazy" decoding="async">`;
        } else {
            name.textContent = 'No file chosen';
            view.hidden = true;
            rm.hidden = true;
            prev.hidden = true;
            prev.innerHTML = '';
        }
    }

    wrap.querySelector(`#${id}`).addEventListener('change', e => {
        _file = e.target.files[0] || null;
        update();
    });
    wrap.querySelector(`#${id}-rm`).addEventListener('click', () => {
        _file = null;
        wrap.querySelector(`#${id}`).value = '';
        update();
    });

    return {
        el     : wrap,
        getFile: () => _file,
        reset  : () => { _file = null; wrap.querySelector(`#${id}`).value = ''; update(); },
        disable: (on) => {
            const inp = wrap.querySelector(`#${id}`);
            const btn = wrap.querySelector('.photo-pick-btn');
            inp.disabled = on;
            btn.classList.toggle('disabled', on);
            btn.setAttribute('aria-disabled', String(on));
        }
    };
}
