/* =====================================================================
   shared/topSkeleton.js - grey shimmer top navbar while the page starts up, and the "text waits for its skeleton" gate
   A normal (non-module) script. pages/customer.html loads it as the FIRST thing inside <body>, so a bar
   the same size as the real one is on screen at once, before the ES modules, Supabase and the data are ready.
   js/shared/layout.js -> injectTopNav() calls  window.todTopSkeleton.remove()  right before it draws the real bar,
   so the two never show together and nothing jumps (it uses the same .topnav / .tn-in classes).
   It shows the logged-in or logged-out version from the cached user in localStorage (key tod_user).
   If the real bar never arrives (the page script failed) the skeleton is removed after 25 seconds.

   Text reveal (css/skeleton-extra.css):
     - html.sk-wait   the hero, page headers, tables and Contact Us text stay invisible while their skeletons shimmer.
                      Grey placeholder bars (.sk-txt) sit where that text will appear, so the page is never half empty.
     - html.sk-play   set when the skeletons are gone: the placeholder bars fade out and the text fades and rises in.
     - html.sk-nav-in set while the real navbar replaces the skeleton bar: its logo and links play in.
   The tab the page opens on decides what the text waits for (see ready() below).
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

    root.classList.add('sk-wait');   // set before the page content is parsed, so its text is hidden from the first paint

    var obs = null, poll = 0, cap = 0;

    /* ---- grey bars where the hidden text will appear (sizes follow the real text; they are only a stand-in) ---- */
    var b = function (w, h, mt, cls) {
        return '<i class="sk-b' + (cls ? ' ' + cls : '') + '" style="width:' + w + ';height:' + h + 'px' + (mt ? ';margin-top:' + mt + 'px' : '') + '"></i>';
    };
    var hero =
        b('190px', 30, 0, 'sk-r99')
        + b('72%', 44, 18, 'sk-h1') + b('54%', 44, 10, 'sk-h1')
        + b('94%', 13, 22) + b('80%', 13, 10)
        + '<div class="sk-cta">' + b('150px', 46, 0, 'sk-r12') + b('112px', 46, 0, 'sk-r12') + b('200px', 46, 0, 'sk-r99') + '</div>';
    var card =
        b('110px', 20, 0)
        + '<div class="sk-grp">' + b('46px', 10, 0) + b('100%', 40, 0, 'sk-r10') + '</div>'
        + '<div class="sk-two"><div class="sk-grp">' + b('40px', 10, 0) + b('100%', 40, 0, 'sk-r10') + '</div>'
        + '<div class="sk-grp">' + b('64px', 10, 0) + b('100%', 40, 0, 'sk-r10') + '</div></div>'
        + b('100%', 48, 0, 'sk-r12')
        + b('70%', 10, 0, 'sk-mid');
    var sc = b('96px', 12, 0) + b('250px', 28, 10) + b('min(390px, 90%)', 12, 8);
    var pg = b('96px', 12, 0) + b('min(320px, 60%)', 34, 12) + b('min(560px, 92%)', 12, 14) + b('min(420px, 70%)', 12, 8);
    var ct = b('130px', 12, 0, 'sk-mid') + b('min(230px, 60%)', 34, 12, 'sk-mid') + b('min(340px, 80%)', 12, 14, 'sk-mid');

    var SK = [   // [where the text will be, the bars, extra class]
        ['.hx-copy', hero, ''],
        ['.hx-card', card, ' sk-txt-card'],
        ['.sc-head > div:first-child', sc, ''],
        ['.pghead > div', pg, ''],
        ['.ct-head', ct, ' sk-txt-mid']
    ];

    function decorate() {
        if (!root.classList.contains('sk-wait'))
            return;
        SK.forEach(function (p) {
            Array.prototype.forEach.call(document.querySelectorAll(p[0]), function (host) {
                if (host.querySelector(':scope > .sk-txt'))
                    return;
                var d = document.createElement('div');
                d.className = 'sk-txt' + p[2];
                d.setAttribute('aria-hidden', 'true');
                d.innerHTML = p[1];
                host.classList.add('sk-rel');      // so the bars can sit on top of the hidden text
                host.appendChild(d);               // last child: the text's own nth-child delays are unchanged
            });
        });
    }

    function undecorate() {
        var list = document.querySelectorAll('.sk-txt');
        Array.prototype.forEach.call(list, function (d) { d.classList.add('out'); });
        setTimeout(function () {
            Array.prototype.forEach.call(list, function (d) {
                var host = d.parentNode;
                if (d.parentNode)
                    d.parentNode.removeChild(d);
                if (host && host.classList)
                    host.classList.remove('sk-rel');
            });
        }, 400);
    }

    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', decorate);
    else
        decorate();

    /* which list each tab waits for (the same ids that js/shared/skeleton.js fills with placeholders) */
    var TAB_BOX = { book: '#cs', rent: '#eq', 'my-bookings': '#mybk', 'my-rentals': '#myrent' };

    /* true when the skeletons the visitor is looking at are gone */
    function ready() {
        if (document.getElementById('sk-top'))
            return false;                                   // the real navbar is not in yet
        var tab = body.getAttribute('data-active');
        if (tab === 'contact') {
            var ct = document.getElementById('ct-touch');   // Contact Us: wait for its rows
            return !!ct && ct.children.length > 0 && !document.querySelector('#ct-touch .sk, #ct-follow .sk, #ct-visit .sk');
        }
        var sel = TAB_BOX[tab];
        if (sel) {                                          // Book / Rent / My bookings / My rental: wait for that tab's list or table
            var box = document.querySelector(sel);
            if (box && box.offsetParent !== null)
                return box.children.length > 0 && !box.querySelector('.sk');
            return true;                                    // not on screen (for example a guest on My bookings): nothing to wait for
        }
        var sl = document.getElementById('slider');         // Home: wait for the showcase slide and the studio picker
        if (sl && (!sl.children.length || sl.querySelector('.sk')))
            return false;
        return !document.querySelector('#qs.sk-field');
    }

    function release() {
        if (!root.classList.contains('sk-wait'))
            return;
        root.classList.remove('sk-wait');
        root.classList.add('sk-play');                      // the text fades and rises in (css/skeleton-extra.css)
        undecorate();                                       // and the grey bars fade out
        if (obs)
            obs.disconnect();
        clearInterval(poll);
        clearTimeout(cap);
        setTimeout(function () { root.classList.remove('sk-play'); }, 2600);   // then give the elements back to their own styles
        settleTables();
    }

    /* The tables fade in only when they are first drawn. Opening or closing "Past and closed" (or a refresh) re-draws
       the table inside the same box; without this the new table replayed the fade (blank for about a second). The first
       re-draw after the reveal marks the box .sk-done, which switches the fade off for it (css/skeleton-extra.css). */
    function settleTables() {
        ['mybk', 'myrent'].forEach(function (id) {
            var box = document.getElementById(id);
            if (!box || !('MutationObserver' in window))
                return;
            var mo = new MutationObserver(function () {
                box.classList.add('sk-done');
                mo.disconnect();
            });
            mo.observe(box, { childList: true });
        });
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