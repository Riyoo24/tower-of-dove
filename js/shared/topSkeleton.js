/* =====================================================================
   shared/topSkeleton.js - grey shimmer top navbar while the page starts up
   A normal (non-module) script. pages/customer.html loads it as the FIRST thing inside <body>, so a bar
   the same size as the real one is on screen at once, before the ES modules, Supabase and the data are ready.
   js/shared/layout.js -> injectTopNav() calls  window.todTopSkeleton.remove()  right before it draws the real bar,
   so the two never show together and nothing jumps (it uses the same .topnav / .tn-in classes).
   It shows the logged-in or logged-out version from the cached user in localStorage (key tod_user).
   If the real bar never arrives (the page script failed) the skeleton is removed after 25 seconds.
   Styles: css/skeleton-extra.css
   ===================================================================== */
(function () {
    'use strict';

    var body = document.body;
    if (!body || !body.classList.contains('hastop') || body.getAttribute('data-role') === 'admin' || document.getElementById('topnav'))
        return;

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
        if (node)
            node.remove();
        clearTimeout(timer);
    }
    window.todTopSkeleton = { remove: remove };
})();