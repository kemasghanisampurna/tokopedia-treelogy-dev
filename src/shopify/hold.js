import { readDoc, updateDoc } from '../store/index.js';

/**
 * Shopify orders a buyer is in the middle of changing.
 *
 * The thank-you page lets a buyer fix their own order (treelogy-order-edit on this VPS).
 * When the fix costs more, they pay the difference by QRIS, which takes minutes, and the
 * edit is only applied once the money has arrived. If the bench arranged and printed the
 * order in that window, the parcel would leave with the old contents and the new ones
 * would be paid for and never sent.
 *
 * So for exactly that window the order is held: it drops out of the arrange queue and its
 * label waits. The hold carries its own expiry - the QR's - so an order is never stuck
 * because the service that asked for the hold went away without releasing it.
 */

export const HELD_DOC = 'shopify/held.json';
const EMPTY = { version: 1, held: {} };

/** No hold may outlive this, whatever the caller asks for. */
export const MAX_HOLD_SECONDS = 45 * 60;

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Every hold on file, expired ones included; `activeHold` decides what still counts. */
export async function heldOrders() {
  const doc = await readDoc(HELD_DOC).catch(() => null);
  return doc?.held ?? {};
}

/** The hold on this order if it is still running, else null. */
export function activeHold(holds, order, now = nowSeconds()) {
  if (order?.channel !== 'shopify') return null;
  const hold = holds?.[order.id];
  return hold && Number(hold.until) > now ? hold : null;
}

/**
 * Hold an order until `until` (epoch seconds), on behalf of `ref` - the edit that asked.
 *
 * A second hold from the same edit extends it; one from a different edit replaces it, so
 * whichever edit the buyer is paying for now is the one the hold belongs to.
 *
 * @param {string} id the order name, exactly as it is stored ("#13987")
 */
export async function holdOrder(id, { until, ref, now = nowSeconds() } = {}) {
  if (!id) throw new Error('hold: tidak ada pesanan');
  if (!ref) throw new Error('hold: tidak ada referensi edit');
  const capped = Math.min(Number(until) || 0, now + MAX_HOLD_SECONDS);
  if (capped <= now) throw new Error('hold: waktu berakhir sudah lewat');
  let saved = null;
  await updateDoc(HELD_DOC, (current) => {
    const next = current ?? structuredClone(EMPTY);
    // Expired entries are dropped on every write, so the document never grows.
    for (const [key, hold] of Object.entries(next.held)) if (Number(hold.until) <= now) delete next.held[key];
    saved = { until: capped, ref: String(ref), at: now };
    next.held[id] = saved;
    return next;
  }, structuredClone(EMPTY));
  return saved;
}

/**
 * Release a hold, but only the one this edit placed. A late release from an edit the buyer
 * abandoned must not lift the hold of the edit they are paying for now.
 *
 * @returns {Promise<boolean>} whether a hold was lifted
 */
export async function releaseOrder(id, { ref, now = nowSeconds() } = {}) {
  let released = false;
  await updateDoc(HELD_DOC, (current) => {
    const next = current ?? structuredClone(EMPTY);
    for (const [key, hold] of Object.entries(next.held)) if (Number(hold.until) <= now) delete next.held[key];
    const hold = next.held[id];
    if (hold && (!ref || hold.ref === String(ref))) {
      delete next.held[id];
      released = true;
    }
    return next;
  }, structuredClone(EMPTY));
  return released;
}

/**
 * Mark held orders on a worklist, so the queue and the label page can leave them be.
 * The flag rides on the order itself, which is what nextAction and labelReadiness see.
 */
export function withHolds(data, holds, now = nowSeconds()) {
  if (!data?.orders?.length || !holds || !Object.keys(holds).length) return data;
  return {
    ...data,
    orders: data.orders.map((order) => {
      const hold = activeHold(holds, order, now);
      return hold ? { ...order, heldUntil: Number(hold.until) } : order;
    }),
  };
}

/** Whether an order carries a hold that has not run out. */
export const isHeld = (order, now = nowSeconds()) => Number(order?.heldUntil) > now;
