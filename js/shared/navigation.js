/* =====================================================================
   shared/navigation.js - moving between pages
   navigate(key) uses ROUTES from config/paths.js.
   ===================================================================== */

import { ROOT, ROUTES } from '../config/paths.js';
import { STUDIOS } from './catalog.js';
import { reducedMotion, toast } from './utils.js';

/* ============================ 4. NAVIGATION ============================ */

/* Go to another page (see ROUTES). If the target is the page you are
   already on, scroll or switch the hash instead of reloading. */
export function navigate(key, params = {}) {
  const url = ROUTES[key];
  if (!url) { toast(`Connect this page: set ROUTES.${key} in shared.js.`); return; }

  const [path, hash = ''] = url.split('#');
  const q = new URLSearchParams(params).toString();
  const target = new URL(ROOT + path + (q ? '?' + q : '') + (hash ? '#' + hash : ''), location.href);

  if (target.pathname === location.pathname && target.search === location.search) {
    if (target.hash && target.hash !== location.hash) location.hash = target.hash;
    else scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
    return;
  }
  location.href = target.href;
}

export function goBook(studioIndex, date, time) {
  const params = {};
  if (studioIndex !== undefined && studioIndex !== null && studioIndex !== '') params.studio = STUDIOS[+studioIndex].id;
  if (date) params.date = date;
  if (time) params.time = time;
  navigate('book', params);
}

export function goRent(itemIndex) {
  navigate('rent', itemIndex !== undefined ? { item: itemIndex } : {});
}
