/* =====================================================================
   auth/index.js - entry point of pages/login.html
   Log in and register forms, tabs, guest button. One page for everyone; the sidebar
   links use #login and #register. Role redirect happens in enter().
   ===================================================================== */

import {
    register,
    requestPasswordReset,
    resendVerification,
    setNewPassword,
    signIn
} from './authService.js';
import { sb } from '../config/supabaseClient.js';
import { navigate } from '../shared/navigation.js';
import { claimableGuestBookings, clearPendingBooking, readPendingBooking } from '../shared/guestStore.js';
import { clearUser, setUser } from '../shared/session.js';
import { $, $$, SLOTS, isEmail, longDate, pl, toast } from '../shared/utils.js';
import '../shared/formRules.js';
import { injectChrome } from '../shared/layout.js';
import './passwordToggle.js';
import { btnBusy, btnReset, btnSuccess } from '../shared/btnState.js';
import { applyChecks, check, hasFieldError, liveCheck, setFieldError } from '../shared/fieldCheck.js';

injectChrome();   // top navigation bar

/* Send each role to its home page: customers book; owner and staff always open the dashboard Overview
   (ROUTES.admin = pages/admin.html#a-over). */
function enter(user) {
    setUser(user);
    if (user.role === 'customer')
        return navigate('book');   // the booking page restores a saved booking and adds guest bookings to the account
    clearPendingBooking();   // owner and staff do not book
    return navigate('admin');
}

/* ============================ FORMS ============================ */

const showError = (id, message) => {
    const box = $(id);
    box.textContent = message;
    box.hidden = !message;
};

function showMode(mode) {
    const reg = mode === 'register';
    $('#f-login').hidden = reg;
    $('#f-reg').hidden = !reg;
    $('#f-verify').hidden = true;
    $('#f-forgot').hidden = true;
    $('#f-reset').hidden = true;
    $('#login-ok').hidden = true;
    $('#login-resend').hidden = true;
    $$('[data-at]').forEach(b => {
        const on = b.dataset.at === mode;
        b.classList.toggle('on', on);
        b.setAttribute('aria-selected', String(on));
    });
    document.title = (reg ? 'Register' : 'Log in') + ' | Tower of Dove Music Studio';
    showError('#login-err', '');
    showError('#reg-err', '');
}

const modeFromHash = () => location.hash === '#register' ? 'register' : 'login';

/* The rules of each form. Checked when a field is left, and again when the form is sent. */
const RULES = {
    login: [
        ['#lu', () => check.email($('#lu').value)],
        ['#lp', () => $('#lp').value ? '' : 'Enter your password.']
    ],
    reg: [
        ['#rg-fn', () => check.first($('#rg-fn').value)],
        ['#rg-ln', () => check.last($('#rg-ln').value)],
        ['#rg-phone', () => check.phone($('#rg-phone').value)],
        ['#rg-user', () => check.email($('#rg-user').value)],
        ['#rg-pass', () => check.password($('#rg-pass').value)],
        ['#rg-pass2', () => check.confirm($('#rg-pass2').value, $('#rg-pass').value)]
    ],
    forgot: [['#fg-email', () => check.email($('#fg-email').value)]],
    reset: [
        ['#rs-pass', () => check.password($('#rs-pass').value, 'Enter a new password.')],
        ['#rs-pass2', () => check.confirm($('#rs-pass2').value, $('#rs-pass').value)]
    ]
};
Object.values(RULES).forEach(liveCheck);
// changing a password changes whether its confirmation matches
[['#rg-pass', '#rg-pass2'], ['#rs-pass', '#rs-pass2']].forEach(([a, b]) => {
    $(a).addEventListener('input', () => {
        if (hasFieldError(b))
            setFieldError(b, check.confirm($(b).value, $(a).value));
    });
});

$('#f-login').addEventListener('submit', async e => {
    e.preventDefault();
    const email = $('#lu').value.trim(), password = $('#lp').value;
    showError('#login-err', '');
    if (!applyChecks(RULES.login.map(([t, rule]) => [t, rule()])))
        return;   // the wrong fields are marked under themselves
    const btn = e.target.querySelector('button[type="submit"]');
    btnBusy(btn, 'Logging in…');
    try {
        const user = await signIn(email, password);
        await btnSuccess(btn, 'Logged in', { keep: true, ms: 500 });
        enter(user);
    }
    catch (err) {
        btnReset(btn);
        showError('#login-err', err.message);
        $('#login-resend').hidden = !err.needsVerify;
    }
});

$('#f-reg').addEventListener('submit', async e => {
    e.preventDefault();
    const first = $('#rg-fn').value.trim(),
        last = $('#rg-ln').value.trim(),
        phone = $('#rg-phone').value.trim();
    const email = $('#rg-user').value.trim();
    const pass = $('#rg-pass').value;

    showError('#reg-err', '');
    if (!applyChecks(RULES.reg.map(([t, rule]) => [t, rule()])))
        return;   // the wrong fields are marked under themselves
    const btn = e.target.querySelector('button[type="submit"]');
    btnBusy(btn, 'Creating…');
    try {
        const r = await register({
            first,
            last,
            phone,
            email,
            password: pass
        });
        await btnSuccess(btn, 'Account created', { keep: !r.pending });
        if (r.pending)
            return showVerify(r.email);
        enter(r);
    } catch (err) {
        btnReset(btn);
        showError('#reg-err', err.message);
    }
});

/* ============================ EMAIL VERIFICATION ============================ */

let verifyEmail = '', cooldownTimer;

function showVerify(email) {
    verifyEmail = email;
    $('#vf-email').textContent = email;
    $('#f-login').hidden = true;
    $('#f-reg').hidden = true;
    $('#f-verify').hidden = false;
    $('#verify-msg').hidden = true;
    $('#verify-err').hidden = true;
    startCooldown();
}

/* The resend button waits 60 seconds so nobody floods an inbox. */
function startCooldown(seconds = 60) {
    const btn = $('#resend-btn');
    clearInterval(cooldownTimer);
    let left = seconds;
    btn.disabled = true;
    const tick = () => {
        btn.textContent = left > 0 ? `Send the email again (${left}s)` : 'Send the email again';
        if (left-- <= 0) {
            clearInterval(cooldownTimer);
            btn.disabled = false;
        }
    };
    tick();
    cooldownTimer = setInterval(tick, 1000);
}

async function resend(email, okBox, errBox) {
    try {
        await resendVerification(email);
        showError(errBox, '');
        $(okBox).textContent = 'Email sent. Open the link in it to finish.';
        $(okBox).hidden = false;
        return true;
    } catch (err) {
        $(okBox).hidden = true;
        showError(errBox, err.message);
        return false;
    }
}

$('#resend-btn').addEventListener('click', async () => {
    if (await resend(verifyEmail, '#verify-msg', '#verify-err'))
        startCooldown();
});
$('#verify-back').addEventListener('click', () => {
    location.hash = 'login';
    showMode('login');
});
$('#resend-login').addEventListener('click', async () => {
    const email = $('#lu').value.trim();
    if (!isEmail(email))
        return showError('#login-err', 'Enter your email address above first.');
    if (await resend(email, '#login-ok', '#login-err'))
        $('#login-resend').hidden = true;
});

/* The confirmation link brings the customer back here (?verified=1, with the session in the URL).
   Sign that automatic session out and ask for a normal log in, or explain a failed link. */
async function handleVerifyReturn() {
    const q = new URLSearchParams(location.search),
        h = new URLSearchParams(location.hash.replace(/^#/, ''));
    const failed = h.get('error_description');

    // the reset-password link: show the "choose a new password" form once Supabase has read the link
    if (q.get('reset')) {
        let session = null;
        if (!failed) {
            try {
                session = (await sb.auth.getSession()).data.session;
            } catch (e) {
                /* no session */
            }
        }
        history.replaceState(null, '', location.pathname + '#login');
        if (!session) {
            showForgot();
            showError('#forgot-err', 'That reset link has expired or was already used. Enter your email to get a new one.');
            return;
        }
        $('#f-login').hidden = true;
        $('#f-reg').hidden = true;
        $('#f-reset').hidden = false;
        return;
    }

    if (!failed && !q.get('verified') && h.get('type') !== 'signup')
        return;
    if (failed) {
        showError('#login-err', /expired|invalid|used/i.test(failed)
            ? 'That confirmation link has expired or was already used. Enter your email below and send a new one.'
            : failed.replace(/\+/g, ' '));
        $('#login-resend').hidden = false;
    } else {
        try {
            await sb.auth.getSession();
            await sb.auth.signOut();
        } catch (e) {
            /* nothing to sign out */
        }
        clearUser();
        $('#login-ok').textContent = 'Your email is confirmed. Log in to continue.';
        $('#login-ok').hidden = false;
    }
    history.replaceState(null, '', location.pathname + '#login');
}

// tabs change the hash, so the sidebar links and the tabs always agree
$$('[data-at]').forEach(b => b.addEventListener('click', () => {
    location.hash = b.dataset.at;
    showMode(b.dataset.at);   // also leaves the "check your email" panel when the hash did not change
}));

window.addEventListener('hashchange', () => showMode(modeFromHash()));

/* ============================ FORGOT PASSWORD ============================ */

function showForgot(email = '') {
    $('#f-login').hidden = true;
    $('#f-reg').hidden = true;
    $('#f-verify').hidden = true;
    $('#f-reset').hidden = true;
    $('#f-forgot').hidden = false;
    $('#fg-email').value = email;
    $('#forgot-ok').hidden = true;
    showError('#forgot-err', '');
    $('#fg-email').focus();
}

$('#forgot').addEventListener('click', () => showForgot($('#lu').value.trim()));
$('#forgot-back').addEventListener('click', () => {
    location.hash = 'login';
    showMode('login');
});

$('#f-forgot').addEventListener('submit', async e => {
    e.preventDefault();
    const email = $('#fg-email').value.trim(), btn = $('#forgot-send');
    $('#forgot-ok').hidden = true;
    showError('#forgot-err', '');
    if (!applyChecks(RULES.forgot.map(([t, rule]) => [t, rule()])))
        return;
    btnBusy(btn, 'Sending…');
    try {
        await requestPasswordReset(email);
        await btnSuccess(btn, 'Sent', { keep: true });
        btn.disabled = true;   // one request a minute (it is enabled again below)
        // same wording whether or not the address has an account
        $('#forgot-ok').textContent = 'If an account exists for that email, a reset link is on its way. Open it to choose a new password. Check your spam folder too.';
        $('#forgot-ok').hidden = false;
        setTimeout(() => {
            btnReset(btn);
        }, 60000);   // one request a minute
    } catch (err) {
        showError('#forgot-err', err.message);
        btnReset(btn);
    }
});

$('#f-reset').addEventListener('submit', async e => {
    e.preventDefault();
    const pass = $('#rs-pass').value;
    showError('#reset-err', '');
    if (!applyChecks(RULES.reset.map(([t, rule]) => [t, rule()])))
        return;
    const btn = e.target.querySelector('button[type="submit"]');
    btnBusy(btn, 'Saving…');
    try {
        await setNewPassword(pass);
        await btnSuccess(btn, 'Saved');
        await sb.auth.signOut();   // the reset link signed them in temporarily; they log in normally with the new password
        clearUser();
        $('#rs-pass').value = $('#rs-pass2').value = '';
        location.hash = 'login';
        showMode('login');
        $('#login-ok').textContent = 'Your password was changed. Log in with the new password.';
        $('#login-ok').hidden = false;
    } catch (err) {
        btnReset(btn);
        showError('#reset-err', err.message);
    }
});

// Guests are not signed in: end any session, then go book. My Bookings and
// My Rental then ask for a reference code instead of showing an account.
$('#guest').addEventListener('click', () => {
    clearPendingBooking();   // they chose not to register, so forget the saved selection
    clearUser();
    navigate('book');
});

/* Tell people what happens to a booking they already started or made as a guest on this device. */
function showSignupNote() {
    const box = $('#pend-note'), p = readPendingBooking(), n = claimableGuestBookings().length;
    let msg = '';
    if (p && Number.isInteger(p.t) && SLOTS[p.t])
        msg = `Your booking for Studio ${p.studio} on ${longDate(p.date)} at ${SLOTS[p.t]} is saved. Register or log in and we bring you back to finish it.`;
    else if (n)
        msg = `${pl(n, 'guest booking')} made on this device can be added to your account after you log in. You will be asked first.`;
    box.textContent = msg;
    box.hidden = !msg;
}

showSignupNote();
showMode(modeFromHash());
handleVerifyReturn();

// a customer whose account was disabled while they were logged in is sent here with a message
try {
    const notice = sessionStorage.getItem('tod_notice');
    if (notice) {
        showError('#login-err', notice);
        sessionStorage.removeItem('tod_notice');
    }
} catch (e) {
    /* storage blocked */
}
