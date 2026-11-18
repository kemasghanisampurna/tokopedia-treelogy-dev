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

/**
 * What this order needs from the shelf that the shelf does not have.
 *
 * A packer cannot pack goods that are not there, and a label printed for a parcel that
 * cannot be packed is a waybill the courier comes for with nothing to collect. Measured
 * against "di rak" - what is physically there - through the same recipes the shelf uses.
 * An order the shelf already counted (printed before) has taken its goods and is never
 * short; a SKU no recipe knows is not guessed at.
 *
 * @returns {Array<{code, name, need, have}>} empty when the order can be packed
 */
export function shortagesFor(doc, order) {
  if (!doc?.items || !order) return [];
  const items = needsFor(doc, order);
  const short = [];
  for (const [code, need] of Object.entries(items)) {
    const item = doc.items[code];
    if (!item) continue;
    const have = Number(item.qty) || 0;
    if (have < need) short.push({ code, name: item.name ?? code, need, have });
  }
  return short;
}

/**
 * What this order will take off the shelf, {code: qty} - empty when the shelf has
 * already counted it. Written into the packer's row so the page can hold it against
 * the shelf as it moves, without asking for the order again.
 */
export function needsFor(doc, order) {
  if (!order) return {};
  const seen = doc?.orders?.[`${order.channel}|${order.id}`];
  if (seen && !seen.undone) return {};
  return itemsForOrder(order, doc?.recipes ?? {}).items;
}

/**
 * The shelf shared out in turn: which of these parcels the shelf can fill, and which not.
 *
 * Asking each parcel on its own whether "di rak" covers it says yes to every one: three
 * sample oils on the shelf cover any single order that needs one, so fifteen of them
 * were handed to one packer. The shelf is one pile, so the parcels queue for it. First
 * the ones already handed to a packer and not yet printed - they were promised their
 * goods when they were handed over - oldest hand-out first; then the rest in the order
 * given. Each takes its goods off what is left; one the remainder cannot fill is short
 * and takes nothing, so a smaller parcel further down may still fit.
 *
 * Only paid parcels waiting for their label hold goods (as in reserveFor); one the shelf
 * has already counted needs nothing (needsFor).
 *
 * @param {object} doc the shelf
 * @param {Array<object>} orders
 * @param {{orders?: Record<string, {at?: number}>}} [assignments]
 * @param {{fresh?: Iterable<string>}} [opts] keys being handed out right now: they queue
 *   behind every parcel already handed out, wherever they were before
 * @returns {Map<string, Array<{code, name, need, have, shelf}>>} by "channel:id"; empty array when it fits
 */
export function shortagesInTurn(doc, orders, assignments = null, { fresh = [] } = {}) {
  const out = new Map();
  if (!doc?.items) return out;
  const handed = assignments?.orders ?? {};
  const later = new Set(fresh);
  const keyOf = (o) => `${o.channel}:${o.id}`;
  const seen = new Set();
  const list = [];
  for (const o of orders ?? []) {
    if (!o?.id || !o.channel || seen.has(keyOf(o))) continue;
    seen.add(keyOf(o));
    list.push(o);
  }
  const holding = (o) => CLAIMING.has(o.stage) && handed[keyOf(o)] && !later.has(keyOf(o));
  const first = list.filter(holding)
    .sort((a, b) => (Number(handed[keyOf(a)].at) || 0) - (Number(handed[keyOf(b)].at) || 0) || keyOf(a).localeCompare(keyOf(b)));
  const queue = [...first, ...list.filter((o) => !holding(o))];

  const left = {};
  const have = (code) => (code in left ? left[code] : Number(doc.items[code]?.qty) || 0);
  for (const o of queue) {
    const need = needsFor(doc, o);
    const short = [];
    for (const [code, qty] of Object.entries(need)) {
      const item = doc.items[code];
      if (!item) continue;
      if (have(code) < qty) short.push({ code, name: item.name ?? code, need: qty, have: have(code), shelf: Number(item.qty) || 0 });
    }
    if (!short.length) for (const [code, qty] of Object.entries(need)) if (doc.items[code]) left[code] = have(code) - qty;
    out.set(keyOf(o), short);
  }
  return out;
}

/** The shelf as the packer page polls it: {code: {q, n}} - only what is needed to judge. */
export function shelfPulse(doc) {
  const items = {};
  for (const [code, item] of Object.entries(doc?.items ?? {})) items[code] = { q: Number(item?.qty) || 0, n: item?.name ?? code };
  return { at: Date.now(), items };
}

/**
 * The one line a packer reads: "Stok di rak kurang: Capsules 90 (perlu 2, ada 0)". When the
 * shelf has some but other parcels hold them first: "(perlu 1, 3 di rak sudah untuk
 * pesanan lain)" - "ada 0" beside a shelf that says 3 would read as a mistake.
 */
const shortPart = (x) => {
  const shelf = Math.max(0, Number(x.shelf ?? x.have) || 0);
  const have = Math.max(0, x.have);
  if (shelf <= have) return `${x.name} (perlu ${x.need}, ada ${have})`;
  return have > 0
    ? `${x.name} (perlu ${x.need}, sisa ${have} - ${shelf - have} dari ${shelf} di rak sudah untuk pesanan lain)`
    : `${x.name} (perlu ${x.need}, ${shelf} di rak sudah untuk pesanan lain)`;
};
export const shortageText = (short) => (short?.length ? `Stok di rak kurang: ${short.map(shortPart).join(', ')}` : '');
