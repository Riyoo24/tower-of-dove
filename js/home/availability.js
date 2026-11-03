/* =====================================================================
   home/availability.js - "Check availability" bar
   DB: rpc get_busy_slots (through shared/availability.js).
   ===================================================================== */

import { firstBookableDate, isPastSlot, lastBookableDate, loadBusy, takenSlots } from '../shared/availability.js';
import { STUDIOS, isClosed } from '../shared/catalog.js';
import { goBook, goRent } from '../shared/navigation.js';
import { $, SLOTS, badge, esc, longDate, manilaDay, peso } from '../shared/utils.js';

/* ============================ AVAILABILITY ============================ */

async function checkAvailability() {
    const all = $('#qs').value === 'all';
    const i = all ? 0 : +$('#qs').value, studio = STUDIOS[i];
    const date = $('#qd').value, time = $('#qt').value;
    const box = $('#avail');

    box.hidden = false;
    box.dataset.studio = all ? 'all' : i;
    box.dataset.date = date;

    if (!date) {
        box.innerHTML = '<div class="card"><h3>Pick a date</h3><p class="mut">Choose a date, then check availability again.</p></div>';
        return;
    }
    if (date < manilaDay(0)) {
        box.innerHTML = '<div class="card"><h3>That date has passed</h3><p class="mut">Pick a date from ' + longDate(firstBookableDate())
            + ' onward.</p></div>';
        return;
    }
    if (date < firstBookableDate()) {
        box.innerHTML = '<div class="card"><h3>The studio is closed for today</h3><p class="mut">Pick ' + longDate(firstBookableDate())
            + ' or a later date.</p></div>';
        return;
    }
    const nowIdx = SLOTS.map((_, k) => k).filter(k => !isPastSlot(date, k));
    if (!nowIdx.length) {
        box.innerHTML = '<div class="card"><h3>No more times today</h3><p class="mut">The studio has no start times left today. Pick another date.</p></div>';
        return;
    }

    if (all) {
        box.innerHTML = `<div class="card">${await allStudiosHtml(date, time)}</div>`;
        return;
    }

    await loadBusy(i, date, date);
    const taken = takenSlots(i, date);
    const openTimes = SLOTS.filter((_, k) => !taken.has(k) && !isPastSlot(date, k));   // past times are never offered
    let html;

    if (isClosed(studio)) {
        const others = STUDIOS.map((s, k) => [s, k]).filter(([s]) => !isClosed(s));
        html = `
      <div class="row"><h3>Studio ${studio.id} is closed</h3>${badge(studio.status)}</div>
      <p class="mut">It is not taking bookings right now. These studios are open:</p>
      <div>${others.map(([s, k]) => `<button class="chip" data-pick-studio="${k}">Studio ${s.id}, ${peso(s.rate)}/hr</button>`).join('')}</div>`;
    } else if (openTimes.includes(time)) {
        html = `
      <div class="row"><h3>Studio ${studio.id} is free on ${longDate(date)} at ${time}</h3>${badge('Available')}</div>
      <p class="mut">${peso(studio.rate)} per hour. ${esc(studio.desc)}.</p>
      <div><button class="btn gold" data-book-time="${esc(time)}">Book this slot</button></div>`;
    } else {
        html = `
      <div class="row"><h3>Studio ${studio.id} is booked on ${longDate(date)} at ${time}</h3><span class="b unavailable">Booked</span></div>
      <p class="mut">${openTimes.length ? 'These times are still open that day. Pick one to continue.' : 'Nothing is open that day. Try another date or studio.'}</p>
      <div>${openTimes.map(t => `<button class="chip" data-book-time="${esc(t)}">${t}</button>`).join('')}</div>`;
    }

    box.innerHTML = `<div class="card">${html}</div>`;
}

/* "All studios": one row per studio showing whether it is free at the chosen time. */
async function allStudiosHtml(date, time) {
    await Promise.all(STUDIOS.map((_, k) => isClosed(STUDIOS[k]) ? null : loadBusy(k, date, date)));
    const rows = STUDIOS.map((s, k) => {
        if (isClosed(s))
            return {
                s,
                k,
                state: 'closed',
                open: []
            };
        const taken = takenSlots(k, date);
        const open = SLOTS.filter((_, n) => !taken.has(n) && !isPastSlot(date, n));
        return {
            s,
            k,
            state: open.includes(time) ? 'free' : 'booked',
            open
        };
    });
    const free = rows.filter(r => r.state === 'free').length;
    const head = free
        ? `${free} of ${STUDIOS.length} ${STUDIOS.length === 1 ? 'studio is' : 'studios are'} free on ${longDate(date)} at ${time}`
        : `No studio is free on ${longDate(date)} at ${time}`;
    return `<div class="row"><h3>${head}</h3></div>`
        + rows.map(r => {
            const where = `Studio ${r.s.id}, ${peso(r.s.rate)}/hr`;
            if (r.state === 'closed')
                return `<div class="row" style="margin-top:12px"><b>${where}</b>${badge(r.s.status)}</div>`;
            if (r.state === 'free')
                return `<div class="row" style="margin-top:12px"><span><b>${where}</b><br><span class="mut">${esc(r.s.desc)}</span></span>
          <span class="row" style="gap:10px">${badge('Available')}<button class="btn gold sm" data-studio="${r.k}" data-book-time="${esc(time)}">Book this slot</button></span></div>`;
            return `<div style="margin-top:12px"><div class="row"><b>${where}</b><span class="b unavailable">Booked</span></div>
          <p class="mut">${r.open.length ? 'Open that day:' : 'Nothing is open that day.'}</p>
          <div>${r.open.slice(0, 6).map(t => `<button class="chip" data-studio="${r.k}" data-book-time="${esc(t)}">${t}</button>`).join('')}</div></div>`;
        }).join('');
}

/* Start-time choices: every hour, but never one that has already started on today's date. */
let qtTouched = false;   // true once the visitor picks a time themselves

function fillStartTimes() {
    const date = $('#qd').value || firstBookableDate(), sel = $('#qt'), keep = sel.value;
    const free = SLOTS.filter((_, k) => !isPastSlot(date, k));
    sel.innerHTML = free.length ? free.map(t => `<option>${t}</option>`).join('') : '<option value="">No more times today</option>';
    // their own choice stays; otherwise today starts at the next upcoming hour and other days at 3:00 PM
    sel.value = qtTouched && free.includes(keep) ? keep : (date !== manilaDay(0) && free.includes('3:00 PM') ? '3:00 PM' : (free[0] || ''));
}

export function initAvailability() {
    // after closing time the form starts on tomorrow, and today can no longer be chosen
    const first = firstBookableDate();
    $('#qd').value = first;
    $('#qd').min = first;
    $('#qd').max = lastBookableDate();
    fillStartTimes();
    $('#qt').addEventListener('change', () => {
        qtTouched = true;
    });
    $('#qd').addEventListener('change', () => {
        if ($('#qd').value && $('#qd').value < firstBookableDate())
            $('#qd').value = firstBookableDate();   // nothing before the first bookable day
        if ($('#qd').value > lastBookableDate())
            $('#qd').value = lastBookableDate();    // nothing more than 4 weeks ahead
        fillStartTimes();
    });

    $('#qb-check').addEventListener('click', checkAvailability);

    // re-run the check automatically if the person changes a field afterwards
    ['#qs', '#qd', '#qt'].forEach(sel =>
        $(sel).addEventListener('change', () => {
            if (!$('#avail').hidden)
                checkAvailability();
        })
    );

    $('#avail').addEventListener('click', e => {
        const b = e.target.closest('button');
        if (!b)
            return;
        const box = $('#avail');
        if (b.dataset.bookTime !== undefined) {
            goBook(b.dataset.studio ?? box.dataset.studio, box.dataset.date, b.dataset.bookTime);
        } else if (b.dataset.pickStudio !== undefined) {
            $('#qs').value = b.dataset.pickStudio;
            checkAvailability();
        }
    });
}

/* Buttons inside the generated cards */
export function initCardButtons() {
    $('#studio-grid').addEventListener('click', e => {
        const b = e.target.closest('[data-book-studio]');
        if (b)
            goBook(b.dataset.bookStudio);
    });
    $('#equipment-grid').addEventListener('click', e => {
        const b = e.target.closest('[data-rent-item]');
        if (b)
            goRent(b.dataset.rentItem);
    });
}
