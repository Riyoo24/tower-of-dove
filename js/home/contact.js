/* =====================================================================
   home/contact.js - Contact Us section of index.html
   Edit CONTACT below to change the details. Leave a link empty ('') to hide it.
   Called from home/index.js. Showing #contact on its own is done by showTab() in customer/ui.js.
   ===================================================================== */

import { icon } from '../shared/layout.js';
import { $, esc } from '../shared/utils.js';
import { VENUE } from '../shared/venue.js';

const CONTACT = {
    email: VENUE.email,
    phone: VENUE.phone,
    facebook: VENUE.facebook,
    youtube: 'https://www.youtube.com/@TowerOfDove/featured',
    address: VENUE.address,
    maps: VENUE.maps,
    /* Embedded satellite map. Coordinates come from the place the Maps link above opens. */
    map: {
        name: 'Tower of Dove Music Studio',
        lat: 14.6960122,
        lng: 121.0742068,
        zoom: 18
    }
};

/* Full-colour brand logos (the phone and address keep the plain white icon on the red circle). */
const LOGO = {
    mail: `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M2 7.2v10.3A1.5 1.5 0 003.5 19H7v-8.4z"/><path fill="#34A853" d="M22 7.2v10.3a1.5 1.5 0 01-1.5 1.5H17v-8.4z"/><path fill="#FBBC04" d="M17 5.1v5.5l5-3.4v-.7c0-1.9-2.2-3-3.7-1.8z"/><path fill="#EA4335" d="M7 10.6V5.1L12 8.8l5-3.7v5.5l-5 3.7z"/><path fill="#C5221F" d="M2 6.5v.7l5 3.4V5.1L5.7 4.7C4.2 3.5 2 4.6 2 6.5z"/></svg>`,
    maps: `<svg viewBox="0 0 24 24" aria-hidden="true"><defs><clipPath id="ct-pin"><path d="M12 1.5a7.5 7.5 0 00-7.5 7.5c0 5.4 7.5 13.5 7.5 13.5S19.5 14.400 19.500 9A7.500 7.500 0 0012 1.500z"/></clipPath></defs><g clip-path="url(#ct-pin)"><rect x="0" y="0" width="24" height="24" fill="#EA4335"/><path fill="#4285F4" d="M0 0h12L4 11 0 11z"/><path fill="#FBBC04" d="M12 24l-9-9 4-5 5 9z M12 24l7-8 5 0v8z"/><path fill="#34A853" d="M12 24l-3-8 4-3 6 3z"/></g><circle cx="12" cy="9" r="2.8" fill="#fff"/></svg>`,
    facebook: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#1877F2"/><path fill="#fff" d="M13.400 24v-8.700h2.900l.5-3.400h-3.400V9.700c0-1 .4-1.700 1.800-1.700h1.700V5c-.3 0-1.400-.2-2.600-.2-2.600 0-4.300 1.600-4.300 4.400v2.700H7v3.400h3v8.700z"/></svg>`,
    youtube: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="1" y="4.500" width="22" height="15" rx="4.500" fill="#FF0000"/><path fill="#fff" d="M10 8.800v6.400l5.500-3.200z"/></svg>`
};

const GO = '<span class="ct-go" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7 17L17 7M9 7h8v8"/></svg></span>';

/* one row: icon + label + text. Links open in a new tab (mailto: stays in the app).
   Without an href the row is plain text: it keeps the hover effect but does nothing when clicked. */
function row(ic, label, text, href, external = true) {
    const ico = LOGO[ic] ? `<span class="ct-ico ct-logo">${LOGO[ic]}</span>` : `<span class="ct-ico">${icon(ic)}</span>`;
    const body = `${ico}
    <span class="ct-txt"><span class="ct-lbl">${label}</span><span class="ct-val">${esc(text)}</span></span>${href ? GO : ''}`;
    if (!href)
        return `<li><div class="ct-link ct-static">${body}</div></li>`;
    const ext = external ? ' target="_blank" rel="noopener noreferrer"' : '';
    return `<li><a class="ct-link" href="${esc(href)}"${ext}>${body}</a></li>`;
}

export function initContact() {
    const c = CONTACT;

    $('#ct-touch').innerHTML = (c.email ? row('mail', 'Email', c.email, 'mailto:' + c.email, false) : '') +
        (c.phone ? row('phone', 'Contact number', c.phone, 'tel:' + c.phone.replace(/[^\d+]/g, ''), false) : '');
    $('#ct-visit').innerHTML =
        (c.address ? row('pin', 'Address', c.address) : '') +
        (c.maps ? row('maps', 'Google Maps', 'Find us on the map', c.maps) : '') +
        row('clock', 'Open daily', '10 AM \u2013 10 PM');
    $('#ct-follow').innerHTML =
        (c.facebook ? row('facebook', 'Facebook', 'Tower of Dove', c.facebook) : '') +
        (c.youtube ? row('youtube', 'YouTube', '@TowerOfDove', c.youtube) : '');

    /* Interactive map. Opens on the street map (easier to read); the toggle switches to satellite.
       Drag, zoom and pan work inside the frame. */
    if (c.map) {
        const { name, lat, lng, zoom } = c.map;
        const host = $('#ct-map');
        const show = t => {
            const src = `https://maps.google.com/maps?q=${encodeURIComponent(name)}%40${lat},${lng}&t=${t}&z=${zoom}&output=embed`;
            host.innerHTML = `<iframe src="${src}" title="Map showing ${esc(name)}" loading="lazy" allowfullscreen referrerpolicy="no-referrer-when-downgrade"></iframe>`;
            document.querySelectorAll('[data-ct-map]').forEach(b => {
                const on = b.dataset.ctMap === t;
                b.classList.toggle('on', on);
                b.setAttribute('aria-pressed', on);
            });
        };
        show('m');
        document.querySelectorAll('[data-ct-map]').forEach(b => b.addEventListener('click', () => show(b.dataset.ctMap)));
        const dir = $('#ct-dir');
        if (dir)
            dir.href = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
    }
}
