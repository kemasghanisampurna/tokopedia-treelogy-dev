import { loadCatalog, apiKeyAccepted } from '../src/agent/service.js';

/**
 * GET /api/catalog - prices, free shipping, promos, vouchers and gifts for the Qontak AI
 * agent (action `get_catalog`).
 *
 * No query string and no body on purpose: Qontak's action sends parameters unreliably,
 * so the endpoint asks for nothing. Read-only, public data; CATALOG_API_KEY, when set,
 * still keeps strangers from leaning on it. Nothing from Shopify - no error text, no
 * token, no stack - ever reaches the response.
 */
export default async function handler(req, res, { load = loadCatalog } = {}) {
  const json = (status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
  };

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    json(405, { ok: false, error: 'method_not_allowed' }, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
    return;
  }
  if (!apiKeyAccepted(req.headers['x-api-key'])) {
    json(401, { ok: false, error: 'unauthorized' }, { 'Cache-Control': 'no-store' });
    return;
  }

  let out;
  try {
    out = await load();
  } catch (error) {
    console.error(`catalog: gagal disusun - ${error.message}`);
    out = { status: 503, body: { ok: false, error: 'catalog_unavailable' } };
  }
  json(out.status, out.body, {
    'Cache-Control': out.status === 200 ? 's-maxage=300, stale-while-revalidate=600' : 'no-store',
  });
}
