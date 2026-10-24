/* =====================================================================
   auth/index.js - entry point of pages/login.html
   Log in and register forms, tabs, guest button. One page for everyone; the sidebar
   links use #login and #register. Role redirect happens in enter().
   ===================================================================== */

import { register, requestPasswordReset, resendVerification, setNewPassword, signIn } from './authService.js';
import { sb } from '../config/supabaseClient.js';
import { navigate } from '../shared/navigation.js';
import { clearUser, setUser } from '../shared/session.js';
import { $, $$, isEmail, isName, toast } from '../shared/utils.js';
import '../shared/formRules.js';
import { injectChrome } from '../shared/layout.js';
import './passwordToggle.js';

injectChrome();   // sidebar + mobile bar

/* Send each role to its home page. */
function enter(user) {
  setUser(user);
  if (user.role === 'customer') return navigate('book');
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

$('#f-login').addEventListener('submit', async e => {
  e.preventDefault();
  const email = $('#lu').value.trim(), password = $('#lp').value;
  if (!email) return showError('#login-err', 'Enter your email address.');
  if (!isEmail(email)) return showError('#login-err', 'Enter a valid email address, like name@example.com.');
  if (!password) return showError('#login-err', 'Enter your password.');
  showError('#login-err', '');
  try { enter(await signIn(email, password)); }
  catch (err) { showError('#login-err', err.message); $('#login-resend').hidden = !err.needsVerify; }
});

$('#f-reg').addEventListener('submit', async e => {
  e.preventDefault();
  const first = $('#rg-fn').value.trim(), last = $('#rg-ln').value.trim(), phone = $('#rg-phone').value.trim();
  const email = $('#rg-user').value.trim();
  const pass = $('#rg-pass').value, pass2 = $('#rg-pass2').value;

  if (!first) return showError('#reg-err', 'Enter your first name.');
  if (!isName(first)) return showError('#reg-err', 'The first name can only contain letters.');
  if (!last) return showError('#reg-err', 'Enter your last name.');
  if (!isName(last)) return showError('#reg-err', 'The last name can only contain letters.');
  if (!/^[\d\s+()-]{7,}$/.test(phone)) return showError('#reg-err', 'Enter a valid phone number.');
  if (!email) return showError('#reg-err', 'Enter your email address.');
  if (!isEmail(email)) return showError('#reg-err', 'Enter a valid email address, like name@example.com.');
  if (pass.length < 8) return showError('#reg-err', 'Use a password with at least 8 characters.');
  if (pass !== pass2) return showError('#reg-err', 'The two passwords do not match.');
  showError('#reg-err', '');
  try {
    const r = await register({ first, last, phone, email, password: pass });
    if (r.pending) return showVerify(r.email);
    enter(r);
  } catch (err) { showError('#reg-err', err.message); }
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
    if (left-- <= 0) { clearInterval(cooldownTimer); btn.disabled = false; }
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

$('#resend-btn').addEventListener('click', async () => { if (await resend(verifyEmail, '#verify-msg', '#verify-err')) startCooldown(); });
$('#verify-back').addEventListener('click', () => { location.hash = 'login'; showMode('login'); });
$('#resend-login').addEventListener('click', async () => {
  const email = $('#lu').value.trim();
  if (!isEmail(email)) return showError('#login-err', 'Enter your email address above first.');
  if (await resend(email, '#login-ok', '#login-err')) $('#login-resend').hidden = true;
});

/* The confirmation link brings the customer back here (?verified=1, with the session in the URL).
   Sign that automatic session out and ask for a normal log in, or explain a failed link. */
async function handleVerifyReturn() {
  const q = new URLSearchParams(location.search), h = new URLSearchParams(location.hash.replace(/^#/, ''));
  const failed = h.get('error_description');

  // the reset-password link: show the "choose a new password" form once Supabase has read the link
  if (q.get('reset')) {
    let session = null;
    if (!failed) { try { session = (await sb.auth.getSession()).data.session; } catch (e) { /* no session */ } }
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

  if (!failed && !q.get('verified') && h.get('type') !== 'signup') return;
  if (failed) {
    showError('#login-err', /expired|invalid|used/i.test(failed)
      ? 'That confirmation link has expired or was already used. Enter your email below and send a new one.'
      : failed.replace(/\+/g, ' '));
    $('#login-resend').hidden = false;
  } else {
    try { await sb.auth.getSession(); await sb.auth.signOut(); } catch (e) { /* nothing to sign out */ }
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
$('#forgot-back').addEventListener('click', () => { location.hash = 'login'; showMode('login'); });

$('#f-forgot').addEventListener('submit', async e => {
  e.preventDefault();
  const email = $('#fg-email').value.trim(), btn = $('#forgot-send');
  $('#forgot-ok').hidden = true;
  if (!email) return showError('#forgot-err', 'Enter your email address.');
  if (!isEmail(email)) return showError('#forgot-err', 'Enter a valid email address, like name@example.com.');
  showError('#forgot-err', '');
  btn.disabled = true;
  try {
    await requestPasswordReset(email);
    // same wording whether or not the address has an account
    $('#forgot-ok').textContent = 'If an account exists for that email, a reset link is on its way. Open it to choose a new password. Check your spam folder too.';
    $('#forgot-ok').hidden = false;
    setTimeout(() => { btn.disabled = false; }, 60000);   // one request a minute
  } catch (err) { showError('#forgot-err', err.message); btn.disabled = false; }
});

$('#f-reset').addEventListener('submit', async e => {
  e.preventDefault();
  const pass = $('#rs-pass').value, pass2 = $('#rs-pass2').value;
  if (pass.length < 8) return showError('#reset-err', 'Use a password with at least 8 characters.');
  if (pass !== pass2) return showError('#reset-err', 'The two passwords do not match.');
  showError('#reset-err', '');
  try {
    await setNewPassword(pass);
    await sb.auth.signOut();   // the reset link signed them in temporarily; they log in normally with the new password
    clearUser();
    $('#rs-pass').value = $('#rs-pass2').value = '';
    location.hash = 'login';
    showMode('login');
    $('#login-ok').textContent = 'Your password was changed. Log in with the new password.';
    $('#login-ok').hidden = false;
  } catch (err) { showError('#reset-err', err.message); }
});

// Guests are not signed in: end any session, then go book. My Bookings and
// My Rental then ask for a reference code instead of showing an account.
$('#guest').addEventListener('click', () => { clearUser(); navigate('book'); });

showMode(modeFromHash());
handleVerifyReturn();

// a customer whose account was disabled while they were logged in is sent here with a message
try {
  const notice = sessionStorage.getItem('tod_notice');
  if (notice) { showError('#login-err', notice); sessionStorage.removeItem('tod_notice'); }
} catch (e) { /* storage blocked */ }
