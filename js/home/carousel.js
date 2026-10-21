/* =====================================================================
   home/carousel.js - hero slider on the landing page
   Slides, dots, auto-advance (stopped when the visitor prefers reduced motion).
   ===================================================================== */

import { $, esc, reducedMotion } from '../shared/utils.js';

/* Carousel slides. To use photos, set img: 'images/studio-a.jpg'. */
export const SLIDES = [
  { label: 'Studio A',    c1: '#C92C3E', c2: '#3D0C14', img: null },
  { label: 'Studio B',    c1: '#C98512', c2: '#33220A', img: null },
  { label: 'Studio C',    c1: '#8E161F', c2: '#1E0A0F', img: null },
  { label: 'Studio D',    c1: '#4A4A55', c2: '#16161A', img: null },
  { label: 'Rental gear', c1: '#6E0F1C', c2: '#0B0B0D', img: null }
];

/* Carousel: scroll-snap slider with dots and autoplay. */
export function initCarousel() {
  const slider = $('#slider'), dots = $('#sdots'), wrap = $('#sw');
  let current = 0, timer;

  slider.innerHTML = SLIDES.map(s => s.img
    ? `<div class="slide"><img src="${esc(s.img)}" alt="${esc(s.label)}"></div>`
    : `<div class="slide" style="background:linear-gradient(135deg,${s.c1},${s.c2})">${esc(s.label)}</div>`
  ).join('');
  dots.innerHTML = SLIDES.map((_, i) => `<button aria-label="Slide ${i + 1}"></button>`).join('');

  const mark = () => [...dots.children].forEach((d, i) => d.classList.toggle('active', i === current));
  const goTo = i => {
    if (!slider.clientWidth) return;
    current = i;
    slider.scrollTo({ left: i * slider.clientWidth, behavior: reducedMotion() ? 'auto' : 'smooth' });
    mark();
  };
  const start = () => {
    clearInterval(timer);
    if (!reducedMotion()) timer = setInterval(() => goTo((current + 1) % SLIDES.length), 3500);
  };

  slider.addEventListener('scroll', () => {
    const n = Math.round(slider.scrollLeft / (slider.clientWidth || 1));
    if (n !== current) { current = n; mark(); }
  });
  dots.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b) { goTo([...dots.children].indexOf(b)); start(); }
  });
  wrap.addEventListener('mouseenter', () => clearInterval(timer));
  wrap.addEventListener('mouseleave', start);
  wrap.addEventListener('touchstart', () => clearInterval(timer), { passive: true });
  wrap.addEventListener('touchend', start);

  mark();
  start();
}
