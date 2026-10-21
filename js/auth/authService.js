/* =====================================================================
   auth/authService.js - Supabase Auth calls (log in, register)
   DB: auth.signInWithPassword, auth.signUp, tables app_user (staff) and customer (status).
   Usernames are turned into fake e-mails (juan -> juan@towerofdove.app).
   Both functions return { role, label } or throw an Error with a message to show.
   ===================================================================== */

import { sb } from '../config/supabaseClient.js';
import { toEmail } from '../shared/utils.js';

/* ============================ SIGN-IN (Supabase Auth) ============================
   Usernames are turned into fake emails (juan -> juan@towerofdove.app).
   Owner and staff have a row in app_user; everyone else is a customer.
   Both functions return { role, label } or throw an Error with a message to show. */

export async function signIn(username, password) {
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

export async function register(d) {
  const { data, error } = await sb.auth.signUp({
    email: toEmail(d.username),
    password: d.password,
    options: { data: { kind: 'customer', first_name: d.first, last_name: d.last, full_name: d.first + ' ' + d.last, username: d.username.trim().toLowerCase(), number: d.phone } }
  });
  if (error) throw new Error(/already/i.test(error.message) ? 'That username is already taken.' : error.message);
  if (!data.session) throw new Error('Account created, but sign-in is blocked. In Supabase turn off Authentication > Providers > Email > Confirm email.');
  return { role: 'customer', label: d.first };
}
