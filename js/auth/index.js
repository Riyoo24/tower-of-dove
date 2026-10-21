/* =====================================================================
   auth/index.js - entry point of pages/login.html
   Log in and register forms, tabs, guest button. One page for everyone; the sidebar
   links use #login and #register. Role redirect happens in enter().
   ===================================================================== */

import { register, signIn } from './authService.js';
import { navigate } from '../shared/navigation.js';
import { clearUser, setUser } from '../shared/session.js';
import { $, $$, toast } from '../shared/utils.js';
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
  const username = $('#lu').value.trim(), password = $('#lp').value;
  if (!username) return showError('#login-err', 'Enter your username.');
  if (!password) return showError('#login-err', 'Enter your password.');
  showError('#login-err', '');
  try { enter(await signIn(username, password)); }
  catch (err) { showError('#login-err', err.message); }
});

$('#f-reg').addEventListener('submit', async e => {
  e.preventDefault();
  const first = $('#rg-fn').value.trim(), last = $('#rg-ln').value.trim(), phone = $('#rg-phone').value.trim();
  const username = $('#rg-user').value.trim();
  const pass = $('#rg-pass').value, pass2 = $('#rg-pass2').value;

  if (!first) return showError('#reg-err', 'Enter your first name.');
  if (!last) return showError('#reg-err', 'Enter your last name.');
  if (!/^[\d\s+()-]{7,}$/.test(phone)) return showError('#reg-err', 'Enter a valid phone number.');
  if (!username) return showError('#reg-err', 'Choose a username.');
  if (!/^[a-z0-9_.]{3,30}$/i.test(username)) return showError('#reg-err', 'Username: 3 to 30 letters, numbers, dots or underscores, no spaces.');
  if (pass.length < 8) return showError('#reg-err', 'Use a password with at least 8 characters.');
  if (pass !== pass2) return showError('#reg-err', 'The two passwords do not match.');
  showError('#reg-err', '');
  try { enter(await register({ first, last, phone, username, password: pass })); }
  catch (err) { showError('#reg-err', err.message); }
});

// tabs change the hash, so the sidebar links and the tabs always agree
$$('[data-at]').forEach(b => b.addEventListener('click', () => {
  location.hash = b.dataset.at;
}));

window.addEventListener('hashchange', () => showMode(modeFromHash()));

$('#forgot').addEventListener('click', () => toast('Password reset is not connected yet. Email Dovepangilinan@gmail.com for help.'));

// Guests are not signed in: end any session, then go book. My Bookings and
// My Rental then ask for a reference code instead of showing an account.
$('#guest').addEventListener('click', () => { clearUser(); navigate('book'); });

showMode(modeFromHash());

// a customer whose account was disabled while they were logged in is sent here with a message
try {
  const notice = sessionStorage.getItem('tod_notice');
  if (notice) { showError('#login-err', notice); sessionStorage.removeItem('tod_notice'); }
} catch (e) { /* storage blocked */ }
