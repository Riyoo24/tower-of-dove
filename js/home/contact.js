/* =====================================================================
   home/contact.js - Contact Us section of index.html
   Edit CONTACT below to change the details. Leave a link empty ('') to hide it.
   Called from home/index.js after the sidebar has been injected.
   ===================================================================== */

import { icon, setActiveNav } from '../shared/layout.js';
import { $, esc } from '../shared/utils.js';

const CONTACT = {
  email:    'Dovepangilinan@gmail.com',
  facebook: 'https://www.facebook.com/TOWEROFDOVEMUSICSTUDIOS',
  youtube:  'https://www.youtube.com/@TowerOfDove/featured',
  maps:     'https://maps.app.goo.gl/RbxWgYzicjWmtKZ48',
  /* Embedded satellite map. Coordinates come from the place the Maps link above opens. */
  map: { name: 'Tower of Dove Music Studio', lat: 14.6960122, lng: 121.0742068, zoom: 18 }
};

/* one row: icon + label + link. External links open in a new tab. */
function row(ic, label, text, href, external = true) {
  const ext = external ? ' target="_blank" rel="noopener noreferrer"' : '';
  return `<li><a class="ct-link" href="${esc(href)}"${ext}>
    <span class="ct-ico">${icon(ic)}</span>
    <span class="ct-txt"><span class="ct-lbl">${label}</span><span class="ct-val">${esc(text)}</span></span>
  </a></li>`;
}

export function initContact() {
  const c = CONTACT;

  $('#ct-touch').innerHTML = c.email ? row('mail', 'Email', c.email, 'mailto:' + c.email, false) : '';
  $('#ct-visit').innerHTML = c.maps ? row('pin', 'Google Maps', 'Find us on the map', c.maps) : '';
  $('#ct-follow').innerHTML =
    (c.facebook ? row('facebook', 'Facebook', 'Tower of Dove', c.facebook) : '') +
    (c.youtube  ? row('youtube', 'YouTube', '@TowerOfDove', c.youtube) : '');

  /* Interactive satellite map (t=k). Drag, zoom and pan work inside the frame. */
  if (c.map) {
    const { name, lat, lng, zoom } = c.map;
    const src = `https://maps.google.com/maps?q=${encodeURIComponent(name)}%40${lat},${lng}&t=k&z=${zoom}&output=embed`;
    $('#ct-map').innerHTML = `<iframe src="${src}" title="Map showing ${esc(name)}" loading="lazy" allowfullscreen referrerpolicy="no-referrer-when-downgrade"></iframe>`;
  }

  /* "Contact Us" is its own view of the landing page: #contact shows only this
     section, anything else (#home or no hash) shows the normal landing page. */
  const page = $('#home');
  const sync = () => {
    const on = location.hash === '#contact';
    const was = page.classList.contains('on-contact');
    page.classList.toggle('on-contact', on);
    setActiveNav(on ? 'contact' : 'home');
    if (on !== was) scrollTo(0, 0);
  };
  addEventListener('hashchange', sync);
  sync();
}
