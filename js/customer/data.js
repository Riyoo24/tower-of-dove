/* =====================================================================
   customer/data.js - loads the signed-in customer's data
   DB: customer (profile), bookings, add-ons and rentals of the logged-in user.
   Guests keep their booking references in localStorage.
   ===================================================================== */

import { state } from './state.js';
import { sb } from '../config/supabaseClient.js';
import { renderMyBookings } from './myBookings.js';
import { renderMyRentals } from './myRentals.js';
import { fmtDT, renderAttachOptions } from './rent.js';
import { BOOKINGS } from '../shared/availability.js';
import { STUDIOS } from '../shared/catalog.js';
import { isMember } from '../shared/session.js';
import { SLOTS, endTime, manilaParts, shortDate, toast } from '../shared/utils.js';

async function loadProfile() {
  if (!isMember()) return;
  const { data: auth } = await sb.auth.getUser();
  if (!auth || !auth.user) return;
  const { data } = await sb.from('customer').select('first_name, last_name, number').eq('auth_user_id', auth.user.id).maybeSingle();
  if (data) state.PROFILE = { first: data.first_name || '', last: data.last_name || '', number: data.number || '' };
}

export const profileReady = loadProfile().catch(() => {});

export const BK_STATUS = { 'Approved': 'Confirmed', 'In Progress': 'Active' };   // database -> labels used on this page

export const RN_STATUS = { 'Active': 'In Use' };

const studioLetter = dbId => (STUDIOS.find(s => s.dbId === dbId) || {}).id;

const fmtD = ts => ts ? shortDate(manilaParts(ts).date) : '';

/* Guests have no account, so their booking references are remembered in this browser
   (only so they can attach rentals). Everything else for guests is the reference lookup. */
const GUEST_KEY = 'tod_guest_bookings';

const guestBookings = () => { try { return JSON.parse(localStorage.getItem(GUEST_KEY) || '[]'); } catch (e) { return []; } };

export function rememberGuestBooking(b) {
  try { localStorage.setItem(GUEST_KEY, JSON.stringify([...guestBookings(), b])); } catch (e) { /* storage blocked */ }
}

export async function loadMyBookings() {
  BOOKINGS.length = 0;
  if (isMember()) {
    const { data, error } = await sb.from('v_booking_summary').select('*').order('start_at');
    if (error) { console.error(error); toast('Could not load your bookings.'); }
    (data || []).forEach(r => {
      const p = manilaParts(r.start_at);
      BOOKINGS.push({
        ref: r.booking_ref, studio: studioLetter(r.studio_id), date: p.date, start: SLOTS[p.hour - 10],
        hours: Math.round(+r.hours), status: BK_STATUS[r.status] || r.status,
        payment: r.payment_status || 'Pending', mine: true,
        name: r.customer_name, method: r.payment_method, created: r.created_at
      });
    });
  } else {
    guestBookings().forEach(b => BOOKINGS.push({ ...b, status: 'Pending', payment: 'Pending', mine: true }));
  }
  renderMyBookings();
  renderAttachOptions();
}

export async function loadMyRentals() {
  state.RENTALS = [];
  state.ADDONS = {};
  if (isMember()) {
    const { data, error } = await sb.from('v_rental_lines').select('*').order('created_at', { ascending: false });
    if (error) console.error(error);
    (data || []).forEach(r => {
      const addon = r.rental_type === 'Add-on', bk = addon ? BOOKINGS.find(b => b.ref === r.booking_ref) : null;
      if (addon && r.booking_ref && !['Rejected', 'Cancelled'].includes(r.status)) {
        (state.ADDONS[r.booking_ref] = state.ADDONS[r.booking_ref] || []).push({ name: r.equipment_name, qty: r.quantity, price: Number(r.unit_price_at_request) || 0 });
      }
      state.RENTALS.push({
        ref: addon ? r.booking_ref : r.rental_ref, item: r.equipment_name, qty: r.quantity,
        type: addon ? 'addon' : 'out',
        when: addon ? (bk ? `${shortDate(bk.date)}, ${bk.start}` : fmtD(r.due_at)) : fmtDT(r.pickup_date),
        ret:  addon ? (bk ? `${shortDate(bk.date)}, ${endTime(bk.start, bk.hours)}` : fmtD(r.due_at)) : fmtDT(r.return_date),
        rentalRef: r.rental_ref, rawStatus: r.status, unit: Number(r.unit_price_at_request) || 0, hours: Number(r.rental_hours) || 0,
        pickup: r.pickup_date, due: r.due_at, down: Number(r.down_payment) || 0, late: Number(r.late_fee) || 0, returnedAt: r.line_returned_at,
        status: RN_STATUS[r.status] || r.status, reason: r.rejected_reason || ''
      });
    });
  }
  renderMyRentals();
}
