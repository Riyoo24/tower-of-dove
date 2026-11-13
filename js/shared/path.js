/* =====================================================================
   shared/path.js - "How booking works" step cards (Home tab)
   ---------------------------------------------------------------------
   A plain script that only sets classes on the section in
   pages/customer.html; css/signal.css does the drawing.
   The first time the section scrolls into view, the steps light up one after
   the other while a red line travels between them, slowly (about three
   seconds), once. No text changes by itself, so nothing has to be read in a
   hurry. Visitors who prefer reduced motion get no animation (it is shown
   finished). It never touches the site's
   data, forms or handlers.
   ===================================================================== */
(function () {
    'use strict';

    var root = document.querySelector('.hx-how');
    if (!root)
        return;
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !('IntersectionObserver' in window))
        return;

    root.classList.add('hx-armed');   // hides the line until the section is seen
    var io = new IntersectionObserver(function (entries) {
        if (!entries[0].isIntersecting)
            return;
        io.disconnect();
        root.classList.add('is-seen');
    }, { threshold: 0.35 });
    io.observe(root);
})();
