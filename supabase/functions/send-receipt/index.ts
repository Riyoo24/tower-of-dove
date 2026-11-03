// Supabase Edge Function: send-receipt
// Emails the confirmation receipt for a booking or rental. The SAME template is used for guests and for
// logged-in customers.
//
// POST body: { "kind": "booking" | "rental", "ref": "TOD-1042" }        receipt after a booking / rental is made
//            { "kind": "verified", "paymentId": 123 }                    "your payment is verified" email (staff only)
//
// Safety:
//  * The recipient is NEVER taken from the request. It is the address saved with the booking / rental
//    (booking.receipt_email / rental_order.receipt_email): the guest's typed email, or the signed-in
//    account's email (set by the database, see 34_receipt_emails.sql).
//  * Each receipt is sent once (receipt_sent_at) and only within 30 minutes of being created, so the
//    function cannot be used to spam an address.
//  * Everything shown in the email is read from the database, not from the browser.
//
// Sends through YOUR OWN email account over SMTP (for example Gmail with an App Password).
// Secrets (Edge Functions > Secrets):  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
// Optional:                            RECEIPT_FROM_EMAIL (defaults to SMTP_USER), STUDIO_NAME, STUDIO_CONTACT_EMAIL

import { createClient } from 'npm:@supabase/supabase-js@2';
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const STUDIO = Deno.env.get('STUDIO_NAME') ?? 'Tower of Dove Music Studio';
const CONTACT = Deno.env.get('STUDIO_CONTACT_EMAIL') ?? '';
const WINDOW_MS = 30 * 60 * 1000;

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const peso = (n: number) => '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const day = (d: string) => new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(d));
const shortDay = (d: string) => new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(d));
const clock = (d: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Manila', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(d));
const stamp = (d: string) => `${shortDay(d)}, ${clock(d)}`;
const maskEmail = (e: string) => { const [u, d] = e.split('@'); return `${u.slice(0, 1)}${'*'.repeat(Math.max(1, Math.min(u.length - 1, 5)))}@${d}`; };

type Line = [string, string];
type Receipt = { subject: string; title: string; label: string; ref: string; lines: Line[]; note: string; shot: string };

/* ---- the ONE receipt template (guests and members) ---- */
function render(r: Receipt) {
  const rows = r.lines.map(([k, v]) =>
    `<tr><td style="padding:8px 0;color:#6b6358;font-size:14px;vertical-align:top;width:42%">${esc(k)}</td><td style="padding:8px 0;color:#1f1b16;font-size:14px;font-weight:600;text-align:right">${esc(v)}</td></tr>`).join('');
  const html = `<!doctype html><html><body style="margin:0;background:#f4efe7;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4efe7;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:#1f1b16;padding:20px 24px;color:#e8c26a;font-size:18px;font-weight:700">${esc(STUDIO)}</td></tr>
<tr><td style="padding:24px">
<h1 style="margin:0 0 6px;font-size:22px;color:#1f1b16">${esc(r.title)}</h1>
<p style="margin:0;color:#6b6358;font-size:14px">${esc(r.label)}</p>
<p style="margin:8px 0 18px;font-size:26px;font-weight:700;letter-spacing:1px;color:#1f1b16">${esc(r.ref)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e6dfd2;border-bottom:1px solid #e6dfd2">${rows}</table>
${r.shot ? `<p style="margin:18px 0 0;padding:12px;background:#faf6ec;border-radius:8px;font-size:13px;color:#1f1b16"><b>Keep this email as your official receipt.</b> ${esc(r.shot)}</p>` : ''}
<p style="margin:14px 0 0;font-size:13px;color:#6b6358">${esc(r.note)}</p>
${CONTACT ? `<p style="margin:14px 0 0;font-size:13px;color:#6b6358">Questions? Contact us at ${esc(CONTACT)}.</p>` : ''}
</td></tr></table>
<p style="max-width:520px;margin:12px 0 0;font-size:12px;color:#8a8174">You received this email because a booking or rental was made with this address at ${esc(STUDIO)}.</p>
</td></tr></table></body></html>`;
  const text = [`${STUDIO}`, '', r.title, `${r.label}: ${r.ref}`, '', ...r.lines.map(([k, v]) => `${k}: ${v}`), '', ...(r.shot ? [`Keep this email as your official receipt. ${r.shot}`] : []), r.note].join('\n');
  return { html, text };
}

type Smtp = { host: string; port: number; user: string; pass: string; from: string };

async function deliver(cfg: Smtp, to: string, r: Receipt) {
  const { html, text } = render(r);
  // port 465 = implicit TLS (Gmail); port 587 = STARTTLS
  const smtp = new SMTPClient({
    connection: { hostname: cfg.host, port: cfg.port, tls: cfg.port === 465, auth: { username: cfg.user, password: cfg.pass } },
  });
  try {
    await smtp.send({ from: cfg.from, to, subject: r.subject, content: text, html });
  } finally {
    try { await smtp.close(); } catch (_) { /* ignore */ }
  }
}

/* studio price + the add-ons ordered together with the booking (add-ons added later have their own payment) */
async function bookingGrandTotal(db: any, b: any) {
  const [{ data: studioTotal }, { data: orders }] = await Promise.all([
    db.rpc('booking_total', { p_booking_id: b.booking_id }),
    db.from('rental_order').select('rental_order_id, status, rental_detail(quantity, equipment(name))').eq('booking_id', b.booking_id).eq('rental_type', 'Add-on'),
  ]);
  let addonOrders = (orders ?? []).filter((o: any) => !['Rejected', 'Cancelled'].includes(o.status));
  if (addonOrders.length) {
    const { data: own } = await db.from('payment').select('rental_order_id').in('rental_order_id', addonOrders.map((o: any) => o.rental_order_id));
    const ownIds = new Set((own ?? []).map((p: any) => p.rental_order_id));
    addonOrders = addonOrders.filter((o: any) => !ownIds.has(o.rental_order_id));
  }
  let addons = 0;
  for (const o of addonOrders) {
    const { data: t } = await db.rpc('rental_order_total', { p_order_id: o.rental_order_id });
    addons += Number(t) || 0;
  }
  return (Number(studioTotal) || 0) + addons;
}

/* "Your payment is verified" email. Only an active staff member may ask for it, and each payment sends once. */
async function sendVerified(req: Request, db: any, cfg: Smtp, paymentId: number) {
  const url = Deno.env.get('SUPABASE_URL')!;
  const caller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
  const { data: who } = await caller.auth.getUser();
  if (!who?.user) return json({ error: 'Please log in again.' }, 401);
  const { data: me } = await db.from('app_user').select('status').eq('auth_user_id', who.user.id).maybeSingle();
  if (!me || me.status !== 'Active') return json({ error: 'Only staff can send this email.' }, 403);

  // claim: the payment must be Verified and its email not yet sent
  const { data: pay, error: claimErr } = await db.from('payment')
    .update({ verified_email_sent_at: new Date().toISOString() })
    .eq('payment_id', paymentId).eq('status', 'Verified').is('verified_email_sent_at', null)
    .select('*').maybeSingle();
  if (claimErr) return json({ error: claimErr.message }, 500);
  if (!pay) return json({ ok: false, reason: 'already_sent_or_not_verified' });
  const release = async () => { await db.from('payment').update({ verified_email_sent_at: null }).eq('payment_id', paymentId); };

  try {
    let ext: any = null;
    if (pay.extension_id) ext = (await db.from('booking_extension').select('*').eq('extension_id', pay.extension_id).maybeSingle()).data;
    const bookingId = pay.booking_id ?? ext?.booking_id ?? null;
    const bk = bookingId ? (await db.from('booking').select('*').eq('booking_id', bookingId).maybeSingle()).data : null;
    const ro = pay.rental_order_id ? (await db.from('rental_order').select('*').eq('rental_order_id', pay.rental_order_id).maybeSingle()).data : null;
    const owner = ro ?? bk;
    if (!owner) { await release(); return json({ error: 'Not found.', reason: 'not_found' }, 404); }

    const { data: cust } = await db.from('customer').select('first_name, last_name, email, auth_user_id').eq('customer_id', owner.customer_id).maybeSingle();
    // the saved receipt address first (guest's typed email / account email), then older records' fallbacks
    let to: string | null = owner.receipt_email || cust?.email || null;
    if (!to && cust?.auth_user_id) {
      const { data: u } = await db.auth.admin.getUserById(cust.auth_user_id);
      to = u?.user?.email ?? null;
    }
    if (!to) { await release(); return json({ ok: false, reason: 'no_email' }); }

    let receipt: Receipt;

    if (ext && bk) {
      const { data: studio } = await db.from('studio').select('name').eq('studio_id', bk.studio_id).maybeSingle();
      const left = Math.max(0, (Number(ext.extra_cost) || 0) - (Number(ext.down_payment) || 0));
      receipt = {
        subject: `Your session extension is verified - ${bk.booking_ref}`,
        title: 'Your session extension is verified!',
        label: 'Booking reference code',
        ref: bk.booking_ref,
        lines: [
          ['Studio', studio?.name ?? 'Studio'],
          ['Session now', `${shortDay(bk.start_at)}, ${clock(bk.start_at)} to ${clock(bk.end_at)} (+${ext.extra_hours} hr)`],
          ['Balance at the studio', left > 0 ? peso(left) : 'Paid in full'],
        ],
        shot: '',
        note: 'Staff verified your payment and your session has been extended.',
      };
    } else if (bk && !ro) {
      const { data: studio } = await db.from('studio').select('name').eq('studio_id', bk.studio_id).maybeSingle();
      const total = await bookingGrandTotal(db, bk);
      const left = Math.max(0, total - (Number(bk.down_payment) || 0));
      receipt = {
        subject: `Your booking is verified - ${bk.booking_ref} - ${STUDIO}`,
        title: 'Your booking is verified!',
        label: 'Your booking reference code',
        ref: bk.booking_ref,
        lines: [
          ['Studio', studio?.name ?? 'Studio'],
          ['When', `${shortDay(bk.start_at)}, ${clock(bk.start_at)} to ${clock(bk.end_at)}`],
          ['Balance at the studio', left > 0.005 ? peso(left) : 'Paid in full'],
        ],
        shot: '',
        note: 'Staff verified your payment and your booking is confirmed. See you at the studio!',
      };
    } else if (ro) {
      const outside = ro.rental_type === 'Outside';
      const [{ data: details }, { data: total }, { data: parent }] = await Promise.all([
        db.from('rental_detail').select('quantity, equipment(name)').eq('rental_order_id', ro.rental_order_id),
        db.rpc('rental_order_total', { p_order_id: ro.rental_order_id }),
        ro.booking_id ? db.from('booking').select('booking_ref').eq('booking_id', ro.booking_id).maybeSingle() : Promise.resolve({ data: null }),
      ]);
      const left = Math.max(0, (Number(total) || 0) - (Number(ro.down_payment) || 0));
      const lines: Line[] = [];
      if (!outside && parent?.booking_ref) lines.push(['Studio booking', parent.booking_ref]);
      lines.push(['Items', ((details ?? []) as any[]).map((d) => `${d.equipment?.name ?? 'Equipment'} x${d.quantity}`).join(', ')]);
      if (outside) lines.push(['Pick-up', stamp(ro.pickup_date)]);
      lines.push([outside ? 'Balance at pick-up' : 'Balance at the studio', left > 0.005 ? peso(left) : 'Paid in full']);
      receipt = {
        subject: `Your ${outside ? 'rental' : 'equipment add-on'} is verified - ${ro.rental_ref} - ${STUDIO}`,
        title: outside ? 'Your rental is verified!' : 'Your equipment add-on is verified!',
        label: outside ? 'Your rental reference code' : 'Rental reference code',
        ref: ro.rental_ref, lines,
        shot: '',
        note: outside ? 'Staff verified your payment. Bring the same ID when you pick up the equipment.' : 'Staff verified your payment for the added equipment.',
      };
    } else {
      await release();
      return json({ error: 'Not found.', reason: 'not_found' }, 404);
    }

    try {
      await deliver(cfg, to, receipt);
    } catch (e) {
      await release();
      console.error('SMTP error', (e as Error).message);
      return json({ error: 'The email could not be sent.', reason: 'send_failed' }, 502);
    }
    return json({ ok: true, to: maskEmail(to) });
  } catch (err) {
    await release();
    return json({ error: (err as Error).message }, 500);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const kind = String(body.kind ?? '');
    const ref = String(body.ref ?? '').trim().toUpperCase();
    const paymentId = Number(body.paymentId);
    if (kind === 'verified') {
      if (!Number.isInteger(paymentId) || paymentId <= 0) return json({ error: 'Bad request.' }, 400);
    } else if (!['booking', 'rental'].includes(kind) || !/^[A-Z]{2,4}-[A-Z0-9]{1,16}$/.test(ref)) return json({ error: 'Bad request.' }, 400);

    const smtpHost = Deno.env.get('SMTP_HOST');
    const smtpPort = Number(Deno.env.get('SMTP_PORT') ?? '465');
    const smtpUser = Deno.env.get('SMTP_USER');
    const smtpPass = Deno.env.get('SMTP_PASS');
    const from = Deno.env.get('RECEIPT_FROM_EMAIL') ?? (smtpUser ? `${STUDIO} <${smtpUser}>` : '');
    if (!smtpHost || !smtpUser || !smtpPass || !from) return json({ error: 'Email sending is not set up yet.', reason: 'not_configured' }, 500);

    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
    const cfg: Smtp = { host: smtpHost, port: smtpPort, user: smtpUser, pass: smtpPass, from };
    if (kind === 'verified') return await sendVerified(req, db, cfg, paymentId);
    const table = kind === 'booking' ? 'booking' : 'rental_order';
    const refCol = kind === 'booking' ? 'booking_ref' : 'rental_ref';

    // 1. Claim the receipt: only if it has an address, was never sent, and is fresh. This makes it send-once.
    const since = new Date(Date.now() - WINDOW_MS).toISOString();
    const { data: claimed, error: claimErr } = await db.from(table)
      .update({ receipt_sent_at: new Date().toISOString() })
      .eq(refCol, ref).is('receipt_sent_at', null).not('receipt_email', 'is', null).gte('created_at', since)
      .select('*').maybeSingle();
    if (claimErr) return json({ error: claimErr.message }, 500);
    if (!claimed) {
      const { data: row } = await db.from(table).select('receipt_email, receipt_sent_at').eq(refCol, ref).maybeSingle();
      if (!row) return json({ error: 'Not found.', reason: 'not_found' }, 404);
      if (!row.receipt_email) return json({ error: 'No email address is saved for this booking.', reason: 'no_email' }, 200);
      return json({ ok: true, already: true, to: maskEmail(row.receipt_email) });
    }

    const release = async () => { await db.from(table).update({ receipt_sent_at: null }).eq(refCol, ref); };

    // 2. Build the receipt from the database
    let receipt: Receipt;
    if (kind === 'booking') {
      const b = claimed;
      const [{ data: studio }, { data: cust }, { data: pay }, { data: orders }, { data: studioTotal }] = await Promise.all([
        db.from('studio').select('name').eq('studio_id', b.studio_id).maybeSingle(),
        db.from('customer').select('first_name, last_name').eq('customer_id', b.customer_id).maybeSingle(),
        db.from('payment').select('payment_option, method').eq('booking_id', b.booking_id).order('payment_id', { ascending: false }).limit(1).maybeSingle(),
        db.from('rental_order').select('rental_order_id, rental_detail(quantity, equipment(name))').eq('booking_id', b.booking_id).eq('rental_type', 'Add-on'),
        db.rpc('booking_total', { p_booking_id: b.booking_id }),
      ]);
      // add-ons ordered together with the booking (add-ons added later have their own payment and their own receipt)
      let addonOrders = orders ?? [];
      if (addonOrders.length) {
        const { data: own } = await db.from('payment').select('rental_order_id').in('rental_order_id', addonOrders.map((o: any) => o.rental_order_id));
        const ownIds = new Set((own ?? []).map((p: any) => p.rental_order_id));
        addonOrders = addonOrders.filter((o: any) => !ownIds.has(o.rental_order_id));
      }
      let addonsTotal = 0;
      for (const o of addonOrders) {
        const { data: t } = await db.rpc('rental_order_total', { p_order_id: o.rental_order_id });
        addonsTotal += Number(t) || 0;
      }
      const total = (Number(studioTotal) || 0) + addonsTotal;
      const down = Number(b.down_payment) || 0;
      const full = pay?.payment_option === 'full';
      const lines: Line[] = [
        ['Name', `${cust?.first_name ?? ''} ${cust?.last_name ?? ''}`.trim()],
        ['Studio', studio?.name ?? 'Studio'],
        ['Date', day(b.start_at)],
        ['Time', `${clock(b.start_at)} to ${clock(b.end_at)}`],
      ];
      for (const o of addonOrders) for (const d of (o as any).rental_detail ?? []) lines.push(['Add-on', `${d.equipment?.name ?? 'Equipment'} x${d.quantity}`]);
      lines.push(['Total', peso(total)]);
      lines.push(['Payment option', full ? 'Full payment (100%)' : '50% down payment']);
      lines.push([full ? 'Full payment sent' : 'Down payment sent (50%)', peso(down)]);
      lines.push(['Balance at the studio', full ? 'Paid in full' : peso(Math.max(0, total - down))]);
      lines.push(['Pick-up', `${studio?.name ?? 'Studio'}, ${shortDay(b.start_at)}, ${clock(b.start_at)}. ${full ? 'Nothing left to pay' : 'Pay the balance on arrival'}`]);
      lines.push(['Payment', `GCash ${full ? 'full payment' : 'down payment'}, waiting for staff to verify`]);
      lines.push(['Booked on', stamp(b.created_at)]);
      receipt = {
        subject: `Your booking request ${ref} - ${STUDIO}`,
        title: 'Booking request sent!',
        label: 'Your booking reference code',
        ref, lines,
        shot: 'Show it to our staff when you arrive so we can verify your reservation.',
        note: full
          ? 'Staff confirm your booking once your payment is verified. Nothing is left to pay at the studio. You can also use this code to look up your booking later.'
          : 'Staff confirm your booking once your down payment is verified. Bring the balance to pay at the studio when you arrive. You can also use this code to look up your booking later.',
      };
    } else {
      const o = claimed;
      const [{ data: cust }, { data: pay }, { data: details }, { data: total }, { data: bk }] = await Promise.all([
        db.from('customer').select('first_name, last_name').eq('customer_id', o.customer_id).maybeSingle(),
        db.from('payment').select('payment_option').eq('rental_order_id', o.rental_order_id).order('payment_id', { ascending: false }).limit(1).maybeSingle(),
        db.from('rental_detail').select('quantity, equipment(name)').eq('rental_order_id', o.rental_order_id),
        db.rpc('rental_order_total', { p_order_id: o.rental_order_id }),
        o.booking_id ? db.from('booking').select('booking_ref').eq('booking_id', o.booking_id).maybeSingle() : Promise.resolve({ data: null }),
      ]);
      const outside = o.rental_type === 'Outside';
      const full = pay?.payment_option === 'full';
      const t = Number(total) || 0, down = Number(o.down_payment) || 0;
      const lines: Line[] = [['Name', `${cust?.first_name ?? ''} ${cust?.last_name ?? ''}`.trim()]];
      if (!outside && bk?.booking_ref) lines.push(['Studio booking', bk.booking_ref]);
      for (const d of (details ?? []) as any[]) lines.push([outside ? 'Item' : 'Added', `${d.equipment?.name ?? 'Equipment'} x${d.quantity}`]);
      if (outside) {
        lines.push(['Pick-up', stamp(o.pickup_date)]);
        lines.push(['Return', stamp(o.return_date)]);
      }
      lines.push([outside ? 'Total' : 'Equipment total', peso(t)]);
      lines.push(['Payment option', full ? 'Full payment (100%)' : '50% down payment']);
      lines.push([full ? 'Full payment sent' : 'Down payment sent (50%)', peso(down)]);
      lines.push([outside ? 'Balance at pick-up' : 'Balance at the studio', full ? 'Paid in full' : peso(Math.max(0, t - down))]);
      lines.push(['Requested on', stamp(o.created_at)]);
      receipt = outside ? {
        subject: `Your rental receipt ${ref} - ${STUDIO}`,
        title: 'Rental request sent!',
        label: 'Your rental reference code',
        ref, lines,
        shot: 'Show it to our staff when you pick up the equipment so we can verify your rental.',
        note: `Staff will check your ID and verify your ${full ? 'full payment' : 'down payment'}. Bring the same ID when you pick up the equipment.`,
      } : {
        subject: `Equipment added to your booking ${bk?.booking_ref ?? ref} - ${STUDIO}`,
        title: 'Equipment added to your booking!',
        label: 'Rental reference code',
        ref, lines,
        shot: 'Show it to our staff when you arrive so we can verify your booking and equipment.',
        note: 'Staff verify your GCash payment and review the equipment request. The new total is shown when you look up this booking.',
      };
    }

    // 3. Send
    try {
      await deliver(cfg, claimed.receipt_email, receipt);
    } catch (e) {
      await release();   // allow a retry
      console.error('SMTP error', (e as Error).message);
      return json({ error: 'The email could not be sent.', reason: 'send_failed' }, 502);
    }
    return json({ ok: true, to: maskEmail(claimed.receipt_email) });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
