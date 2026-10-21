/* =====================================================================
   config/supabaseClient.js - the ONE shared Supabase client
   Every module that talks to the database imports `sb` from here, so the whole
   site uses a single client instance.
   The supabase-js library itself is loaded by a <script> tag in each HTML page
   (it creates window.supabase before any module runs).
   The anon key is meant to be public; Row Level Security protects the data.
   NEVER put the service_role key in this file.
   ===================================================================== */

export const SUPABASE_URL = 'https://xwdpduwgswyxqhbrvpay.supabase.co';

export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh3ZHBkdXdnc3d5eHFoYnJ2cGF5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIxMzY1NTIsImV4cCI6MjEwNzcxMjU1Mn0.tGYMspKr91Azw4xkfjCEkcFhS2c6LkZGhHZ16zI81M8';

export const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
