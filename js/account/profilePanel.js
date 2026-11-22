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
  <div class="acct">
    <aside class="acct-card acct-summary" aria-label="Account summary">
      <div class="acct-avatar" id="pf-avatar" aria-hidden="true"></div>
      <h2 id="pf-sum-name"></h2>
      <p class="mut" id="pf-sum-user"></p>
      <dl>
        <div><dt>Login email</dt><dd><span class="acct-dot" aria-hidden="true"></span><span id="pf-sum-email"></span></dd></div>
        <div><dt>Email change</dt><dd id="pf-sum-pending"></dd></div>
        <div><dt>Password</dt><dd class="mut">Changed by email link</dd></div>
      </dl>
    </aside>

    <div class="acct-main">
      <form class="acct-card" id="pf-name-form" novalidate>
        <div class="acct-body" id="acct-name">
          <h2>Account name</h2>
          <p class="mut acct-lead">Your first and last name update as soon as you save. Your username is shown in the sidebar.</p>
          <div class="acct-fields">
            <div class="wide">
              <label for="pf-username">Username <span class="req" aria-hidden="true">*</span></label>
              <input id="pf-username" autocomplete="username" autocapitalize="none" spellcheck="false" minlength="3" maxlength="30" required aria-required="true" aria-describedby="pf-username-help">
              <p class="mut acct-help" id="pf-username-help">Your sidebar display name. Use 3-30 letters, numbers, underscores or periods.</p>
            </div>
            <div>
              <label for="pf-first-name">First name <span class="req" aria-hidden="true">*</span></label>
              <input id="pf-first-name" data-letters autocomplete="given-name" required aria-required="true">
            </div>
            <div>
              <label for="pf-last-name">Last name</label>
              <input id="pf-last-name" data-letters autocomplete="family-name">
            </div>
          </div>
          <div class="alert" id="pf-name-error" hidden></div>
        </div>
        <div class="acct-foot">
          <span class="mut" id="pf-name-state" aria-live="polite">No changes yet</span>
          <button class="btn gold" type="submit" id="pf-name-save" disabled>Save name</button>
        </div>
      </form>

      <form class="acct-card" id="pf-email-form" novalidate>
        <div class="acct-body" id="acct-email">
          <h2>Email address</h2>
          <p class="mut acct-lead">This is the address you log in with. We email a confirmation link to the new address; it changes after you open it.</p>
          <div class="alert ok" id="pf-email-notice" hidden></div>
          <div class="alert" id="pf-email-error" hidden></div>
          <div class="acct-fields">
            <div>
              <label for="pf-current-email">Current email</label>
              <input id="pf-current-email" type="email" readonly>
            </div>
            <div>
              <label for="pf-new-email">New email (Gmail or any address) <span class="req" aria-hidden="true">*</span></label>
              <input id="pf-new-email" type="email" inputmode="email" autocomplete="off" placeholder="name@gmail.com" required aria-required="true">
            </div>
          </div>
        </div>
        <div class="acct-foot">
          <span class="mut" id="pf-email-state" aria-live="polite">Enter a new address to continue</span>
          <button class="btn gold" type="submit" id="pf-email-save" disabled>Change email</button>
        </div>
      </form>

      <form class="acct-card" id="pf-password-form" novalidate>
        <div class="acct-body acct-pw" id="acct-password">
          <div>
            <h2>Password</h2>
            <p class="mut acct-lead">For your security the password is changed through an email link. We send it to your login address; open it and choose a new password.</p>
            <div class="alert ok" id="pf-password-notice" hidden></div>
            <div class="alert" id="pf-password-error" hidden></div>
          </div>
          <button class="btn gold" type="submit" id="pf-password-save">Email me a password link</button>
        </div>
      </form>
    </div>
  </div>`;

function showMessage(elementId, message) {
    const messageBox = $(elementId);
    messageBox.textContent = message;
    messageBox.hidden = !message;
}

/* Runs a save action: a spinner while it works, a check mark when it worked, and any error in the given box. */
async function runFormAction(saveButtonId, errorBoxId, action, afterSettled) {
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
    if (afterSettled)
        afterSettled();
}

function showPendingEmail(pendingEmail) {
    showMessage('#pf-email-notice', pendingEmail
        ? `Confirmation sent. Open the link we emailed to ${pendingEmail} (and to your current address) to finish the change. You keep logging in with your current email until then.`
        : '');
}

/* The summary card on the left mirrors what is saved (not what is typed). */
function renderSummary(profile) {
    const fullName = `${profile.firstName} ${profile.lastName}`.trim() || profile.username;
    const letter = ((profile.firstName || profile.username || 'U').trim()[0] || 'U').toUpperCase();
    $('#pf-avatar').textContent = letter;
    $('#pf-sum-name').textContent = fullName;
    $('#pf-sum-user').textContent = '@' + profile.username;
    $('#pf-sum-email').textContent = profile.loginEmail;
    const pending = $('#pf-sum-pending');
    pending.textContent = '';
    pending.className = '';
    if (profile.pendingEmail) {
        const dot = document.createElement('span');
        dot.className = 'acct-dot wait';
        dot.setAttribute('aria-hidden', 'true');
        const text = document.createElement('span');
        text.textContent = profile.pendingEmail;
        pending.append(dot, text);
    } else {
        pending.className = 'mut';
        pending.textContent = 'None pending';
    }
}

/* Save buttons stay off until there is something to save. The server still checks everything. */
function updateNameState(profile) {
    const changed = $('#pf-username').value.trim() !== profile.username
        || $('#pf-first-name').value.trim() !== profile.firstName
        || $('#pf-last-name').value.trim() !== profile.lastName;
    const complete = $('#pf-username').value.trim() && $('#pf-first-name').value.trim();
    const saveButton = $('#pf-name-save');
    if (!saveButton.classList.contains('is-busy') && !saveButton.classList.contains('is-done'))
        saveButton.disabled = !(changed && complete);
    $('#pf-name-state').textContent = !changed ? 'No changes yet' : complete ? 'You have unsaved changes' : 'Username and first name are required';
}

function updateEmailState(profile) {
    const typed = $('#pf-new-email').value.trim();
    const sameAsNow = typed.toLowerCase() === profile.loginEmail.toLowerCase();
    const saveButton = $('#pf-email-save');
    if (!saveButton.classList.contains('is-busy') && !saveButton.classList.contains('is-done'))
        saveButton.disabled = !typed || sameAsNow;
    $('#pf-email-state').textContent = !typed ? 'Enter a new address to continue' : sameAsNow ? 'That is already your login email' : 'Ready to send a confirmation link';
}

/* The header chips (Name / Email / Password) jump to a card and show which one is in view. Only account.html has them. */
function wireSectionChips() {
    const chips = [...document.querySelectorAll('.pg-chips a[href^="#acct-"]')];
    if (!chips.length || !('IntersectionObserver' in window))
        return;
    const watcher = new IntersectionObserver(entries => entries.forEach(entry => {
        if (entry.isIntersecting)
            chips.forEach(chip => chip.setAttribute('aria-current', String(chip.getAttribute('href') === '#' + entry.target.id)));
    }), { rootMargin: '-35% 0px -55% 0px' });
    chips.forEach(chip => {
        const target = document.querySelector(chip.getAttribute('href'));
        if (target)
            watcher.observe(target);
    });
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
    renderSummary(profile);
    updateNameState(profile);
    updateEmailState(profile);
    wireSectionChips();
    ['#pf-username', '#pf-first-name', '#pf-last-name'].forEach(id => $(id).addEventListener('input', () => updateNameState(profile)));
    $('#pf-new-email').addEventListener('input', () => updateEmailState(profile));

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
            renderSummary(profile);
            toast('Your account name was saved.');
        }, () => updateNameState(profile));
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
            renderSummary(profile);
            toast('Check your inbox to confirm the new email address.');
        }, () => updateEmailState(profile));
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