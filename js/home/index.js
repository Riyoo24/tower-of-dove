/* =====================================================================
   home/index.js - the Home and Contact Us tabs of pages/customer.html
   initHome() is called once by customer/index.js. It waits for the catalog,
   then draws every landing-page section.
   ===================================================================== */

import { initAvailability, initCardButtons } from './availability.js';
import { initContact } from './contact.js';
import { initInfo } from './info.js';
import { initReviews } from './reviews.js';
import { initCarousel } from './carousel.js';
import { renderEquipment, renderStudioOptions } from './render.js';
import { initBackToTop } from '../shared/backToTop.js';
import { dataReady } from '../shared/catalog.js';

export function initHome() {
    initContact();    // Contact Us section
    initInfo();       // Before you book + FAQ
    initBackToTop();  // floating back-to-top button
    initReviews();    // Google rating in the review badge

    dataReady.then(() => {
        renderStudioOptions();
        renderEquipment();
        initCarousel();
        initAvailability();
        initCardButtons();
    });
}