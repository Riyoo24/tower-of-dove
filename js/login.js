/* =====================================================================
   Tower of Dove Music Studio: log in and register (pages/login.html)
   One page for everyone. The sidebar links use #login and #register.
   Data, helpers, sidebar and navigation live in shared.js.
   ===================================================================== */


/* ============================ DEMO SIGN-IN ============================
   There is no server yet, so any username and password work.
   The username "owner" or "staff" signs in as that role; anything else
   is a customer. Replace these two functions with fetch() calls to your
   backend and return { role, label } when it accepts the credentials. */

function signIn(username, password) {
  const k = username.toLowerCase();
  if (k === 'owner') return { role: 'owner', label: 'Owner' };
  if (k === 'staff') return { role: 'staff', label: 'Staff' };
  return { role: 'customer', label: username };
}

function register(details) {
  return { role: 'customer', label: details.name };
}

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

$('#f-login').addEventListener('submit', e => {
  e.preventDefault();
  const username = $('#lu').value.trim(), password = $('#lp').value;
  if (!username) return showError('#login-err', 'Enter your username.');
  if (!password) return showError('#login-err', 'Enter your password.');
  showError('#login-err', '');
  enter(signIn(username, password));
});

$('#f-reg').addEventListener('submit', e => {
  e.preventDefault();
  const name = $('#rg-name').value.trim(), phone = $('#rg-phone').value.trim();
  const username = $('#rg-user').value.trim();
  const pass = $('#rg-pass').value, pass2 = $('#rg-pass2').value;

  if (!name) return showError('#reg-err', 'Enter your full name.');
  if (!/^[\d\s+()-]{7,}$/.test(phone)) return showError('#reg-err', 'Enter a valid phone number.');
  if (!username) return showError('#reg-err', 'Choose a username.');
  if (pass.length < 8) return showError('#reg-err', 'Use a password with at least 8 characters.');
  if (pass !== pass2) return showError('#reg-err', 'The two passwords do not match.');
  showError('#reg-err', '');
  enter(register({ name, phone, username, password: pass }));
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
