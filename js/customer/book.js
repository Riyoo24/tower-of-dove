/* =====================================================================
   customer/book.js - "Book a studio" tab: studio picker and calendar
   DB: reads busy slots through shared/availability.js (rpc get_busy_slots).
   ===================================================================== */

import { state } from './state.js';
import { openBook } from './bookingForm.js';
import { firstBookableDate, loadBusy, takenSlots } from '../shared/availability.js';
import { studioThumb } from '../shared/cards.js';
import { STUDIOS, isClosed } from '../shared/catalog.js';
import { $, SLOTS, badge, esc, longDate, pad, peso } from '../shared/utils.js';

/* ============================ 2. BOOK A STUDIO ============================ */

function renderBook() {
  if (state.selDate < firstBookableDate()) state.selDate = firstBookableDate();   // the page was left open past closing time
  $('#cs').innerHTML = STUDIOS.map((s, i) => `
    <div class="card pick ${i === state.selStudio ? 'sel' : ''}" data-i="${i}">
      ${studioThumb(s)}
      <div class="row"><h3>Studio ${s.id}</h3>${badge(s.status)}</div>
      <p class="mut">${esc(s.desc)}</p>
      <p style="margin-top:6px"><b>${peso(s.rate)}</b> <span class="mut">per hour</span></p>
    </div>`).join('');

  const y = state.calMonth.getFullYear(), m = state.calMonth.getMonth();
  const firstWeekday = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  $('#cal-t').textContent = state.calMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) + ', Studio ' + STUDIOS[state.selStudio].id;

  let html = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => `<small class="mut">${d}</small>`).join('')
           + '<span></span>'.repeat(firstWeekday);
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${y}-${pad(m + 1)}-${pad(d)}`;
    const n = takenSlots(state.selStudio, ds).size;
    const cls = ds === state.selDate ? 'sel' : n >= SLOTS.length ? 'full' : n ? 'part' : '';
    html += `<button class="cd ${cls}" data-d="${ds}" ${ds < firstBookableDate() ? 'disabled' : ''}>${d}<i>${n ? n + 'h' : ''}</i></button>`;
  }
  $('#cal').innerHTML = html;

  const occupied = [...takenSlots(state.selStudio, state.selDate)].sort((a, b) => a - b);
  $('#dayocc').innerHTML = `<h3 style="font-size:14px">${longDate(state.selDate)}</h3>` + (occupied.length
    ? `<p class="mut">Occupied: ${occupied.map(i => SLOTS[i]).join(', ')}</p>`
    : '<p class="mut">No occupied times. The whole day is open.</p>');

  $('#bk-now').disabled = isClosed(STUDIOS[state.selStudio]);
}

/* Load the month's taken hours from the database, then draw the calendar. */
export async function refreshBook() {
  const y = state.calMonth.getFullYear(), m = state.calMonth.getMonth();
  await loadBusy(state.selStudio, `${y}-${pad(m + 1)}-01`, `${y}-${pad(m + 1)}-${pad(new Date(y, m + 1, 0).getDate())}`);
  renderBook();
}

export function initBookTab() {
  $('#c-book').addEventListener('click', e => {
    const pick = e.target.closest('.pick'), day = e.target.closest('.cd');
    if (pick) state.selStudio = +pick.dataset.i;
    else if (day) state.selDate = day.dataset.d;
    else if (e.target.closest('#cal-p')) state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() - 1, 1);
    else if (e.target.closest('#cal-n')) state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + 1, 1);
    else if (e.target.closest('#bk-now')) return openBook();
    else return;
    (day ? renderBook : refreshBook)();
  });
}

/* ---- success pop-up: stays open until the customer presses Done (no timer) ---- */
export const okDlg = $('#okdlg');
