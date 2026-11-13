/* =====================================================================
   shared/catalog.js - studios and equipment loaded from Supabase
   DB: studio, v_equipment_stock, storage bucket studio-images (GCash QR).
   Pages wait for `dataReady` before using STUDIOS / EQUIPMENT.
   ===================================================================== */

import { sb } from '../config/supabaseClient.js';
import { toast } from './utils.js';
import { COLS, run } from './query.js';

/* The studio's GCash QR image lives in the public studio-images bucket (the owner uploads it in
   Settings). It is shown in the booking form above the GCash reference number. */
export const GCASH_QR_PATH = 'payment/gcash-qr';

export const gcashQrUrl = bust =>
    sb.storage.from('studio-images').getPublicUrl(GCASH_QR_PATH).data.publicUrl + '?v='
    + (bust || Math.floor(Date.now() / 300000));

/* Studios and equipment are loaded from Supabase when the page opens (see loadCatalog).
   Page scripts must wait for `dataReady` before using them.
   Studio: { dbId, id: 'A', desc, rate, status, c1, c2 }   status: Available | Maintenance | Unavailable */
export const STUDIOS = [];

export const EQUIPMENT = [];

export const STUDIO_COLORS = [['#C92C3E', '#3D0C14'], ['#C98512', '#33220A'], ['#8E161F', '#1E0A0F'], ['#4A4A55', '#16161A']];

/* Order set by the owner (drag and drop in Admin > Equipment, needs 77_equipment_sort_order.sql).
   Read from the equipment table on its own so the rest of the site keeps working if the column does not exist yet:
   then the map is empty and items stay in id order, as before. Returns an array of [equipment_id, sort_order]. */
export async function fetchSortPairs() {
    try {
        const r = await sb.from('equipment').select('equipment_id,sort_order');
        return r.error || !r.data ? [] : r.data.map(x => [x.equipment_id, x.sort_order]);
    } catch (e) {
        return [];
    }
}

export async function loadCatalog() {
    const [st, eq, pairs] = await Promise.all([
        run(sb, 'studio', COLS.studio, q => q.order('studio_id')),
        run(sb, 'v_equipment_stock', COLS.v_equipment_stock, q => q.order('equipment_id')),
        fetchSortPairs()
    ]);
    const order = new Map(pairs);
    const pos = e => order.get(e.equipment_id) ?? e.equipment_id;
    if (st.error || eq.error) {
        console.error(st.error, eq.error);
        toast('Could not load studios and equipment. Check your connection.');
        if (window.todSkeleton)
            window.todSkeleton.fail();   // swap the shimmer placeholders for a "Try again" message
        return;
    }
    STUDIOS.length = 0;
    EQUIPMENT.length = 0;
    st.data.forEach((s, i) => {
        const c = STUDIO_COLORS[i % STUDIO_COLORS.length];
        STUDIOS.push({
            dbId: s.studio_id,
            id: s.name.replace(/^studio\s*/i, ''),
            desc: s.description || '',
            rate: +s.hourly_rate,
            status: s.status,
            img: s.image,
            c1: c[0],
            c2: c[1]
        });
    });
    eq.data.filter(e => e.stock_status !== 'Unavailable').sort((a, b) => pos(a) - pos(b) || a.equipment_id - b.equipment_id).forEach(e => EQUIPMENT.push({   // hidden items are not shown to customers
        id: e.equipment_id,
        name: e.name,
        category: e.category_name,
        desc: e.description,
        img: e.image,
        addonPrice: +e.add_on_rate || 0,
        outsidePrice: +e.outside_rate || 0,
        stock: e.stock_status === 'Unavailable' ? 0 : e.available,
        total: e.total_quantity,
        addon: e.allow_addon,
        outside: e.allow_outside,
        minHours: e.min_hours
    }));
}

export const dataReady = loadCatalog();

export const isClosed = s => s.status === 'Maintenance' || s.status === 'Unavailable';

export const studioIndex = id => STUDIOS.findIndex(s => s.id === id);
