/* =====================================================================
   home/reviews.js - the review badge beside "Rent gear" on Home
   Reads data-rating and data-count from #hx-reviews in pages/customer.html.
   Copy those two numbers from the Tower of Dove listing on Google Maps and update them now and then.
   Nothing is invented: while data-rating is empty, the badge only says "Google reviews".
   ===================================================================== */

export function initReviews() {
    const el = document.getElementById('hx-reviews');
    const main = document.getElementById('hx-rv-main');
    const sub = document.getElementById('hx-rv-sub');
    if (!el || !main || !sub)
        return;
    const rating = parseFloat(el.getAttribute('data-rating'));
    const count = parseInt(el.getAttribute('data-count'), 10);
    if (!(rating > 0 && rating <= 5))
        return;
    main.textContent = rating.toFixed(1);
    sub.textContent = count > 0
        ? count.toLocaleString('en-US') + ' Google review' + (count === 1 ? '' : 's')
        : 'on Google';
    el.setAttribute('aria-label', 'Rated ' + rating.toFixed(1) + ' out of 5 on Google. Read Tower of Dove reviews (opens in a new tab)');
}
