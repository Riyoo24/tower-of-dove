/* =====================================================================
   shared/catalog.js - studios and equipment loaded from Supabase
   DB: studio, v_equipment_stock, storage bucket studio-images (GCash QR).
   Pages wait for `dataReady` before using STUDIOS / EQUIPMENT.
   ===================================================================== */

import { sb } from '../config/supabaseClient.js';
import { toast } from './utils.js';

/* The studio's GCash QR image lives in the public studio-images bucket (the owner uploads it in
   Settings). It is shown in the booking form above the GCash reference number. */
export const GCASH_QR_PATH = 'payment/gcash-qr';

export const gcashQrUrl = bust =>
  sb.storage.from('studio-images').getPublicUrl(GCASH_QR_PATH).data.publicUrl + '?v=' + (bust || Math.floor(Date.now() / 300000));

/* Studios and equipment are loaded from Supabase when the page opens (see loadCatalog).
   Page scripts must wait for `dataReady` before using them.
   Studio: { dbId, id: 'A', desc, rate, status, c1, c2 }   status: Available | Maintenance | Unavailable */
export const STUDIOS = [];

export const EQUIPMENT = [];

export const STUDIO_COLORS = [['#C92C3E', '#3D0C14'], ['#C98512', '#33220A'], ['#8E161F', '#1E0A0F'], ['#4A4A55', '#16161A']];

export async function loadCatalog() {
  const [st, eq] = await Promise.all([
    sb.from('studio').select('*').order('studio_id'),
    sb.from('v_equipment_stock').select('*').order('equipment_id')
  ]);
  if (st.error || eq.error) {
    console.error(st.error, eq.error);
    toast('Could not load studios and equipment. Check your connection.');
    return;
  }
  STUDIOS.length = 0;
  EQUIPMENT.length = 0;
  st.data.forEach((s, i) => {
    const c = STUDIO_COLORS[i % STUDIO_COLORS.length];
    STUDIOS.push({
      dbId: s.studio_id, id: s.name.replace(/^studio\s*/i, ''), desc: s.description || '',
      rate: +s.hourly_rate, status: s.status, img: s.image, c1: c[0], c2: c[1]
    });
  });
  eq.data.filter(e => e.stock_status !== 'Unavailable').forEach(e => EQUIPMENT.push({   // hidden items are not shown to customers
    id: e.equipment_id, name: e.name, category: e.category_name, desc: e.description, img: e.image,
    addonPrice: +e.add_on_rate || 0, outsidePrice: +e.outside_rate || 0,
    stock: e.stock_status === 'Unavailable' ? 0 : e.available, total: e.total_quantity,
    addon: e.allow_addon, outside: e.allow_outside, minHours: e.min_hours,
    drum: e.is_drum_set ? { kit: e.drum_kit, vip: e.is_vip } : null
  }));
}

export const dataReady = loadCatalog();

export const isClosed = s => s.status === 'Maintenance' || s.status === 'Unavailable';

export const studioIndex = id => STUDIOS.findIndex(s => s.id === id);
