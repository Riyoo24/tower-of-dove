/* =====================================================================
   shared/layout.js - sidebar and mobile bar (injected into every page)
   Call injectChrome() once at the start of each page script.
   ===================================================================== */

import { loadAccountProfile, syncDisplayName } from '../account/profileService.js';
import { ASSETS } from '../config/paths.js';
import { sb } from '../config/supabaseClient.js';
import { navigate } from './navigation.js';
import { initMobileUx } from './mobileUx.js';
import { SESSION_KEY, clearUser, getUser, isLoggingOut, logout } from './session.js';
import { $, $$, esc } from './utils.js';

export const ICONS = {
    home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
    cal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    music: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    box: '<path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
    login: '<path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M15 12H3"/>',
    edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>',
    menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
    x: '<path d="M5 5l14 14M19 5L5 19"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-3.5 3-5.5 7-5.5s7 2 7 5.5M16 4.5a3.5 3.5 0 010 7M22 20c0-2.5-1.5-4.2-4-5"/>',
    card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
    grid: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/>',
    week: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M9 9v12M15 9v12M3 15h18"/>',
    chart: '<path d="M3 3v18h18"/><path d="M8 16v-5M13 16V7M18 16v-8"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
    door: '<path d="M5 21V3h14v18M3 21h18"/><circle cx="15" cy="12" r="1"/>',
    plus: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
    tag: '<path d="M3 12V3h9l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1"/>',
    logout: '<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
    phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z"/>',
    pin: '<path d="M12 21s-7-6.2-7-11a7 7 0 0114 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
    facebook: '<path d="M14 8h3V4h-3a4 4 0 00-4 4v3H7v4h3v6h4v-6h3l1-4h-4V8z"/>',
    youtube: '<rect x="2" y="5" width="20" height="14" rx="4"/><path d="M10 9l5 3-5 3z"/>',
};


export const icon = n => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n]}</svg>`;

/* [key, label, icon]. Keys match ROUTES. */
export const NAV_ITEMS = [
    ['home', 'Home', 'home'],
    ['book', 'Book a Studio', 'cal'],
    ['rent', 'Rent Equipment', 'music'],
    ['mybook', 'My Bookings', 'list'],
    ['myrent', 'My Rental', 'box'],
    ['contact', 'Contact Us', 'mail']
];

/* Owner and staff sidebar. [tab id, label, icon, ownerOnly]. Links are
   #hashes handled by admin.js, so they never leave pages/admin.html. */
export const ADMIN_NAV = [
    ['a-over', 'Overview', 'grid'],
    ['a-cal', 'Room Calendar', 'week'],
    ['a-sess', 'Studio Sessions', 'clock'],
    ['a-onb', 'Onsite Booking', 'plus'],
    ['a-onr', 'Onsite Rental', 'tag'],
    ['a-book', 'Bookings', 'cal'],
    ['a-rent', 'Rentals', 'box'],
    ['a-pay', 'Payment', 'card'],
    ['a-cust', 'Customers', 'users'],
    ['a-eqp', 'Equipments', 'music'],
    ['a-stud', 'Studio Management', 'door', true],
    ['a-rep', 'Reports', 'chart', true],
    ['a-set', 'Settings', 'gear', true]
];

/* "Log out?" alert. Resolves true only when the user presses "Yes, log out"
   (Cancel, Esc, or a click outside the box all resolve false). Cancel has the focus,
   so pressing Enter by accident never logs anyone out. */
function confirmLogout() {
    return new Promise(resolve => {
        const dlg = document.createElement('dialog');
        dlg.className = 'dlg confirm';
        dlg.setAttribute('role', 'alertdialog');
        dlg.setAttribute('aria-label', 'Log out');
        dlg.innerHTML = `<div class="in"><h2 style="margin:0 0 8px">Log out?</h2>
      <p class="mut">You will be signed out of your account on this device.</p>
      <div class="acts"><button type="button" class="btn line" data-lo="no">Cancel</button><button type="button" class="btn gold" data-lo="yes">Yes, log out</button></div></div>`;
        document.body.appendChild(dlg);
        let result = false;
        dlg.addEventListener('click', e => {
            if (e.target === dlg)
                return dlg.close();
            const b = e.target.closest('[data-lo]');
            if (b) {
                result = b.dataset.lo === 'yes';
                dlg.close();
            }
        });
        dlg.addEventListener('close', () => {
            dlg.remove();
            resolve(result);
        });
        dlg.showModal();
        dlg.querySelector('[data-lo="no"]').focus();
    });
}

/* Replaces the name shown on the sidebar profile link (the only place the name appears). */
export function updateSidebarName(displayName) {
    const sidebarNameElement = $('#ps-profile .lbl');
    if (sidebarNameElement)
        sidebarNameElement.textContent = displayName;
    const letter = ((displayName || '').trim()[0] || 'U').toUpperCase();
    $$('#ps-profile .tn-av, #mb-user .tn-av').forEach(avatar => {   // sidebar / top bar avatar and the phone top bar avatar: first letter of the name
        avatar.textContent = letter;
    });
}

/* Keeps this page honest about who is logged in. The sidebar is drawn once, when the page loads, so it would keep
   showing the name after a log out in these cases:
   - another tab logged out (or in): the storage event tells this tab to redraw;
   - the Back button brings the page back from the browser's page cache (pageshow, persisted);
   - the Supabase session ended (expired, or signed out somewhere else).
   A name saved in another tab only changes the sidebar name. */
function keepSidebarInSyncWithLogin(renderedLoggedIn) {
    const reloadIfLoginChanged = () => {
        if (!!getUser() !== renderedLoggedIn) {
            location.reload();
            return true;
        }
        return false;
    };
    window.addEventListener('storage', storageEvent => {
        if (storageEvent.key !== SESSION_KEY && storageEvent.key !== null)
            return;
        if (reloadIfLoginChanged())
            return;
        const cachedUser = getUser();
        if (cachedUser)
            updateSidebarName(cachedUser.username || '');
    });
    window.addEventListener('pageshow', pageEvent => {
        if (!pageEvent.persisted)
            return;
        if (reloadIfLoginChanged())
            return;
        if (renderedLoggedIn)   // restored from the page cache: make sure the session is still alive
            sb.auth.getSession().then(({ data }) => {
                if (!data.session) {
                    clearUser();
                    location.reload();
                }
            });
    });
    sb.auth.onAuthStateChange(event => {
        if (event !== 'SIGNED_OUT')
            return;
        clearUser();
        if (renderedLoggedIn && !isLoggingOut() && !/login\.html/.test(location.pathname))
            location.reload();
    });
}


/* ---------------------------------------------------------------------
   Customer top navigation (home, customer tabs, account, login).
   The admin dashboard keeps its own sidebar (see injectChrome below).
   The ids and data attributes (#ps-main, #ps-auth, #ps-profile, #logout,
   data-side, data-route) match the old sidebar so every page script keeps
   working: setActiveNav(), updateSidebarName() and the [data-route] clicks.
   --------------------------------------------------------------------- */
function injectTopNav(user) {
    document.body.classList.add('hastop');
    const label = user ? (user.username || user.label || 'Account') : '';
    const initial = (label.trim()[0] || 'U').toUpperCase();
    document.body.insertAdjacentHTML('afterbegin', `
    <header class="topnav" id="topnav">
      <div class="tn-in">
        <a class="tn-brand" href="#" data-route="home" aria-label="Tower of Dove Music Studio, home">
          <img src="${ASSETS}img/logo.png" alt="" width="36" height="36">
          <span class="tn-word"><b>Tower of Dove</b><small>Music Studio</small></span>
        </a>
        <nav class="tn-nav" id="tn-panel" aria-label="Main navigation">
          <ul class="tn-links" id="ps-main">
            ${NAV_ITEMS.map(([key, text, ic]) => `
            <li data-side="${key}"><a href="#" data-route="${key}"><span class="ico">${icon(ic)}</span><span class="lbl">${text}</span></a></li>`).join('')}
          </ul>
          <ul class="tn-auth" id="ps-auth">
            ${user ? `
            <li data-side="account"><a href="#" id="ps-profile" class="tn-user" data-route="account"><span class="tn-av" aria-hidden="true">${esc(initial)}</span><span class="lbl">${esc(label)}</span></a></li>
            <li><a href="#" id="logout" class="tn-out" title="Log out" aria-label="Log out"><span class="ico">${icon('logout')}</span><span class="lbl">Log out</span></a></li>` : `
            <li><a href="#" class="tn-login" data-route="login"><span class="ico">${icon('login')}</span><span class="lbl">Log in</span></a></li>
            <li><a href="#" class="tn-reg" data-route="register"><span class="ico">${icon('user')}</span><span class="lbl">Register</span></a></li>`}
          </ul>
        </nav>
        <button class="tn-burger" id="tn-burger" type="button" aria-label="Open menu" aria-expanded="false" aria-controls="tn-panel">${icon('menu')}</button>
      </div>
    </header>
    <div class="tn-scrim" id="tn-scrim"></div>`);

    // shared footer for every customer page (the admin dashboard has none)
    const page = document.querySelector('main.page');
    if (page && !$('#sitefoot'))
        page.insertAdjacentHTML('afterend', `
    <footer class="sitefoot" id="sitefoot">
      <div class="sf-in">
        <div class="sf-brand">
          <a class="tn-brand" href="#" data-route="home" aria-label="Tower of Dove Music Studio, home">
            <img src="${ASSETS}img/logo.png" alt="" width="36" height="36">
            <span class="tn-word"><b>Tower of Dove</b><small>Music Studio</small></span>
          </a>
          <p>Rehearsal rooms and studio-owned gear for bands, duos and solo artists.</p>
        </div>
        <nav class="sf-col" aria-label="Footer">
          <h4 aria-level="2">Explore</h4>
          <a href="#" data-route="book">Book a Studio</a>
          <a href="#" data-route="rent">Rent Equipment</a>
          <a href="#" data-route="mybook">My Bookings</a>
          <a href="#" data-route="myrent">My Rental</a>
        </nav>
        <div class="sf-col">
          <h4 aria-level="2">Studio</h4>
          <a href="#" data-route="contact">Contact Us</a>
          <span>Open daily, 10 AM &ndash; 10 PM</span>
          <span>Pay 50% by GCash, the rest at the studio</span>
        </div>
      </div>
      <p class="sf-note">&copy; ${new Date().getFullYear()} Tower of Dove Music Studio. Online bookings need a 50% GCash down payment (the balance is paid at the studio) and are confirmed after staff verify it.</p>
    </footer>`);

    const bar = $('#topnav');
    const burger = $('#tn-burger');
    const setOpen = open => {
        bar.classList.toggle('open', open);
        $('#tn-scrim').classList.toggle('on', open);
        burger.setAttribute('aria-expanded', String(open));
        burger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
        burger.innerHTML = icon(open ? 'x' : 'menu');
    };
    burger.addEventListener('click', () => setOpen(!bar.classList.contains('open')));
    $('#tn-scrim').addEventListener('click', () => setOpen(false));
    $('#tn-panel').addEventListener('click', e => {
        if (e.target.closest('a'))
            setOpen(false);
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape')
            setOpen(false);
    });

    // phones: bottom tab bar, card tables, keyboard-aware bars (css/mobile.css)
    initMobileUx({ icon });

    // a soft shadow once the page has scrolled under the bar
    const onScroll = () => bar.classList.toggle('scrolled', scrollY > 8);
    addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    // every [data-route] link or button in the page
    document.addEventListener('click', e => {
        const el = e.target.closest('[data-route]');
        if (!el)
            return;
        e.preventDefault();
        navigate(el.dataset.route);
    });

    const lo = $('#logout');
    if (lo)
        lo.addEventListener('click', async e => {
            e.preventDefault();
            setOpen(false);
            if (await confirmLogout())
                logout();
        });

    window.addEventListener('profile-updated', profileEvent => {
        updateSidebarName(profileEvent.detail.username || '');
    });
    keepSidebarInSyncWithLogin(!!user);
    if (user) {
        loadAccountProfile().then(profile => {
            if (profile)
                syncDisplayName(profile);
        }).catch(() => {
            // Keep the last saved username when the database cannot be reached.
        });
    }
    setActiveNav(document.body.dataset.active);
}

export function injectChrome() {
    const isAdmin = document.body.dataset.role === 'admin';
    const user = getUser();
    if (!isAdmin)
        return injectTopNav(user);   // customer pages: top bar. Admin below is unchanged.
    const navList = isAdmin
        ? ADMIN_NAV.filter(n => !n[3] || (user && user.role === 'owner'))
        : NAV_ITEMS;
    document.body.classList.add('hasside');
    if (window.todSideSkeleton)
        window.todSideSkeleton.remove();   // the grey placeholder sidebar from js/shared/sideSkeleton.js (admin page only)
    document.body.insertAdjacentHTML('afterbegin', `
    <div class="mbar">
      <button id="mb-open" aria-label="Open menu">${icon('menu')}</button>
      <span class="mb-brand"><img src="${ASSETS}img/logo.png" alt="" width="30" height="30"> Tower of Dove</span>
      <button id="mb-user" aria-label="${getUser() ? 'Account' : 'Log in'}" ${getUser() ? '' : 'data-route="login"'}>${getUser() ? `<span class="tn-av" aria-hidden="true">${esc(((getUser().username || getUser().label || '').trim()[0] || 'U').toUpperCase())}</span>` : icon('user')}</button>
    </div>
    <div class="scrim" id="scrim"></div>
    <aside class="pubside" id="pubside" aria-label="Main navigation">
      <button class="ps-x" id="ps-x" aria-label="Close menu">${icon('x')}</button>
      <div class="ps-menu" id="ps-toggle" role="button" tabindex="0" aria-label="Expand or collapse menu" aria-expanded="true">${icon('menu')}</div>
      <ul class="ps-links" id="ps-main">
        ${navList.map(([key, label, ic]) => `
        <li data-side="${key}">
          <div class="curve-top"></div>
          <a href="${isAdmin ? '#' + key : '#'}" ${isAdmin ? '' : `data-route="${key}"`}><span class="ico">${icon(ic)}</span><span class="lbl">${label}</span></a>
          <div class="curve-bottom"></div>
        </li>`).join('')}
      </ul>
      <ul class="ps-links ps-auth" id="ps-auth">
        ${getUser() ? `
        <li data-side="${isAdmin ? 'a-prof' : 'account'}"><a href="${isAdmin ? '#a-prof' : '#'}" id="ps-profile" ${isAdmin ? '' : 'data-route="account"'}><span class="ico ps-av"><span class="tn-av" aria-hidden="true">${esc(((getUser().username || getUser().label || '').trim()[0] || 'U').toUpperCase())}</span></span><span class="lbl"></span></a></li>
        <li><a href="#" id="logout"><span class="ico">${icon('logout')}</span><span class="lbl">Log out</span></a></li>` : `
        <li><a href="#" data-route="login"><span class="ico">${icon('login')}</span><span class="lbl">Log in</span></a></li>
        <li><a href="#" data-route="register"><span class="ico">${icon('edit')}</span><span class="lbl">Register</span></a></li>`}
      </ul>
      <div class="ps-logo">
        <img src="${ASSETS}img/logo.png" alt="Tower of Dove logo" width="64" height="64">
        <div class="ps-title">Tower of Dove</div>
      </div>
    </aside>`);


    const setDrawer = open => {
        $('#pubside').classList.toggle('open', open);
        $('#scrim').classList.toggle('on', open);
    };
    const toggleSidebar = () => {
        // The page's left margin changes once (instant, one layout). The slide you see is a transform
        // (graphics card only) from where the page was to where it is now, so no per-frame re-layout.
        const page = document.querySelector('.page');
        const animate = page && page.animate && innerWidth > 820 && !matchMedia('(prefers-reduced-motion: reduce)').matches;
        const before = animate ? page.getBoundingClientRect().left : 0;
        const collapsed = $('#pubside').classList.toggle('collapsed');
        document.body.classList.toggle('sc', collapsed);
        $('#ps-toggle').setAttribute('aria-expanded', String(!collapsed));
        if (!animate)
            return;
        const shift = before - page.getBoundingClientRect().left;
        if (!shift)
            return;
        const root = document.documentElement;
        root.classList.add('sb-anim');   // clips sideways overflow while sliding
        const a = page.animate([{ transform: `translateX(${shift}px)` }, { transform: 'translateX(0)' }],
            { duration: 380, easing: 'cubic-bezier(.22,.61,.36,1)' });
        const done = () => root.classList.remove('sb-anim');
        a.onfinish = done;
        a.oncancel = done;
    };

    $('#ps-toggle').addEventListener('click', toggleSidebar);
    $('#ps-toggle').addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleSidebar();
        }
    });
    $('#mb-open').addEventListener('click', () => setDrawer(true));
    // phone top bar: the avatar opens the account (Profile) page of the dashboard
    const mbUser = $('#mb-user');
    if (mbUser && getUser())
        mbUser.addEventListener('click', () => {
            setDrawer(false);
            location.hash = 'a-prof';
        });
    $('#ps-x').addEventListener('click', () => setDrawer(false));
    $('#scrim').addEventListener('click', () => setDrawer(false));
    $('#pubside').addEventListener('click', e => {
        if (e.target.closest('a'))
            setDrawer(false);
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape')
            setDrawer(false);
    });

    // every [data-route] link or button in the page
    document.addEventListener('click', e => {
        const el = e.target.closest('[data-route]');
        if (!el)
            return;
        e.preventDefault();
        navigate(el.dataset.route);
    });

    const lo = $('#logout');
    if (lo)
        lo.addEventListener('click', async e => {
            e.preventDefault();
            setDrawer(false);
            if (await confirmLogout())
                logout();
        });

    window.addEventListener('profile-updated', profileEvent => {
        updateSidebarName(profileEvent.detail.username || '');
    });
    keepSidebarInSyncWithLogin(!!user);
    if (user) {
        loadAccountProfile().then(profile => {
            if (profile)
                syncDisplayName(profile);
        }).catch(() => {
            // Keep the last saved username when the database cannot be reached.
        });
    }
    setActiveNav(document.body.dataset.active);
}

/* Highlight a sidebar item by its key (home, book, rent, mybook, myrent). */
export function setActiveNav(key) {
    const mobileAvatar = $('#mb-user');   // phone top bar avatar: lit while the Profile page is open
    if (mobileAvatar)
        mobileAvatar.classList.toggle('active', key === 'a-prof');
    $$('#ps-main li, #ps-auth li[data-side], #mtabs li').forEach(li => {
        const on = li.dataset.side === key;
        li.classList.toggle('active', on);
        const a = li.closest('#mtabs') && li.querySelector('a');
        if (a)
            on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
    });
}