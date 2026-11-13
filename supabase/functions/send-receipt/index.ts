// Supabase Edge Function: send-receipt
// Emails the confirmation receipt for a booking or rental. The SAME template is used for guests and for
// logged-in customers.
//
// POST body: { "kind": "booking" | "rental", "ref": "TOD-1042" }        receipt after a booking / rental is made
//            { "kind": "verified", "paymentId": 123 }                    "your payment is verified" email (staff only)
//            { "kind": "balance", "target": "booking" | "rental", "ref": "TOD-1042" }   "fully paid" receipt after staff collect the balance (staff only)
//            { "kind": "damage", "ref": "TOD-1042" }                                 "fully paid" receipt after a damage fee of that rental is paid (staff only)
//            { "kind": "latefee", "ref": "TOD-1042" }                                "fully paid" receipt after the late fee of that rental is paid (staff only)
//            { "kind": "replacement", "event": "offer", "offerId": 12 }              "choose your replacement item" email after staff pressed Let customer choose (staff only)
//            { "kind": "replacement", "event": "swap", "detailId": 345 }             "your item was replaced" email after staff pressed Swap item (staff only)
//            { "kind": "noshow" }                                                    reminder (~2 h before the start) and forfeiture (released no-show) emails; called every 5 minutes by
//                                                                             pg_cron (79_no_show_emails.sql) with the x-cron-secret header = secret CRON_SECRET
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
// For kind 'noshow':                   CRON_SECRET
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

/* Onsite payment made in cash: what was paid, the cash the customer gave and the change returned (payment.cash_tendered, file 75) */
const cashPaidLines = (pay: any): Line[] => {
  const t = pay?.method === 'Cash' && pay.cash_tendered != null ? Number(pay.cash_tendered) : NaN;
  const paid = Number(pay?.amount) || 0;
  return Number.isFinite(t) && t > 0
    ? [['Amount paid', peso(paid)], ['Paid by', 'Cash'], ['Cash received', peso(t)], ['Change', peso(Math.max(0, Math.round((t - paid) * 100) / 100))]]
    : [];
};
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
      // no-show terms (78_no_show_release.sql): when a balance is left, tell the customer until when the slot is held
      let holdLine: Line[] = [], holdNote = '';
      if (left > 0.005) {
        try {
          const [{ data: rel }, { data: gm }] = await Promise.all([db.rpc('booking_release_at', { p_booking_id: bk.booking_id }), db.rpc('no_show_grace_minutes')]);
          if (rel) {
            holdLine = [['Pay the balance by', stamp(rel)]];
            holdNote = ` Please pay the balance at the studio by ${clock(rel)}. If it is not paid and the session has not started within ${Number(gm) || 15} minutes after your start time, the booking is cancelled automatically, the slot is released and the down payment is non-refundable.`;
          }
        } catch (_) { /* file 78 not run yet: no extra lines */ }
      }
      receipt = {
        subject: `Your booking is verified - ${bk.booking_ref} - ${STUDIO}`,
        title: 'Your booking is verified!',
        label: 'Your booking reference code',
        ref: bk.booking_ref,
        lines: [
          ['Studio', studio?.name ?? 'Studio'],
          ['When', `${shortDay(bk.start_at)}, ${clock(bk.start_at)} to ${clock(bk.end_at)}`],
          ...cashPaidLines(pay),
          ['Balance at the studio', left > 0.005 ? peso(left) : 'Paid in full'],
          ...holdLine,
        ],
        shot: '',
        note: 'Staff verified your payment and your booking is confirmed. See you at the studio!' + holdNote,
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
      lines.push(...cashPaidLines(pay));
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

/* "Fully paid" receipt. Staff just collected the remaining balance of a booking or rental. Only an active staff member
   may ask for it. It is sent once per collection: the payments settled by it are claimed with balance_email_sent_at
   (66_balance_receipt_email.sql) and only within 30 minutes of the collection, so it cannot be used to spam an address. */
async function sendBalance(req: Request, db: any, cfg: Smtp, target: string, ref: string) {
  const url = Deno.env.get('SUPABASE_URL')!;
  const caller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
  const { data: who } = await caller.auth.getUser();
  if (!who?.user) return json({ error: 'Please log in again.' }, 401);
  const { data: me } = await db.from('app_user').select('status').eq('auth_user_id', who.user.id).maybeSingle();
  if (!me || me.status !== 'Active') return json({ error: 'Only staff can send this email.' }, 403);

  const isBooking = target === 'booking';
  const { data: owner } = await db.from(isBooking ? 'booking' : 'rental_order').select('*').eq(isBooking ? 'booking_ref' : 'rental_ref', ref).maybeSingle();
  if (!owner) return json({ error: 'Not found.', reason: 'not_found' }, 404);

  // the payments this collection settled (a booking can also settle the balance of its add-ons' own payments)
  let payIds: number[] = [];
  const own = await db.from('payment').select('payment_id').eq(isBooking ? 'booking_id' : 'rental_order_id', isBooking ? owner.booking_id : owner.rental_order_id);
  payIds = (own.data ?? []).map((p: any) => p.payment_id);
  if (isBooking) {
    const { data: ads } = await db.from('rental_order').select('rental_order_id').eq('booking_id', owner.booking_id).eq('rental_type', 'Add-on');
    if (ads?.length) {
      const { data: adPay } = await db.from('payment').select('payment_id').in('rental_order_id', ads.map((a: any) => a.rental_order_id));
      payIds = payIds.concat((adPay ?? []).map((p: any) => p.payment_id));
    }
  }
  if (!payIds.length) return json({ ok: false, reason: 'nothing_collected' });

  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const { data: claimed, error: claimErr } = await db.from('payment')
    .update({ balance_email_sent_at: new Date().toISOString() })
    .in('payment_id', payIds).gt('balance_paid_amount', 0).gte('balance_paid_at', since).is('balance_email_sent_at', null)
    .select('payment_id, balance_paid_amount, balance_paid_at, balance_paid_method, balance_paid_reference, balance_tendered');
  if (claimErr) return json({ error: claimErr.message }, 500);
  if (!claimed?.length) return json({ ok: false, reason: 'already_sent_or_nothing_collected' });
  const release = async () => { await db.from('payment').update({ balance_email_sent_at: null }).in('payment_id', claimed.map((c: any) => c.payment_id)); };

  try {
    const { data: cust } = await db.from('customer').select('first_name, last_name, email, auth_user_id').eq('customer_id', owner.customer_id).maybeSingle();
    let to: string | null = owner.receipt_email || cust?.email || null;
    if (!to && cust?.auth_user_id) {
      const { data: u } = await db.auth.admin.getUserById(cust.auth_user_id);
      to = u?.user?.email ?? null;
    }
    if (!to) { await release(); return json({ ok: false, reason: 'no_email' }); }

    const collected = claimed.reduce((t: number, c: any) => t + (Number(c.balance_paid_amount) || 0), 0);
    const first = claimed[0];
    const method = first.balance_paid_method === 'GCash' ? 'GCash' : 'Cash';
    const gref = claimed.map((c: any) => c.balance_paid_reference).find((x: any) => !!x) as string | undefined;
    const name = `${cust?.first_name ?? ''} ${cust?.last_name ?? ''}`.trim();
    const lines: Line[] = [];
    let receipt: Receipt;
    // cash: what the customer handed over and the change returned (the same amount is saved on every payment of one collection)
    const tendered = Number(claimed.map((c: any) => c.balance_tendered).find((x: any) => x !== null && x !== undefined));
    const cashLines: Line[] = method === 'Cash' && tendered > 0
      ? [['Cash received', peso(tendered)], ['Change', peso(Math.max(0, Math.round((tendered - collected) * 100) / 100))]]
      : [];

    if (isBooking) {
      const [{ data: studio }, { data: studioTotal }, { data: orders }] = await Promise.all([
        db.from('studio').select('name').eq('studio_id', owner.studio_id).maybeSingle(),
        db.rpc('booking_total', { p_booking_id: owner.booking_id }),
        db.from('rental_order').select('rental_order_id, status, rental_detail(quantity, equipment(name))').eq('booking_id', owner.booking_id).eq('rental_type', 'Add-on'),
      ]);
      const addonOrders = (orders ?? []).filter((o: any) => !['Rejected', 'Cancelled'].includes(o.status));
      let total = Number(studioTotal) || 0;
      for (const o of addonOrders) {
        const { data: t } = await db.rpc('rental_order_total', { p_order_id: o.rental_order_id });
        total += Number(t) || 0;
      }
      if (name) lines.push(['Name', name]);
      lines.push(['Studio', studio?.name ?? 'Studio']);
      lines.push(['Date', day(owner.start_at)]);
      lines.push(['Time', `${clock(owner.start_at)} to ${clock(owner.end_at)}`]);
      for (const o of addonOrders) for (const d of (o as any).rental_detail ?? []) lines.push(['Add-on', `${d.equipment?.name ?? 'Equipment'} x${d.quantity}`]);
      lines.push(['Total', peso(total)]);
      lines.push(['Balance paid at the studio', peso(collected)]);
      lines.push(['Paid by', method]);
      lines.push(...cashLines);
      if (method === 'GCash' && gref) lines.push(['GCash reference', gref]);
      lines.push(['Paid on', stamp(first.balance_paid_at)]);
      lines.push(['Balance', 'Paid in full']);
      receipt = {
        subject: `Fully paid receipt - ${owner.booking_ref} - ${STUDIO}`,
        title: 'Payment received. You are fully paid!',
        label: 'Your booking reference code',
        ref: owner.booking_ref, lines,
        shot: 'It shows your booking is paid in full.',
        note: 'Thank you! Staff received your remaining balance. Nothing is left to pay for this booking.',
      };
    } else {
      const outside = owner.rental_type === 'Outside';
      const [{ data: details }, { data: total }, { data: parent }] = await Promise.all([
        db.from('rental_detail').select('quantity, equipment(name)').eq('rental_order_id', owner.rental_order_id),
        db.rpc('rental_order_total', { p_order_id: owner.rental_order_id }),
        owner.booking_id ? db.from('booking').select('booking_ref').eq('booking_id', owner.booking_id).maybeSingle() : Promise.resolve({ data: null }),
      ]);
      if (name) lines.push(['Name', name]);
      if (!outside && parent?.booking_ref) lines.push(['Studio booking', parent.booking_ref]);
      lines.push(['Items', ((details ?? []) as any[]).map((d) => `${d.equipment?.name ?? 'Equipment'} x${d.quantity}`).join(', ')]);
      if (outside) {
        lines.push(['Pick-up', stamp(owner.pickup_date)]);
        lines.push(['Return', stamp(owner.return_date)]);
      }
      lines.push([outside ? 'Total' : 'Equipment total', peso(Number(total) || 0)]);
      lines.push([outside ? 'Balance paid at pick-up' : 'Balance paid at the studio', peso(collected)]);
      lines.push(['Paid by', method]);
      lines.push(...cashLines);
      if (method === 'GCash' && gref) lines.push(['GCash reference', gref]);
      lines.push(['Paid on', stamp(first.balance_paid_at)]);
      lines.push(['Balance', 'Paid in full']);
      receipt = {
        subject: `Fully paid receipt - ${owner.rental_ref} - ${STUDIO}`,
        title: 'Payment received. You are fully paid!',
        label: outside ? 'Your rental reference code' : 'Rental reference code',
        ref: owner.rental_ref, lines,
        shot: 'It shows your rental is paid in full.',
        note: outside
          ? 'Thank you! Staff received your remaining balance. Late returns and damage, if any, are charged separately.'
          : 'Thank you! Staff received the remaining balance for your equipment.',
      };
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

/* "Fully paid" receipt for a DAMAGE FEE. The fee of an outside rental was just paid: staff collected it (Cash or GCash), accepted the
   GCash payment the customer sent from My rentals, or collected it at the return. Same template as the balance receipt above. Only
   an active staff member may ask for it. It is sent once per payment: the paid fees are claimed with paid_email_sent_at
   (68_damage_paid_email.sql) and only within 30 minutes of the payment, so it cannot be used to spam an address. */
async function sendDamagePaid(req: Request, db: any, cfg: Smtp, ref: string) {
  const url = Deno.env.get('SUPABASE_URL')!;
  const caller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
  const { data: who } = await caller.auth.getUser();
  if (!who?.user) return json({ error: 'Please log in again.' }, 401);
  const { data: me } = await db.from('app_user').select('status').eq('auth_user_id', who.user.id).maybeSingle();
  if (!me || me.status !== 'Active') return json({ error: 'Only staff can send this email.' }, 403);

  const { data: owner } = await db.from('rental_order').select('*').eq('rental_ref', ref).maybeSingle();
  if (!owner) return json({ error: 'Not found.', reason: 'not_found' }, 404);

  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const { data: claimed, error: claimErr } = await db.from('damage_charge')
    .update({ paid_email_sent_at: new Date().toISOString() })
    .eq('rental_order_id', owner.rental_order_id).eq('status', 'Paid').gt('amount', 0).gte('paid_at', since).is('paid_email_sent_at', null)
    .select('damage_charge_id, rental_detail_id, amount, condition, reason, paid_method, gcash_reference, paid_at, paid_tendered');
  if (claimErr) return json({ error: claimErr.message }, 500);
  if (!claimed?.length) return json({ ok: false, reason: 'already_sent_or_nothing_paid' });
  const release = async () => { await db.from('damage_charge').update({ paid_email_sent_at: null }).in('damage_charge_id', claimed.map((c: any) => c.damage_charge_id)); };

  try {
    const { data: cust } = await db.from('customer').select('first_name, last_name, email, auth_user_id').eq('customer_id', owner.customer_id).maybeSingle();
    let to: string | null = owner.receipt_email || cust?.email || null;
    if (!to && cust?.auth_user_id) {
      const { data: u } = await db.auth.admin.getUserById(cust.auth_user_id);
      to = u?.user?.email ?? null;
    }
    if (!to) { await release(); return json({ ok: false, reason: 'no_email' }); }

    const [{ data: details }, { data: still }] = await Promise.all([
      db.from('rental_detail').select('rental_detail_id, quantity, equipment(name)').in('rental_detail_id', claimed.map((c: any) => c.rental_detail_id)),
      db.from('damage_charge').select('amount').eq('rental_order_id', owner.rental_order_id).in('status', ['Unpaid', 'Pending']).gt('amount', 0),
    ]);
    const itemOf = new Map<number, string>(((details ?? []) as any[]).map((d: any): [number, string] => [d.rental_detail_id, `${d.equipment?.name ?? 'Equipment'} x${d.quantity}`]));
    const left = (still ?? []).reduce((t: number, c: any) => t + (Number(c.amount) || 0), 0);

    const paid = claimed.reduce((t: number, c: any) => t + (Number(c.amount) || 0), 0);
    const first = claimed[0];
    const method = first.paid_method === 'GCash' ? 'GCash' : 'Cash';
    const gref = claimed.map((c: any) => c.gcash_reference).find((x: any) => !!x) as string | undefined;
    const name = `${cust?.first_name ?? ''} ${cust?.last_name ?? ''}`.trim();
    // cash: what the customer handed over and the change returned (the same amount is saved on every fee of one payment)
    const tendered = Number(claimed.map((c: any) => c.paid_tendered).find((x: any) => x !== null && x !== undefined));
    const cashLines: Line[] = method === 'Cash' && tendered > 0
      ? [['Cash received', peso(tendered)], ['Change', peso(Math.max(0, Math.round((tendered - paid) * 100) / 100))]]
      : [];

    const lines: Line[] = [];
    if (name) lines.push(['Name', name]);
    for (const c of claimed as any[]) {
      lines.push(['Item', itemOf.get(c.rental_detail_id) ?? 'Equipment']);
      lines.push(['Condition', String(c.condition ?? '')]);
      if (c.reason) lines.push(['Damage', String(c.reason)]);
      if (claimed.length > 1) lines.push(['Damage fee', peso(Number(c.amount) || 0)]);
    }
    lines.push(['Total damage fee paid', peso(paid)]);
    lines.push(['Paid by', method]);
    lines.push(...cashLines);
    if (method === 'GCash' && gref) lines.push(['GCash reference', gref]);
    lines.push(['Paid on', stamp(first.paid_at)]);
    lines.push(['Damage fee balance', left > 0.005 ? peso(left) : 'Paid in full']);
    const receipt: Receipt = {
      subject: `Damage fee paid receipt - ${owner.rental_ref} - ${STUDIO}`,
      title: left > 0.005 ? 'Payment received. Thank you!' : 'Payment received. Your damage fee is fully paid!',
      label: 'Your rental reference code',
      ref: owner.rental_ref, lines,
      shot: left > 0.005 ? 'It shows the damage fee you paid.' : 'It shows your damage fee is paid in full.',
      note: left > 0.005
        ? 'Thank you! Staff received your damage fee payment. Part of the damage fee is still unpaid.'
        : 'Thank you! Staff received your damage fee payment. Nothing is left to pay for the damage on this rental.',
    };

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

/* "Fully paid" receipt for a LATE FEE. The late fee of an outside rental was just paid: collected at the return, collected later by staff
   (Cash or GCash), or the GCash payment the customer sent from My rentals was accepted. Same template as the damage fee receipt above.
   Only an active staff member may ask for it. Sent once per payment: the paid items are claimed with late_fee_paid_email_sent_at
   (83_late_fee_collection.sql) and only within 30 minutes of the payment, so it cannot be used to spam an address. */
async function sendLateFeePaid(req: Request, db: any, cfg: Smtp, ref: string) {
  const url = Deno.env.get('SUPABASE_URL')!;
  const caller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
  const { data: who } = await caller.auth.getUser();
  if (!who?.user) return json({ error: 'Please log in again.' }, 401);
  const { data: me } = await db.from('app_user').select('status').eq('auth_user_id', who.user.id).maybeSingle();
  if (!me || me.status !== 'Active') return json({ error: 'Only staff can send this email.' }, 403);

  const { data: owner } = await db.from('rental_order').select('*').eq('rental_ref', ref).maybeSingle();
  if (!owner) return json({ error: 'Not found.', reason: 'not_found' }, 404);

  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const { data: claimed, error: claimErr } = await db.from('rental_detail')
    .update({ late_fee_paid_email_sent_at: new Date().toISOString() })
    .eq('rental_order_id', owner.rental_order_id).gt('late_fee', 0).not('late_fee_paid_at', 'is', null).gte('late_fee_paid_at', since).is('late_fee_paid_email_sent_at', null)
    .select('rental_detail_id, quantity, late_fee, late_fee_paid_method, late_fee_reference, late_fee_paid_at, late_fee_tendered');
  if (claimErr) return json({ error: claimErr.message }, 500);
  if (!claimed?.length) return json({ ok: false, reason: 'already_sent_or_nothing_paid' });
  const release = async () => { await db.from('rental_detail').update({ late_fee_paid_email_sent_at: null }).in('rental_detail_id', claimed.map((c: any) => c.rental_detail_id)); };

  try {
    const { data: cust } = await db.from('customer').select('first_name, last_name, email, auth_user_id').eq('customer_id', owner.customer_id).maybeSingle();
    let to: string | null = owner.receipt_email || cust?.email || null;
    if (!to && cust?.auth_user_id) {
      const { data: u } = await db.auth.admin.getUserById(cust.auth_user_id);
      to = u?.user?.email ?? null;
    }
    if (!to) { await release(); return json({ ok: false, reason: 'no_email' }); }

    const [{ data: details }, { data: still }] = await Promise.all([
      db.from('rental_detail').select('rental_detail_id, quantity, equipment(name)').in('rental_detail_id', claimed.map((c: any) => c.rental_detail_id)),
      db.from('rental_detail').select('late_fee').eq('rental_order_id', owner.rental_order_id).eq('late_fee_deferred', true).is('late_fee_paid_at', null).gt('late_fee', 0),
    ]);
    const itemOf = new Map<number, string>(((details ?? []) as any[]).map((d: any): [number, string] => [d.rental_detail_id, `${d.equipment?.name ?? 'Equipment'} x${d.quantity}`]));
    const left = (still ?? []).reduce((t: number, c: any) => t + (Number(c.late_fee) || 0), 0);

    const paid = claimed.reduce((t: number, c: any) => t + (Number(c.late_fee) || 0), 0);
    const first = claimed[0];
    const method = first.late_fee_paid_method === 'GCash' ? 'GCash' : 'Cash';
    const gref = claimed.map((c: any) => c.late_fee_reference).find((x: any) => !!x) as string | undefined;
    const name = `${cust?.first_name ?? ''} ${cust?.last_name ?? ''}`.trim();
    // cash: what the customer handed over and the change returned (the same amount is saved on every item of one payment)
    const tendered = Number(claimed.map((c: any) => c.late_fee_tendered).find((x: any) => x !== null && x !== undefined));
    const cashLines: Line[] = method === 'Cash' && tendered > 0
      ? [['Cash received', peso(tendered)], ['Change', peso(Math.max(0, Math.round((tendered - paid) * 100) / 100))]]
      : [];

    const lines: Line[] = [];
    if (name) lines.push(['Name', name]);
    for (const c of claimed as any[]) {
      lines.push(['Item', itemOf.get(c.rental_detail_id) ?? 'Equipment']);
      if (claimed.length > 1) lines.push(['Late fee', peso(Number(c.late_fee) || 0)]);
    }
    lines.push(['Total late fee paid', peso(paid)]);
    lines.push(['Paid by', method]);
    lines.push(...cashLines);
    if (method === 'GCash' && gref) lines.push(['GCash reference', gref]);
    lines.push(['Paid on', stamp(first.late_fee_paid_at)]);
    lines.push(['Late fee balance', left > 0.005 ? peso(left) : 'Paid in full']);
    const receipt: Receipt = {
      subject: `Late fee paid receipt - ${owner.rental_ref} - ${STUDIO}`,
      title: left > 0.005 ? 'Payment received. Thank you!' : 'Payment received. Your late fee is fully paid!',
      label: 'Your rental reference code',
      ref: owner.rental_ref, lines,
      shot: left > 0.005 ? 'It shows the late fee you paid.' : 'It shows your late fee is paid in full.',
      note: left > 0.005
        ? 'Thank you! Staff received your late fee payment. Part of the late fee is still unpaid.'
        : 'Thank you! Staff received your late fee payment. Nothing is left to pay for the late return on this rental.',
    };

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

/* ---- Replacement item emails (supabase/76_replacement_emails.sql) ----
   The booked item became unavailable (for example it came back damaged). Two emails, both sent once and only by staff:
     offer  = Let customer choose: the items offered with their prices, the answer deadline and the item the customer gets
              automatically when nobody answers in time (the first choice, when staff left automatic swapping on)
     swap   = Swap item: the item was replaced, with the new item and its price */
async function sendReplacement(req: Request, db: any, cfg: Smtp, body: any) {
  const url = Deno.env.get('SUPABASE_URL')!;
  const caller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
  const { data: who } = await caller.auth.getUser();
  if (!who?.user) return json({ error: 'Please log in again.' }, 401);
  const { data: me } = await db.from('app_user').select('status').eq('auth_user_id', who.user.id).maybeSingle();
  if (!me || me.status !== 'Active') return json({ error: 'Only staff can send this email.' }, 403);

  const event = String(body.event ?? '');
  const isOffer = event === 'offer';
  const table = isOffer ? 'rental_swap_offer' : 'rental_item_swap';
  const idCol = isOffer ? 'offer_id' : 'swap_id';

  // find the row to announce: the offer itself, or the newest swap of that rental line that was not announced yet
  let rowId: number | null = null;
  if (isOffer) rowId = Number(body.offerId) || null;
  else {
    const { data: last } = await db.from('rental_item_swap').select('swap_id').eq('rental_detail_id', Number(body.detailId)).is('customer_emailed_at', null)
      .order('swap_id', { ascending: false }).limit(1).maybeSingle();
    rowId = last?.swap_id ?? null;
  }
  if (!rowId) return json({ ok: false, reason: 'nothing_to_send' });

  // claim: each offer / swap is announced once
  const { data: row, error: claimErr } = await db.from(table)
    .update({ customer_emailed_at: new Date().toISOString() })
    .eq(idCol, rowId).is('customer_emailed_at', null)
    .select('*').maybeSingle();
  if (claimErr) return json({ error: claimErr.message }, 500);
  if (!row) return json({ ok: false, reason: 'already_sent' });
  const release = async () => { await db.from(table).update({ customer_emailed_at: null }).eq(idCol, rowId); };

  try {
    if (isOffer && row.status !== 'Open') { await release(); return json({ ok: false, reason: 'offer_closed' }); }
    const { data: ro } = await db.from('rental_order').select('*').eq('rental_order_id', row.rental_order_id).maybeSingle();
    if (!ro) { await release(); return json({ error: 'Not found.', reason: 'not_found' }, 404); }
    const { data: cust } = await db.from('customer').select('first_name, last_name, email, auth_user_id').eq('customer_id', ro.customer_id).maybeSingle();
    const parent = ro.booking_id ? (await db.from('booking').select('receipt_email').eq('booking_id', ro.booking_id).maybeSingle()).data : null;
    let to: string | null = ro.receipt_email || parent?.receipt_email || cust?.email || null;
    if (!to && cust?.auth_user_id) {
      const { data: u } = await db.auth.admin.getUserById(cust.auth_user_id);
      to = u?.user?.email ?? null;
    }
    if (!to) { await release(); return json({ ok: false, reason: 'no_email' }); }

    const outside = ro.rental_type === 'Outside';
    const per = outside ? 'per 8 hours' : 'per session';
    const priceOf = (e: any) => `${peso(Number(outside ? e?.outside_rate : e?.add_on_rate) || 0)} ${per}`;
    const name = [cust?.first_name, cust?.last_name].filter(Boolean).join(' ');
    const oldName = row.old_name as string;
    const qty = Number(row.quantity) || 1;
    const lines: Line[] = [];
    if (name) lines.push(['Name', name]);
    lines.push(['Item no longer available', `${oldName} x${qty}`]);
    if (outside && ro.pickup_date) lines.push(['Pick-up', stamp(ro.pickup_date)]);
    let receipt: Receipt;

    if (isOffer) {
      const { data: opts } = await db.from('rental_swap_offer_option').select('equipment_id, name, sort_order').eq('offer_id', row.offer_id).order('sort_order', { ascending: true });
      const ids = (opts ?? []).map((o: any) => o.equipment_id);
      const { data: eqs } = await db.from('equipment').select('equipment_id, outside_rate, add_on_rate').in('equipment_id', ids);
      const byId = new Map((eqs ?? []).map((e: any) => [e.equipment_id, e]));
      const list = (opts ?? []) as any[];
      list.forEach((o, i) => lines.push([`Choice ${i + 1}${row.auto_assign && i === 0 ? ' (default)' : ''}`, `${o.name} - ${priceOf(byId.get(o.equipment_id))}`]));
      lines.push(['Please answer before', stamp(row.deadline_at)]);
      lines.push(['If you do not answer', row.auto_assign && list[0]
        ? `You will automatically get ${list[0].name}`
        : 'Our staff will contact you']);
      lines.push(['Extra charge', 'None. No refund either.']);
      receipt = {
        subject: `Please choose your replacement item - ${ro.rental_ref} - ${STUDIO}`,
        title: 'Please choose your replacement item',
        label: 'Your rental reference code',
        ref: ro.rental_ref, lines,
        shot: '',
        note: `We are sorry: the item you booked (${oldName}) is not available for your rental. Please log in, open My rentals and choose one of the items above before the deadline. ${row.auto_assign && list[0] ? `If we do not hear from you, ${list[0].name} is swapped in automatically.` : 'If we do not hear from you, our staff will contact you.'} You keep the price you already paid. The prices shown are each item's regular rate.`,
      };
    } else {
      const { data: ne } = await db.from('equipment').select('outside_rate, add_on_rate').eq('equipment_id', row.new_equipment_id).maybeSingle();
      lines.push(['Replaced by', `${row.new_name} x${qty}`]);
      lines.push(['Price of the new item', priceOf(ne)]);
      lines.push(['Extra charge', 'None. No refund either.']);
      receipt = {
        subject: `Your rental item was replaced - ${ro.rental_ref} - ${STUDIO}`,
        title: 'Your rental item was replaced',
        label: 'Your rental reference code',
        ref: ro.rental_ref, lines,
        shot: '',
        note: `We are sorry: ${oldName} is not available for your rental, so our staff replaced it with ${row.new_name}. You keep the price you already paid, so nothing extra is charged and nothing is refunded. The price shown is the new item's regular rate. If this does not work for you, please contact us.`,
      };
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

/* Reminder (~2 h before the start) and forfeiture (released no-show) emails. Called by pg_cron every 5 minutes (79_no_show_emails.sql).
   Not callable from a browser: the x-cron-secret header must equal the CRON_SECRET secret. Each email is claimed first
   (booking.no_show_reminder_sent_at / forfeit_email_sent_at), so it is sent once even if two runs overlap. */
async function sendNoShowJobs(req: Request, db: any, cfg: Smtp) {
  const secret = Deno.env.get('CRON_SECRET') ?? '';
  const got = req.headers.get('x-cron-secret') ?? '';
  if (!secret || got.length !== secret.length || [...got].reduce((d, c, i) => d | (c.charCodeAt(0) ^ secret.charCodeAt(i)), 0) !== 0)
    return json({ error: 'Not allowed.' }, 401);

  const out = { reminders: 0, forfeits: 0, failed: 0 };
  const now = new Date();
  const nowIso = now.toISOString();
  const TWO_H = 2 * 60 * 60 * 1000;
  const money = (n: number) => peso(Math.round(n * 100) / 100);
  const nameOf = async (customerId: number) => {
    const { data: c } = await db.from('customer').select('first_name, last_name, auth_user_id').eq('customer_id', customerId).maybeSingle();
    return { name: `${c?.first_name ?? ''} ${c?.last_name ?? ''}`.trim(), member: !!c?.auth_user_id };
  };

  // ---- 1. reminders: confirmed, balance due, starts within 2 hours ----
  const { data: soon } = await db.from('booking')
    .select('booking_id, booking_ref, customer_id, studio_id, start_at, end_at, receipt_email')
    .eq('status', 'Approved').is('no_show_reminder_sent_at', null).not('receipt_email', 'is', null)
    .gt('start_at', nowIso).lte('start_at', new Date(now.getTime() + TWO_H).toISOString())
    .order('start_at').limit(25);
  for (const b of soon ?? []) {
    try {
      const { data: bal } = await db.rpc('booking_balance_due', { p_booking_id: b.booking_id });
      if (!(Number(bal) > 0.005)) continue;                       // nothing owed: no reminder needed
      // booked or confirmed less than 2 h before the start: the confirmation email just said it, so no second email
      const { data: lastPay } = await db.from('payment').select('verified_at').eq('booking_id', b.booking_id).eq('status', 'Verified').order('verified_at', { ascending: false }).limit(1).maybeSingle();
      if (lastPay?.verified_at && new Date(lastPay.verified_at).getTime() > new Date(b.start_at).getTime() - TWO_H) continue;
      const { data: claimed } = await db.from('booking').update({ no_show_reminder_sent_at: nowIso })
        .eq('booking_id', b.booking_id).eq('status', 'Approved').is('no_show_reminder_sent_at', null).select('booking_id').maybeSingle();
      if (!claimed) continue;
      try {
        const [{ data: studio }, { data: rel }, { data: gm }, who] = await Promise.all([
          db.from('studio').select('name').eq('studio_id', b.studio_id).maybeSingle(),
          db.rpc('booking_release_at', { p_booking_id: b.booking_id }),
          db.rpc('no_show_grace_minutes'),
          nameOf(b.customer_id),
        ]);
        const grace = Number(gm) || 15;
        const lines: Line[] = [];
        if (who.name) lines.push(['Name', who.name]);
        lines.push(['Studio', studio?.name ?? 'Studio'], ['Date', day(b.start_at)], ['Time', `${clock(b.start_at)} to ${clock(b.end_at)}`],
                   ['Balance to pay', money(Number(bal))]);
        if (rel) lines.push(['Slot held until', stamp(rel)]);
        await deliver(cfg, b.receipt_email, {
          subject: `Reminder: your session starts soon - ${b.booking_ref} - ${STUDIO}`,
          title: 'Your session starts soon',
          label: 'Your booking reference code',
          ref: b.booking_ref, lines,
          shot: '',
          note: `Please arrive on time and pay the balance at the studio. If the balance is not paid and the session has not started within ${grace} minutes after your start time, the booking is cancelled automatically, the slot is released and the down payment is non-refundable.`
            + (who.member ? ' Running late? Open My bookings and tap "I\'m running late" once for 15 extra minutes (the session still ends on time).' : ''),
        });
        out.reminders++;
      } catch (e) {
        await db.from('booking').update({ no_show_reminder_sent_at: null }).eq('booking_id', b.booking_id);   // retry on the next run
        console.error('reminder error', (e as Error).message);
        out.failed++;
      }
    } catch (e) { console.error('reminder error', (e as Error).message); out.failed++; }
  }

  // ---- 2. forfeiture: released as a no-show in the last 6 hours ----
  const { data: ev } = await db.from('booking_event').select('booking_id').eq('action', 'No-show').gte('at', new Date(now.getTime() - 6 * 3600 * 1000).toISOString()).limit(100);
  const ids = [...new Set((ev ?? []).map((e: any) => e.booking_id))];
  if (ids.length) {
    const { data: rel } = await db.from('booking')
      .select('booking_id, booking_ref, customer_id, studio_id, start_at, end_at, down_payment, receipt_email')
      .in('booking_id', ids).eq('status', 'Cancelled').is('forfeit_email_sent_at', null).not('receipt_email', 'is', null).limit(25);
    for (const b of rel ?? []) {
      try {
        const { data: claimed } = await db.from('booking').update({ forfeit_email_sent_at: nowIso })
          .eq('booking_id', b.booking_id).eq('status', 'Cancelled').is('forfeit_email_sent_at', null).select('booking_id').maybeSingle();
        if (!claimed) continue;
        try {
          const [{ data: studio }, { data: gm }, who] = await Promise.all([
            db.from('studio').select('name').eq('studio_id', b.studio_id).maybeSingle(),
            db.rpc('no_show_grace_minutes'),
            nameOf(b.customer_id),
          ]);
          const grace = Number(gm) || 15;
          const lines: Line[] = [];
          if (who.name) lines.push(['Name', who.name]);
          lines.push(['Studio', studio?.name ?? 'Studio'], ['Date', day(b.start_at)], ['Time', `${clock(b.start_at)} to ${clock(b.end_at)}`],
                     ['Status', 'Cancelled (no-show)']);
          if (Number(b.down_payment) > 0) lines.push(['Down payment kept', money(Number(b.down_payment))]);
          await deliver(cfg, b.receipt_email, {
            subject: `Your booking was released - ${b.booking_ref} - ${STUDIO}`,
            title: 'Your booking was released',
            label: 'Your booking reference code',
            ref: b.booking_ref, lines,
            shot: '',
            note: `The balance was not paid and the session did not start within ${grace} minutes after the start time, so the booking was cancelled and the time slot was released for other clients. As stated in the booking terms, the payment already made is non-refundable.`
              + (who.member ? ' You can book a new time from the website (Book again in My bookings).' : ' You are welcome to book a new time on our website.')
              + (CONTACT ? ` If you think this is a mistake, contact us at ${CONTACT}.` : ' If you think this is a mistake, please contact the studio.'),
          });
          out.forfeits++;
        } catch (e) {
          await db.from('booking').update({ forfeit_email_sent_at: null }).eq('booking_id', b.booking_id);
          console.error('forfeit error', (e as Error).message);
          out.failed++;
        }
      } catch (e) { console.error('forfeit error', (e as Error).message); out.failed++; }
    }
  }
  return json({ ok: true, ...out });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    const kind = String(body.kind ?? '');
    const ref = String(body.ref ?? '').trim().toUpperCase();
    const paymentId = Number(body.paymentId);
    const target = String(body.target ?? '');
    if (kind === 'verified') {
      if (!Number.isInteger(paymentId) || paymentId <= 0) return json({ error: 'Bad request.' }, 400);
    } else if (kind === 'balance') {
      if (!['booking', 'rental'].includes(target) || !/^[A-Z]{2,4}-[A-Z0-9]{1,16}$/.test(ref)) return json({ error: 'Bad request.' }, 400);
    } else if (kind === 'replacement') {
      const ev = String(body.event ?? '');
      if (!(ev === 'offer' ? Number.isInteger(Number(body.offerId)) && Number(body.offerId) > 0 : ev === 'swap' && Number.isInteger(Number(body.detailId)) && Number(body.detailId) > 0))
        return json({ error: 'Bad request.' }, 400);
    } else if (kind === 'noshow') {
      /* no fields: the cron secret is checked in sendNoShowJobs */
    } else if (kind === 'damage' || kind === 'latefee') {
      if (!/^[A-Z]{2,4}-[A-Z0-9]{1,16}$/.test(ref)) return json({ error: 'Bad request.' }, 400);
    } else if (!['booking', 'rental'].includes(kind) || !/^[A-Z]{2,4}-[A-Z0-9]{1,16}$/.test(ref)) return json({ error: 'Bad request.' }, 400);

    const smtpHost = Deno.env.get('SMTP_HOST');
    const smtpPort = Number(Deno.env.get('SMTP_PORT') ?? '465');
    const smtpUser = Deno.env.get('SMTP_USER');
    const smtpPass = Deno.env.get('SMTP_PASS');
    const from = Deno.env.get('RECEIPT_FROM_EMAIL') ?? (smtpUser ? `${STUDIO} <${smtpUser}>` : '');
    if (!smtpHost || !smtpUser || !smtpPass || !from) return json({ error: 'Email sending is not set up yet.', reason: 'not_configured' }, 500);

    const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
    const cfg: Smtp = { host: smtpHost, port: smtpPort, user: smtpUser, pass: smtpPass, from };
    if (kind === 'noshow') return await sendNoShowJobs(req, db, cfg);
    if (kind === 'verified') return await sendVerified(req, db, cfg, paymentId);
    if (kind === 'balance') return await sendBalance(req, db, cfg, target, ref);
    if (kind === 'damage') return await sendDamagePaid(req, db, cfg, ref);
    if (kind === 'latefee') return await sendLateFeePaid(req, db, cfg, ref);
    if (kind === 'replacement') return await sendReplacement(req, db, cfg, body);
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
      let graceNote = '';
      if (!full) {
        try { const { data: gm } = await db.rpc('no_show_grace_minutes'); graceNote = ` If the balance is not paid within ${Number(gm) || 15} minutes after your start time, the booking is released and the down payment is non-refundable.`; } catch (_) { /* file 78 not run yet */ }
      }
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
          : 'Staff confirm your booking once your down payment is verified. Bring the balance to pay at the studio when you arrive.' + graceNote + ' You can also use this code to look up your booking later.',
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
