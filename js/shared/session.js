/* =====================================================================
   shared/session.js - who is logged in
   The real login lives in Supabase Auth. { role, label } is also cached in
   localStorage so the sidebar can render instantly on every page.
   Also: signs out disabled customers and guards the admin page.
   ===================================================================== */

import { ROOT } from '../config/paths.js';
import { sb } from '../config/supabaseClient.js';
import { navigate } from './navigation.js';

/* ============================ SESSION ============================
   The real login lives in Supabase Auth. We also keep { role, label } in
   localStorage so the sidebar can render instantly on every page. */
export const SESSION_KEY = 'tod_user';

export const getUser = () => { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { return null; } };

export const setUser = u => { try { localStorage.setItem(SESSION_KEY, JSON.stringify(u)); } catch (e) { /* storage blocked */ } };

export const clearUser = () => { try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* storage blocked */ } };

export const isMember = () => { const u = getUser(); return !!u && u.role === 'customer'; };

export async function logout() {
  try { await sb.auth.signOut(); } catch (e) { /* ignore */ }
  clearUser();
  navigate('home');
}

// the Supabase session ended (expired or signed out elsewhere): forget the cached user
sb.auth.getSession().then(({ data }) => {
  if (!data.session && getUser()) { clearUser(); location.reload(); return; }
  // a customer whose account staff disabled is signed out
  const u = getUser();
  if (data.session && data.session.user && u && u.role === 'customer') {
    sb.from('customer').select('status').eq('auth_user_id', data.session.user.id).maybeSingle().then(({ data: c }) => {
      if (c && c.status === 'Inactive') {
        try { sessionStorage.setItem('tod_notice', 'This account has been disabled. Please contact the studio.'); } catch (e) { /* ignore */ }
        sb.auth.signOut().finally(() => { clearUser(); location.href = ROOT + 'pages/login.html#login'; });
      }
    });
  }
});

// the dashboard is for owner and staff only
if (document.body.dataset.role === 'admin') {
  const u = getUser();
  if (!u || (u.role !== 'owner' && u.role !== 'staff')) location.replace(ROOT + 'pages/login.html#login');
}
