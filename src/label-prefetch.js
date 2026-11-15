import { buildLabelSheet } from './labels.js';
import { fetchOrdersByIds } from './omni.js';
import { ordersForPrinting } from './orders-by-id.js';
import { rasterizePdf } from './label-raster.js';

/**
 * Marketplace labels, rendered before anybody asks for them.
 *
 * A Shopee waybill is created, polled and downloaded from Shopee, a TikTok one fetched
 * from TikTok: two to ten seconds that used to sit between the button and the printer.
 * The waybill does not change once the parcel is arranged, so it is fetched and rendered
 * while the label page is being looked at, and the press only has to queue what is
 * already here. Kept in memory: a restart loses it and the next page view refills it.
 *
 * Shopify and typed-in labels are drawn by us in tens of milliseconds and carry the
 * print time and the pick number, so they are drawn at the press, never ahead.
 */

const TTL_MS = 12 * 3600_000;
const MAX_AHEAD = 40;
const PARALLEL = 3;
const MARKETPLACE = new Set(['shopee', 'tiktok_shop', 'tokopedia']);

const cache = new Map(); // key -> { at, pages: string[] (base64 TSPL) }
const inFlight = new Set();

export const labelKey = (o) => `${o.channel}:${o.id}`;
export const aheadOfTime = (o) => MARKETPLACE.has(o.channel);

/** The resolvers the print route uses; the same ones, so the labels are the same. */
export const resolvers = {
  resolvePackages: async (tiktokOrders) => {
    const { orders, errors } = await fetchOrdersByIds(tiktokOrders);
    if (orders.length === 0 && Object.keys(errors).length > 0) throw new Error(Object.values(errors)[0]);
    return orders;
  },
  resolveShopify: async (rows) => {
    const { orders, errors } = await ordersForPrinting(rows);
    if (orders.length === 0 && Object.keys(errors).length > 0) throw new Error(Object.values(errors)[0]);
    return orders.filter((o) => o.channel === 'shopify' || o.channel === 'manual');
  },
};

export function cachedPages(order, now = Date.now()) {
  const hit = cache.get(labelKey(order));
  if (!hit) return null;
  if (now - hit.at > TTL_MS) { cache.delete(labelKey(order)); return null; }
  return hit.pages;
}

export function rememberPages(order, pages, now = Date.now()) {
  cache.set(labelKey(order), { at: now, pages });
  // Never more than a shelf's worth.
  if (cache.size > MAX_AHEAD * 3) {
    for (const key of [...cache.keys()].slice(0, cache.size - MAX_AHEAD * 3)) cache.delete(key);
  }
}

export function forgetPages(order) { cache.delete(labelKey(order)); }
export const cacheSize = () => cache.size;
export const resetPrefetch = () => { cache.clear(); inFlight.clear(); };

/** Render one order's label through the normal sheet builder, as TSPL pages. */
export async function renderOrder(order, { build = buildLabelSheet, raster = rasterizePdf } = {}) {
  const sheet = await build({ orders: [{ id: order.id, channel: order.channel, stage: order.stage, status: order.status }], ...resolvers });
  if (sheet.failures?.length && sheet.groups.length === 0) throw new Error(sheet.failures[0].reason || 'label tidak tersedia');
  const pages = [];
  for (const group of sheet.groups) {
    // eslint-disable-next-line no-await-in-loop
    for (const tspl of await raster(group.bytes)) pages.push(Buffer.from(tspl).toString('base64'));
  }
  if (pages.length === 0) throw new Error('label kosong');
  return pages;
}

/**
 * Fetch and render what the page shows as ready to print, a few at a time, in the
 * background. Returns at once; failures are quiet - the press will try again and say
 * what went wrong then.
 */
export function prefetchLabels(orders, { render = renderOrder, log = console } = {}) {
  const wanted = orders.filter(aheadOfTime).filter((o) => !cachedPages(o) && !inFlight.has(labelKey(o))).slice(0, MAX_AHEAD);
  if (wanted.length === 0) return Promise.resolve(0);
  for (const o of wanted) inFlight.add(labelKey(o));
  let done = 0;
  const queue = [...wanted];
  const worker = async () => {
    while (queue.length) {
      const order = queue.shift();
      try {
        // eslint-disable-next-line no-await-in-loop
        rememberPages(order, await render(order));
        done += 1;
      } catch (error) {
        log.warn?.(`labels: siapkan ${labelKey(order)} gagal - ${error.message}`);
      } finally {
        inFlight.delete(labelKey(order));
      }
    }
  };
  return Promise.all(Array.from({ length: Math.min(PARALLEL, wanted.length) }, worker)).then(() => {
    if (done) log.log?.(`labels: ${done} label gudang disiapkan lebih dulu`);
    return done;
  });
}
