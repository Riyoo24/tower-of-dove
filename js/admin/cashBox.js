/* =====================================================================
   admin/cashBox.js - Cash payment block: the amount tendered (cash given), quick-cash chips and the change to return.
   Same markup and behaviour as the cash block of the Onsite tab (admin/onsite.js), used by the Extend window of a running
   session (admin/bookings.js). The cash must cover the amount received now.
   ===================================================================== */

const centsOf = n => Math.round(n * 100);
const peso = n => '\u20B1' + (Math.round(n * 100) / 100).toLocaleString('en-PH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export function cashBox(box, getDue) {
    const id = box.id;
    box.innerHTML = `<label for="${id}-t">Amount tendered (cash given) <span class="req" aria-hidden="true">*</span></label>
      <div class="money-in"><span aria-hidden="true">\u20B1</span><input type="text" id="${id}-t" inputmode="decimal" autocomplete="off" placeholder="0.00" aria-describedby="${id}-c"></div>
      <div class="quick-cash" role="group" aria-label="Quick cash amounts"><button type="button" class="chip" data-quick="exact">Exact</button>${[200, 500, 1000].map(q => `<button type="button" class="chip" data-quick="${q}">\u20B1${q.toLocaleString('en-US')}</button>`).join('')}</div>
      <div class="bal-calc" id="${id}-c" role="status" aria-live="polite"></div>`;
    const input = box.querySelector('input'), calc = box.querySelector('.bal-calc');
    const tendered = () => {
        const v = input.value.replace(/,/g, '');
        return v === '' || v === '.' ? null : Number(v);
    };
    const sync = () => {
        const due = getDue(), t = tendered();
        calc.className = 'bal-calc';
        if (t === null)
            calc.textContent = 'Enter the cash received from the customer.';
        else if (centsOf(t) < centsOf(due)) {
            calc.classList.add('short');
            calc.innerHTML = `Short by <b>${peso((centsOf(due) - centsOf(t)) / 100)}</b>`;
        } else {
            calc.classList.add('ok');
            calc.innerHTML = `Change to return: <b>${peso((centsOf(t) - centsOf(due)) / 100)}</b>`;
        }
        box.querySelectorAll('[data-quick]').forEach(c => {
            const v = c.dataset.quick === 'exact' ? due : Number(c.dataset.quick);
            c.classList.toggle('on', t !== null && centsOf(t) === centsOf(v));
        });
    };
    input.addEventListener('input', () => {   // digits and one dot, 2 decimals
        let v = input.value.replace(/[^\d.]/g, '');
        const dot = v.indexOf('.');
        v = dot >= 0 ? v.slice(0, dot).slice(0, 7) + '.' + v.slice(dot + 1).replace(/\./g, '').slice(0, 2) : v.slice(0, 7);
        if (v !== input.value)
            input.value = v;
        sync();
    });
    box.querySelectorAll('[data-quick]').forEach(c => c.addEventListener('click', () => {
        const due = getDue();
        input.value = c.dataset.quick === 'exact' ? String(Number.isInteger(due) ? due : due.toFixed(2)) : c.dataset.quick;
        sync();
        input.focus();
    }));
    sync();
    return {
        tendered, sync, focus: () => input.focus(),
        reset: () => { input.value = ''; sync(); },
        /* null when fine, otherwise the message to show */
        problem: () => {
            const t = tendered();
            return t === null ? 'Enter the cash received (amount tendered).' : centsOf(t) < centsOf(getDue()) ? 'The cash tendered is less than the amount received.' : null;
        }
    };
}