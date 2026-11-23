/* =====================================================================
   admin/overviewMotion.js - animations for the Overview tab
   ---------------------------------------------------------------------
   Called at the end of renderOverview() (admin/overview.js). It only adds
   CSS classes and counts the numbers up; it never changes what the Overview
   shows or which data it reads. The styles live in css/overview-motion.css.

   - The first render with real data (the grey loading shapes have just been
     replaced): the intro plays once (class .ov-play for a moment) and the
     numbers count up from 0. If the Overview is not the tab on screen yet,
     the intro waits until it is opened.
   - Silent refreshes (polling): the entrance does not replay. A number that
     changed counts from its old value to the new one and its card flashes once.
   - Overdue rentals > 0: the Overdue card gets .ov-alert (a steady red edge).
   - Does nothing for visitors who prefer reduced motion.
   ===================================================================== */

const REDUCE = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const NUMS = '#ovk .num, #rkpi .num';
const INTRO_MS = 1400;

let prev = null;       // the numbers shown after the last render
let waiting = false;   // intro still to play when the tab is opened
let timer = 0;

const isInt = t => /^\d+$/.test(t);

function countUp(el, from, to, ms) {
    cancelAnimationFrame(el.__cu);
    const t0 = performance.now();
    const step = t => {
        const p = Math.min(1, (t - t0) / ms);
        el.textContent = String(Math.round(from + (to - from) * (1 - Math.pow(1 - p, 3))));
        if (p < 1)
            el.__cu = requestAnimationFrame(step);
    };
    el.__cu = requestAnimationFrame(step);
}

function intro(page) {
    page.classList.add('ov-play');
    page.querySelectorAll(NUMS).forEach(el => {
        const t = el.textContent.trim();
        if (isInt(t) && +t > 0)
            countUp(el, 0, +t, 700);
    });
    clearTimeout(timer);
    timer = setTimeout(() => page.classList.remove('ov-play'), INTRO_MS);
}

export function playOverview() {
    const page = document.getElementById('a-over');
    if (!page)
        return;
    const nums = [...page.querySelectorAll(NUMS)];
    const now = nums.map(el => el.textContent.trim());

    const od = page.querySelector('#rkpi .kpi');   // the first card is "Overdue rentals"
    if (od)
        od.classList.toggle('ov-alert', isInt(now[4] ?? '') && +now[4] > 0);

    if (!REDUCE) {
        if (prev === null) {
            if (page.classList.contains('on'))
                intro(page);
            else if (!waiting) {   // opened on another tab: play the intro when the Overview is shown
                waiting = true;
                const mo = new MutationObserver(() => {
                    if (!page.classList.contains('on'))
                        return;
                    mo.disconnect();
                    waiting = false;
                    intro(page);
                });
                mo.observe(page, { attributes: true, attributeFilter: ['class'] });
            }
        } else if (!page.classList.contains('ov-play')) {
            nums.forEach((el, i) => {
                if (prev[i] === now[i])
                    return;
                if (isInt(prev[i] ?? '') && isInt(now[i]))
                    countUp(el, +prev[i], +now[i], 600);
                const card = el.closest('.card');
                if (card) {
                    card.classList.add('ov-flash');
                    card.addEventListener('animationend', () => card.classList.remove('ov-flash'), { once: true });
                }
            });
        }
    }
    prev = now;
}