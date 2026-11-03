/* =====================================================================
   shared/actionMenu.js - the "Actions" dropdown (customer My bookings / My rental, staff Bookings / Rentals)
   ONE menu element lives on the page (not inside a table, whose scroll box would clip it).
   openActionMenu(button, items, onPick): items = [{ act, label, id?, danger?, disabled? }]; onPick(act) runs after the menu closes.
   An item with an id keeps it as data-id: the staff page's data-act click handler (admin/helpers.js ACT) then runs it, so onPick is optional.
   ===================================================================== */

let menuEl = null, menuBtn = null, pick = null, watch = 0;

export function closeActionMenu() {
    if (!menuEl || menuEl.hidden)
        return;
    menuEl.hidden = true;
    clearInterval(watch);
    if (menuBtn) {
        menuBtn.setAttribute('aria-expanded', 'false');
        menuBtn = null;
    }
}

function build() {
    menuEl = document.createElement('div');
    menuEl.className = 'actmenu';
    menuEl.setAttribute('role', 'menu');
    menuEl.hidden = true;
    document.body.appendChild(menuEl);
    menuEl.addEventListener('click', e => {
        const item = e.target.closest('[data-act]');
        if (!item)
            return;
        const run = pick;
        closeActionMenu();
        if (run)
            run(item.dataset.act);
    });
    menuEl.addEventListener('keydown', e => {
        const list = [...menuEl.querySelectorAll('button:not([disabled])')], i = list.indexOf(document.activeElement);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length].focus();
        }
        else if (e.key === 'Escape') {
            const back = menuBtn;
            closeActionMenu();
            if (back)
                back.focus();
        }
        else if (e.key === 'Tab')
            closeActionMenu();
    });
    document.addEventListener('click', e => {
        if (!e.target.closest('.actmenu') && !e.target.closest('.menu-btn'))
            closeActionMenu();
    });
    window.addEventListener('resize', closeActionMenu);
    document.addEventListener('scroll', closeActionMenu, true);
}

export function openActionMenu(btn, items, onPick) {
    if (!menuEl)
        build();
    const wasThis = menuBtn === btn && !menuEl.hidden;
    closeActionMenu();
    if (wasThis)
        return;
    pick = onPick;
    menuEl.innerHTML = items.map(it => it.disabled
        ? `<button type="button" role="menuitem" disabled>${it.label}</button>`
        : `<button type="button" role="menuitem" data-act="${it.act}"${it.id !== undefined ? ` data-id="${String(it.id).replace(/[&"<>]/g, c => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[c]))}"` : ''}${it.danger ? ' class="danger"' : ''}>${it.label}</button>`).join('');
    menuEl.hidden = false;
    const r = btn.getBoundingClientRect(), h = menuEl.offsetHeight, w = menuEl.offsetWidth;
    const below = r.bottom + 4 + h <= window.innerHeight || r.top - 4 - h < 0;
    menuEl.style.top = `${below ? r.bottom + 4 : r.top - 4 - h}px`;
    menuEl.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
    menuBtn = btn;
    btn.setAttribute('aria-expanded', 'true');
    // a table that redraws itself (the staff lists refresh) takes the button away: close the menu with it
    watch = setInterval(() => {
        if (!btn.isConnected)
            closeActionMenu();
    }, 500);
    const first = menuEl.querySelector('button:not([disabled])');
    if (first)
        first.focus();
}
