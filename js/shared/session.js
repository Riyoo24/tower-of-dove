/* =====================================================================
   shared/session.js - who is logged in
   The real login lives in Supabase Auth. { role, label } is also cached in
   localStorage so the sidebar can render instantly on every page.
   Also: signs out disabled customers and guards the admin page.
   ===================================================================== */

import { ROOT, ROUTES } from '../config/paths.js';
import { sb } from '../config/supabaseClient.js';

/* ============================ SESSION ============================
   The real login lives in Supabase Auth. We also keep { role, label } in
   localStorage so the sidebar can render instantly on every page. */
export const SESSION_KEY = 'tod_user';

export const getUser = () => {
    try {
        return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    } catch (e) {
        return null;
    }
};

export const setUser = user => {
    try {
        localStorage.setItem(SESSION_KEY, JSON.stringify(user));
    } catch (e) {
        /* storage blocked */
    }
    window.dispatchEvent(new CustomEvent('profile-updated', { detail: user }));
};

export const clearUser = () => {
    try {
        localStorage.removeItem(SESSION_KEY);
    } catch (e) {
        /* storage blocked */
    }
};

/* The name shown in the sidebar: first and last name, with no stray spaces when the last name is empty. */
export const buildDisplayName = (firstName, lastName) =>
    [firstName, lastName].map(namePart => (namePart || '').trim()).filter(Boolean).join(' ');

export const isMember = () => {
    const u = getUser();
    return !!u && u.role === 'customer';
};

let loggingOut = false;
export const isLoggingOut = () => loggingOut;

export async function logout() {
    loggingOut = true;   // the page is about to leave: do not reload it when the sign-out event arrives
    clearUser();         // forget the name first, so nothing can show it again while signing out
    try {
        // never wait longer than 3 seconds for the network: the local session is removed either way
        await Promise.race([sb.auth.signOut(), new Promise(done => setTimeout(done, 3000))]);
    } catch (e) {
        /* ignore */
    }
    clearUser();
    // Logging out while already on the home page used to only scroll to the top, so the sidebar kept showing the name.
    // Go to the home page and always load it fresh.
    const home = new URL(ROOT + ROUTES.home.split('#')[0], location.href);
    if (home.pathname === location.pathname) {
        history.replaceState(null, '', home.href);   // all customer tabs share one page: land on Home, then reload fresh
        location.reload();
    }
    else
        location.replace(home.href);
}

// the Supabase session ended (expired or signed out elsewhere): forget the cached user
sb.auth.getSession().then(({ data }) => {
    if (!data.session && getUser()) {
        clearUser();
        location.reload();
        return;
    }
    // a customer whose account staff disabled is signed out
    const u = getUser();
    if (data.session && data.session.user && u && u.role === 'customer') {
        sb.from('customer').select('status').eq('auth_user_id', data.session.user.id).maybeSingle().then(({ data: c }) => {
            if (c && c.status === 'Inactive') {
                try {
                    sessionStorage.setItem('tod_notice', 'This account has been disabled. Please contact the studio.');
                } catch (e) {
                    /* ignore */
                }
                sb.auth.signOut().finally(() => {
                    clearUser();
                    location.href = ROOT + 'pages/login.html#login';
                });
            }
        });
    }
});

// the dashboard is for owner and staff only
if (document.body.dataset.role === 'admin') {
    const u = getUser();
    if (!u || (u.role !== 'owner' && u.role !== 'staff'))
        location.replace(ROOT + 'pages/login.html#login');
    else {
        try {
            sessionStorage.setItem('tod_staff_landed', '1');   // already on the dashboard this session: the public pages are not redirected
        } catch (e) {
            /* ignore */
        }
    }
}

// Owner / staff who are still signed in when they open the website again land on the dashboard, not on the customer pages.
// Only the first visit of a browser session is redirected, so staff can still look at the public pages afterwards.
(() => {
    if (document.body.dataset.role === 'admin')
        return;
    const u = getUser();
    if (!u || (u.role !== 'owner' && u.role !== 'staff'))
        return;
    const base = new URL(ROOT).pathname, here = location.pathname;
    const isPublicEntry = here === base || here === base + 'index.html' || here === base + 'pages/customer.html';
    if (!isPublicEntry)
        return;
    try {
        if (sessionStorage.getItem('tod_staff_landed'))
            return;
        sessionStorage.setItem('tod_staff_landed', '1');
    } catch (e) {
        return;   // storage blocked: do not redirect (it could loop)
    }
    location.replace(ROOT + ROUTES.admin);
})();
