/* =====================================================================
   shared/skeleton.js - grey shimmer placeholders while Supabase answers
   A normal (non-module) script, loaded BEFORE boot.js, so the placeholders are on screen at once, while the
   page's ES modules are still being fetched. Each container below gets placeholders shaped like what will
   replace them (cards, table rows, KPI tiles). The page's own render code later does
   `container.innerHTML = ...`, which simply replaces the placeholders; nothing has to remove them.
   If the data never arrives (a failed request, or 25 seconds pass) the leftover placeholders turn into a
   short message with a "Try again" button instead of shimmering forever.
   Other scripts can call  window.todSkeleton.fail()  to do that at once.
   ===================================================================== */
(function () {
    'use strict';

    var bar = function (w, cls) { return '<i class="sk-b' + (cls ? ' ' + cls : '') + '" style="width:' + w + '"></i>'; };
    var many = function (n, fn) { var s = ''; for (var i = 0; i < n; i++) s += fn(i); return s; };
    var SR = '<span class="sk-sr">Loading</span>';
    var W = ['62%', '78%', '48%', '70%', '56%', '84%', '44%', '66%'];   // cell widths, varied so rows do not look stamped

    /* a studio / equipment card: picture, title + badge, two text lines, price and button */
    function card(i) {
        return '<div class="card sk sk-card" aria-hidden="true">' + (i ? '' : SR) + '<div class="sk-b sk-pic"></div>'
            + '<div class="sk-row">' + bar('46%', 'sk-h') + bar('22%', 'sk-pill') + '</div>'
            + bar('92%') + bar('70%')
            + '<div class="sk-row sk-foot">' + bar('30%', 'sk-h') + bar('34%', 'sk-btn') + '</div></div>';
    }
    /* a small number tile (admin overview) */
    function kpi(i) {
        return '<div class="card sk sk-kpi" aria-hidden="true">' + (i ? '' : SR) + bar('52%') + bar('34%', 'sk-num') + '</div>';
    }
    /* a short tile with a title + badge and one line (admin overview studios) */
    function tile(i) {
        return '<div class="card sk sk-tile" aria-hidden="true">' + (i ? '' : SR) + '<div class="sk-row">' + bar('40%', 'sk-h') + bar('24%', 'sk-pill') + '</div>' + bar('72%') + '</div>';
    }
    /* a wide panel (admin studio sessions: one per studio) */
    function panel(i) {
        return '<div class="card sk sk-panel" aria-hidden="true">' + (i ? '' : SR) + '<div class="sk-row">' + bar('26%', 'sk-h') + bar('16%', 'sk-pill') + '</div>'
            + bar('58%') + bar('40%') + '<div class="sk-row sk-foot">' + bar('22%', 'sk-btn') + bar('22%', 'sk-btn') + '</div></div>';
    }
    /* the big showcase slide on Home: one picture-sized shimmer with the caption bars on it */
    function slide(i) {
        return '<div class="slide sk sk-slide" aria-hidden="true">' + (i ? '' : SR)
            + '<div class="sk-cap">' + bar('16%', 'sk-pill') + bar('30%', 'sk-title') + bar('48%')
            + '<div class="sk-row sk-foot">' + bar('18%', 'sk-h') + bar('24%', 'sk-btn') + '</div></div></div>';
    }
    /* the carousel dots under the slide */
    function dots() {
        return many(5, function () { return '<i class="sk-b sk-dot" aria-hidden="true"></i>'; });
    }
    /* what the "Check availability" box shows while the request is running */
    function avail() {
        return '<div class="card sk sk-avail" role="status" aria-label="Checking availability">' + SR
            + '<div class="sk-row">' + bar('50%', 'sk-h') + bar('14%', 'sk-pill') + '</div>' + bar('62%')
            + '<div class="sk-row sk-chips">' + many(4, function () { return bar('', 'sk-chip'); }) + '</div></div>';
    }
    /* an overview list row */
    function li(i) {
        return '<li class="sk sk-li" aria-hidden="true">' + (i ? '' : SR) + bar(W[(i * 3) % W.length]) + '</li>';
    }
    /* a table: optional filter tabs, a heading row and n rows of cells */
    function table(cols, rows, tabs) {
        return '<div class="sk sk-table" role="status" aria-label="Loading">' + SR
            + (tabs ? '<div class="sk-tabs" aria-hidden="true">' + many(tabs, function () { return bar('', 'sk-tab'); }) + '</div>' : '')
            + '<div class="sk-tr sk-th" aria-hidden="true">' + many(cols, function (c) { return bar('52%'); }) + '</div>'
            + many(rows, function (r) {
                return '<div class="sk-tr" aria-hidden="true">' + many(cols, function (c) { return bar(W[(r * 3 + c * 5) % W.length]); }) + '</div>';
            }) + '</div>';
    }

    var PLAN = [
        // admin
        ['#ovk', function () { return many(4, kpi); }],
        ['#rkpi', function () { return many(3, kpi); }],
        ['#ost', function () { return many(2, tile); }],
        ['#ovl', function () { return many(4, li); }],
        ['#abk', function () { return table(7, 7, 5); }],
        ['#asess', function () { return many(2, panel); }],
        ['#ast', function () { return many(3, card); }],
        ['#aeq', function () { return table(6, 6); }],
        ['#arn', function () { return table(6, 6, 5); }],
        ['#apy', function () { return table(7, 6, 4); }],
        ['#acu', function () { return table(6, 6); }],
        ['#stf', function () { return table(4, 3); }],
        ['#rp', function () { return table(5, 6); }],
        // customer
        ['#cs', function () { return many(3, card); }],
        ['#eq', function () { return many(6, card); }],
        ['#mybk', function () { return table(7, 4); }],
        ['#myrent', function () { return table(6, 3); }],
        // home page
        ['#studio-grid', function () { return many(4, card); }],
        ['#equipment-grid', function () { return many(4, card); }],
        ['#slider', function () { return slide(0); }],        // the big showcase slide (the Home "hero" picture)
        ['#sdots', dots, true]                                // third item: quiet, no message of its own when loading fails
    ];

    var found = [], quiet = [];
    PLAN.forEach(function (p) {
        var el = document.querySelector(p[0]);
        if (el && !el.firstElementChild) {   // only an empty container: never touch anything already drawn
            el.innerHTML = p[1]();
            (p[2] ? quiet : found).push(el);
        }
    });

    /* ---- the studio picker in the hero's "Check a time" card: shimmer until its options are drawn ---- */
    var qs = document.getElementById('qs');
    if (qs && !qs.firstElementChild) {
        qs.classList.add('sk-field');
        qs.setAttribute('aria-busy', 'true');
        new MutationObserver(function (_, mo) {
            if (!qs.firstElementChild)
                return;
            qs.classList.remove('sk-field');
            qs.removeAttribute('aria-busy');
            mo.disconnect();
        }).observe(qs, { childList: true });
    }

    /* ---- pictures: studio photos, equipment photos, slide photos, reviewer faces ----
       css/components.css shows a shimmer until the photo has really loaded. Here we only mark each <img>.
       The "load" and "error" events do not bubble, so they are caught in the capture phase, which also covers
       pictures that are drawn later by the render code. The class on <html> keeps the pictures visible if this
       script never runs. */
    var root = document.documentElement;
    root.classList.add('sk-imgs');
    function mark(img) {
        if (!img.complete)
            return;
        img.classList.add(img.naturalWidth ? 'is-loaded' : 'is-failed');
    }
    function sweep() {   // safety net for a picture whose event was missed (cached images, a very fast load)
        Array.prototype.forEach.call(document.querySelectorAll('img:not(.is-loaded):not(.is-failed)'), mark);
    }
    document.addEventListener('load', function (e) {
        if (e.target && e.target.tagName === 'IMG') {
            e.target.classList.remove('is-failed');
            e.target.classList.add('is-loaded');
        }
    }, true);
    document.addEventListener('error', function (e) {
        if (e.target && e.target.tagName === 'IMG')
            e.target.classList.add('is-failed');
    }, true);
    sweep();
    var sweeps = 0, sweeper = setInterval(function () {
        sweep();
        if (++sweeps >= 20)
            clearInterval(sweeper);
    }, 500);

    function pending() {
        return found.filter(function (el) { return el.isConnected && el.firstElementChild && el.firstElementChild.classList.contains('sk'); });
    }

    /* Replace whatever placeholders are still showing with a message and a retry button. */
    function fail() {
        quiet.forEach(function (el) {
            if (el.isConnected && el.firstElementChild && el.firstElementChild.classList.contains('sk-b'))
                el.innerHTML = '';
        });
        if (qs)
            qs.classList.remove('sk-field');
        pending().forEach(function (el) {
            el.innerHTML = '<div class="sk-fail" role="alert"><span>Could not load this yet. Check your connection.</span>'
                + '<button type="button" class="btn sm line" data-sk-retry>Try again</button></div>';
        });
    }

    document.addEventListener('click', function (e) {
        if (e.target.closest && e.target.closest('[data-sk-retry]'))
            location.reload();
    });

    window.todSkeleton = { fail: fail, avail: avail };
    if (found.length)
        setTimeout(fail, 25000);
})();