/* =====================================================================
   home/index.js - the Home and Contact Us tabs of pages/customer.html
   initHome() is called once by customer/index.js. It waits for the catalog,
   then draws every landing-page section.
   ===================================================================== */

import { initAvailability, initCardButtons } from './availability.js';
import { initContact } from './contact.js';
import { initInfo } from './info.js';
import { SLIDES, initCarousel } from './carousel.js';
import { renderEquipment, renderStudioOptions, renderStudios } from './render.js';
import { initBackToTop } from '../shared/backToTop.js';
import { STUDIOS, dataReady } from '../shared/catalog.js';

export function initHome() {
    initContact();    // Contact Us section
    initInfo();       // Before you book + FAQ
    initBackToTop();  // floating back-to-top button

    dataReady.then(() => {
        // studio photos, descriptions and rates from the dashboard fill in the slides
        SLIDES.forEach(sl => {
            const si = STUDIOS.findIndex(x => 'Studio ' + x.id === sl.label);
            const st = STUDIOS[si];
            if (!st)
                return;
            sl.studio = si;   // the "Book this room" button opens this studio
            if (st.img)
                sl.img = st.img;
            if (st.desc)
                sl.sub = st.desc;
            sl.price = st.rate || 0;
        });

        renderStudioOptions();
        renderStudios();
        renderEquipment();
        initCarousel();
        initAvailability();
        initCardButtons();
    });
}
