/* =====================================================================
   admin/data.js - loads all dashboard data from Supabase
   DB: bookings, payments, rental lines, stock, customers, revenue, staff, studios.
   refresh() re-loads and re-draws every tab (also every 30 seconds).
   ===================================================================== */

import { notifyConnection } from './alerts.js';
import { renderAll } from './index.js';
import { renderForms } from './onsite.js';
import { sb } from '../config/supabaseClient.js';
import { fetchSortPairs } from '../shared/catalog.js';
import { toast } from '../shared/utils.js';
import { COLS, LIMIT, run } from '../shared/query.js';

/* ============================ 2. LOAD DATA ============================ */

/* true once 77_equipment_sort_order.sql has been run (equipment.sort_order exists) */
export let SORT_OK = false;

export let BK = [],
    PAY = [],
    RL = [],
    STK = [],
    CUS = [],
    REV = [],
    CNT = {},
    STAFF = [],
    CATS = [],
    STU = [],
    DMG = [],   // damage fees of outside rentals (needs 58_damage_charges.sql)
    SWP = [],   // items swapped on a rental (needs 61_swap_rental_item.sql)
    OFR = [],   // replacement offers: staff let the customer choose a replacement item, each with its rental_swap_offer_option rows (needs 71_customer_swap_choice.sql)
    SHORT = [], // rentals / bookings that need more of an item than can still be rented (equipment_stock_conflicts, needs 60_out_of_service_stock.sql; staff only)
    LFL = [],   // History of late fees: one line per step (needs 83_late_fee_collection.sql; staff only)
    REP = [],   // reputation flags and damage-fee blocks per customer (needs 64_damage_block_reputation.sql; staff only)
    EXT = [],   // customers' session extension requests (needs 23_extension_payment.sql)
    REL = [],   // release time of every confirmed booking that still owes a balance: { booking_ref, release_at, hold_count, hold_note } (needs 78_no_show_release.sql)
    EVT = [],   // booking events for the History: holds and no-show releases (needs 78_no_show_release.sql)
    NSC = [],   // no-shows of the last 12 months per customer: { customer_id, no_shows, last_at } (needs 78_no_show_release.sql)
    CHK = [];   // check-ins: { booking_ref, checked_in_at, by_name }, when the customer arrived (needs 87_booking_check_in.sql)

/* true once 87_booking_check_in.sql has been run (the Check in buttons only show then) */
export let CHK_OK = false;

let lastSig = '', dataChanged = true;

async function loadAll(poll) {
    // only the columns the dashboard uses, and the newest rows for the long lists (see shared/query.js)
    const q = (t, cols, build) => run(sb, t, cols, build);
    const res = await Promise.all([
        q('v_booking_summary', COLS.v_booking_summary, x => x.order('start_at', { ascending: false }).limit(LIMIT.bookings)),
        q('v_payment_queue', COLS.v_payment_queue, x => x.order('created_at', { ascending: false }).limit(LIMIT.payments)),
        q('v_rental_lines', COLS.v_rental_lines, x => x.order('created_at', { ascending: false }).limit(LIMIT.rentals)),
        q('v_equipment_stock', COLS.v_equipment_stock, x => x.order('equipment_id')),
        q('v_customer_spending', '*', x => x.order('total_spent', { ascending: false })),
        q('v_revenue_daily', '*', x => x),
        q('v_dashboard_counts', '*', x => x.maybeSingle()),
        q('app_user', '*', x => x.order('user_id')),
        q('equipment_category', '*', x => x.order('category_id')),
        q('studio', COLS.studio, x => x.order('studio_id')),
        // extension requests: if 23_extension_payment.sql has not been run yet, carry on without them
        q('v_booking_extension', COLS.v_booking_extension, x => x.order('created_at', { ascending: false }).limit(LIMIT.extensions)).then(r => r.error ? { data: [], error: null } : r),
        // damage fees: if 58_damage_charges.sql has not been run yet, carry on without them
        q('v_damage_charge', COLS.v_damage_charge, x => x.order('created_at', { ascending: false }).limit(LIMIT.rentals)).then(r => r.error ? { data: [], error: null } : r),
        // item swaps: if 61_swap_rental_item.sql has not been run yet, carry on without them
        q('rental_item_swap', '*', x => x.order('created_at', { ascending: false }).limit(LIMIT.rentals)).then(r => r.error ? { data: [], error: null } : r),
        // reputation flags: if 64_damage_block_reputation.sql has not been run yet, carry on without them
        sb.rpc('staff_customer_reputation').then(r => r.error ? { data: [], error: null } : r),
        // replacement offers: if 71_customer_swap_choice.sql has not been run yet, carry on without them
        q('rental_swap_offer', '*, rental_swap_offer_option(*)', x => x.order('created_at', { ascending: false }).limit(LIMIT.rentals)).then(r => r.error ? { data: [], error: null } : r),
        // out-of-stock rentals: if 60_out_of_service_stock.sql has not been run yet, carry on without them
        sb.rpc('equipment_stock_conflicts', { p_equipment_id: null }).then(r => r.error ? { data: [], error: null } : r),
        // order set by dragging equipment rows: if 77_equipment_sort_order.sql has not been run yet, carry on without it
        fetchSortPairs().then(p => ({ data: p, error: null })),
        // no-show release (78_no_show_release.sql): if it has not been run yet, carry on without it
        sb.rpc('staff_release_times').then(r => r.error ? { data: [], error: null } : r),
        sb.from('booking_event').select('event_id,booking_id,at,action,note,by_name').order('at', { ascending: false }).limit(LIMIT.rentals).then(r => r.error ? { data: [], error: null } : r),
        sb.rpc('staff_no_show_counts').then(r => r.error ? { data: [], error: null } : r),
        // late fee history: if 83_late_fee_collection.sql has not been run yet, carry on without it
        sb.from('late_fee_log').select('log_id,rental_ref,action,amount,old_status,new_status,note,by_user_id,by_customer,created_at').order('log_id', { ascending: false }).limit(LIMIT.rentals).then(r => r.error ? { data: [], error: null } : r),
        // check-in times: if 87_booking_check_in.sql has not been run yet, carry on without them (and hide the Check in buttons)
        sb.rpc('staff_check_in_times').then(r => r.error ? { data: [], error: null, missing: true } : r)
    ]);
    const bad = res.find(r => r.error);
    if (bad) {
        console.error(bad.error);
        notifyConnection(false);   // a pop-up that stays until the next successful load (admin/alerts.js)
        if (!poll)
            toast('Could not load dashboard data: ' + bad.error.message);
        if (window.todSkeleton)
            window.todSkeleton.fail();   // first load: swap the shimmer placeholders for a "Try again" message
        return false;
    }
    // nothing changed since the last load? remember that, so a background refresh can skip redrawing every table
    const sig = JSON.stringify(res.map(r => r.data));
    dataChanged = sig !== lastSig;
    lastSig = sig;
    [BK, PAY, RL, STK, CUS, REV, , STAFF, CATS, STU, EXT, DMG, SWP, REP, OFR, SHORT] = res.map(r => r.data);
    const sortMap = new Map(res[16].data);
    SORT_OK = sortMap.size > 0;
    STK.forEach(c => { c.sort_order = sortMap.get(c.equipment_id) ?? c.equipment_id; });
    REL = res[17].data || [];
    EVT = res[18].data || [];
    NSC = res[19].data || [];
    LFL = res[20].data || [];
    CHK = res[21].data || [];
    CHK_OK = !res[21].missing;
    REP = REP || [];
    SHORT = SHORT || [];
    OFR = OFR || [];
    CNT = res[6].data || {};
    notifyConnection(true);
    return true;
}

let polling = false;

export async function refresh(poll) {
    if (polling)
        return;
    polling = true;
    try {
        try {
            await sb.rpc('start_due_sessions');
        } catch (e) {
            /* needs 11_cash_autostart_addons.sql */
        }   // also done by the database itself every 30 seconds (49_cron_auto_complete.sql); this call just makes the page current at once
        try {
            await sb.rpc('expire_swap_offers');   // replacement offers past their deadline: auto-assign or flag for follow-up (71_customer_swap_choice.sql; the database also does this every minute)
        } catch (e) {
            /* needs 71_customer_swap_choice.sql */
        }
        let loaded = false;
        try {
            loaded = await loadAll(poll);
        } catch (e) {   // the request itself failed (offline, server unreachable)
            console.error(e);
            notifyConnection(false);
            if (!poll)
                toast('Could not load dashboard data. Check your connection.');
        }
        if (!loaded)
            return;
        if (poll && !dataChanged)
            return;   // the 30-second background refresh found nothing new: leave the tables as they are
        renderAll(poll);
        if (!poll)
            renderForms();
    } finally {
        polling = false;
    }
}
