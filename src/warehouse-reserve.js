import { itemsForOrder, afterOpening } from './warehouse.js';

/**
 * What the open orders have already claimed from the shelf.
 *
 * The shelf count (`items[code].qty`) moves when a label comes out: that is when the
 * goods physically leave. But a sale that came in ten minutes ago has claimed its jars
 * already, label or not, and the number a buyer can still be promised is the shelf
 * minus every such claim. So the Stok page shows three figures per item:
 *
 *   di rak        what is physically there - moves at print time, as before
 *   perlu diproses  what the paid orders not yet printed will take
 *   tersedia      the difference - moves the moment an order arrives
 *
 * The claim is never stored. It is read off the live open orders every time the page is
 * drawn, through the same recipes the shelf uses, so a cancelled order simply stops
 * claiming and an edited one claims what it says now. Nothing to resync, nothing that
 * can drift from the orders. An order the shelf has already counted (its label came out)
 * is left out, or it would be subtracted twice.
 */

/** Paid and waiting for a label: the only stage that claims without having taken. */
const CLAIMING = new Set(['to_ship']);

export function reserveFor(doc, orders) {
  const taken = doc?.orders ?? {};
  const edited = doc?.recipes ?? {};
  const items = {};
  const unknown = new Set();
  let count = 0;
  for (const order of orders ?? []) {
    if (!order?.id || !order.channel || !CLAIMING.has(order.stage)) continue;
    if (!afterOpening(order)) continue;
    const key = `${order.channel}|${order.id}`;
    const seen = taken[key];
    if (seen && !seen.undone) continue;
    const { items: take, unknown: missing } = itemsForOrder(order, edited);
    let claimed = false;
    for (const [code, qty] of Object.entries(take)) { items[code] = (items[code] ?? 0) + qty; claimed = true; }
    for (const sku of missing) unknown.add(sku);
    if (claimed || missing.length) count += 1;
  }
  return { items, orders: count, unknown: [...unknown].sort() };
}

/** The three figures for one item. */
export const figuresFor = (item, reserve, code) => {
  const shelf = Number(item?.qty) || 0;
  const claimed = Number(reserve?.items?.[code]) || 0;
  return { shelf, claimed, available: shelf - claimed };
};
