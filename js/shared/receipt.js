/* =====================================================================
   shared/receipt.js - ask the `send-receipt` Edge Function to email the confirmation receipt
   The browser sends only the kind and the reference code. The recipient is the address the database saved
   with the booking / rental (the guest's typed email, or the signed-in account's email), never one chosen here.
   ===================================================================== */

import { sb } from '../config/supabaseClient.js';

/* kind: 'booking' | 'rental'. Resolves { ok, to?, reason? } and never throws (a failed email must not undo a booking). */
export async function sendReceipt(kind, ref) {
    try {
        const { data, error } = await sb.functions.invoke('send-receipt', { body: { kind, ref } });
        if (error)
            throw error;
        if (data && data.ok)
            return { ok: true, to: data.to };
        return { ok: false, reason: (data && data.reason) || 'failed' };
    }
    catch (err) {
        console.warn('Receipt email failed:', err);
        return { ok: false, reason: 'failed' };
    }
}

/* Text for the "Receipt email" row of the success pop-up. */
export const receiptSending = to => `Sending to ${to}...`;

export function receiptResultText(result) {
    if (result.ok)
        return `Sent to ${result.to}`;
    if (result.reason === 'no_email')
        return 'No email address is saved for this booking';
    return 'Could not be sent. Your booking is saved: keep this screen as your receipt';
}

/* Fill the "Receipt email" row (the dd with id ok-receipt, see showSuccess) once the email result is known. */
export function showReceiptResult(result) {
    const cell = document.getElementById('ok-receipt');
    if (cell)
        cell.textContent = receiptResultText(result);
}
