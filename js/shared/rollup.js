/* =====================================================================
   shared/rollup.js - totals roll to their new value instead of jumping
   ---------------------------------------------------------------------
   A plain script, loaded on every page that shows money (customer page,
   admin dashboard). When the site rewrites a total, this script notices,
   puts the old amount back and counts to the new one, then restores the
   site's own markup. Every total uses the same timing and easing, so
   the booking modal, the extend modal, the checkout, the cart bar and the
   admin modals all move alike.

   - Works on any text that holds peso amounts, not just a lone figure:
     "₱1,200", "₱500 now, ₱700 at the studio (total ₱1,200)" and boxes that
     hold several amounts ("Pay now ₱500 / Balance ₱500") all roll. Only
     the amounts move; the words and <b> tags around them are never touched.
   - The roll only runs when the surrounding wording is unchanged (so only
     the numbers differ). Anything else is left to simply appear.
   - To make a new total roll, add its id to IDS or put data-roll on it.
   - The first value an element shows, and "—" placeholders, are not rolled.
   - Does nothing for visitors who prefer reduced motion.
   ===================================================================== */
(function () {
    'use strict';

    if (!window.matchMedia || window.matchMedia('(prefers-reduced-motion: reduce)').matches)
        return;

    var DUR = 500;   // one duration for every total, whatever the size of the change

    // elements the site fills with money (customer rent/booking/extend flows and admin modals)
    var IDS = [
        // cart, checkout, phone bar
        'ctt', 'co-total', 'co-foot-tot', 'co-foot-amt', 'co-due-amt', 'co-due-bal', 'rsum', 'rs-total', 'aq-amt', 'oq-amt',
        // booking modal
        'bk-st', 'bk-ao', 'bk-t', 'bk-dp', 'bk-foot-amt', 'bk-foot-tot', 'bk-bal', 'bk-bal2', 'bk-qa',
        // extend modal (customer and admin)
        'ex-cost', 'ex-tot', 'ex-dp', 'ex-foot-amt', 'ex-bal',
        // admin: on-site booking / outside rental received, return damage + late fee totals
        'ob-tot', 'or-tot', 'ret-dmg-tot', 'ret-pay-sum'
    ];
    var SEL = IDS.map(function (id) { return '#' + id; }).concat(['.ex-qa', '[data-roll]']).join(',');
    var AMT = /₱\s*(\d[\d,]*(?:\.\d+)?)/g;

    function key(text) {   // the wording with every amount blanked, so only the numbers can differ
        return (text || '').replace(AMT, '₱#');
    }

    function amounts(text) {
        var out = [], m;
        AMT.lastIndex = 0;
        while ((m = AMT.exec(text || '')))
            out.push(parseFloat(m[1].replace(/,/g, '')));
        return out;
    }

    function textNodes(el) {
        var list = [], w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null), n;
        while ((n = w.nextNode()))
            if (AMT.test(n.data)) {
                list.push({ node: n, orig: n.data });
                AMT.lastIndex = 0;
            }
        AMT.lastIndex = 0;
        return list;
    }

    function fmt(n, dec) {
        return '₱' + n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
    }

    // render one text node with the current (in-between) amounts, keeping each amount's own decimals
    function paint(item, vals, at) {
        item.node.data = item.orig.replace(AMT, function (all, num) {
            var dec = (num.split('.')[1] || '').length;
            return fmt(vals[at.i++], dec);
        });
    }

    function paintAll(run, vals) {
        var at = { i: 0 };
        run.items.forEach(function (it) { paint(it, vals, at); });
    }

    function stop(el) {
        var run = el.__ru;
        if (!run)
            return;
        cancelAnimationFrame(run.raf);
        clearTimeout(run.timer);
        el.__ru = null;
        el.classList.remove('ru-roll');
        run.items.forEach(function (it) {   // put the site's own text back
            if (it.node.data !== it.orig)
                it.node.data = it.orig;
        });
    }

    function roll(el, prevText) {
        var run0 = el.__ru;
        var items, to, from;
        if (run0) {                          // changed again mid-roll: restart from what is on screen
            from = run0.shown;
            stop(el);
        }
        items = textNodes(el);
        to = amounts(items.map(function (i) { return i.orig; }).join(''));
        if (!from)
            from = amounts(prevText);
        var finalKey = key(el.textContent);
        // roll when the amounts line up one for one (several amounts in one box must also keep the same wording)
        if (!to.length || from.length !== to.length || (!run0 && to.length > 1 && key(prevText) !== finalKey))
            return;
        if (from.every(function (v, i) { return v === to[i]; }))
            return;

        var run = { items: items, shown: from.slice(), raf: 0, timer: 0 };
        el.__ru = run;
        el.classList.add('ru-roll');
        paintAll(run, from);

        var t0 = performance.now();

        function frame(now) {
            if (el.__ru !== run)
                return;
            var p = Math.min(1, (now - t0) / DUR);
            if (p >= 1)
                return stop(el);
            var eased = 1 - Math.pow(1 - p, 3);
            run.shown = from.map(function (v, i) { return v + (to[i] - v) * eased; });
            paintAll(run, run.shown);
            run.raf = requestAnimationFrame(frame);
        }

        run.raf = requestAnimationFrame(frame);
        run.timer = setTimeout(function () { stop(el); }, DUR + 150);   // in case the tab was hidden and frames were paused
    }

    function start() {
        var mo = new MutationObserver(function (records) {
            var first = new Map();   // element -> the text it showed before this batch of changes
            records.forEach(function (r) {
                var el = r.target;
                if (el.nodeType !== 1 || !r.addedNodes.length || first.has(el) || !el.matches(SEL))
                    return;
                var prev = '';
                r.removedNodes.forEach(function (n) { prev += n.textContent; });
                first.set(el, prev);
            });
            first.forEach(function (prev, el) {
                roll(el, prev);
            });
        });
        mo.observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', start);
    else
        start();
})();
