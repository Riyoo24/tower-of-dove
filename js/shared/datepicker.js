/* =====================================================================
   shared/datepicker.js - date pickers that look and open like the dropdowns
   ---------------------------------------------------------------------
   A plain script (not an ES module), loaded with "defer" on every page
   that has a date field. It finds every <input type="date"> (also the ones
   the site builds later, such as the Reschedule window and the report
   dates) and puts a button in front of it that looks like a dropdown.
   Clicking the button opens a small calendar in the same style as the
   dropdown menus.

   The real <input type="date"> stays in the page, hidden. It is still the
   one source of truth, so the site's own code does not change at all:
     - input.value, input.min, input.max and input.disabled keep working,
       also when the site's code sets them (the button follows)
     - choosing a day sets input.value and fires "input" and "change"
   If the browser has no Popover API the native date field is left alone.
   Styles for this file are in css/motion.css ("DATE PICKERS").
   ===================================================================== */
(function () {
    'use strict';

    if (!('showPopover' in HTMLElement.prototype) || !window.MutationObserver)
        return;

    var VALUE = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    var MON_SHORT = MONTHS.map(function (m) { return m.slice(0, 3); });
    var WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
    var open = null;      // the picker that is open right now (only one at a time)
    var escAt = 0;        // when Esc last closed a picker (so it does not also close a window)
    var uid = 0;

    /* ----- date helpers: everything is a "YYYY-MM-DD" string, month is 0-11 ----- */
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    function iso(y, m, d) { return y + '-' + pad(m + 1) + '-' + pad(d); }
    function parse(s) {
        var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
        return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null;
    }
    function fromDate(dt) { return iso(dt.getFullYear(), dt.getMonth(), dt.getDate()); }
    function addDays(s, n) { var p = parse(s); return fromDate(new Date(p.y, p.m, p.d + n)); }
    function daysIn(y, m) { return new Date(y, m + 1, 0).getDate(); }
    function addMonths(s, n) {
        var p = parse(s), t = p.y * 12 + p.m + n, y = Math.floor(t / 12), m = t - y * 12;
        return iso(y, m, Math.min(p.d, daysIn(y, m)));
    }
    function long(s) {
        var p = parse(s);
        return new Date(p.y, p.m, p.d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    }
    function shortLabel(s) {
        var p = parse(s);
        return new Date(p.y, p.m, p.d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    }
    function today() {   // the site works in Manila time
        try {
            return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
        } catch (e) {
            return fromDate(new Date());
        }
    }

    function enhance(input) {
        if (input.__dp)
            return;
        input.__dp = true;

        var id = 'dp' + (++uid);
        var view = 'days', vy = 0, vm = 0, focus = '';

        /* ----- the button that looks like a dropdown ----- */
        var trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'dp-trigger';
        trigger.style.cssText = input.style.cssText;   // keeps inline widths such as max-width:170px
        trigger.setAttribute('aria-haspopup', 'dialog');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.setAttribute('aria-controls', id);
        var val = document.createElement('span');
        val.className = 'dp-val';
        trigger.appendChild(val);

        var lab = input.labels && input.labels[0];
        if (lab) {
            if (!lab.id)
                lab.id = id + '-l';
            trigger.setAttribute('aria-labelledby', lab.id + ' ' + id + '-v');
            val.id = id + '-v';
        }
        else if (input.getAttribute('aria-label'))
            trigger.setAttribute('aria-label', input.getAttribute('aria-label'));

        /* ----- the calendar (same look as the dropdown menu) ----- */
        var panel = document.createElement('div');
        panel.id = id;
        panel.className = 'dp-panel';
        panel.setAttribute('popover', 'manual');
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-label', 'Choose a date');
        panel.innerHTML =
            '<div class="dp-head">' +
            '<button type="button" class="dp-nav dp-prev" aria-label="Previous month"></button>' +
            '<button type="button" class="dp-title" aria-label="Choose month and year"></button>' +
            '<button type="button" class="dp-nav dp-next" aria-label="Next month"></button>' +
            '</div>' +
            '<div class="dp-body">' +
            '<div class="dp-days">' +
            '<div class="dp-wk" aria-hidden="true">' + WEEKDAYS.map(function (w) { return '<span>' + w + '</span>'; }).join('') + '</div>' +
            '<div class="dp-grid">' + new Array(43).join('<button type="button" class="dp-day" tabindex="-1"></button>') + '</div>' +
            '</div>' +
            '<div class="dp-months" hidden>' + MON_SHORT.map(function (m, i) { return '<button type="button" class="dp-mon" tabindex="-1" data-m="' + i + '">' + m + '</button>'; }).join('') + '</div>' +
            '</div>';

        var prev = panel.querySelector('.dp-prev'), next = panel.querySelector('.dp-next'), title = panel.querySelector('.dp-title');
        var days = panel.querySelector('.dp-days'), months = panel.querySelector('.dp-months');
        var cells = [].slice.call(panel.querySelectorAll('.dp-day'));
        var mons = [].slice.call(panel.querySelectorAll('.dp-mon'));

        input.classList.add('dp-native');
        input.tabIndex = -1;
        input.setAttribute('aria-hidden', 'true');
        input.after(trigger, panel);   // panel sits next to the field, so it also works inside a modal window

        /* ----- range ----- */
        function min() { return parse(input.min) ? input.min : ''; }
        function max() { return parse(input.max) ? input.max : ''; }
        function ok(s) { return (!min() || s >= min()) && (!max() || s <= max()); }
        function clamp(s) { return min() && s < min() ? min() : max() && s > max() ? max() : s; }

        /* ----- the button text ----- */
        function sync() {
            var v = VALUE.get.call(input);
            if (parse(v)) {
                val.textContent = (input.hasAttribute('data-today-label') && v === today()) ? 'Today, ' + shortLabel(v) : shortLabel(v);
                trigger.classList.remove('empty');
            }
            else {
                val.textContent = 'Select date';
                trigger.classList.add('empty');
            }
            trigger.disabled = input.disabled;
            if (open === api)
                render();
        }

        /* ----- drawing the calendar (the 42 day buttons are reused, never rebuilt) ----- */
        function render() {
            var sel = VALUE.get.call(input), t = today(), lo = min(), hi = max();
            days.hidden = view !== 'days';
            months.hidden = view !== 'months';
            if (view === 'days') {
                title.textContent = MONTHS[vm] + ' ' + vy;
                prev.setAttribute('aria-label', 'Previous month');
                next.setAttribute('aria-label', 'Next month');
                prev.disabled = !!lo && iso(vy, vm, 1) <= lo;
                next.disabled = !!hi && iso(vy, vm, daysIn(vy, vm)) >= hi;
                var start = new Date(vy, vm, 1 - new Date(vy, vm, 1).getDay());   // the Sunday on or before the 1st
                cells.forEach(function (c, i) {
                    var s = fromDate(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
                    c.textContent = +s.slice(8);
                    c.dataset.d = s;
                    c.setAttribute('aria-label', long(s));
                    c.classList.toggle('out', parseInt(s.slice(5, 7), 10) - 1 !== vm);
                    c.classList.toggle('today', s === t);
                    c.classList.toggle('on', s === sel);
                    c.setAttribute('aria-pressed', s === sel ? 'true' : 'false');
                    c.setAttribute('aria-disabled', ok(s) ? 'false' : 'true');
                    if (s === t)
                        c.setAttribute('aria-current', 'date');
                    else
                        c.removeAttribute('aria-current');
                    c.tabIndex = s === focus ? 0 : -1;
                });
            }
            else {
                var sp = parse(sel);
                title.textContent = vy;
                prev.setAttribute('aria-label', 'Previous year');
                next.setAttribute('aria-label', 'Next year');
                prev.disabled = !!lo && vy <= +lo.slice(0, 4);
                next.disabled = !!hi && vy >= +hi.slice(0, 4);
                mons.forEach(function (b, i) {
                    var first = iso(vy, i, 1), last = iso(vy, i, daysIn(vy, i));
                    b.classList.toggle('on', !!sp && sp.y === vy && sp.m === i);
                    b.classList.toggle('today', parse(t).y === vy && parse(t).m === i);
                    b.setAttribute('aria-disabled', (lo && last < lo) || (hi && first > hi) ? 'true' : 'false');
                    b.tabIndex = i === vm ? 0 : -1;
                });
            }
        }

        function focusCell() {
            var el = view === 'days'
                ? cells.filter(function (c) { return c.dataset.d === focus; })[0]
                : mons[vm];
            if (el)
                el.focus({ preventScroll: true });
        }

        /* ----- opening, closing, placing ----- */
        function place() {
            var r = trigger.getBoundingClientRect(), vw = document.documentElement.clientWidth, vh = window.innerHeight;
            var w = Math.min(Math.max(r.width, 288), 340, vw - 16);
            panel.style.width = w + 'px';
            var h = panel.offsetHeight;
            var left = Math.max(8, Math.min(r.left, vw - w - 8));
            var top = r.bottom + 6, up = false;
            if (top + h > vh - 8 && r.top - 6 - h >= 8) {
                top = r.top - 6 - h;
                up = true;
            }
            else
                top = Math.max(8, Math.min(top, vh - h - 8));
            panel.style.left = left + 'px';
            panel.style.top = top + 'px';
            panel.classList.toggle('dp-up', up);
        }

        function openIt() {
            if (input.disabled)
                return;
            if (open && open !== api)
                open.close();
            var base = parse(VALUE.get.call(input)) ? VALUE.get.call(input) : clamp(today());
            focus = clamp(base);
            var p = parse(focus);
            vy = p.y;
            vm = p.m;
            view = 'days';
            render();
            panel.showPopover();
            place();
            trigger.setAttribute('aria-expanded', 'true');
            open = api;
            focusCell();
        }

        function closeIt(back) {
            if (open !== api)
                return;
            open = null;
            trigger.setAttribute('aria-expanded', 'false');
            if (panel.matches(':popover-open'))
                panel.hidePopover();
            if (back)
                trigger.focus({ preventScroll: true });
        }

        function pick(s) {
            if (!ok(s))
                return;
            var changed = VALUE.get.call(input) !== s;
            VALUE.set.call(input, s);
            sync();
            closeIt(true);
            if (changed) {   // same events as the native field, so the site's own listeners run
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }

        /* ----- moving around ----- */
        function setFocus(s, keepView) {
            focus = clamp(s);
            var p = parse(focus);
            if (view === 'days' && (p.y !== vy || p.m !== vm)) {
                vy = p.y;
                vm = p.m;
            }
            if (keepView)
                view = 'days';
            render();
            focusCell();
        }

        function shiftView(n) {
            if (view === 'days') {
                var t = vy * 12 + vm + n;
                vy = Math.floor(t / 12);
                vm = t - vy * 12;
                // keep the keyboard focus inside the month that is shown
                focus = clamp(iso(vy, vm, Math.min(parse(focus).d, daysIn(vy, vm))));
            }
            else
                vy += n;
            render();
        }

        /* ----- events: button ----- */
        trigger.addEventListener('click', function () {
            if (open === api)
                closeIt(false);
            else
                openIt();
        });
        trigger.addEventListener('keydown', function (e) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                openIt();
            }
        });

        /* a click on the field's label focuses the button (what a label does for a date field) */
        [].forEach.call(input.labels || [], function (l) {
            l.addEventListener('click', function (e) {
                e.preventDefault();
                trigger.focus();
            });
        });
        input.focus = function () { trigger.focus.apply(trigger, arguments); };

        /* ----- events: calendar ----- */
        prev.addEventListener('click', function () { shiftView(-1); });
        next.addEventListener('click', function () { shiftView(1); });
        title.addEventListener('click', function () {
            if (view === 'days')
                view = 'months';
            else {
                view = 'days';
                focus = clamp(iso(vy, vm, Math.min(parse(focus).d, daysIn(vy, vm))));
                var p = parse(focus);
                vy = p.y;
                vm = p.m;
            }
            render();
            focusCell();
        });
        panel.addEventListener('click', function (e) {
            var d = e.target.closest('.dp-day'), m = e.target.closest('.dp-mon');
            if (d)
                pick(d.dataset.d);
            else if (m && m.getAttribute('aria-disabled') !== 'true') {
                vm = +m.dataset.m;
                view = 'days';
                focus = clamp(iso(vy, vm, Math.min(parse(focus).d, daysIn(vy, vm))));
                var p = parse(focus);
                vy = p.y;
                vm = p.m;
                render();
                focusCell();
            }
        });
        panel.addEventListener('keydown', function (e) {
            var k = e.key;
            if (k === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                escAt = Date.now();
                closeIt(true);
                return;
            }
            if (k === 'Tab') {      // Tab moves through the calendar; leaving either end closes it and carries on from the button
                var tabs = [].filter.call(panel.querySelectorAll('button'), function (b) {
                    return !b.disabled && b.tabIndex >= 0 && !b.closest('[hidden]');
                });
                if ((!e.shiftKey && e.target === tabs[tabs.length - 1]) || (e.shiftKey && e.target === tabs[0]))
                    closeIt(true);
                return;
            }
            if (e.target.closest('.dp-head'))
                return;
            var cur = parse(focus), step = 0;
            if (view === 'days' && e.target.closest('.dp-day')) {
                if (k === 'ArrowLeft') step = -1;
                else if (k === 'ArrowRight') step = 1;
                else if (k === 'ArrowUp') step = -7;
                else if (k === 'ArrowDown') step = 7;
                else if (k === 'Home') step = -new Date(cur.y, cur.m, cur.d).getDay();
                else if (k === 'End') step = 6 - new Date(cur.y, cur.m, cur.d).getDay();
                if (step || k === 'Home' || k === 'End') {
                    e.preventDefault();
                    setFocus(addDays(focus, step));
                }
                else if (k === 'PageUp' || k === 'PageDown') {
                    e.preventDefault();
                    setFocus(addMonths(focus, (k === 'PageUp' ? -1 : 1) * (e.shiftKey ? 12 : 1)));
                }
            }
            else if (view === 'months' && e.target.closest('.dp-mon')) {
                if (k === 'ArrowLeft') step = -1;
                else if (k === 'ArrowRight') step = 1;
                else if (k === 'ArrowUp') step = -3;
                else if (k === 'ArrowDown') step = 3;
                if (step) {
                    e.preventDefault();
                    vm = Math.max(0, Math.min(11, vm + step));
                    render();
                    focusCell();
                }
            }
        });

        /* ----- the site's own code changes the field: keep the button in step ----- */
        Object.defineProperty(input, 'value', {
            configurable: true,
            get: function () { return VALUE.get.call(this); },
            set: function (v) {
                VALUE.set.call(this, v);
                sync();
            }
        });
        new MutationObserver(sync).observe(input, { attributes: true, attributeFilter: ['value', 'min', 'max', 'disabled'] });

        var api = { close: closeIt, place: place, owns: function (n) { return trigger.contains(n) || panel.contains(n); } };
        sync();
    }

    /* ----- one set of page-wide listeners ----- */
    document.addEventListener('pointerdown', function (e) {
        if (open && !open.owns(e.target))
            open.close(false);
    }, true);
    window.addEventListener('resize', function () { if (open) open.place(); });
    document.addEventListener('scroll', function () { if (open) open.place(); }, true);
    // a window (dialog) closing for any reason also closes its calendar
    document.addEventListener('close', function () { if (open) open.close(false); }, true);
    // Esc that just closed a calendar must not also close the window behind it
    document.addEventListener('cancel', function (e) {
        if (Date.now() - escAt < 200)
            e.preventDefault();
    }, true);

    /* ----- find the date fields: the ones on the page now and the ones added later ----- */
    function scan(node) {
        if (!node || node.nodeType !== 1)
            return;
        if (node.matches && node.matches('input[type="date"]'))
            enhance(node);
        if (node.querySelectorAll)
            [].forEach.call(node.querySelectorAll('input[type="date"]'), enhance);
    }

    function start() {
        scan(document.body);
        new MutationObserver(function (list) {
            list.forEach(function (r) { [].forEach.call(r.addedNodes, scan); });
        }).observe(document.body, { childList: true, subtree: true });
    }

    if (document.body)
        start();
    else
        document.addEventListener('DOMContentLoaded', start);
})();
