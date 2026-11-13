/* =====================================================================
   customer/registerModal.js - "Create your account" pop-up on the booking page
   Same fields and checks as the register form on pages/login.html (first and last name, phone,
   email, password, confirm password) and the same auth call (register in auth/authService.js).
   Opened from the booking form's "Register an account" choice and from the guest receipt.
   After a successful sign-up:
     - e-mail confirmation on  -> the pop-up tells the customer to open the link, then log in;
     - signed in right away    -> the page reloads, so the saved booking is restored and any
                                  guest bookings are added to the new account.
   ===================================================================== */

import { register } from '../auth/authService.js';
import { navigate } from '../shared/navigation.js';
import { setUser } from '../shared/session.js';
import { btnBusy, btnReset, btnSuccess } from '../shared/btnState.js';
import { applyChecks, check, hasFieldError, liveCheck, setFieldError } from '../shared/fieldCheck.js';
import { $, esc } from '../shared/utils.js';

const dlg = document.createElement('dialog');
dlg.className = 'dlg';
dlg.id = 'regdlg';
dlg.setAttribute('aria-label', 'Create your account');
document.body.appendChild(dlg);

/* one set of listeners for the pop-up's whole life; the caller of the current opening is kept in activityCb */
let activityCb = null;

['pointerdown', 'keydown', 'input', 'touchstart'].forEach(ev => dlg.addEventListener(ev, () => {
    if (activityCb)
        activityCb();
}));

const showError = msg => {
    const box = $('#rgm-err');
    if (!box)
        return;
    box.textContent = msg;
    box.hidden = !msg;
};

/* options:
   first, last, phone  - filled in from what the customer already typed
   savedNote           - text shown after sign-up when e-mail confirmation is needed
   onActivity()        - called while the customer types (keeps a booking slot hold alive)
   onClose()           - called whenever the pop-up closes (Cancel, Esc, Close)
   onAccount()         - called once the account exists, before the page reloads or the
                         "check your email" message shows (the caller saves the booking selection) */
export function openRegisterModal({ first = '', last = '', phone = '', savedNote = '', onActivity, onAccount, onClose } = {}) {
    dlg.innerHTML = `<div class="in">
      <form id="rgm" novalidate>
        <div class="row"><h2 style="margin:0">Create your account</h2><button type="button" class="btn sm line" data-rgm-close>Cancel</button></div>
        <p class="mut" style="margin-top:4px">Keep every booking and rental in one place.</p>
        <p class="req-note"><span class="req">*</span> Required</p>
        <div class="fg2">
          <div><label for="rgm-fn">First name <span class="req" aria-hidden="true">*</span></label><input id="rgm-fn" data-letters autocomplete="given-name" required aria-required="true" value="${esc(first)}"></div>
          <div><label for="rgm-ln">Last name <span class="req" aria-hidden="true">*</span></label><input id="rgm-ln" data-letters autocomplete="family-name" required aria-required="true" value="${esc(last)}"></div>
        </div>
        <label for="rgm-phone">Phone number <span class="req" aria-hidden="true">*</span></label>
        <input id="rgm-phone" type="tel" data-phone inputmode="tel" maxlength="15" placeholder="e.g. 0917 123 4567" autocomplete="tel" required aria-required="true" value="${esc(phone)}">
        <label for="rgm-email">Email address <span class="req" aria-hidden="true">*</span></label>
        <input id="rgm-email" type="email" placeholder="you@example.com" autocomplete="email" inputmode="email" required aria-required="true">
        <label for="rgm-pass">Password <span class="req" aria-hidden="true">*</span></label>
        <input id="rgm-pass" type="password" autocomplete="new-password" required aria-required="true">
        <label for="rgm-pass2">Confirm password <span class="req" aria-hidden="true">*</span></label>
        <input id="rgm-pass2" type="password" autocomplete="new-password" required aria-required="true">
        <p class="mut" style="margin:8px 0 0">Already have an account? <button type="button" class="lk" id="rgm-login">Log in</button></p>
        <div class="alert" id="rgm-err" hidden></div>
        <div class="acts">
          <button type="button" class="btn line" data-rgm-close>Cancel</button>
          <button class="btn gold" id="rgm-go">Create account</button>
        </div>
      </form>
    </div>`;

    activityCb = onActivity || null;
    dlg.onclose = () => {
        activityCb = null;
        if (onClose)
            onClose();
    };

    dlg.querySelectorAll('[data-rgm-close]').forEach(b => {
        b.onclick = () => dlg.close();
    });
    // an existing customer: the booking selection is kept, so logging in brings them back to it
    $('#rgm-login').onclick = () => {
        if (onAccount)
            onAccount();
        navigate('login');
    };

    /* the rules of this form: checked when a field is left, and again when the form is sent */
    const rules = () => [
        ['#rgm-fn', () => check.first($('#rgm-fn').value)],
        ['#rgm-ln', () => check.last($('#rgm-ln').value)],
        ['#rgm-phone', () => check.phone($('#rgm-phone').value)],
        ['#rgm-email', () => check.email($('#rgm-email').value)],
        ['#rgm-pass', () => check.password($('#rgm-pass').value)],
        ['#rgm-pass2', () => check.confirm($('#rgm-pass2').value, $('#rgm-pass').value)]
    ];
    liveCheck(rules());
    // changing the password changes whether the confirmation matches
    $('#rgm-pass').addEventListener('input', () => {
        if (hasFieldError('#rgm-pass2'))
            setFieldError('#rgm-pass2', check.confirm($('#rgm-pass2').value, $('#rgm-pass').value));
    });

    $('#rgm').onsubmit = async e => {
        e.preventDefault();
        const f = $('#rgm-fn').value.trim(), l = $('#rgm-ln').value.trim(), ph = $('#rgm-phone').value.trim();
        const email = $('#rgm-email').value.trim(), pass = $('#rgm-pass').value;

        showError('');
        if (!applyChecks(rules().map(([t, rule]) => [t, rule()])))
            return;   // the wrong fields are marked under themselves

        const btn = $('#rgm-go');
        btnBusy(btn, 'Creating…');
        try {
            const r = await register({
                first: f,
                last: l,
                phone: ph,
                email,
                password: pass
            });
            await btnSuccess(btn, 'Account created', { keep: true });
            if (onAccount)
                onAccount();
            if (r.pending)
                return showVerify(r.email, savedNote);
            setUser(r);
            location.reload();   // now signed in: the page restores the saved booking and adds guest bookings
        } catch (err) {
            btnReset(btn);
            showError(err.message);
        }
    };

    dlg.showModal();
    $('#rgm-fn').focus();
}

function showVerify(email, savedNote) {
    dlg.innerHTML = `<div class="in">
      <h2 style="margin:0 0 8px">Check your email</h2>
      <p class="sub">We sent a confirmation link to <b>${esc(email)}</b>. Open it to activate your account, then log in. Check your spam folder if you do not see it.</p>
      ${savedNote ? `<div class="policy">${esc(savedNote)}</div>` : ''}
      <div class="acts">
        <button type="button" class="btn line" id="rgm-x">Close</button>
        <button type="button" class="btn gold" id="rgm-tologin">Go to log in</button>
      </div>
    </div>`;
    $('#rgm-x').onclick = () => dlg.close();
    $('#rgm-tologin').onclick = () => navigate('login');
}
