/* =====================================================================
   shared/boot.js - starts a page's ES modules reliably
   The site is made of many small .js files. Over a tunnel (ngrok) or a busy dev server, a few of those requests
   can fail with 502 at the same moment, and then the whole page stays empty until a hard refresh.
   This script (a normal script, not a module) therefore
     1) reads the entry module and every module it imports, a few files at a time (so the server is not flooded),
     2) retries a file that failed (a short wait, up to 5 tries), which also puts it in the browser cache,
     3) only then starts the page with import(entry). If that still fails, the page reloads (up to 3 times in 2 minutes).
   If anything in step 1 goes wrong the page still starts normally. Usage:
     <script src="js/shared/boot.js" data-entry="js/home/index.js"></script>   (paths relative to the page)
   ===================================================================== */
(function () {
    var me = document.currentScript;
    var entry = new URL(me.getAttribute('data-entry'), location.href).href;
    var MAX_PARALLEL = 6, TRIES = 5, GIVE_UP_MS = 20000;
    var seen = {}, waiting = [], running = 0, finish, ready = new Promise(function (r) { finish = r; });
    // import 'x'  /  import a from 'x'  /  import { a,\n b } from 'x'  /  export { a } from 'x'   (relative paths only)
    var IMPORT = /(?:^|[\n;])\s*(?:import|export)\s*(?:[^'"()]*?\sfrom\s*)?['"]([^'"]+)['"]/g;

    function pause(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    function get(url, attempt) {
        return fetch(url).then(function (res) {
            if (!res.ok)
                throw new Error(res.status);
            return res.text();
        }).catch(function (err) {
            if (attempt >= TRIES)
                throw err;
            return pause(300 * attempt).then(function () { return get(url, attempt + 1); });
        });
    }

    function add(url) {
        if (seen[url])
            return;
        seen[url] = true;
        waiting.push(url);
        pump();
    }

    function pump() {
        while (running < MAX_PARALLEL && waiting.length) {
            (function (url) {
                running++;
                get(url, 1).then(function (text) {
                    var m;
                    IMPORT.lastIndex = 0;
                    while ((m = IMPORT.exec(text))) {
                        if (m[1].charAt(0) === '.' || m[1].charAt(0) === '/')
                            add(new URL(m[1], url).href);
                    }
                }).catch(function () { /* the real import below reports it */ }).then(function () {
                    running--;
                    if (!running && !waiting.length)
                        finish();
                    else
                        pump();
                });
            })(waiting.shift());
        }
    }

    function reloadOrGiveUp(err) {
        console.error('Page scripts failed to load:', err);
        var KEY = 'tod_boot_retry', t = [];
        try {
            t = JSON.parse(sessionStorage.getItem(KEY) || '[]').filter(function (x) { return Date.now() - x < 120000; });
            if (t.length >= 3)
                return;
            t.push(Date.now());
            sessionStorage.setItem(KEY, JSON.stringify(t));
        } catch (e) {
            return;
        }
        location.reload();
    }

    try {
        add(entry);
    } catch (e) {
        finish();
    }
    Promise.race([ready, pause(GIVE_UP_MS)]).then(function () {
        return import(entry);
    }).then(function () {
        try { sessionStorage.removeItem('tod_boot_retry'); } catch (e) { /* ignore */ }
    }).catch(reloadOrGiveUp);
})();
