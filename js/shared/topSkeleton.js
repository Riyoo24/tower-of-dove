/* =====================================================================
   shared/topSkeleton.js - grey shimmer top navbar while the page starts up, and the "text waits for its skeleton" gate
   A normal (non-module) script. pages/customer.html loads it as the FIRST thing inside <body>, so a bar
   the same size as the real one is on screen at once, before the ES modules, Supabase and the data are ready.
   js/shared/layout.js -> injectTopNav() calls  window.todTopSkeleton.remove()  right before it draws the real bar,
   so the two never show together and nothing jumps (it uses the same .topnav / .tn-in classes).
   It shows the logged-in or logged-out version from the cached user in localStorage (key tod_user).
   If the real bar never arrives (the page script failed) the skeleton is removed after 25 seconds.

   Text reveal (css/skeleton-extra.css):
     - html.sk-wait   the hero, "Find your room" header and Contact Us text stay invisible while their skeletons shimmer.
     - html.sk-play   set when the skeletons are gone: that text fades and rises in, one piece after another.
     - html.sk-nav-in set while the real navbar replaces the skeleton bar: its logo and links play in.
   Nothing is hidden for visitors who prefer reduced motion, and the wait is released after 15 seconds at most.
   ===================================================================== */
(function () {
    'use strict';

    var body = document.body;
    if (!body || !body.classList.contains('hastop') || body.getAttribute('data-role') === 'admin' || document.getElementById('topnav'))
        return;

    var root = document.documentElement;
    var reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    var loggedIn = false;
    try {
        loggedIn = !!JSON.parse(localStorage.getItem('tod_user') || 'null');   // same key as shared/session.js
    } catch (e) { /* storage blocked: show the logged-out bar */ }

    var bar = function (w, cls) { return '<i class="sk-b' + (cls ? ' ' + cls : '') + '" style="width:' + w + '"></i>'; };

    // one placeholder per nav link (Home, Book a Studio, Rent Equipment, My Bookings, My Rental, Contact Us)
    var WIDTHS = ['34px', '84px', '96px', '84px', '66px', '74px'];
    var links = WIDTHS.map(function (w) {
        return '<li><span class="sk-tn-a">' + bar(w) + '</span></li>';
    }).join('');

    var auth = loggedIn
        ? '<li><span class="sk-tn-user"><i class="sk-b sk-tn-av"></i><i class="sk-b sk-tn-uname"></i></span></li>'
          + '<li><i class="sk-b sk-tn-out"></i></li>'
        : '<li><span class="sk-tn-a">' + bar('48px') + '</span></li>'
          + '<li><i class="sk-b sk-tn-btn"></i></li>';

    var el = document.createElement('header');
    el.id = 'sk-top';
    el.className = 'topnav sk-topnav';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML =
        '<div class="tn-in">'
        + '<span class="tn-brand"><i class="sk-b sk-tn-logo"></i>'
        + '<span class="tn-word"><i class="sk-b sk-tn-name"></i><i class="sk-b sk-tn-sub"></i></span></span>'
        + '<div class="tn-nav"><ul class="tn-links">' + links + '</ul><ul class="tn-auth">' + auth + '</ul></div>'
        + '<i class="sk-b sk-tn-burger"></i>'
        + '</div>';
    body.insertBefore(el, body.firstChild);

    var timer = setTimeout(remove, 25000);
    function remove() {
        var node = document.getElementById('sk-top');
        if (node) {
            node.remove();
            if (!reduce) {   // the real bar is injected right after this: its text plays in once, then the class is dropped
                root.classList.add('sk-nav-in');
                setTimeout(function () { root.classList.remove('sk-nav-in'); }, 1600);
            }
        }
        clearTimeout(timer);
    }
    window.todTopSkeleton = { remove: remove };

    /* ---------- text waits for its skeleton ---------- */
    if (reduce)
        return;

    root.classList.add('sk-wait');   // set before the hero is parsed, so its text is hidden from the first paint

    var obs = null, poll = 0, cap = 0;

    /* true when the skeletons the visitor is looking at are gone */
    function ready() {
        if (document.getElementById('sk-top'))
            return false;                                   // the real navbar is not in yet
        if (body.getAttribute('data-active') === 'contact') {
            var ct = document.getElementById('ct-touch');   // Contact Us: wait for its rows
            return !!ct && ct.children.length > 0 && !document.querySelector('#ct-touch .sk, #ct-follow .sk, #ct-visit .sk');
        }
        var sl = document.getElementById('slider');         // Home (and the other tabs): wait for the showcase slide and the studio picker
        if (sl && (!sl.children.length || sl.querySelector('.sk')))
            return false;
        return !document.querySelector('#qs.sk-field');
    }

    function release() {
        if (!root.classList.contains('sk-wait'))
            return;
        root.classList.remove('sk-wait');
        root.classList.add('sk-play');                      // the text fades and rises in (css/skeleton-extra.css)
        if (obs)
            obs.disconnect();
        clearInterval(poll);
        clearTimeout(cap);
        setTimeout(function () { root.classList.remove('sk-play'); }, 2600);   // then give the elements back to their own styles
    }

    function check() {
        if (ready())
            release();
    }

    if ('MutationObserver' in window) {
        obs = new MutationObserver(check);
        obs.observe(body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'data-active'] });
    }
    poll = setInterval(check, 250);          // backup in case a change was missed
    cap = setTimeout(release, 15000);        // never keep the text hidden: a failed request still shows it
})();