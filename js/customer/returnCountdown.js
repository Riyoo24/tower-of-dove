/* =====================================================================
   customer/returnCountdown.js - live "Return in 2h 15m" under the Return time
   of an outside rental that is in use (My rental tab).
   ---------------------------------------------------------------------
   Hover (or focus, or tap) the badge to open a small card with the return time, when late fees start and the rate.
   Three stages, each with its own colour (the same badge colours as the rest of the page):
   1. before the return time you chose      blue, amber in the last hour, red in the last 15 minutes
   2. return time passed, 8-hour window left  amber: "Late fee starts in ..."
   3. after the full window                   red: "Overdue by ..." with the late fee so far
   The price covers up to 8 hours, so a late fee only starts after the full window (the rental's due time),
   even when the chosen return time was earlier. Same rule and same maths as the rental receipt and the reminders.
   The text refreshes every 30 seconds without redrawing the table (an open Actions menu stays open).
   ===================================================================== */

import { everyVisible, esc, peso } from '../shared/utils.js';

const MIN = 60 * 1000, HOUR = 60 * MIN;

/* 95 minutes -> "1h 35m", 2 hours -> "2h", 50 hours -> "2d 2h" */
function span(ms) {
    const total = Math.max(1, Math.ceil(ms / MIN));
    const d = Math.floor(total / 1440), h = Math.floor(total % 1440 / 60), m = total % 60;
    if (d)
        return `${d}d${h ? ` ${h}h` : ''}`;
    if (h)
        return `${h}h${m ? ` ${m}m` : ''}`;
    return `${m}m`;
}

const clock = ms => new Date(ms).toLocaleString('en-PH', {
    timeZone: 'Asia/Manila',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
});

/* What to show for the given moment: the badge (cls + label) and the rows of the hover card. */
function view(data, now) {
    const due = +data.due, perHour = +data.rate, charged = +data.late;
    const retAt = Math.min(+data.ret || due, due);
    const rate = `${peso(Math.round(perHour))} / hour`;
    const rows = [];
    if (now < retAt) {
        const left = retAt - now;
        if (retAt < due)
            rows.push(['Return time', clock(retAt)]);
        rows.push(['Late fees start', clock(due)], ['Late fee', rate]);
        return {
            cls: left <= 15 * MIN ? 'overdue' : left <= HOUR ? 'pending' : 'inuse',
            label: `Return in ${span(left)}`,
            title: 'Return reminder',
            rows,
            foot: 'The price covers up to 8 hours of use. Returning earlier does not lower it.'
        };
    }
    if (now < due) {
        rows.push(['Return time', 'Passed'], ['Late fees start', clock(due)], ['Late fee', rate]);
        return {
            cls: 'pending',
            label: `Late fee starts in ${span(due - now)}`,
            title: 'Return time passed',
            rows,
            foot: 'Bring the gear back before late fees start to avoid the charge.'
        };
    }
    const fee = charged + perHour * Math.ceil((now - due) / HOUR);
    rows.push(['Late fees started', clock(due)], ['Late fee so far', peso(Math.round(fee)), true], ['Rate', rate]);
    return {
        cls: 'overdue',
        label: `Overdue by ${span(now - due)}`,
        title: 'Rental overdue',
        rows,
        foot: 'Please return the gear now. Every started hour is charged.'
    };
}

const badge = (data, now) => {
    const v = view(data, now);
    return `<span class="b ${v.cls}">${v.label}</span>`;
};

/* HTML for the Status cell of one rental order ('' when there is nothing to count down). */
export function returnCountdownHtml(order) {
    if (!order || order.type !== 'out' || order.rawStatus !== 'Active')
        return '';
    const lines = order.lines.filter(l => !l.returnedAt && l.due);
    if (!lines.length)
        return '';
    const due = Date.parse(lines[0].due);
    if (!Number.isFinite(due))
        return '';
    const ret = lines[0].returnAt ? Date.parse(lines[0].returnAt) : 0;
    const data = {
        ret: Number.isFinite(ret) ? ret : 0,
        due,
        rate: lines.reduce((n, l) => n + l.qty * l.unit / 8, 0),   // one-eighth of the price for every late hour
        late: lines.reduce((n, l) => n + l.late, 0)                // late fees already charged
    };
    return `<span class="rcd" tabindex="0" role="timer" aria-live="off" data-ret="${data.ret}" data-due="${data.due}" data-rate="${esc(data.rate)}" data-late="${esc(data.late)}">${badge(data, Date.now())}</span>`;
}

/* ============================ hover card ============================ */

const CSS = `
.rcd{display:inline-block;cursor:help;border-radius:99px}
.rcd:focus-visible{outline:2px solid var(--focus,#FF6B78);outline-offset:3px}
.rcd-tip{position:fixed;z-index:1000;width:max-content;max-width:272px;padding:13px 15px 12px;background:var(--surface,#17171B);color:var(--ink,#F4F1EE);
  border:1px solid var(--line-strong,#5A5A66);border-radius:12px;box-shadow:0 16px 36px var(--shadow,#000000a6);font-size:12.5px;line-height:1.4;
  pointer-events:none;opacity:0;transform:translateY(4px);transition:opacity .14s ease,transform .14s ease}
.rcd-tip.below{transform:translateY(-4px)}
.rcd-tip.on{opacity:1;transform:none}
.rcd-tip::after{content:"";position:absolute;left:var(--ax,50%);bottom:-6px;width:10px;height:10px;background:var(--surface,#17171B);
  border:solid var(--line-strong,#5A5A66);border-width:0 1px 1px 0;transform:translateX(-50%) rotate(45deg)}
.rcd-tip.below::after{bottom:auto;top:-6px;border-width:1px 0 0 1px}
.rcd-tip.s-inuse{--c:var(--info,#8DB0FF)}
.rcd-tip.s-pending{--c:var(--warn,#F2A93B)}
.rcd-tip.s-overdue{--c:var(--bad,#FF7A85)}
.rcd-tip .tt{display:flex;align-items:center;gap:8px;margin-bottom:9px;font-weight:700;font-size:13px}
.rcd-tip .tt i{width:8px;height:8px;border-radius:50%;background:var(--c);box-shadow:0 0 0 3px color-mix(in srgb,var(--c) 22%,transparent);flex:none}
.rcd-tip dl{display:grid;grid-template-columns:auto 1fr;gap:5px 18px;margin:0}
.rcd-tip dt{color:var(--mut,#A3A1AD)}
.rcd-tip dd{margin:0;text-align:right;font-weight:600;white-space:nowrap}
.rcd-tip dd.bad{color:var(--bad,#FF7A85)}
.rcd-tip p{margin:10px 0 0;padding-top:9px;border-top:1px solid var(--line,#2E2E35);color:var(--mut,#A3A1AD);font-size:12px}
@media (prefers-reduced-motion:reduce){.rcd-tip{transition:none}}
`;

let tip = null, current = null, hideTimer = 0;

function ensureTip() {
    if (tip)
        return tip;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    tip = document.createElement('div');
    tip.className = 'rcd-tip';
    tip.id = 'rcd-tip';
    tip.setAttribute('role', 'tooltip');
    tip.hidden = true;
    document.body.appendChild(tip);
    return tip;
}

/* Fill the card for the badge and put it above the badge (below it when there is no room above). */
function paint(el) {
    const t = ensureTip(), v = view(el.dataset, Date.now());
    t.classList.remove('s-inuse', 's-pending', 's-overdue');
    t.classList.add('s-' + v.cls);
    t.innerHTML = `<div class="tt"><i></i>${esc(v.title)}</div>`
        + `<dl>${v.rows.map(([k, val, bad]) => `<dt>${esc(k)}</dt><dd${bad ? ' class="bad"' : ''}>${esc(val)}</dd>`).join('')}</dl>`
        + `<p>${esc(v.foot)}</p>`;
    t.hidden = false;
    const box = (el.querySelector('.b') || el).getBoundingClientRect();
    const w = t.offsetWidth, h = t.offsetHeight;
    const below = box.top - h - 12 < 8;
    const left = Math.min(Math.max(8, box.left + box.width / 2 - w / 2), window.innerWidth - w - 8);
    t.classList.toggle('below', below);
    t.style.top = (below ? box.bottom + 12 : box.top - h - 12) + 'px';
    t.style.left = left + 'px';
    t.style.setProperty('--ax', (box.left + box.width / 2 - left) + 'px');
}

function show(el) {
    clearTimeout(hideTimer);
    const wasOpen = current === el;
    current = el;
    paint(el);
    el.setAttribute('aria-describedby', 'rcd-tip');
    if (!wasOpen)
        requestAnimationFrame(() => tip && current && tip.classList.add('on'));
}

function hide() {
    if (!current)
        return;
    current.removeAttribute('aria-describedby');
    current = null;
    tip.classList.remove('on');
    hideTimer = setTimeout(() => {
        if (!current)
            tip.hidden = true;
    }, 170);
}

const badgeOf = node => node && node.closest ? node.closest('.rcd') : null;
const canHover = () => window.matchMedia('(hover: hover)').matches;

function wireHoverCard() {
    document.addEventListener('mouseover', e => {
        const el = badgeOf(e.target);
        if (el)
            show(el);
        else
            hide();
    });
    document.addEventListener('focusin', e => {
        const el = badgeOf(e.target);
        if (el)
            show(el);
    });
    document.addEventListener('focusout', e => {
        if (badgeOf(e.target))
            hide();
    });
    // phones and tablets have no hover: a tap opens the card, another tap (anywhere) closes it
    document.addEventListener('click', e => {
        if (canHover())
            return;
        const el = badgeOf(e.target);
        if (el && el !== current)
            show(el);
        else
            hide();
    });
    window.addEventListener('scroll', hide, { capture: true, passive: true });
    window.addEventListener('resize', hide);
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape')
            hide();
    });
}

function tick() {
    const now = Date.now();
    document.querySelectorAll('.rcd[data-due]').forEach(el => {
        el.innerHTML = badge(el.dataset, now);
    });
    if (current) {
        if (document.contains(current))
            paint(current);   // the open card keeps counting too
        else
            hide();           // the table was redrawn under it
    }
}

let started = false;

/* Call once. Keeps every countdown on the page up to date. */
export function startReturnCountdown() {
    if (started)
        return;
    started = true;
    wireHoverCard();
    everyVisible(tick, 30000);
}