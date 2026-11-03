/* =====================================================================
   customer/cart.js - shared equipment cart and combined stock rules
   Studio add-ons and outside rent share the same stock. For one item:
       total stock = quantity in Studio Add-ons + quantity in Outside Rent + what is still selectable.
   Every screen that picks equipment (Rent tab, Browse equipment window) uses these helpers.
   ===================================================================== */

import { state } from './state.js';
import { EQUIPMENT } from '../shared/catalog.js';

export const CTX_LABEL = {
    addon: 'Studio Add-ons',
    book: 'the booking form add-ons',
    out: 'Outside Rent'
};

const CTXS = ['addon', 'book', 'out'];

/* quantity of an item held in every cart except `ctx` */
const heldElsewhere = (ctx, id) => CTXS.filter(k => k !== ctx).reduce((n, k) => n + qtyIn(k, id), 0);

/* quantity of an equipment item held in one cart ('addon', 'book' or 'out') */
export const qtyIn = (ctx, id) => +state.cart[ctx][id] || 0;

/* how many more of this item can be added to `ctx` (what the other carts hold is already taken) */
export const remainingFor = (ctx, id) => {
    const e = EQUIPMENT.find(x => x.id === +id);
    return e ? Math.max(0, e.stock - heldElsewhere(ctx, id) - qtyIn(ctx, id)) : 0;
};

/* the most that `ctx` may hold of this item (its own quantity plus what is still free) */
export const maxFor = (ctx, id) => qtyIn(ctx, id) + remainingFor(ctx, id);

/* Sets the quantity of an item in `ctx`, never above the combined stock.
   Returns { q: quantity now held, capped: true when the request was cut down to fit the stock }. */
export function setQty(ctx, id, want) {
    const q = Math.max(0, Math.min(Math.floor(+want) || 0, maxFor(ctx, id)));
    if (q > 0)
        state.cart[ctx][id] = q;
    else
        delete state.cart[ctx][id];
    return {
        q,
        capped: q < Math.max(0, Math.floor(+want) || 0)
    };
}

/* Sentence for the alert: where the item's stock is held right now. */
export function allocationMessage(id) {
    const e = EQUIPMENT.find(x => x.id === +id);
    const a = qtyIn('addon', id), b = qtyIn('book', id), o = qtyIn('out', id);
    const held = [];
    if (a)
        held.push(`${a} allocated in Studio Add-ons`);
    if (b)
        held.push(`${b} in the booking form add-ons`);
    if (o)
        held.push(`${o} in Outside Rent`);
    const list = held.length > 1 ? held.slice(0, -1).join(', ') + ' and ' + held[held.length - 1] : held[0];
    return {
        name: e ? e.name : 'this item',
        stock: e ? e.stock : 0,
        addon: a,
        book: b,
        out: o,
        text: `You have reached the maximum available stock of ${e ? e.stock : 0}. ` +
            (list ? `You currently have ${list}.` : 'None of it is allocated yet.')
    };
}

/* empties the add-on cart after the studio booking or add-on request was sent */
export const clearCart = ctx => {
    Object.keys(state.cart[ctx]).forEach(k => delete state.cart[ctx][k]);
};

/* drops cart lines whose equipment is gone or no longer offered, and cuts quantities to fit the (reloaded) stock */
export function trimCartToStock() {
    CTXS.forEach(ctx => {
        Object.keys(state.cart[ctx]).forEach(id => {
            const e = EQUIPMENT.find(x => x.id === +id);
            if (!e || (ctx === 'out' ? !e.outside : !e.addon))
                delete state.cart[ctx][id];
            else {
                const left = e.stock - heldElsewhere(ctx, id);
                if (left <= 0)
                    delete state.cart[ctx][id];
                else if (state.cart[ctx][id] > left)
                    state.cart[ctx][id] = left;
            }
        });
    });
}
