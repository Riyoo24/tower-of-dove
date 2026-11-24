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
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
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
    chev: '<path d="M6 9l6 6 6-6"/>',
    fold: '<path d="M11 7l-5 5 5 5M18 7l-5 5 5 5"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
    add: '<path d="M12 5v14M5 12h14"/>',
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

/* Owner and staff sidebar, grouped by job. [tab id, label, icon]. Links are #hashes handled by
   admin/index.js, so they never leave pages/admin.html. A group with owner:true is drawn for the owner only.
   Onsite Booking (a-onb) and Onsite Rental (a-onr) are not menu rows: they open from the "New walk-in" button. */
export const ADMIN_GROUPS = [
    { id: 'daily', label: 'Front desk', items: [
        ['a-over', 'Overview', 'grid'],
        ['a-cal', 'Calendar', 'week'],
        ['a-sess', 'Studio Sessions', 'clock']] },
    { id: 'orders', label: 'Bookings and payments', items: [
        ['a-book', 'Bookings', 'cal'],
        ['a-rent', 'Rentals', 'box'],
        ['a-pay', 'Payments', 'card']] },
    { id: 'people', label: 'People and gear', items: [
        ['a-cust', 'Customers', 'users'],
        ['a-eqp', 'Equipment', 'music']] },
    { id: 'owner', label: 'Owner tools', owner: true, closed: true, items: [
        ['a-stud', 'Studio Management', 'door'],
        ['a-rep', 'Reports', 'chart'],
        ['a-audit', 'Audit Log', 'shield'],
        ['a-set', 'Settings', 'gear']] }
];

/* The collapsed menu and folded groups are remembered on this device. */
const NAV_PREF_KEY = 'tod_admin_nav';
const readNavPref = () => {
    try {
        return JSON.parse(localStorage.getItem(NAV_PREF_KEY) || '{}') || {};
    } catch (e) {
        return {};
    }
};
const saveNavPref = pref => {
    try {
        localStorage.setItem(NAV_PREF_KEY, JSON.stringify(pref));
    } catch (e) { /* storage blocked: the menu simply starts open next time */ }
};

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
    const sidebarNameElement = $('#ps-profile .lbl, #adm-me .lbl');
    if (sidebarNameElement)
        sidebarNameElement.textContent = displayName;
    const letter = ((displayName || '').trim()[0] || 'U').toUpperCase();
    $$('#ps-profile .tn-av, #adm-me .adm-av, #mb-user .tn-av').forEach(avatar => {   // sidebar / top bar avatar and the phone top bar avatar: first letter of the name
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
    if (window.todTopSkeleton)
        window.todTopSkeleton.remove();   // the grey placeholder bar from js/shared/topSkeleton.js
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
    const owner = !!(user && user.role === 'owner');
    const pref = readNavPref();
    const folded = pref.closed || { owner: true };   // the Owner tools group starts folded
    const name = user ? (user.username || user.label || 'Account') : '';
    const initial = (name.trim()[0] || 'U').toUpperCase();
    const desktop = () => innerWidth > 820;
    document.body.classList.add('hasside');
    if (window.todSideSkeleton)
        window.todSideSkeleton.remove();   // the grey placeholder sidebar from js/shared/sideSkeleton.js (admin page only)
    document.body.insertAdjacentHTML('afterbegin', `
    <div class="mbar">
      <button id="mb-open" aria-label="Open menu">${icon('menu')}</button>
      <span class="mb-brand"><img src="${ASSETS}img/logo.png" alt="" width="30" height="30"> Tower of Dove</span>
      <button id="mb-user" aria-label="${user ? 'Account' : 'Log in'}" ${user ? '' : 'data-route="login"'}>${user ? `<span class="tn-av" aria-hidden="true">${esc(initial)}</span>` : icon('user')}</button>
    </div>
    <div class="scrim" id="scrim"></div>
    <aside class="snav-side" id="snav" aria-label="Main navigation">
      <div class="snav-top">
        <div class="snav-brand">
          <img src="${ASSETS}img/logo.png" alt="" width="36" height="36">
          <div class="snav-t"><b>Tower of Dove</b><small>${owner ? 'Owner' : 'Staff'} dashboard</small></div>
          <button type="button" class="snav-fold" id="ps-toggle" aria-label="Collapse menu" aria-expanded="true" data-tip="Collapse menu">${icon('fold')}</button>
          <button type="button" class="snav-x" id="ps-x" aria-label="Close menu">${icon('x')}</button>
        </div>
        <div class="snav-walk">
          <button type="button" class="snav-cta" id="snav-cta" aria-haspopup="menu" aria-expanded="false" aria-controls="snav-wpop" data-tip="New walk-in">${icon('add')}<span class="lbl">New walk-in</span><span class="snav-chev">${icon('chev')}</span></button>
          <div class="snav-pop" id="snav-wpop" role="menu" hidden>
            <a role="menuitem" href="#a-onb">${icon('cal')}<span><strong>Walk-in booking</strong><small>Book a room for someone at the desk</small></span></a>
            <a role="menuitem" href="#a-onr">${icon('box')}<span><strong>Walk-in rental</strong><small>Rent gear to take away</small></span></a>
          </div>
        </div>
      </div>
      <nav class="snav-nav" id="snav-nav" aria-label="Dashboard pages">
        ${ADMIN_GROUPS.filter(g => !g.owner || owner).map(g => {
            const isFolded = !!g.label && !!folded[g.id];
            return `
        <section class="snav-grp${isFolded ? ' closed' : ''}" data-grp="${g.id}">
          ${g.label ? `<button type="button" class="snav-gh" data-fold="${g.id}" aria-expanded="${!isFolded}">${g.owner ? icon('lock') : ''}<span>${g.label}</span><span class="snav-dot" title="Something here needs attention"></span><span class="snav-chev">${icon('chev')}</span></button>` : ''}
          <div class="snav-gb"><ul${isFolded ? ' inert' : ''}>
            ${g.items.map(([key, label, ic]) => `
            <li data-side="${key}"><a href="#${key}" data-tip="${label}"><span class="snav-i">${icon(ic)}</span><span class="lbl">${label}</span></a></li>`).join('')}
          </ul></div>
        </section>`;
        }).join('')}
      </nav>
      <div class="snav-foot">
        ${user ? `
        <button type="button" class="snav-me" id="adm-me" aria-haspopup="menu" aria-expanded="false" aria-controls="snav-mpop" data-tip="${esc(name)}">
          <span class="snav-av adm-av" aria-hidden="true">${esc(initial)}</span>
          <span class="snav-n"><b class="lbl">${esc(name)}</b><small>${owner ? 'Owner' : 'Staff'}</small></span>
          <span class="snav-chev">${icon('chev')}</span>
        </button>
        <div class="snav-pop" id="snav-mpop" role="menu" hidden>
          <a role="menuitem" href="#a-prof">${icon('user')}<span><strong>${owner ? 'Owner profile' : 'My profile'}</strong></span></a>
          <button type="button" role="menuitem" id="logout">${icon('logout')}<span><strong>Log out</strong></span></button>
        </div>` : `
        <a class="snav-me" href="#" data-route="login">${icon('login')}<span class="snav-n"><b>Log in</b></span></a>`}
      </div>
    </aside>`);
    document.body.insertAdjacentHTML('beforeend', '<div class="snav-tip" id="snav-tip" hidden></div>');

    const side = $('#snav');
    const tip = $('#snav-tip');

    const setDrawer = open => {
        side.classList.toggle('open', open);
        $('#scrim').classList.toggle('on', open);
    };
    const closePops = () => {
        $$('.snav-pop').forEach(p => { p.hidden = true; });
        ['#snav-cta', '#adm-me'].forEach(sel => {
            const b = $(sel);
            if (b)
                b.setAttribute('aria-expanded', 'false');
        });
    };
    const togglePop = (btn, pop) => {
        const wasOpen = !pop.hidden;
        closePops();
        if (!wasOpen) {
            pop.hidden = false;
            btn.setAttribute('aria-expanded', 'true');
        }
    };

    // folded groups cannot be tabbed into; in the icon rail every group is shown
    const syncFolds = () => {
        const rail = side.classList.contains('rail');
        $$('.snav-grp', side).forEach(g => {
            const ul = g.querySelector('ul');
            if (ul)
                ul.inert = g.classList.contains('closed') && !rail;
        });
    };
    // the icon rail is a desktop-only state; phones always get the full drawer
    const applyRail = () => {
        const rail = !!pref.rail && desktop();
        side.classList.toggle('rail', rail);
        document.body.classList.toggle('sc', rail);
        const fold = $('#ps-toggle');
        fold.setAttribute('aria-expanded', String(!rail));
        fold.setAttribute('aria-label', rail ? 'Expand menu' : 'Collapse menu');
        fold.dataset.tip = rail ? 'Expand menu' : 'Collapse menu';
        syncFolds();
    };
    const toggleSidebar = () => {
        // The page's left margin changes once (instant, one layout). The slide you see is a transform
        // (graphics card only) from where the page was to where it is now, so no per-frame re-layout.
        const page = document.querySelector('.page');
        const animate = page && page.animate && desktop() && !matchMedia('(prefers-reduced-motion: reduce)').matches;
        const before = animate ? page.getBoundingClientRect().left : 0;
        closePops();
        tip.hidden = true;
        pref.rail = !pref.rail;
        saveNavPref(pref);
        applyRail();
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
    applyRail();
    matchMedia('(min-width: 821px)').addEventListener('change', applyRail);

    // hover labels in the icon rail
    const showTip = el => {
        if (!side.classList.contains('rail') || !el.dataset.tip)
            return;
        const r = el.getBoundingClientRect();
        tip.textContent = el.dataset.tip;
        tip.hidden = false;
        tip.style.left = r.right + 12 + 'px';
        tip.style.top = r.top + r.height / 2 - tip.offsetHeight / 2 + 'px';
    };
    side.addEventListener('mouseover', e => {
        const el = e.target.closest('[data-tip]');
        el ? showTip(el) : (tip.hidden = true);
    });
    side.addEventListener('focusin', e => {
        const el = e.target.closest('[data-tip]');
        el ? showTip(el) : (tip.hidden = true);
    });
    side.addEventListener('mouseleave', () => { tip.hidden = true; });
    side.addEventListener('focusout', () => { tip.hidden = true; });

    $('#ps-toggle').addEventListener('click', toggleSidebar);
    $('#snav-cta').addEventListener('click', () => togglePop($('#snav-cta'), $('#snav-wpop')));
    const me = $('#adm-me');
    if (me)
        me.addEventListener('click', () => togglePop(me, $('#snav-mpop')));

    // fold or open a group, and remember it
    $('#snav-nav').addEventListener('click', e => {
        const head = e.target.closest('[data-fold]');
        if (!head)
            return;
        const grp = head.closest('.snav-grp');
        const nowFolded = !grp.classList.contains('closed');
        grp.classList.toggle('closed', nowFolded);
        head.setAttribute('aria-expanded', String(!nowFolded));
        pref.closed = { ...(pref.closed || { owner: true }), [head.dataset.fold]: nowFolded };
        saveNavPref(pref);
        syncFolds();
    });

    $('#mb-open').addEventListener('click', () => setDrawer(true));
    // phone top bar: the avatar opens the account (Profile) page of the dashboard
    const mbUser = $('#mb-user');
    if (mbUser && user)
        mbUser.addEventListener('click', () => {
            setDrawer(false);
            location.hash = 'a-prof';
        });
    $('#ps-x').addEventListener('click', () => setDrawer(false));
    $('#scrim').addEventListener('click', () => setDrawer(false));
    side.addEventListener('click', e => {
        if (e.target.closest('a[href^="#"]')) {
            closePops();
            setDrawer(false);
        }
    });
    document.addEventListener('click', e => {
        if (!e.target.closest('.snav-walk, .snav-foot'))
            closePops();
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            setDrawer(false);
            closePops();
        }
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
            closePops();
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
    $$('#ps-main li, #ps-auth li[data-side], #snav li[data-side], #mtabs li').forEach(li => {
        const on = li.dataset.side === key;
        li.classList.toggle('active', on);
        const a = li.closest('#mtabs, #snav') && li.querySelector('a');
        if (a)
            on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
    });
    // admin sidebar: the account button, the New walk-in button, and a folded group that holds the open page
    const account = $('#adm-me');
    if (account)
        account.classList.toggle('active', key === 'a-prof');
    const walkIn = $('#snav-cta');
    if (walkIn)
        walkIn.classList.toggle('here', key === 'a-onb' || key === 'a-onr');
    const here = $('#snav li.active');
    const folded = here && here.closest('.snav-grp.closed');
    if (folded) {
        folded.classList.remove('closed');
        const head = folded.querySelector('[data-fold]');
        if (head)
            head.setAttribute('aria-expanded', 'true');
        const ul = folded.querySelector('ul');
        if (ul)
            ul.inert = false;
    }
}