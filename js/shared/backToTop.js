/* =====================================================================
   shared/backToTop.js - floating "back to top" button
   Appears after the page is scrolled down a bit; clicking it scrolls
   smoothly to the top. Call initBackToTop() once.
   ===================================================================== */

export function initBackToTop() {
    if (document.getElementById('back-to-top'))
        return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'back-to-top';
    btn.className = 'btn gold';
    btn.setAttribute('aria-label', 'Back to top');
    btn.title = 'Back to top';
    btn.hidden = true;
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
    document.body.appendChild(btn);

    const update = () => {
        const show = window.scrollY > 400;
        if (show && btn.hidden) {
            btn.hidden = false;
            requestAnimationFrame(() => btn.classList.add('show'));
        } else if (!show && !btn.hidden) {
            btn.classList.remove('show');
            setTimeout(() => { if (!btn.classList.contains('show')) btn.hidden = true; }, 200);
        }
    };

    btn.addEventListener('click', () => {
        const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
    });

    window.addEventListener('scroll', update, { passive: true });
    update();
}
