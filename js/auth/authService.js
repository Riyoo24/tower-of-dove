/* =====================================================================
   auth/authService.js - Supabase Auth calls (log in, register)
   DB: auth.signInWithPassword, auth.signUp, tables app_user (staff) and customer (status).
   Customers and staff sign in with their real e-mail address.
   Both functions return { role, label } or throw an Error with a message to show.
   register() returns { pending: true, email } when the customer still has to confirm their e-mail.
   ===================================================================== */

import { sb } from '../config/supabaseClient.js';
import { ROOT } from '../config/paths.js';
import { normalizeEmail } from '../shared/utils.js';

/* Where the e-mail confirmation link sends the customer back to. This address must be listed under
   Supabase > Authentication > URL Configuration > Redirect URLs. */
const resetUrl = () => ROOT + 'pages/login.html?reset=1';
const confirmUrl = () => ROOT + 'pages/login.html?verified=1';

/* ============================ SIGN-IN (Supabase Auth) ============================
   Owner and staff have a row in app_user; everyone else is a customer.
   Both functions return { role, label } or throw an Error with a message to show. */

export async function signIn(emailInput, password) {
  const email = normalizeEmail(emailInput);
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    if (error.code === 'email_not_confirmed' || /not confirmed/i.test(error.message)) {
      const e = new Error('Please verify your email address first. Open the confirmation link we sent to your inbox.');
      e.needsVerify = true;
      throw e;
    }
    throw new Error('Wrong email or password.');
  }

  const { data: staff } = await sb.from('app_user')
    .select('role, first_name, status').eq('auth_user_id', data.user.id).maybeSingle();

  if (staff && staff.status !== 'Active') { await sb.auth.signOut(); throw new Error('This staff account is deactivated. Ask the owner.'); }
  if (staff) return { role: staff.role.toLowerCase(), label: staff.role === 'Owner' ? 'Owner' : staff.first_name };
  const { data: me } = await sb.from('customer').select('status, first_name').eq('auth_user_id', data.user.id).maybeSingle();
  if (me && me.status === 'Inactive') { await sb.auth.signOut(); throw new Error('This account has been disabled. Please contact the studio.'); }
  return { role: 'customer', label: (me && me.first_name) || email };
}

export async function register(d) {
  const email = normalizeEmail(d.email);
  const { data, error } = await sb.auth.signUp({
    email,
    password: d.password,
    options: { emailRedirectTo: confirmUrl(), data: { kind: 'customer', first_name: d.first, last_name: d.last, full_name: d.first + ' ' + d.last, username: email, number: d.phone } }
  });
  if (error) throw new Error(/already/i.test(error.message) ? 'That email address is already registered. Log in instead.' : error.message);
  // With "Confirm email" on, Supabase hides whether an address already exists: it returns a user with no identities.
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    throw new Error('That email address is already registered. Log in instead.');
  }
  // No session yet = the customer must open the confirmation link first.
  if (!data.session) return { pending: true, email };
  return { role: 'customer', label: d.first };
}

/* Send the confirmation e-mail again. */
export async function resendVerification(emailInput) {
  const { error } = await sb.auth.resend({ type: 'signup', email: normalizeEmail(emailInput), options: { emailRedirectTo: confirmUrl() } });
  if (error) {
    throw new Error(/rate|seconds|too many/i.test(error.message)
      ? 'Please wait a minute before asking for another email.'
      : 'Could not send the email. Check the address and try again.');
  }
}

/* Forgot password: e-mail a reset link. Supabase answers the same way whether or not the address has an
   account, so nobody can use this to find out who is registered. The link returns to login.html?reset=1. */
export async function requestPasswordReset(emailInput) {
  const { error } = await sb.auth.resetPasswordForEmail(normalizeEmail(emailInput), { redirectTo: resetUrl() });
  if (error) {
    throw new Error(/rate|seconds|too many/i.test(error.message)
      ? 'Please wait a minute before asking for another email.'
      : 'Could not send the email. Check the address and try again.');
  }
}

/* Called while the reset link's temporary session is active. */
export async function setNewPassword(password) {
  const { error } = await sb.auth.updateUser({ password });
  if (error) {
    throw new Error(/same|different/i.test(error.message) ? 'Choose a password you have not used before.' : error.message);
  }
}
