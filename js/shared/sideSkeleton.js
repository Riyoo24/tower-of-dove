/* =====================================================================
   shared/sideSkeleton.js - grey shimmer sidebar while the admin page starts up
   A normal (non-module) script. pages/admin.html loads it as the FIRST thing inside <body>, so the sidebar
   (desktop) and the top bar (phone) are drawn at once, long before the ES modules, the Supabase script and
   the first data request are done.
   js/shared/layout.js -> injectChrome() calls  window.todSideSkeleton.remove()  right before it draws the real
   sidebar, so nothing has to be cleaned up by hand and the two never show together.
   How many rows it shows depends on who is logged in (the cached user in localStorage):
   owner and staff both see 8 menu rows (the 4 owner tools start folded).
   If the real sidebar never arrives (the page script failed) the skeleton is removed after 25 seconds,
   so it never shimmers forever.
   ===================================================================== */
(function () {
    'use strict';

    var body = document.body;
    if (!body || body.getAttribute('data-role') !== 'admin')
        return;

    var ROWS = 8;   // owner tools start folded, so owner and staff see the same 8 rows
    var W = ['58%', '72%', '64%', '80%', '52%', '68%', '60%', '76%'];   // label widths, varied so rows do not look stamped

    /* the menu may be saved as collapsed (icon rail); see NAV_PREF_KEY in shared/layout.js */
    var rail = false;
    try {
        var pref = JSON.parse(localStorage.getItem('tod_admin_nav') || '{}') || {};
        rail = !!pref.rail && innerWidth > 820;
    } catch (e) { /* storage blocked: draw it open */ }

    function row(i) {
        return '<div class="sk-row"><span class="sk-b sk-ic"></span><span class="sk-b sk-lb" style="height:12px;width:' + W[i % W.length] + '"></span></div>';
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
        + '<aside class="snav-side sk-side' + (rail ? ' rail' : '') + '">'
        + '<div class="snav-top">'
        + '<div class="sk-row" style="padding:0"><span class="sk-b" style="width:36px;height:36px;border-radius:50%;flex:none"></span><span class="sk-b sk-lb" style="width:110px;height:14px"></span></div>'
        + '<span class="sk-b sk-blk" style="height:42px"></span>'
        + '</div>'
        + '<div class="snav-nav">' + many(ROWS, row) + '</div>'
        + '<div class="snav-foot"><div class="sk-row" style="height:46px"><span class="sk-b" style="width:34px;height:34px;border-radius:50%;flex:none"></span><span class="sk-b sk-lb" style="width:70px;height:12px"></span></div></div>'
        + '</aside>';

    body.classList.add('hasside');
    if (rail)
        body.classList.add('sc');   // same page margin as the real icon rail
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