/* =====================================================================
   shared/flair.js - extra motion for the landing page (index.html)
   ---------------------------------------------------------------------
   A plain script that only adds decoration and CSS classes/variables.
   It never changes the site's data, handlers, forms or wording, and it
   does nothing at all when the visitor prefers reduced motion. Styles
   live in the "FLAIR PACK" block at the end of css/motion.css.

     2) Hero headline arrives word by word.
     3) Availability results: chips/rows get a stagger index (CSS animates).
     4) Studio cards tilt slightly toward the pointer.
     7) Gear marquee strip built from the equipment cards on the page.
   (5 and 6 are CSS only.)
   ===================================================================== */
(function () {
    'use strict';
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    var $ = function (s, r) { return (r || document).querySelector(s); };

    /* ---- 2: headline word by word ---- */
    function headline() {
        var h1 = $('.hero h1');
        if (!h1 || h1.classList.contains('split')) return;
        var text = h1.textContent.trim();
        if (!text) return;
        h1.setAttribute('aria-label', text);
        /* wrap every word in a span, keeping the markup that is already there (<br>, <span class="hl">) */
        var n = 0, walker = document.createTreeWalker(h1, NodeFilter.SHOW_TEXT), nodes = [];
        while (walker.nextNode()) nodes.push(walker.currentNode);
        nodes.forEach(function (node) {
            var frag = document.createDocumentFragment();
            node.nodeValue.split(/(\s+)/).forEach(function (part) {
                if (!part) return;
                if (/^\s+$/.test(part)) { frag.appendChild(document.createTextNode(' ')); return; }
                var s = document.createElement('span');
                s.className = 'w';
                s.setAttribute('aria-hidden', 'true');
                s.style.setProperty('--i', n++);
                s.textContent = part;
                frag.appendChild(s);
            });
            node.parentNode.replaceChild(frag, node);
        });
        h1.classList.add('split');
    }

    /* ---- 3: availability results ---- */
    function availability() {
        var box = $('#avail');
        if (!box) return;
        new MutationObserver(function () {
            var i = 0;
            Array.prototype.forEach.call(box.querySelectorAll('.chip'), function (c) {
                c.style.setProperty('--i', Math.min(i++, 14));
            });
        }).observe(box, { childList: true });
    }

    /* ---- 4: studio card tilt (mouse only) ---- */
    function tilt() {
        var grid = $('#studio-grid');
        if (!grid || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
        var MAX = 5, raf = 0, last = null;
        function clear(card) {
            card.classList.remove('tilting');
            card.style.removeProperty('--rx');
            card.style.removeProperty('--ry');
        }
        grid.addEventListener('pointermove', function (e) {
            var card = e.target.closest && e.target.closest('#studio-grid > .card');
            if (last && last !== card) clear(last);
            last = card;
            if (!card || raf) return;
            raf = requestAnimationFrame(function () {
                raf = 0;
                var r = card.getBoundingClientRect();
                var px = (e.clientX - r.left) / r.width - 0.5;
                var py = (e.clientY - r.top) / r.height - 0.5;
                card.style.setProperty('--ry', (px * MAX * 2).toFixed(2) + 'deg');
                card.style.setProperty('--rx', (-py * MAX * 2).toFixed(2) + 'deg');
                card.classList.add('tilting');
            });
        });
        grid.addEventListener('pointerleave', function () { if (last) clear(last); last = null; });
    }

    /* ---- 7: gear marquee, built from the equipment cards once they render ---- */
    function marquee() {
        var grid = $('#equipment-grid'), section = $('#equipment');
        if (!grid || !section || !section.parentNode) return;
        var strip = document.createElement('div');
        strip.className = 'gear-strip';
        strip.setAttribute('aria-hidden', 'true');
        strip.hidden = true;
        section.parentNode.insertBefore(strip, section);
        var key = '';

        function build() {
            var items = [];
            Array.prototype.forEach.call(grid.querySelectorAll(':scope > .card'), function (card) {
                var h = card.querySelector('h3');
                if (!h || !h.textContent.trim()) return;
                var img = card.querySelector('.eqimg img');
                items.push({ name: h.textContent.trim(), src: img ? img.getAttribute('src') : '' });
            });
            var k = items.map(function (x) { return x.name + '|' + x.src; }).join('~');
            if (k === key) return;
            key = k;
            strip.textContent = '';
            if (!items.length) { strip.hidden = true; return; }

            var half = items.slice();
            while (half.length < 8) half = half.concat(items);      // enough to fill a wide screen
            var track = document.createElement('div');
            track.className = 'gear-track';
            half.concat(half).forEach(function (x) {                // twice, so -50% loops seamlessly
                var el = document.createElement('span');
                el.className = 'gear-item';
                if (x.src) {
                    var im = document.createElement('img');
                    im.alt = '';
                    im.loading = 'lazy';
                    im.src = x.src;
                    el.appendChild(im);
                }
                el.appendChild(document.createTextNode(x.name));
                track.appendChild(el);
            });
            track.style.setProperty('--dur', Math.max(24, half.length * 4.5) + 's');
            strip.appendChild(track);
            strip.hidden = false;
        }
        new MutationObserver(build).observe(grid, { childList: true });
        build();
    }

    function start() {
        headline();
        availability();
        tilt();
        marquee();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
