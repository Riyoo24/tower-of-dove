/* =====================================================================
   Tower of Dove Music Studio: log in and register (pages/login.html)
   One page for everyone. The sidebar links use #login and #register.
   Data, helpers, sidebar and navigation live in shared.js.
   ===================================================================== */


/* ============================ SIGN-IN (Supabase Auth) ============================
   Usernames are turned into fake emails (juan -> juan@towerofdove.app).
   Owner and staff have a row in app_user; everyone else is a customer.
   Both functions return { role, label } or throw an Error with a message to show. */

async function signIn(username, password) {
  const { data, error } = await sb.auth.signInWithPassword({ email: toEmail(username), password });
  if (error) throw new Error('Wrong username or password.');

  const { data: staff } = await sb.from('app_user')
    .select('role, first_name, status').eq('auth_user_id', data.user.id).maybeSingle();

  if (staff && staff.status !== 'Active') { await sb.auth.signOut(); throw new Error('This staff account is deactivated. Ask the owner.'); }
  if (staff) return { role: staff.role.toLowerCase(), label: staff.role === 'Owner' ? 'Owner' : staff.first_name };
  const { data: me } = await sb.from('customer').select('status').eq('auth_user_id', data.user.id).maybeSingle();
  if (me && me.status === 'Inactive') { await sb.auth.signOut(); throw new Error('This account has been disabled. Please contact the studio.'); }
  return { role: 'customer', label: username.trim() };
}

async function register(d) {
  const { data, error } = await sb.auth.signUp({
    email: toEmail(d.username),
    password: d.password,
    options: { data: { kind: 'customer', first_name: d.first, last_name: d.last, full_name: d.first + ' ' + d.last, username: d.username.trim().toLowerCase(), number: d.phone } }
  });
  if (error) throw new Error(/already/i.test(error.message) ? 'That username is already taken.' : error.message);
  if (!data.session) throw new Error('Account created, but sign-in is blocked. In Supabase turn off Authentication > Providers > Email > Confirm email.');
  return { role: 'customer', label: d.first };
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


/* ============================ SHOW / HIDE PASSWORD ============================
   Puts an eye button inside every password box on this page. */

const EYE = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.4 10.4 0 0 1 12 19c-6.4 0-10-7-10-7a18.5 18.5 0 0 1 5.06-5.94M9.9 4.24A9.7 9.7 0 0 1 12 5c6.4 0 10 7 10 7a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="M2 2l20 20"/></svg>';

$$('input[type="password"]').forEach(input => {
  const wrap = document.createElement('div');
  wrap.className = 'pw';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'pw-toggle';
  toggle.setAttribute('aria-label', 'Show password');
  toggle.setAttribute('aria-pressed', 'false');
  toggle.innerHTML = EYE;
  toggle.onclick = () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.setAttribute('aria-pressed', String(show));
    toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    toggle.innerHTML = show ? EYE_OFF : EYE;
  };
  wrap.appendChild(toggle);
});

// a customer whose account was disabled while they were logged in is sent here with a message
try {
  const notice = sessionStorage.getItem('tod_notice');
  if (notice) { showError('#login-err', notice); sessionStorage.removeItem('tod_notice'); }
} catch (e) { /* storage blocked */ }

