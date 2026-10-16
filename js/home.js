/* =====================================================================
   Tower of Dove Music Studio: landing page (index.html)
   Data, helpers, sidebar and navigation live in shared.js.
   ===================================================================== */

/* Carousel slides. To use photos, set img: 'images/studio-a.jpg'. */
const SLIDES = [
  { label: 'Studio A',    c1: '#C92C3E', c2: '#3D0C14', img: null },
  { label: 'Studio B',    c1: '#C98512', c2: '#33220A', img: null },
  { label: 'Studio C',    c1: '#8E161F', c2: '#1E0A0F', img: null },
  { label: 'Studio D',    c1: '#4A4A55', c2: '#16161A', img: null },
  { label: 'Rental gear', c1: '#6E0F1C', c2: '#0B0B0D', img: null }
];

/* ============================ RENDERING ============================ */

const IMAGE_ICON =
  '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/>' +
  '<circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-8 8"/></svg>';

const studioThumb = s =>
  `<div class="ph" style="background:linear-gradient(135deg,${s.c1},${s.c2})">${s.id}</div>`;

const equipmentImage = e => e.img
  ? `<div class="eqimg has"><img src="${esc(e.img)}" alt="${esc(e.name)}"></div>`
  : `<div class="eqimg" role="img" aria-label="No image yet">${IMAGE_ICON}</div>`;

function renderStudioOptions() {
  $('#qs').innerHTML = STUDIOS
    .map((s, i) => `<option value="${i}">Studio ${s.id}, ${peso(s.rate)}/hr</option>`)
    .join('');
}

function renderStudios() {
  $('#studio-grid').innerHTML = STUDIOS.map((s, i) => {
    const closed = isClosed(s);
    return `
      <div class="card">
        ${studioThumb(s)}
        <div class="row"><h3>Studio ${s.id}</h3>${badge(s.status)}</div>
        <p class="mut">${esc(s.desc)}</p>
        <div class="row" style="margin-top:12px">
          <span><b>${peso(s.rate)}</b> <span class="mut">per hour</span></span>
          <button class="btn gold" data-book-studio="${i}" ${closed ? 'disabled' : ''}>${closed ? 'Closed' : 'Book now'}</button>
        </div>
      </div>`;
  }).join('');
}

function renderEquipment() {
  $('#equipment-grid').innerHTML = EQUIPMENT.map((e, i) => {
    const lines = [];
    if (e.addon)   lines.push(`<div><span class="b addon">Add-on</span> ${peso(e.addonPrice)} ${e.drum ? 'per rental' : 'per session'}</div>`);
    if (e.outside) lines.push(`<div><span class="b out">Outside</span> ${peso(e.outsidePrice)} ${e.drum ? 'per rental' : 'per day, 8 hrs minimum'}</div>`);

    const sub = e.drum
      ? `${e.drum.kit}, ${e.drum.vip ? 'VIP' : 'Basic'} set-up. 8 hrs minimum, no service.`
      : `${e.stock} available`;

    return `
      <div class="card">
        ${equipmentImage(e)}
        <p class="cat">${esc(e.category || '')}</p>
        <h3>${esc(e.name)}</h3>
        ${e.desc ? `<p class="mut" style="margin-top:4px">${esc(e.desc)}</p>` : ''}
        <p class="mut">${esc(sub)}</p>
        <div class="price-lines">${lines.join('')}</div>
        <button class="btn gold full" data-rent-item="${i}">Rent</button>
      </div>`;
  }).join('');
}

/* Carousel: scroll-snap slider with dots and autoplay. */
function initCarousel() {
  const slider = $('#slider'), dots = $('#sdots'), wrap = $('#sw');
  let current = 0, timer;

  slider.innerHTML = SLIDES.map(s => s.img
    ? `<div class="slide"><img src="${esc(s.img)}" alt="${esc(s.label)}"></div>`
    : `<div class="slide" style="background:linear-gradient(135deg,${s.c1},${s.c2})">${esc(s.label)}</div>`
  ).join('');
  dots.innerHTML = SLIDES.map((_, i) => `<button aria-label="Slide ${i + 1}"></button>`).join('');

  const mark = () => [...dots.children].forEach((d, i) => d.classList.toggle('active', i === current));
  const goTo = i => {
    if (!slider.clientWidth) return;
    current = i;
    slider.scrollTo({ left: i * slider.clientWidth, behavior: reducedMotion() ? 'auto' : 'smooth' });
    mark();
  };
  const start = () => {
    clearInterval(timer);
    if (!reducedMotion()) timer = setInterval(() => goTo((current + 1) % SLIDES.length), 3500);
  };

  slider.addEventListener('scroll', () => {
    const n = Math.round(slider.scrollLeft / (slider.clientWidth || 1));
    if (n !== current) { current = n; mark(); }
  });
  dots.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (b) { goTo([...dots.children].indexOf(b)); start(); }
  });
  wrap.addEventListener('mouseenter', () => clearInterval(timer));
  wrap.addEventListener('mouseleave', start);
  wrap.addEventListener('touchstart', () => clearInterval(timer), { passive: true });
  wrap.addEventListener('touchend', start);

  mark();
  start();
}


/* ============================ AVAILABILITY ============================ */

async function checkAvailability() {
  const i = +$('#qs').value, studio = STUDIOS[i];
  const date = $('#qd').value, time = $('#qt').value;
  const box = $('#avail');

  box.hidden = false;
  box.dataset.studio = i;
  box.dataset.date = date;

  if (!date) {
    box.innerHTML = '<div class="card"><h3>Pick a date</h3><p class="mut">Choose a date, then check availability again.</p></div>';
    return;
  }

  await loadBusy(i, date, date);
  const taken = takenSlots(i, date);
  const openTimes = SLOTS.filter((_, k) => !taken.has(k));
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


function initAvailability() {
  const today = TODAY;
  $('#qd').value = today;
  $('#qd').min = today;

  $('#qb-check').addEventListener('click', checkAvailability);

  // re-run the check automatically if the person changes a field afterwards
  ['#qs', '#qd', '#qt'].forEach(sel =>
    $(sel).addEventListener('change', () => { if (!$('#avail').hidden) checkAvailability(); })
  );

  $('#avail').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const box = $('#avail');
    if (b.dataset.bookTime !== undefined) {
      goBook(box.dataset.studio, box.dataset.date, b.dataset.bookTime);
    } else if (b.dataset.pickStudio !== undefined) {
      $('#qs').value = b.dataset.pickStudio;
      checkAvailability();
    }
  });
}

/* Buttons inside the generated cards */
function initCardButtons() {
  $('#studio-grid').addEventListener('click', e => {
    const b = e.target.closest('[data-book-studio]');
    if (b) goBook(b.dataset.bookStudio);
  });
  $('#equipment-grid').addEventListener('click', e => {
    const b = e.target.closest('[data-rent-item]');
    if (b) goRent(b.dataset.rentItem);
  });
}


/* ============================ START ============================ */

dataReady.then(() => {

renderStudioOptions();
renderStudios();
renderEquipment();
initCarousel();
initAvailability();
initCardButtons();
});
