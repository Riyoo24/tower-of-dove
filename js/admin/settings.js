/* =====================================================================
   admin/settings.js - Settings tab: profile, staff accounts, GCash QR
   DB: edge function create-staff, app_user, storage studio-images (payment/gcash-qr).
   ===================================================================== */

import { afterAction } from './bookings.js';
import { STAFF } from './data.js';
import { ACT, OWNER, btn, dlg, run, showDlg, tb, CONFIRM } from './helpers.js';
import { sb } from '../config/supabaseClient.js';
import { GCASH_QR_PATH, gcashQrUrl } from '../shared/catalog.js';
import { $, esc, isEmail, isName, normalizeEmail, toast } from '../shared/utils.js';

/* ============================ 9. SETTINGS & STAFF ============================ */

export function renderStaff() {
  const head = OWNER ? ['Name', 'Email', 'Role', 'Status', 'Actions'] : ['Name', 'Role', 'Status'];
  tb('stf', head, STAFF.map(u => {
    const name = esc(((u.first_name || '') + ' ' + (u.last_name || '')).trim() || u.username);
    const role = u.role === 'Owner' ? 'Owner/Admin' : 'Staff/Caretaker', status = esc(u.status || 'Active');
    if (!OWNER) return [name, role, status];
    const acts = u.role === 'Staff' ? btn('sf-pw', u.user_id, 'Reset password', 1) + btn('sf-tog', u.user_id, u.status === 'Active' ? 'Deactivate' : 'Activate', 1) : '-';
    return [name, esc(u.username), role, status, acts];
  }));
}

/* Staff accounts are created by the create-staff Edge Function (it holds the service_role key). */
async function fnCall(body) {
  const { data, error } = await sb.functions.invoke('create-staff', { body });
  if (error) {
    let msg = error.message || 'Something went wrong.';
    try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch (e) { /* no body */ }
    if (/failed to send|fetch|not found|404/i.test(msg)) msg = 'Could not reach the create-staff function. Deploy it first (see supabase/README.md).';
    throw new Error(msg);
  }
  if (data && data.error) throw new Error(data.error);
  return data;
}

function staffForm() {
  showDlg(`<form id="sf-f" novalidate><h2 style="margin:0 0 4px">Add staff account</h2>
    <p class="mut">The staff member logs in with this email address and password. Give them the temporary password in person.</p>
    <p class="req-note"><span class="req">*</span> Required</p>
    <div class="fg" style="grid-template-columns:1fr 1fr"><div><label for="sf-fn">First name <span class="req" aria-hidden="true">*</span></label><input id="sf-fn" data-letters autocomplete="off" required aria-required="true"></div><div><label for="sf-ln">Last name <span class="req" aria-hidden="true">*</span></label><input id="sf-ln" data-letters autocomplete="off" required aria-required="true"></div></div>
    <label for="sf-u">Email address <span class="req" aria-hidden="true">*</span></label><input id="sf-u" type="email" inputmode="email" autocomplete="off" placeholder="e.g. maria@example.com" required aria-required="true">
    <label for="sf-p">Phone (optional)</label><input id="sf-p" type="tel" autocomplete="off">
    <label for="sf-pw">Temporary password <span class="req" aria-hidden="true">*</span></label><input id="sf-pw" autocomplete="off" placeholder="At least 8 characters" required aria-required="true">
    <div class="alert" id="sf-e" hidden></div>
    <div class="acts"><button type="button" class="btn line" data-close>Cancel</button><button class="btn gold" id="sf-go">Create account</button></div></form>`);
  $('#sf-f').onsubmit = async ev => {
    ev.preventDefault();
    const err = m => { $('#sf-e').textContent = m; $('#sf-e').hidden = !m; };
    const v = { action: 'create', first_name: $('#sf-fn').value.trim(), last_name: $('#sf-ln').value.trim(), email: normalizeEmail($('#sf-u').value), number: $('#sf-p').value.trim(), password: $('#sf-pw').value };
    if (!v.first_name || !v.last_name) return err('Enter the first and last name.');
    if (!isName(v.first_name) || !isName(v.last_name)) return err('First and last names can only contain letters.');
    if (!isEmail(v.email)) return err('Enter a valid email address, like name@example.com.');
    if (v.password.length < 8) return err('The password must be at least 8 characters.');
    $('#sf-go').disabled = true; err('');
    try { await fnCall(v); await afterAction(`Staff account "${v.email}" created.`); }
    catch (x) { err(x.message); $('#sf-go').disabled = false; }
  };
}

ACT['sf-pw'] = id => {
  const u = STAFF.find(x => x.user_id === +id);
  showDlg(`<form id="sp-f" novalidate><h2 style="margin:0 0 4px">Reset password</h2><p class="mut">Set a new temporary password for ${esc(u.username)}.</p>
    <label for="sp-pw">New password</label><input id="sp-pw" autocomplete="off" placeholder="At least 8 characters">
    <div class="alert" id="sp-e" hidden></div>
    <div class="acts"><button type="button" class="btn line" data-close>Cancel</button><button class="btn gold" id="sp-go">Save password</button></div></form>`);
  $('#sp-f').onsubmit = async ev => {
    ev.preventDefault();
    const err = m => { $('#sp-e').textContent = m; $('#sp-e').hidden = !m; }, pw = $('#sp-pw').value;
    if (pw.length < 8) return err('The password must be at least 8 characters.');
    $('#sp-go').disabled = true; err('');
    try { await fnCall({ action: 'reset_password', user_id: u.user_id, password: pw }); dlg.close(); toast(`Password for ${u.username} changed.`); }
    catch (x) { err(x.message); $('#sp-go').disabled = false; }
  };
};

/* only deactivating asks "Are you sure?"; activating again does not */
CONFIRM['sf-tog'] = id => {
  const u = STAFF.find(x => x.user_id === +id);
  return u && u.status === 'Active' ? { title: 'Deactivate this staff account?', message: `${u.username} will no longer be able to log in or use the dashboard. You can activate the account again later.`, ok: 'Yes, deactivate', danger: true } : null;
};

ACT['sf-tog'] = async id => {
  const u = STAFF.find(x => x.user_id === +id), next = u.status === 'Active' ? 'Inactive' : 'Active';
  if (await run(sb.from('app_user').update({ status: next }).eq('user_id', u.user_id))) afterAction(`${u.username} ${next === 'Active' ? 'activated' : 'deactivated'}.`);
};

export async function fillProfile() {
  const { data } = await sb.auth.getUser();
  const me = data && data.user && STAFF.find(u => u.auth_user_id === data.user.id);
  if (!me) return;
  if ($('#an')) $('#an').value = ((me.first_name || '') + ' ' + (me.last_name || '')).trim();
  if ($('#ae')) $('#ae').value = me.username || '';
}

$('#ap-btn').onclick = async () => {
  const pw = $('#ap').value;
  if (pw.length < 8) return toast('Use a password of at least 8 characters.');
  if (await run(sb.auth.updateUser({ password: pw }))) { $('#ap').value = ''; toast('Password changed.'); }
};

/* ---- GCash QR code shown in the customer booking form ---- */
function showQrPreview(src) {
  const box = $('#gq-prev');
  box.innerHTML = '<img id="gq-img" alt="Current GCash QR code" hidden><p class="mut" id="gq-note">Checking for a QR code...</p>';
  const img = $('#gq-img');
  img.onload = () => { img.hidden = false; $('#gq-note').textContent = 'This is the QR code customers see now.'; };
  img.onerror = () => { img.hidden = true; $('#gq-note').textContent = 'No QR code uploaded yet. Customers are told to ask staff for the GCash details.'; };
  img.src = src;
}

$('#gq-card').hidden = !OWNER;

if (OWNER) {
  showQrPreview(gcashQrUrl(Date.now()));
  $('#gq-btn').onclick = async () => {
    const f = $('#gq-file').files[0];
    if (!f) return toast('Choose the QR image first.');
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) return toast('Use a PNG, JPG or WebP image.');
    if (f.size > 5 * 1024 * 1024) return toast('The image must be 5 MB or smaller.');
    $('#gq-btn').disabled = true;
    const up = await sb.storage.from('studio-images').upload(GCASH_QR_PATH, f, { upsert: true, contentType: f.type, cacheControl: '60' });
    $('#gq-btn').disabled = false;
    if (up.error) return toast('Upload failed: ' + up.error.message);
    $('#gq-file').value = '';
    showQrPreview(gcashQrUrl(Date.now()));
    toast('GCash QR code saved. Customers will see it in the booking form.');
  };
}

const addStaffBtn = $('#st-add');

if (addStaffBtn) addStaffBtn.onclick = () => { if (OWNER) staffForm(); else toast('Only the owner can add staff accounts.'); };
