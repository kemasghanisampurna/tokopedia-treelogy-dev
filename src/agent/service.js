import crypto from 'node:crypto';
import { fetchWithTimeout } from '../http.js';
import { cached, invalidate } from '../cache.js';
import { STOREFRONT, VARIANT_MAP, buildCatalog } from './catalog.js';
import { loadAgentConfig, defaultConfig } from './config-store.js';

/**
 * The catalogue as the bot receives it, assembled from its two sources.
 *
 * Prices come from the public storefront feed - the same numbers a buyer sees, no token -
 * and are cached for a minute in this process, with ten more minutes of "stale but fine"
 * so a slow treelogy.com never makes the bot wait. The offers are read from the store on
 * every call: it is local Redis, and a save on the dashboard has to be what the very next
 * WhatsApp answer says.
 */

export const STOREFRONT_FEED = `${STOREFRONT}/products.json?limit=250`;
const FEED_TIMEOUT_MS = 5_000;
const FEED_TTL_MS = 60_000;
const FEED_STALE_MS = 10 * 60_000;
const WANTED = new Set(VARIANT_MAP.map((row) => row.handle));

/** Only what the payload needs: products.json carries body_html and images for every listing. */
const slim = (product) => ({
  handle: product.handle,
  variants: (product.variants ?? []).map((v) => ({
    id: v.id, title: v.title, price: v.price, compare_at_price: v.compare_at_price, available: v.available,
  })),
});

export async function fetchStorefrontProducts({ fetchImpl = fetchWithTimeout } = {}) {
  const response = await fetchImpl(STOREFRONT_FEED, { timeout: FEED_TIMEOUT_MS, headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`products.json HTTP ${response.status}`);
  const data = await response.json();
  if (!Array.isArray(data?.products)) throw new Error('products.json tanpa daftar produk');
  return data.products.filter((p) => WANTED.has(p?.handle)).map(slim);
}

export const storefrontProducts = (options) =>
  cached('agent:storefront', FEED_TTL_MS, () => fetchStorefrontProducts(options), { staleMs: FEED_STALE_MS });

/** For the dashboard's "ambil harga sekarang". */
export const forgetStorefront = () => invalidate('agent:storefront');

/**
 * @returns {Promise<{status: 200|503, body: object, warnings?: object[], meta?: object, today?: string}>}
 */
export async function loadCatalog({ products = storefrontProducts, config = loadAgentConfig, now = new Date() } = {}) {
  const [feed, cfg] = await Promise.allSettled([products(), config()]);
  if (feed.status === 'rejected') {
    console.warn(`agent: katalog tidak tersedia - ${feed.reason?.message ?? feed.reason}`);
    return { status: 503, body: { ok: false, error: 'catalog_unavailable' } };
  }
  // loadAgentConfig never rejects; a stand-in that does is treated like a broken store.
  const settled = cfg.status === 'fulfilled'
    ? cfg.value
    : { config: defaultConfig(), source: 'fallback', problem: 'config tidak terbaca', updatedAt: null, updatedBy: null };
  const built = buildCatalog({ storefrontProducts: feed.value, config: settled.config, configSource: settled.source, now });
  if (built.warnings.length) {
    console.warn(`agent: ${built.warnings.length} varian tidak cocok lewat id - ${built.warnings.map((w) => `${w.key}:${w.how}`).join(', ')}`);
  }
  return { status: 200, body: built.body, warnings: built.warnings, meta: settled, today: built.today };
}

/** Constant-time comparison of the x-api-key header with CATALOG_API_KEY. */
export function apiKeyAccepted(given, expected = process.env.CATALOG_API_KEY) {
  if (!expected) return true;
  const digest = (value) => crypto.createHash('sha256').update(String(value ?? '')).digest();
  return crypto.timingSafeEqual(digest(given), digest(expected));
}
