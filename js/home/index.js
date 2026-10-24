/* =====================================================================
   home/index.js - entry point of index.html
   Waits for the catalog, then draws every section.
   ===================================================================== */

import { initAvailability, initCardButtons } from './availability.js';
import { initContact } from './contact.js';
import { SLIDES, initCarousel } from './carousel.js';
import { renderEquipment, renderStudioOptions, renderStudios } from './render.js';
import { STUDIOS, dataReady } from '../shared/catalog.js';
import { injectChrome } from '../shared/layout.js';

injectChrome();   // sidebar + mobile bar
initContact();    // Contact Us section

/* ============================ START ============================ */

dataReady.then(() => {
  // studio photos uploaded in the dashboard replace the colored slides
  SLIDES.forEach(sl => { const st = STUDIOS.find(x => 'Studio ' + x.id === sl.label); if (st && st.img) sl.img = st.img; });

renderStudioOptions();
renderStudios();
renderEquipment();
initCarousel();
initAvailability();
initCardButtons();
});
