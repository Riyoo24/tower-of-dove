// Supabase Edge Function: create-staff
// Lets the OWNER create staff accounts and reset staff passwords from the dashboard.
// It runs on Supabase's servers, so it can safely use the service_role key
// (Supabase provides it to the function automatically; it never reaches the browser).
//
// POST body:
//   { "action": "create", "first_name": "...", "last_name": "...", "username": "...", "number": "...", "password": "..." }
//   { "action": "reset_password", "user_id": 12, "password": "..." }

import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);

  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // 1. Who is calling? Use the logged-in user's own token.
    const caller = createClient(url, anon, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const { data: who } = await caller.auth.getUser();
    if (!who?.user) return json({ error: 'Please log in again.' }, 401);

    // 2. Only an active Owner may continue.
    const admin = createClient(url, service, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: me } = await admin.from('app_user').select('role, status').eq('auth_user_id', who.user.id).maybeSingle();
    if (!me || me.role !== 'Owner' || me.status !== 'Active') return json({ error: 'Only the owner can manage staff accounts.' }, 403);

    const body = await req.json().catch(() => ({}));

    // ---- create a staff account ----
    if (body.action === 'create') {
      const first = String(body.first_name ?? '').trim();
      const last = String(body.last_name ?? '').trim();
      const username = String(body.username ?? '').trim().toLowerCase();
      const number = String(body.number ?? '').trim() || null;
      const password = String(body.password ?? '');

      if (!first || !last) return json({ error: 'Enter the first and last name.' }, 400);
      if (!/^[a-z0-9_.]{3,30}$/.test(username)) return json({ error: 'Username: 3 to 30 letters, numbers, dots or underscores, no spaces.' }, 400);
      if (password.length < 8) return json({ error: 'The password must be at least 8 characters.' }, 400);
      if (number && !/^[0-9+()\s-]{7,20}$/.test(number)) return json({ error: 'Enter a valid phone number or leave it empty.' }, 400);

      const { data: taken } = await admin.from('app_user').select('user_id').ilike('username', username).maybeSingle();
      if (taken) return json({ error: 'That username is already taken.' }, 409);

      // Auth account (the site turns the username into username@towerofdove.app).
      // user_metadata.kind = 'staff' so the sign-up trigger does NOT create a customer row.
      const { data: created, error: e1 } = await admin.auth.admin.createUser({
        email: `${username}@towerofdove.app`, password, email_confirm: true, user_metadata: { kind: 'staff' },
      });
      if (e1 || !created?.user) {
        const taken2 = /already|registered|exists/i.test(e1?.message ?? '');
        return json({ error: taken2 ? 'That username is already taken.' : (e1?.message ?? 'Could not create the account.') }, taken2 ? 409 : 400);
      }

      // Profile row that makes the account staff.
      const { error: e2 } = await admin.from('app_user').insert({
        auth_user_id: created.user.id, first_name: first, last_name: last, username, number, role: 'Staff',
      });
      if (e2) {
        await admin.auth.admin.deleteUser(created.user.id);   // undo, so no half-created account is left
        return json({ error: e2.message }, 400);
      }
      return json({ ok: true, username });
    }

    // ---- reset a staff member's password ----
    if (body.action === 'reset_password') {
      const password = String(body.password ?? '');
      if (password.length < 8) return json({ error: 'The password must be at least 8 characters.' }, 400);
      const { data: target } = await admin.from('app_user').select('auth_user_id, role').eq('user_id', Number(body.user_id)).maybeSingle();
      if (!target) return json({ error: 'Staff account not found.' }, 404);
      if (target.role !== 'Staff') return json({ error: 'Change the owner password from Settings instead.' }, 400);
      const { error } = await admin.auth.admin.updateUserById(target.auth_user_id, { password });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true });
    }

    return json({ error: 'Unknown action.' }, 400);
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
