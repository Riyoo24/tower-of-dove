/* =====================================================================
   account/profilePanel.js - the "name, email, password" forms
   One panel, used by pages/account.html and by the Owner/Staff profile view in pages/admin.html.
   mountProfilePanel() draws the forms into a container and wires them to profileService.js.
   ===================================================================== */

import {
    loadAccountProfile,
    requestEmailChange,
    requestPasswordChangeEmail,
    syncDisplayName,
    updateAccountName
} from './profileService.js';
import { $, toast } from '../shared/utils.js';
import { btnBusy, btnReset, btnSuccess } from '../shared/btnState.js';

const PANEL_HTML = `
  <div class="grid ge">
    <form class="card" id="pf-name-form" novalidate>
      <h2>Account name</h2>
      <p class="mut">Your first and last name update as soon as you save. Your username is shown in the sidebar.</p>
      <label for="pf-username">Username <span class="req" aria-hidden="true">*</span></label>
      <input id="pf-username" autocomplete="username" autocapitalize="none" spellcheck="false" minlength="3" maxlength="30" required aria-required="true" aria-describedby="pf-username-help">
      <p class="mut" id="pf-username-help">Your sidebar display name. Use 3-30 letters, numbers, underscores or periods.</p>
      <label for="pf-first-name">First name <span class="req" aria-hidden="true">*</span></label>
      <input id="pf-first-name" data-letters autocomplete="given-name" required aria-required="true">
      <label for="pf-last-name">Last name</label>
      <input id="pf-last-name" data-letters autocomplete="family-name">
      <div class="alert" id="pf-name-error" hidden></div>
      <button class="btn gold full" type="submit" id="pf-name-save" style="margin-top:12px">Save name</button>
    </form>

    <form class="card" id="pf-email-form" novalidate>
      <h2>Email address</h2>
      <p class="mut">This is the address you log in with. We email a confirmation link to the new address; it changes after you open it.</p>
      <label for="pf-current-email">Current email</label>
      <input id="pf-current-email" type="email" readonly>
      <label for="pf-new-email">New email (Gmail or any address) <span class="req" aria-hidden="true">*</span></label>
      <input id="pf-new-email" type="email" inputmode="email" autocomplete="off" placeholder="name@gmail.com" required aria-required="true">
      <div class="alert ok" id="pf-email-notice" hidden></div>
      <div class="alert" id="pf-email-error" hidden></div>
      <button class="btn gold full" type="submit" id="pf-email-save" style="margin-top:12px">Change email</button>
    </form>

    <form class="card" id="pf-password-form" novalidate>
      <h2>Password</h2>
      <p class="mut">For your security the password is changed through an email link. We send it to your login address; open it and choose a new password.</p>
      <div class="alert ok" id="pf-password-notice" hidden></div>
      <div class="alert" id="pf-password-error" hidden></div>
      <button class="btn gold full" type="submit" id="pf-password-save" style="margin-top:12px">Email me a password link</button>
    </form>
  </div>`;

function showMessage(elementId, message) {
    const messageBox = $(elementId);
    messageBox.textContent = message;
    messageBox.hidden = !message;
}

/* Runs a save action: a spinner while it works, a check mark when it worked, and any error in the given box. */
async function runFormAction(saveButtonId, errorBoxId, action) {
    const saveButton = $(saveButtonId);
    showMessage(errorBoxId, '');
    btnBusy(saveButton, 'Saving…');
    try {
        await action();
        await btnSuccess(saveButton, 'Saved');
    } catch (error) {
        btnReset(saveButton);
        showMessage(errorBoxId, error.message);
    }
}

function showPendingEmail(pendingEmail) {
    showMessage('#pf-email-notice', pendingEmail
        ? `Confirmation sent. Open the link we emailed to ${pendingEmail} (and to your current address) to finish the change. You keep logging in with your current email until then.`
        : '');
}

/* options.container          element the forms are drawn into
   options.emailRedirectUrl   page the confirmation link brings the person back to
   options.onNameSaved(label) called with the username when the sidebar name should change (after saving, and when a stale label is fixed) */
export async function mountProfilePanel({ container, emailRedirectUrl, onNameSaved }) {
    const profile = await loadAccountProfile();
    if (!profile) {
        container.innerHTML = '<div class="card"><p class="mut">Could not load your profile. Please log in again.</p></div>';
        return null;
    }

    container.innerHTML = PANEL_HTML;
    $('#pf-username').value = profile.username;
    $('#pf-first-name').value = profile.firstName;
    $('#pf-last-name').value = profile.lastName;
    $('#pf-current-email').value = profile.loginEmail;
    showPendingEmail(profile.pendingEmail);

    // a sidebar label cached before the name was changed (or an old "Owner" label) is corrected here
    const syncedLabel = syncDisplayName(profile);
    if (syncedLabel && onNameSaved)
        onNameSaved(syncedLabel);

    $('#pf-name-form').addEventListener('submit', submitEvent => {
        submitEvent.preventDefault();
        runFormAction('#pf-name-save', '#pf-name-error', async () => {
            const savedUsername = await updateAccountName(
                profile,
                $('#pf-username').value,
                $('#pf-first-name').value,
                $('#pf-last-name').value
            );
            $('#pf-username').value = profile.username;
            $('#pf-first-name').value = profile.firstName;
            $('#pf-last-name').value = profile.lastName;
            if (onNameSaved)
                onNameSaved(savedUsername);
            toast('Your account name was saved.');
        });
    });

    $('#pf-email-form').addEventListener('submit', submitEvent => {
        submitEvent.preventDefault();
        runFormAction('#pf-email-save', '#pf-email-error', async () => {
            const requestedEmail = await requestEmailChange(
                profile,
                $('#pf-new-email').value,
                emailRedirectUrl
            );
            $('#pf-new-email').value = '';
            showPendingEmail(requestedEmail);
            toast('Check your inbox to confirm the new email address.');
        });
    });

    $('#pf-password-form').addEventListener('submit', submitEvent => {
        submitEvent.preventDefault();
        runFormAction('#pf-password-save', '#pf-password-error', async () => {
            await requestPasswordChangeEmail(profile);
            showMessage('#pf-password-notice', `We emailed a link to ${profile.loginEmail}. Open it to choose a new password. Your current password keeps working until then.`);
            toast('Check your inbox for the password link.');
        });
    });

    return profile;
}
