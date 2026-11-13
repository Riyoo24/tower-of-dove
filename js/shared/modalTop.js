/* =====================================================================
   js/shared/modalTop.js - every modal (<dialog>) glides back to the top when it opens
   A plain script (no import) that wraps HTMLDialogElement.showModal() / show().
   After a dialog opens, the dialog and every scrolled box inside it (drawer body, lists, tables)
   scroll up to the top with a short ease-out animation (about 0.45 s). It runs again a moment later,
   because some windows move the focus to a button at the bottom right after opening, which makes the
   browser scroll down to it. The glide stops at once if the person scrolls, and it is instant when the
   device asks for reduced motion. Loaded in the <head> of every page. No database changes.
   ===================================================================== */
(function () {
    'use strict';
    if (typeof HTMLDialogElement === 'undefined')
        return;

    var DURATION = 450;   // ms
    var reduce = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    var running = new WeakMap();   // element -> { id, stop }

    function stop(el) {
        var r = running.get(el);
        if (!r)
            return;
        cancelAnimationFrame(r.id);
        el.removeEventListener('wheel', r.stop);
        el.removeEventListener('touchstart', r.stop);
        el.removeEventListener('keydown', r.stop);
        el.style.scrollBehavior = r.sb;
        running.delete(el);
    }

    function glide(el) {
        var from = el.scrollTop;
        if (from <= 0)
            return;
        stop(el);
        if (reduce && reduce.matches) {
            el.scrollTop = 0;
            return;
        }
        var start = null, r = { sb: el.style.scrollBehavior };
        r.stop = function () { stop(el); };
        el.style.scrollBehavior = 'auto';   // our own easing, not the browser's
        el.addEventListener('wheel', r.stop, { passive: true });
        el.addEventListener('touchstart', r.stop, { passive: true });
        el.addEventListener('keydown', r.stop);
        function step(t) {
            if (start === null)
                start = t;
            var p = Math.min(1, (t - start) / DURATION),
                e = 1 - Math.pow(1 - p, 3);   // ease-out cubic
            el.scrollTop = from * (1 - e);
            if (p < 1 && el.isConnected)
                r.id = requestAnimationFrame(step);
            else
                stop(el);
        }
        r.id = requestAnimationFrame(step);
        running.set(el, r);
    }

    function toTop(dlg) {
        if (!dlg || !dlg.isConnected || !dlg.open)
            return;
        glide(dlg);
        var boxes = dlg.querySelectorAll('*');
        for (var i = 0; i < boxes.length; i++)
            if (boxes[i].scrollTop > 0)
                glide(boxes[i]);
    }

    function wrap(name) {
        var orig = HTMLDialogElement.prototype[name];
        if (typeof orig !== 'function')
            return;
        HTMLDialogElement.prototype[name] = function () {
            var dlg = this, res = orig.apply(dlg, arguments);
            toTop(dlg);
            setTimeout(function () { toTop(dlg); }, 150);
            return res;
        };
    }

    wrap('showModal');
    wrap('show');
})();
