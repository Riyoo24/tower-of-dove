/* =====================================================================
   shared/payOption.js - "50% Downpayment" or "Full payment (100%)"
   One small helper used by every online payment on the Customer page: studio bookings, outside rentals,
   add-on rentals and session extensions. The database applies the same rule (pay_option_amount), so the
   amount on screen is the amount saved. 'down' is the default choice.
   ===================================================================== */

import { downPayment } from './utils.js';

export const PAY_DOWN = 'down';
export const PAY_FULL = 'full';

/* amount to pay now for a total */
export const dueNow = (total, opt) => opt === PAY_FULL ? Math.round(total * 100) / 100 : downPayment(total);

/* words used on screens and receipts */
export const optName = opt => opt === PAY_FULL ? 'Full payment (100%)' : '50% down payment';
export const optShort = opt => opt === PAY_FULL ? 'Full payment' : 'Down payment (50%)';

/* The chooser. `id` makes the radio group name unique (bk, rt, ao, ex). `rest` names where the balance is paid
   ("at the studio" / "at pick-up"). */
export function payOptionHtml(id, rest, selected = PAY_DOWN) {
    const row = (v, title, text) =>
        `<label class="acct-opt"><input type="radio" name="${id}-opt" value="${v}"${selected === v ? ' checked' : ''}>` +
        `<span><b>${title}</b><small>${text}</small></span></label>`;
    return `<fieldset class="acct-choice" id="${id}-optbox">
          <legend>Payment option <span class="req" aria-hidden="true">*</span></legend>
          ${row(PAY_DOWN, '50% Downpayment', `Pay half now with GCash. The other half is paid ${rest}.`)}
          ${row(PAY_FULL, 'Full Payment (100%)', 'Pay everything now with GCash. Nothing is left to pay later.')}
        </fieldset>`;
}

/* the option the customer picked, or '' when none is picked (the payment button must not go on) */
export const readPayOption = id => {
    const r = document.querySelector(`input[name="${id}-opt"]:checked`);
    return r ? r.value : '';
};

export const onPayOption = (id, fn) => {
    document.querySelectorAll(`input[name="${id}-opt"]`).forEach(r => r.addEventListener('change', fn));
};
