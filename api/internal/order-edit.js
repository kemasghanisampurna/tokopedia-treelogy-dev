import { timingSafeEqual } from 'node:crypto';
import { orderById, ordersOutstanding } from '../../src/db/orders.js';
import { arrangedOrders, printedLabels } from '../../src/shopify/label.js';
import { printedEntry } from '../../src/labels.js';
import { heldOrders, activeHold, holdOrder, releaseOrder } from '../../src/shopify/hold.js';
import { loadWarehouse } from '../../src/warehouse-run.js';
import { reserveFor, figuresFor } from '../../src/warehouse-reserve.js';
import { recipeOf, itemsForOrder, afterOpening } from '../../src/warehouse.js';

/**
 * What the buyer-facing order editor (treelogy-order-edit, on this same VPS) needs to know
 * from the warehouse, and the one thing it may ask of it.
 *
 *   GET  ?order=%2313987[&skus=OMC-180-001,OMO-30-001]
 *        Whether the order may still be changed, and how many of each SKU the shelf can
 *        still promise to it - its own claim added back, since an edit replaces it.
 *   POST {action:"hold", order, until, ref}   keep it out of arranging and printing while
 *        the buyer pays for a change (src/shopify/hold.js)
 *   POST {action:"release", order, ref}
 *
 * Machine-to-machine only. nginx forwards /api/ to this process, so the route is reachable
 * from outside in principle; it answers nobody who does not carry the shared secret, and
 * nobody whose request came through nginx at all.
 *
 * The rule for "may still be changed" is the one the owner chose on 16 Nov 2026: until the
 * label has been printed. An order on hold is still editable - the hold exists for the edit.
 */

const SECRET = () => process.env.ORDER_EDIT_INTERNAL_SECRET || '';
const NAME = /^#\d{3,10}$/;
const SKU = /^[A-Za-z0-9._+&-]{1,64}$/;
const MAX_SKUS = 30;

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** Loopback, no proxy in front of it, and the right secret - all three. */
export function authorized(req, secret = SECRET()) {
  if (!secret) return false;
  if (req.headers['x-forwarded-for'] || req.headers['x-real-ip']) return false;
  const remote = req.socket?.remoteAddress ?? '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) return false;
  const given = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * The verdict for one stored order. Pure, so it can be tested without a store.
 * @returns {{editable: boolean, reason: string}}
 */
export function editability(order, { printed = {} } = {}) {
  if (!order) return { editable: false, reason: 'not_found' };
  if (order.channel !== 'shopify') return { editable: false, reason: 'not_shopify' };
  if (order.stage === 'cancelled' || order.stage === 'returned') return { editable: false, reason: 'cancelled' };
  if (order.stage === 'unpaid') return { editable: false, reason: 'unpaid' };
  if (order.stage !== 'to_ship') return { editable: false, reason: 'shipped' };
  const entry = printedEntry(printed, order);
  // A label marked printed without printing (a cleared backlog) still means the bench
  // has moved on from this order.
  if (entry) return { editable: false, reason: 'label_printed' };
  return { editable: true, reason: 'ok' };
}

/**
 * Units of each SKU the shelf can still promise to this order.
 *
 * `tersedia` on the Stok page is shelf minus every open order's claim. This order's own
 * claim is part of that, and an edit replaces it, so it is added back before dividing.
 * A SKU with no recipe cannot be checked and comes back as null - the caller decides.
 */
export function availableFor(order, skus, warehouse, openOrders) {
  const reserve = reserveFor(warehouse, openOrders);
  const own = {};
  const counted = warehouse?.orders?.[`${order?.channel}|${order?.id}`];
  if (order && order.stage === 'to_ship' && afterOpening(order) && !(counted && !counted.undone)) {
    for (const [code, qty] of Object.entries(itemsForOrder(order, warehouse?.recipes ?? {}).items)) own[code] = qty;
  }
  const out = {};
  for (const sku of skus) {
    const recipe = recipeOf(sku, warehouse?.recipes ?? {});
    if (!recipe || !Object.keys(recipe).length) { out[sku] = null; continue; }
    let units = Infinity;
    for (const [code, perUnit] of Object.entries(recipe)) {
      const { available } = figuresFor(warehouse?.items?.[code], reserve, code);
      const free = available + (own[code] ?? 0);
      units = Math.min(units, Math.floor(free / Math.max(perUnit, 1)));
    }
    out[sku] = Number.isFinite(units) ? Math.max(units, 0) : null;
  }
  return out;
}

async function readJson(req, limit = 4096) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export default async function handler(req, res) {
  if (!authorized(req)) return send(res, 404, { error: 'not found' });
  const url = new URL(req.url, 'http://localhost');

  try {
    if (req.method === 'GET') {
      const name = String(url.searchParams.get('order') ?? '');
      if (!NAME.test(name)) return send(res, 400, { error: 'order must look like #12345' });
      const skus = String(url.searchParams.get('skus') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (skus.length > MAX_SKUS || skus.some((s) => !SKU.test(s))) return send(res, 400, { error: 'bad skus' });

      const [order, printed, arranged, holds] = await Promise.all([
        orderById('shopify', name),
        printedLabels().catch(() => ({})),
        arrangedOrders().catch(() => ({})),
        heldOrders().catch(() => ({})),
      ]);
      const verdict = editability(order, { printed });
      const body = {
        order: order ? { id: order.id, gid: order.gid, stage: order.stage } : null,
        ...verdict,
        arrangedAt: order ? (arranged[order.id]?.at ?? null) : null,
        printedAt: order ? (printedEntry(printed, order)?.first ?? null) : null,
        hold: order ? activeHold(holds, order) : null,
      };
      if (skus.length && order) {
        const [warehouse, open] = await Promise.all([loadWarehouse(), ordersOutstanding()]);
        body.available = availableFor(order, skus, warehouse, open);
      }
      return send(res, 200, body);
    }

    if (req.method === 'POST') {
      const input = await readJson(req);
      const name = String(input.order ?? '');
      if (!NAME.test(name)) return send(res, 400, { error: 'order must look like #12345' });
      const ref = String(input.ref ?? '').slice(0, 80);
      if (!ref) return send(res, 400, { error: 'ref required' });

      if (input.action === 'hold') {
        const order = await orderById('shopify', name);
        const verdict = editability(order, { printed: await printedLabels().catch(() => ({})) });
        // Never hold an order the bench has already moved past: the hold would hide a
        // parcel that is physically on its way.
        if (!verdict.editable) return send(res, 409, verdict);
        const hold = await holdOrder(name, { until: Number(input.until), ref });
        console.log(`internal/order-edit: ${name} ditahan sampai ${new Date(hold.until * 1000).toISOString()} (${ref})`);
        return send(res, 200, { held: true, hold });
      }
      if (input.action === 'release') {
        const released = await releaseOrder(name, { ref });
        console.log(`internal/order-edit: ${name} ${released ? 'dilepas' : 'tidak ditahan oleh'} (${ref})`);
        return send(res, 200, { released });
      }
      return send(res, 400, { error: 'unknown action' });
    }

    return send(res, 405, { error: 'method not allowed' });
  } catch (error) {
    console.error('internal/order-edit failed:', error.message);
    return send(res, 500, { error: 'internal error' });
  }
}
