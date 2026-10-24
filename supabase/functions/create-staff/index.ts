// Supabase Edge Function: create-staff
// Lets the OWNER create staff accounts and reset staff passwords from the dashboard.
// It runs on Supabase's servers, so it can safely use the service_role key
// (Supabase provides it to the function automatically; it never reaches the browser).
//
// POST body:
//   { "action": "create", "first_name": "...", "last_name": "...", "email": "name@example.com", "number": "...", "password": "..." }
//   { "action": "reset_password", "user_id": 12, "password": "..." }
//   { "action": "delete_customer", "customer_id": 34 }

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
      // Staff log in with a real e-mail address (older callers may still send it as "username").
      const email = String(body.email ?? body.username ?? '').trim().toLowerCase();
      const number = String(body.number ?? '').trim() || null;
      const password = String(body.password ?? '');

      const nameOk = (v: string) => /\p{L}/u.test(v) && !/[^\p{L}\p{M}\s.'\u2019-]/u.test(v);
      if (!first || !last) return json({ error: 'Enter the first and last name.' }, 400);
      if (!nameOk(first) || !nameOk(last)) return json({ error: 'First and last names can only contain letters.' }, 400);
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json({ error: 'Enter a valid email address, like name@example.com.' }, 400);
      if (password.length < 8) return json({ error: 'The password must be at least 8 characters.' }, 400);
      if (number && !/^[0-9+()\s-]{7,20}$/.test(number)) return json({ error: 'Enter a valid phone number or leave it empty.' }, 400);

      const { data: taken } = await admin.from('app_user').select('user_id').eq('username', email).maybeSingle();
      if (taken) return json({ error: 'That email address is already used by another staff account.' }, 409);

      // Auth account: the staff member signs in with this e-mail address.
      // user_metadata.kind = 'staff' so the sign-up trigger does NOT create a customer row.
      const { data: created, error: e1 } = await admin.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { kind: 'staff' },
      });
      if (e1 || !created?.user) {
        const taken2 = /already|registered|exists/i.test(e1?.message ?? '');
        return json({ error: taken2 ? 'That email address is already registered.' : (e1?.message ?? 'Could not create the account.') }, taken2 ? 409 : 400);
      }

      // Profile row that makes the account staff.
      const { error: e2 } = await admin.from('app_user').insert({
        auth_user_id: created.user.id, first_name: first, last_name: last, username: email, email, number, role: 'Staff',
      });
      if (e2) {
        await admin.auth.admin.deleteUser(created.user.id);   // undo, so no half-created account is left
        return json({ error: e2.message }, 400);
      }
      return json({ ok: true, email });
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

    // ---- remove a customer account ----
    // No bookings or rentals: the record and the login are deleted completely.
    // With history: the login is deleted and the record is kept (inactive) so past bookings,
    // payments and reports stay correct.
    if (body.action === 'delete_customer') {
      const id = Number(body.customer_id);
      const { data: c } = await admin.from('customer').select('customer_id, auth_user_id').eq('customer_id', id).maybeSingle();
      if (!c) return json({ error: 'Customer not found.' }, 404);

      if (c.auth_user_id) {
        const { data: isStaff } = await admin.from('app_user').select('user_id').eq('auth_user_id', c.auth_user_id).maybeSingle();
        if (isStaff) return json({ error: 'That login belongs to a staff account. Deactivate it in Settings instead.' }, 400);
      }

      const { count: nb } = await admin.from('booking').select('booking_id', { count: 'exact', head: true }).eq('customer_id', id);
      const { count: nr } = await admin.from('rental_order').select('rental_order_id', { count: 'exact', head: true }).eq('customer_id', id);

      if ((nb ?? 0) + (nr ?? 0) === 0) {
        const { error: e1 } = await admin.from('customer').delete().eq('customer_id', id);
        if (e1) return json({ error: e1.message }, 400);
        if (c.auth_user_id) {
          const { error: e2 } = await admin.auth.admin.deleteUser(c.auth_user_id);
          if (e2) return json({ error: 'The record was deleted, but the login could not be removed: ' + e2.message }, 400);
        }
        return json({ ok: true, kept: false });
      }

      if (!c.auth_user_id) {
        return json({ error: 'This guest has bookings or rentals on record, so the record is kept for your reports.' }, 400);
      }
      const { error: e3 } = await admin.from('customer').update({ username: null, email: null, status: 'Inactive' }).eq('customer_id', id);
      if (e3) return json({ error: e3.message }, 400);
      const { error: e4 } = await admin.auth.admin.deleteUser(c.auth_user_id);
      if (e4) return json({ error: e4.message }, 400);
      return json({ ok: true, kept: true });
    }

    return json({ error: 'Unknown action.' }, 400);
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
