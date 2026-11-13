/* =====================================================================
   shared/motion.js - scroll reveals and the scroll progress bar
   ---------------------------------------------------------------------
   A plain script (not an ES module) that only adds CSS classes. It never
   reads or changes the site's data, handlers, forms or text, and the site
   behaves the same if this file fails to load or the visitor prefers
   reduced motion (then nothing is hidden or animated).

   What it does
     1) Adds html.motion, which switches on the scroll-reveal styles in
        css/motion.css.
     2) Fades and lifts sections and cards in as they scroll into view.
        Cards in one grid arrive one after another (a small stagger).
        A grid that has already been revealed is not animated again when
        the page re-renders it (filters, tabs, polling), so nothing flickers.
     3) Plays an animation when a closed group ("Past and closed" etc.) in
        a table is opened (rows drop in one after another) or closed (the
        table box eases down to its short height while the old rows fade
        out). It only watches the click and the rows that appear or vanish;
        on closing it shows a harmless, non-clickable picture of the old
        rows inside the shrinking box and then deletes it. The toggle logic
        is still entirely the site's own.
     4) Moves a soft light under the mouse on browsable cards (it only sets
        two CSS variables, --mx and --my, on the card being hovered).
     5) Draws a thin progress bar at the top of the window while scrolling.
   ===================================================================== */
(function () {
    'use strict';

    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !('IntersectionObserver' in window))
        return;

    // elements that fade in when first scrolled to
    var TARGETS = [
        '.sec > h2', '.sec > .sub', '.ct-card', '.foot',
        '#studio-grid > *', '#equipment-grid > *', '#cs > *', '#eq > *', '#ovk > *',
        '.login'
    ].join(',');
    // elements whose siblings arrive as a staggered group
    var GROUPS = '#studio-grid, #equipment-grid, #cs, #eq, #ovk';

    var STEP = 70, MAX_STEPS = 6;
    var root = document.documentElement;

    var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
            if (!entry.isIntersecting)
                return;
            var el = entry.target;
            io.unobserve(el);
            if (el.parentElement && el.parentElement.matches(GROUPS))
                el.parentElement.setAttribute('data-mv-seen', '');
            el.classList.add('mv-in');
            // after the reveal, give transitions back to the element's own hover styles
            setTimeout(function () {
                el.classList.add('mv-done');
                el.style.removeProperty('--mv-d');
            }, 900 + MAX_STEPS * STEP);
        });
    }, { threshold: 0.12, rootMargin: '0px 0px -4% 0px' });

    function prepare(el, index) {
        if (el.__mv || el.classList.contains('sk'))
            return;   // placeholders (shared/skeleton.js) show at once; the real cards that replace them get the reveal
        el.__mv = true;
        var parent = el.parentElement;
        // a grid that was already shown: new or re-rendered cards appear normally
        if (parent && parent.matches(GROUPS) && parent.hasAttribute('data-mv-seen'))
            return;
        el.classList.add('mv');
        el.style.setProperty('--mv-d', Math.min(index, MAX_STEPS) * STEP + 'ms');
        io.observe(el);
    }

    function scan(node) {
        if (!node || node.nodeType !== 1)
            return;
        var list = [];
        if (node.matches && node.matches(TARGETS))
            list.push(node);
        if (node.querySelectorAll)
            Array.prototype.push.apply(list, node.querySelectorAll(TARGETS));
        list.forEach(function (el) {
            var siblings = el.parentElement ? Array.prototype.indexOf.call(el.parentElement.children, el) : 0;
            prepare(el, el.parentElement && el.parentElement.matches(GROUPS) ? siblings : 0);
        });
    }

    // ---- opening a closed table group ----
    var pending = null;   // { key, t } set when a closed group's button is clicked

    function playOpen() {
        var key = pending.key;
        pending = null;
        var btns = document.querySelectorAll('.grp-btn[data-toggle="' + key + '"][aria-expanded="true"]');
        Array.prototype.forEach.call(btns, function (btn) {
            var chev = btn.querySelector('.grp-chev');
            if (chev)
                chev.classList.add('chev-in');
            var row = btn.closest('tr');
            var i = 0;
            for (row = row && row.nextElementSibling; row && !row.classList.contains('grp-row'); row = row.nextElementSibling) {
                row.classList.add('row-in');
                row.style.setProperty('--ri-d', Math.min(i++, 12) * 35 + 'ms');
            }
        });
    }

    // ---- closing an open table group ----
    // The open group lives in a box (.tw) that has a height limit and scrolls inside itself. When the group
    // closes the site re-renders the table, so the limit disappears and the box would snap to its short height.
    // Instead the box keeps its OLD height and eases down to the new one, while a non-clickable picture of the
    // old rows (a copy taken before the re-render) fades away inside it. The cost does not depend on how many
    // rows the group had, and the page below the table moves smoothly instead of jumping.
    var closing = null;   // { key, index, t, h0, scroll, copy } set when an open group's button is clicked

    // the colour behind a box (the first ancestor that is not transparent), so the picture of the old rows blends in
    function backdrop(el) {
        for (var n = el.parentElement; n; n = n.parentElement) {
            var bg = getComputedStyle(n).backgroundColor;
            if (bg && bg !== 'transparent' && !/,\s*0\)$/.test(bg))
                return bg;
        }
        return '';
    }

    function playClose() {
        var c = closing;
        closing = null;
        var btn = document.querySelectorAll('.grp-btn[data-toggle="' + c.key + '"]')[c.index];
        if (!btn || btn.getAttribute('aria-expanded') !== 'false')
            return;
        var box = btn.closest('.tw');
        if (!box)
            return;
        if (box.__clDone)
            box.__clDone();
        var h1 = box.getBoundingClientRect().height;   // height of the closed table
        if (c.h0 - h1 < 8)
            return;
        var chev = btn.querySelector('.grp-chev');
        if (chev)
            chev.classList.add('chev-out');
        var dur = Math.round(Math.min(560, Math.max(320, 260 + (c.h0 - h1) * 0.5)));   // a taller table takes a little longer
        var ghost = document.createElement('div');
        ghost.className = 'tw-ghost';
        ghost.setAttribute('aria-hidden', 'true');
        if ('inert' in ghost)
            ghost.inert = true;
        ghost.style.backgroundColor = backdrop(box);
        ghost.appendChild(c.copy);
        box.style.setProperty('--cl-dur', dur + 'ms');
        box.style.height = c.h0 + 'px';
        box.classList.add('tw-closing');
        box.appendChild(ghost);
        c.copy.scrollTop = c.scroll;                   // show the old rows exactly where the person had scrolled to
        void box.offsetHeight;                         // start from the old height, then ease to the new one
        box.style.transition = 'height ' + dur + 'ms cubic-bezier(.4, 0, .2, 1)';
        box.style.height = h1 + 'px';
        box.classList.add('tw-go');
        var timer = setTimeout(done, dur + 80);
        function done() {
            clearTimeout(timer);
            box.__clDone = null;
            if (ghost.parentNode)
                ghost.parentNode.removeChild(ghost);
            box.classList.remove('tw-closing', 'tw-go');
            box.style.removeProperty('height');
            box.style.removeProperty('transition');
            box.style.removeProperty('--cl-dur');
        }
        box.__clDone = done;
    }

    // capture phase: runs before the site's own click handler re-renders the table
    document.addEventListener('click', function (e) {
        var btn = e.target.closest && e.target.closest('.grp-btn[data-toggle]');
        if (!btn)
            return;
        var key = btn.getAttribute('data-toggle');
        var box = btn.closest('.tw');
        if (box && box.__clDone)
            box.__clDone();                            // a click during a running close: finish it first
        if (btn.getAttribute('aria-expanded') === 'false') {
            pending = { key: key, t: Date.now() };
            return;
        }
        // closing: keep the box's height and scroll position, and a copy of it (the copy is only a picture)
        if (!box)
            return;
        var copy = box.cloneNode(true);
        copy.removeAttribute('id');
        Array.prototype.forEach.call(copy.querySelectorAll('[id]'), function (n) { n.removeAttribute('id'); });
        Array.prototype.forEach.call(copy.querySelectorAll('.row-in'), function (n) { n.classList.remove('row-in'); });
        Array.prototype.forEach.call(copy.querySelectorAll('.chev-in'), function (n) { n.classList.remove('chev-in'); });
        var all = document.querySelectorAll('.grp-btn[data-toggle="' + key + '"]');
        closing = {
            key: key,
            index: Array.prototype.indexOf.call(all, btn),
            t: Date.now(),
            h0: box.getBoundingClientRect().height,
            scroll: box.scrollTop,
            copy: copy
        };
    }, true);

    // ---- cursor spotlight on cards (mouse devices only) ----
    if (window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
        var SPOT = '#studio-grid > .card, #equipment-grid > .card, #cs > .card, #eq > .card, .card.go';
        var spotEl = null, spotX = 0, spotY = 0, spotQueued = false;
        document.addEventListener('mousemove', function (e) {
            var card = e.target.closest && e.target.closest(SPOT);
            if (!card)
                return;
            spotEl = card;
            spotX = e.clientX;
            spotY = e.clientY;
            if (spotQueued)
                return;
            spotQueued = true;
            requestAnimationFrame(function () {
                spotQueued = false;
                var r = spotEl.getBoundingClientRect();
                spotEl.style.setProperty('--mx', (spotX - r.left) + 'px');
                spotEl.style.setProperty('--my', (spotY - r.top) + 'px');
            });
        }, { passive: true });
    }

    function start() {
        root.classList.add('motion');
        scan(document.body);
        new MutationObserver(function (records) {
            records.forEach(function (r) {
                r.addedNodes.forEach(scan);
            });
            if (pending) {
                if (Date.now() - pending.t < 800)
                    playOpen();
                else
                    pending = null;
            }
            if (closing) {
                if (Date.now() - closing.t < 800)
                    playClose();
                else
                    closing = null;
            }
        }).observe(document.body, { childList: true, subtree: true });

        // scroll progress bar (a fixed, click-through strip; nothing else uses it)
        var bar = document.createElement('div');
        bar.className = 'scroll-bar';
        bar.setAttribute('aria-hidden', 'true');
        document.body.appendChild(bar);
        var ticking = false;
        function paint() {
            ticking = false;
            var max = root.scrollHeight - window.innerHeight;
            bar.style.transform = 'scaleX(' + (max > 0 ? Math.min(1, window.scrollY / max) : 0) + ')';
        }
        window.addEventListener('scroll', function () {
            if (!ticking) {
                ticking = true;
                requestAnimationFrame(paint);
            }
        }, { passive: true });
        window.addEventListener('resize', paint, { passive: true });
        paint();
    }

    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', start);
    else
        start();
})();
