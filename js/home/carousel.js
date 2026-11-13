/* =====================================================================
   home/carousel.js - studio showcase carousel on the landing page
   Slides, prev/next arrows, dots, a "01 / 05" counter and auto-advance
   (stopped on hover, focus, touch, or when the visitor prefers reduced motion).
   ===================================================================== */

import { $, descHTML, esc, peso, reducedMotion } from '../shared/utils.js';
import { goBook } from '../shared/navigation.js';
import { photo } from '../shared/cards.js';

/* Carousel slides. index.js fills in `img`, `sub` and `price` from the studio data (Supabase).
   `studio` (set by index.js) is the studio's position in STUDIOS, so the button opens the booking page on that studio.
   `scroll` makes the button jump to a section of the page instead of opening the booking page. */
export const SLIDES = [
    { label: 'Studio A', tag: 'Rehearsal room', sub: 'Pick a time and plug in.', price: 0, c1: '#C92C3E', c2: '#3D0C14', img: null, cta: 'Book this room' },
    { label: 'Studio B', tag: 'Rehearsal room', sub: 'Pick a time and plug in.', price: 0, c1: '#C98512', c2: '#33220A', img: null, cta: 'Book this room' },
    { label: 'Studio C', tag: 'Rehearsal room', sub: 'Pick a time and plug in.', price: 0, c1: '#8E161F', c2: '#1E0A0F', img: null, cta: 'Book this room' },
    { label: 'Studio D', tag: 'Rehearsal room', sub: 'Pick a time and plug in.', price: 0, c1: '#4A4A55', c2: '#16161A', img: null, cta: 'Book this room' },
    { label: 'Rental gear', tag: 'Equipment', sub: 'Add gear to a booking, or rent it to take outside the studio.', price: 0, c1: '#6E0F1C', c2: '#0B0B0D', img: null, cta: 'Browse gear', scroll: 'equipment' }
];

/* Placeholder art for rooms without a photo: a quiet equalizer. Heights are fixed per slide, so they never jump around. */
function equalizer(seed) {
    let x = seed * 9301 + 49297;
    const bars = [];
    for (let i = 0; i < 28; i++) {
        x = (x * 9301 + 49297) % 233280;
        const h = 18 + Math.round((x / 233280) * 72);
        bars.push(`<rect x="${i * 10 + 1}" y="${100 - h}" width="6" height="${h}" rx="3"/>`);
    }
    return `<svg class="slide-art" viewBox="0 0 280 100" preserveAspectRatio="none" aria-hidden="true">${bars.join('')}</svg>`;
}

function slideHTML(s, i) {
    const media = s.img
        ? photo(s.img, '', { width: 1200, height: 440, sizes: '(max-width: 900px) 100vw, 1120px', eager: i === 0 })
        : equalizer(i + 1);
    const action = s.scroll ? `data-scroll="${esc(s.scroll)}"`
        : s.studio !== undefined ? `data-book-studio="${s.studio}"` : 'data-route="book"';
    return `
    <article class="slide" role="group" aria-roledescription="slide" aria-label="${i + 1} of ${SLIDES.length}: ${esc(s.label)}" style="--c1:${s.c1};--c2:${s.c2}">
      ${media}
      <div class="slide-cap">
        <div class="slide-txt">
          <span class="slide-tag">${esc(s.tag)}</span>
          <h3>${esc(s.label)}</h3>
          ${descHTML(s.sub, 'on-photo')}
        </div>
        <div class="slide-act">
          ${s.price ? `<span class="slide-price"><b>${peso(s.price)}</b> / hour</span>` : ''}
          <button type="button" class="btn gold" ${action}>${esc(s.cta)} &rarr;</button>
        </div>
      </div>
    </article>`;
}

export function initCarousel() {
    const slider = $('#slider'), dots = $('#sdots'), wrap = $('#sw'), count = $('#scount');
    const n = SLIDES.length;
    let current = 0, timer, target = null, release;   // target: slide we are scrolling to ourselves

    slider.innerHTML = SLIDES.map(slideHTML).join('');
    dots.innerHTML = SLIDES.map((s, i) => `<button type="button" aria-label="Go to ${esc(s.label)} (${i + 1} of ${n})"></button>`).join('');
    const slides = [...slider.children];

    const pad = v => String(v).padStart(2, '0');
    const mark = () => {
        [...dots.children].forEach((d, i) => {
            d.classList.toggle('active', i === current);
            d.setAttribute('aria-current', i === current ? 'true' : 'false');
        });
        count.textContent = `${pad(current + 1)} / ${pad(n)}`;
    };

    // slides can be narrower than the box (the next one peeks in on phones), so go by each slide's own position
    const left = i => slides[i].offsetLeft - slides[0].offsetLeft;
    const goTo = i => {
        if (!slider.clientWidth)
            return;
        current = (i + n) % n;
        target = current;   // ignore scroll events on the way there, or the dots jump back to the old slide
        clearTimeout(release);
        release = setTimeout(() => { target = null; }, 1000);   // safety: never stay locked
        slider.scrollTo({ left: left(current), behavior: reducedMotion() ? 'auto' : 'smooth' });
        mark();
    };
    const start = () => {
        clearInterval(timer);
        if (!reducedMotion())
            timer = setInterval(() => {
                if (!document.hidden)
                    goTo(current + 1);   // no sliding in a background tab
            }, 5500);
    };
    const stop = () => clearInterval(timer);

    // follow the visitor's own swipes: the slide nearest the left edge is the current one
    let raf = 0;
    slider.addEventListener('scroll', () => {
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
            const x = slider.scrollLeft;
            if (target !== null) {
                if (Math.abs(x - Math.min(left(target), slider.scrollWidth - slider.clientWidth)) < 3)
                    target = null;   // arrived
                return;
            }
            let near = 0, best = Infinity;
            slides.forEach((_, k) => {
                const d = Math.abs(left(k) - x);
                if (d < best) { best = d; near = k; }
            });
            if (x + slider.clientWidth >= slider.scrollWidth - 2)
                near = n - 1;   // the last slide may not reach the left edge
            if (near !== current) {
                current = near;
                mark();
            }
        });
    }, { passive: true });

    ['pointerdown', 'wheel'].forEach(ev => slider.addEventListener(ev, () => { target = null; }, { passive: true }));

    dots.addEventListener('click', e => {
        const b = e.target.closest('button');
        if (b) { goTo([...dots.children].indexOf(b)); start(); }
    });
    $('#sprev').addEventListener('click', () => { goTo(current - 1); start(); });
    $('#snext').addEventListener('click', () => { goTo(current + 1); start(); });
    slider.addEventListener('keydown', e => {
        if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(current - 1); start(); }
        if (e.key === 'ArrowRight') { e.preventDefault(); goTo(current + 1); start(); }
    });

    // "Book this room" opens the booking page with that slide's studio already selected
    slider.addEventListener('click', e => {
        const b = e.target.closest('[data-book-studio]');
        if (b)
            goBook(b.dataset.bookStudio);
    });

    // "Browse gear" scrolls down to the equipment section
    slider.addEventListener('click', e => {
        const b = e.target.closest('[data-scroll]');
        const el = b && document.getElementById(b.dataset.scroll);
        if (el)
            el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    });

    wrap.addEventListener('mouseenter', stop);
    wrap.addEventListener('mouseleave', start);
    wrap.addEventListener('focusin', stop);
    wrap.addEventListener('focusout', start);
    wrap.addEventListener('touchstart', stop, { passive: true });
    wrap.addEventListener('touchend', start);

    mark();
    start();
}
