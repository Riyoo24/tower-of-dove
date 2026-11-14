/* =====================================================================
   shared/sideSkeleton.js - grey shimmer sidebar while the admin page starts up
   A normal (non-module) script. pages/admin.html loads it as the FIRST thing inside <body>, so the sidebar
   (desktop) and the top bar (phone) are drawn at once, long before the ES modules, the Supabase script and
   the first data request are done.
   js/shared/layout.js -> injectChrome() calls  window.todSideSkeleton.remove()  right before it draws the real
   sidebar, so nothing has to be cleaned up by hand and the two never show together.
   How many rows it shows depends on who is logged in (the cached user in localStorage):
   the owner sees 13 menu rows, staff see 10. If nobody is cached it shows the owner's 13.
   If the real sidebar never arrives (the page script failed) the skeleton is removed after 25 seconds,
   so it never shimmers forever.
   ===================================================================== */
(function () {
    'use strict';

    var body = document.body;
    if (!body || body.getAttribute('data-role') !== 'admin')
        return;

    var role = '';
    try {
        var u = JSON.parse(localStorage.getItem('tod_user') || 'null');   // same key as shared/session.js
        role = (u && u.role) || '';
    } catch (e) { /* storage blocked: show the full list */ }

    var ROWS = role && role !== 'owner' ? 10 : 13;       // the owner has 3 extra tabs (studios, reports, settings)
    var W = ['58%', '72%', '64%', '80%', '52%', '68%', '60%', '76%'];   // label widths, varied so rows do not look stamped

    function row(i) {
        return '<li class="sk-sd-row"><span class="sk-b sk-sd-ico"></span><span class="sk-b sk-sd-lbl" style="width:' + W[i % W.length] + '"></span></li>';
    }
    function many(n, fn) {
        var s = '';
        for (var i = 0; i < n; i++)
            s += fn(i);
        return s;
    }

    var wrap = document.createElement('div');
    wrap.id = 'sk-side';
    wrap.setAttribute('aria-hidden', 'true');
    wrap.innerHTML =
        /* phone: the top bar (menu button, logo + name, account button) */
        '<div class="mbar sk-mbar">'
        + '<span class="sk-b sk-mb-btn"></span>'
        + '<span class="sk-mb-brand"><span class="sk-b sk-mb-logo"></span><span class="sk-b sk-mb-name"></span></span>'
        + '<span class="sk-b sk-mb-btn"></span>'
        + '</div>'
        /* desktop: the sidebar itself (on phones this is the closed drawer, so it is off screen) */
        + '<aside class="pubside sk-side">'
        + '<div class="ps-menu sk-sd-menu"><span class="sk-b sk-sd-ico"></span></div>'
        + '<ul class="ps-links sk-sd-list">' + many(ROWS, row) + '</ul>'
        + '<ul class="ps-links ps-auth sk-sd-list">' + many(2, function (i) { return row(i + 3); }) + '</ul>'
        + '<div class="ps-logo sk-sd-logo"><span class="sk-b sk-sd-pic"></span><span class="sk-b sk-sd-title"></span></div>'
        + '</aside>';

    body.classList.add('hasside');
    body.insertBefore(wrap, body.firstChild);

    function remove() {
        var el = document.getElementById('sk-side');
        if (el)
            el.remove();
        if (timer)
            clearTimeout(timer);
    }
    var timer = setTimeout(remove, 25000);
    window.todSideSkeleton = { remove: remove };
})();