/* =====================================================================
   admin/data.js - loads all dashboard data from Supabase
   DB: bookings, payments, rental lines, stock, customers, revenue, staff, studios.
   refresh() re-loads and re-draws every tab (also every 30 seconds).
   ===================================================================== */

import { renderAll } from './index.js';
import { renderForms } from './onsite.js';
import { sb } from '../config/supabaseClient.js';
import { toast } from '../shared/utils.js';

/* ============================ 2. LOAD DATA ============================ */

export let BK = [], PAY = [], RL = [], STK = [], CUS = [], REV = [], CNT = {}, STAFF = [], CATS = [], STU = [];

async function loadAll() {
  const q = t => sb.from(t).select('*');
  const res = await Promise.all([
    q('v_booking_summary').order('start_at', { ascending: false }),
    q('v_payment_queue').order('created_at', { ascending: false }),
    q('v_rental_lines').order('created_at', { ascending: false }),
    q('v_equipment_stock').order('equipment_id'),
    q('v_customer_spending').order('total_spent', { ascending: false }),
    q('v_revenue_daily'),
    q('v_dashboard_counts').maybeSingle(),
    q('app_user').order('user_id'),
    q('equipment_category').order('category_id'),
    q('studio').order('studio_id')
  ]);
  const bad = res.find(r => r.error);
  if (bad) { console.error(bad.error); toast('Could not load dashboard data: ' + bad.error.message); return false; }
  [BK, PAY, RL, STK, CUS, REV, , STAFF, CATS, STU] = res.map(r => r.data);
  CNT = res[6].data || {};
  return true;
}

let polling = false;

export async function refresh(poll) {
  if (polling) return;
  polling = true;
  try {
    try { await sb.rpc('start_due_sessions'); } catch (e) { /* needs 11_cash_autostart_addons.sql */ }   // sessions whose time has come start by themselves
    if (!(await loadAll())) return;
    renderAll(poll);
    if (!poll) renderForms();
  } finally { polling = false; }
}
