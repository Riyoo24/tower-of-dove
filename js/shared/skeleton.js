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
    /* Admin overview placeholders. They are built from the SAME elements and classes as the real cards (a
       one-line text strip stands in for each line of text), so every placeholder is exactly as tall as the card
       that replaces it and nothing moves when the data arrives. css/overview-motion.css has the .sk-ln styles. */
    function ln(w, cls, h) {
        return '<span class="' + cls + ' sk-ln">&#8203;<i class="sk-b" style="width:' + w + (h ? ';height:' + h + 'px' : '') + '"></i></span>';
    }
    /* small text that sits in the card's own line (like the real <span class="mut">): same line height as the real one */
    function lni(w) {
        return '<span class="mut sk-lni">&#8203;<i class="sk-b" style="width:' + w + '"></i></span>';
    }
    /* the top number cards: label + big number */
    function ovKpi(i) {
        return '<div class="card kpi sk" aria-hidden="true">' + (i ? '' : SR) + lni('52%')
            + '<div class="num sk-ln">&#8203;<i class="sk-b" style="width:34%;height:26px"></i></div></div>';
    }
    /* the Equipment returns cards: label + big number + a line of small text */
    function ovRet(i) {
        return '<div class="card kpi sk" aria-hidden="true">' + (i ? '' : SR) + lni('52%')
            + '<div class="num sk-ln">&#8203;<i class="sk-b" style="width:34%;height:26px"></i></div>' + lni('70%') + '</div>';
    }
    /* a studio tile: name + status badge, and one line of small text */
    function ovStudio(i) {
        return '<div class="card sk" aria-hidden="true">' + (i ? '' : SR)
            + '<div class="row"><h3 class="sk-ln" style="width:44%">&#8203;<i class="sk-b" style="width:100%;height:16px"></i></h3><span class="b sk-ghost">Available</span></div>'
            + '<p class="mut sk-ln" style="margin-top:6px">&#8203;<i class="sk-b" style="width:72%"></i></p></div>';
    }
    /* a Needs attention row */
    function ovRow(i) {
        return '<li class="sk" aria-hidden="true">' + (i ? '' : SR) + '<span class="sk-ln" style="width:' + W[(i * 3) % W.length] + '">&#8203;<i class="sk-b" style="width:100%"></i></span></li>';
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
    /* the 7-day bar chart on the admin overview: seven shimmer columns with a small label under each */
    function barCols(i) {
        var H = [44, 70, 30, 86, 52, 64, 96];
        return '<div class="sk" aria-hidden="true">' + (i ? '' : SR)
            + '<span class="sk-b" style="height:' + H[i] + 'px;border-radius:5px 5px 0 0;margin-bottom:4px"></span>'
            + '<span class="sk-b" style="height:10px;width:56%;margin:6px auto 0"></span></div>';
    }
    /* an overview list row */
    function li(i) {
        return '<li class="sk sk-li" aria-hidden="true">' + (i ? '' : SR) + bar(W[(i * 3) % W.length]) + '</li>';
    }
    /* a Contact Us row: round icon, a small label and a value line (same box as the real .ct-link) */
    function ctRow(i) {
        return '<li class="sk" aria-hidden="true">' + (i ? '' : SR)
            + '<div class="ct-link sk-ctrow"><i class="sk-b sk-ct-ico"></i>'
            + '<span class="sk-ct-txt">' + bar('30%') + bar(W[(i * 3 + 1) % W.length]) + '</span></div></li>';
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

    /* the My account panel: summary card on the left, then the Name / Email / Password cards (same boxes as account/profilePanel.js) */
    function accountPanel() {
        var field = function (lbl, wide) {
            return '<div' + (wide ? ' class="wide"' : '') + '>' + bar(lbl, 'sk-acct-lbl') + bar('100%', 'sk-acct-input') + '</div>';
        };
        var dl = many(3, function (i) {
            return '<div>' + bar('34%', 'sk-acct-dt') + bar(['72%', '40%', '56%'][i], 'sk-acct-dd') + '</div>';
        });
        return '<div class="acct sk" role="status" aria-label="Loading your account" aria-busy="true">' + SR
            + '<aside class="acct-card acct-summary" aria-hidden="true">'
            + '<i class="sk-b sk-acct-avatar"></i>' + bar('58%', 'sk-acct-name') + bar('30%', 'sk-acct-user') + '<dl>' + dl + '</dl></aside>'
            + '<div class="acct-main" aria-hidden="true">'
            + '<div class="acct-card"><div class="acct-body">' + bar('30%', 'sk-acct-h') + bar('78%')
            + '<div class="acct-fields">' + field('22%', true) + field('34%') + field('34%') + '</div></div>'
            + '<div class="acct-foot">' + bar('22%') + bar('150px', 'sk-btn') + '</div></div>'
            + '<div class="acct-card"><div class="acct-body">' + bar('34%', 'sk-acct-h') + bar('84%')
            + '<div class="acct-fields">' + field('30%') + field('52%') + '</div></div>'
            + '<div class="acct-foot">' + bar('30%') + bar('150px', 'sk-btn') + '</div></div>'
            + '<div class="acct-card"><div class="acct-body acct-pw"><div class="sk-acct-pwtxt">' + bar('26%', 'sk-acct-h') + bar('88%') + '</div>'
            + bar('190px', 'sk-btn') + '</div></div>'
            + '</div></div>';
    }

    /* ---- Rent tab ---- */
    /* the search box and the "In stock only" switch (same box as shared/eqFilter.js toolbarHtml) */
    function rentTools() {
        return '<div class="eq-tools sk-q" aria-hidden="true"><div class="eq-search">' + bar('100%', 'sk-search') + '</div>'
            + '<span class="sk-swrow">' + bar('', 'sk-sw') + bar('84px') + '</span></div>';
    }
    /* the category chips (All, Guitars, Amplifiers ...) */
    function rentCats() {
        return many(6, function (i) { return bar(['46px', '84px', '88px', '92px', '70px', '82px'][i], 'sk-tabpill'); });
    }
    /* the whole Rental summary card: title, how-will-you-use-it switch, booking picker, empty cart box, total, checkout button.
       It is put inside the real card (which is hidden meanwhile), so the card keeps its own size and position. */
    function rentSummary() {
        return '<div class="sk-in" role="status" aria-label="Loading rental summary">' + SR
            + bar('46%', 'sk-h2') + '<i class="sk-hr" aria-hidden="true"></i>'
            + bar('38%')
            + bar('100%', 'sk-seg')
            + bar('34%')
            + bar('100%', 'sk-field')
            + bar('100%', 'sk-cartbox')
            + '<div class="sk-row sk-tot">' + bar('16%', 'sk-h') + bar('12%', 'sk-h') + '</div>'
            + bar('100%', 'sk-cta')
            + '</div>';
    }

    var PLAN = [
        // admin
        ['#ovk', function () { return many(4, ovKpi); }],
        ['#bars', function () { return many(7, barCols); }],
        ['#rkpi', function () { return many(3, ovRet); }],
        ['#ost', function () { return many(4, ovStudio); }],      // four studio tiles (the real list is drawn from the studios table)
        ['#ovl', function () { return many(8, ovRow); }],         // Needs attention always has 8 rows
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
        ['#mybk', function () { return many(3, panel); }],
        ['#myrent', function () { return many(3, panel); }],
        ['#c-rent #eq-toolbar', rentTools, true],            // the search box + "In stock only" switch (third item: quiet)
        ['#c-rent #eq-cats', rentCats, true],                // the category chips
        // My account page (the profile forms are drawn by js/account/profilePanel.js)
        ['#account-profile', accountPanel],
        // home page
        ['#studio-grid', function () { return many(4, card); }],
        ['#equipment-grid', function () { return many(4, card); }],
        ['#slider', function () { return slide(0); }],        // the big showcase slide (the Home "hero" picture)
        ['#sdots', dots, true],                               // third item: quiet, no message of its own when loading fails
        // Contact Us: the three info lists (filled by js/home/contact.js)
        ['#ct-touch', function () { return many(2, ctRow); }],
        ['#ct-follow', function () { return many(2, ctRow); }],
        ['#ct-visit', function () { return many(3, ctRow); }]
    ];

    /* the Overview shows today's date at once (admin/overview.js writes the same text later) */
    var ovSub = document.querySelector('#a-over .sub');
    if (ovSub)
        ovSub.textContent = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) + '. Here is what is happening right now.';

    var found = [], quiet = [];
    PLAN.forEach(function (p) {
        var el = document.querySelector(p[0]);
        if (el && !el.firstElementChild) {   // only an empty container: never touch anything already drawn
            el.innerHTML = p[1]();
            (p[2] ? quiet : found).push(el);
        }
    });

    /* ---- Rent tab: the Rental summary card shows a placeholder until the equipment list has been drawn ---- */
    var rsum = document.querySelector('#c-rent .rsum-card'), eqBox = document.getElementById('eq');
    function releaseSummary() {
        if (!rsum)
            return;
        var ph = rsum.querySelector(':scope > .sk-in');
        if (ph)
            ph.remove();
        rsum.classList.remove('sk-hold');
        rsum.removeAttribute('aria-busy');
    }
    if (rsum && eqBox && eqBox.firstElementChild && eqBox.firstElementChild.classList.contains('sk')) {
        rsum.classList.add('sk-hold');   // css/skeleton-extra.css hides the real card content while this is set
        rsum.setAttribute('aria-busy', 'true');
        rsum.insertAdjacentHTML('afterbegin', rentSummary());
        new MutationObserver(function (_, mo) {
            if (eqBox.firstElementChild && !eqBox.querySelector('.sk')) {   // the real cards (or the failure message) replaced the placeholders
                releaseSummary();
                mo.disconnect();
            }
        }).observe(eqBox, { childList: true });
    }

    /* ---- Contact Us map: shimmer over the frame until the map iframe has loaded (js/home/contact.js removes it) ---- */
    var ctMap = document.getElementById('ct-map');
    if (ctMap && !ctMap.firstElementChild) {
        ctMap.classList.add('sk-map');
        ctMap.setAttribute('aria-busy', 'true');
        setTimeout(function () {   // safety: never shimmer forever
            ctMap.classList.remove('sk-map');
            ctMap.removeAttribute('aria-busy');
        }, 25000);
    }

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
            if (el.isConnected && el.firstElementChild && (el.firstElementChild.classList.contains('sk-b') || el.firstElementChild.classList.contains('sk-q')))
                el.innerHTML = '';
        });
        releaseSummary();
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

    window.todSkeleton = { fail: fail, avail: avail, account: accountPanel };
    if (found.length)
        setTimeout(fail, 25000);
})();