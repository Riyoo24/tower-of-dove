/* shared/themeInit.js - the site is dark-only. Light theme has been removed. */
(function () {
    'use strict';
    document.documentElement.setAttribute('data-theme', 'dark');
    try { localStorage.removeItem('tod-theme'); } catch (e) { /* ignore */ }
    window.TODTheme = { toggle: function () {}, set: function () {}, get: function () { return 'dark'; }, refresh: function () {} };
})();
