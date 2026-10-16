/* =====================================================================
   Tower of Dove Music Studio: Supabase connection
   Loaded before shared.js on every page (after the supabase-js CDN script).
   The anon key is meant to be public; Row Level Security protects the data.
   NEVER put the service_role key in this file.
   ===================================================================== */

const SUPABASE_URL = 'https://xwdpduwgswyxqhbrvpay.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh3ZHBkdXdnc3d5eHFoYnJ2cGF5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIxMzY1NTIsImV4cCI6MjEwNzcxMjU1Mn0.tGYMspKr91Azw4xkfjCEkcFhS2c6LkZGhHZ16zI81M8';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* Usernames become fake emails for Supabase Auth: juan -> juan@towerofdove.app */
const toEmail = username => String(username).trim().toLowerCase() + '@towerofdove.app';

/* The database stores real timestamps; the studio runs on Manila time (UTC+8). */
const manilaTS = (dateISO, hour) => `${dateISO}T${String(hour).padStart(2, '0')}:00:00+08:00`;

/* timestamp from the database -> { date: 'YYYY-MM-DD', hour: 14 } in Manila time */
function manilaParts(ts) {
  const m = new Date(new Date(ts).getTime() + 8 * 3600e3);
  return { date: m.toISOString().slice(0, 10), hour: m.getUTCHours() };
}
