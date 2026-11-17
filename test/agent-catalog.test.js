import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VARIANT_MAP, BLOCKED_HANDLES, rupiahText, witaToday, witaIso, itemStatus, activeItems, normalizeTitle,
  findVariant, catalogProducts, buildCatalog, validateConfig, cleanItem, slugId,
} from '../src/agent/catalog.js';
import { loadAgentConfig, saveShipping, saveItem, deleteItem, defaultConfig, CONFIG_DOC } from '../src/agent/config-store.js';
import { loadCatalog, apiKeyAccepted, fetchStorefrontProducts } from '../src/agent/service.js';
import catalogHandler from '../api/catalog.js';
import { renderAgent } from '../src/pages/agent.js';
import { deleteDoc, writeDoc, readDoc, closeStore } from '../src/store/index.js';

/**
 * The brief's acceptance list (BRIEF_api_catalog_treelogy_1.md §8), proved here rather
 * than by asking the bot: which listing counts, how a price is written, when a voucher
 * stops being offered, and what the endpoint says when a source is down.
 */

test.after(async () => { await closeStore(); });
test.beforeEach(async () => { await deleteDoc(CONFIG_DOC); });

/** A storefront shaped like treelogy.com/products.json on 17 Nov 2026, decoys included. */
const PRICES = {
  kapsul_90: ['455000.00', null], kapsul_180: ['795000.00', '910000.00'], kapsul_270: ['1145000.00', '1365000.00'],
  powder_45: ['370000.00', null], powder_90: ['625000.00', '740000.00'], powder_180: ['1145000.00', '1480000.00'],
  oil_30: ['470000.00', null], oil_60: ['790000.00', '940000.00'],
  insideout_30: ['810000.00', '925000.00'], insideout_60: ['1045000.00', '1265000.00'],
  discovery: ['1165000.00', '1295000.00'], ritual_set: ['760000.00', null], ritual_starter: ['1015000.00', '1130000.00'],
  ritual_daily: ['1175000.00', '1385000.00'], ritual_complete: ['1520000.00', '1905000.00'],
  whisk: ['290000.00', '520000.00'], scoop: ['90000.00', '120000.00'],
};
function storefront({ dropIds = false } = {}) {
  const byHandle = new Map();
  for (const row of VARIANT_MAP) {
    const product = byHandle.get(row.handle) ?? { handle: row.handle, variants: [] };
    const [price, compare] = PRICES[row.key];
    product.variants.push({ id: dropIds ? row.id + 1 : row.id, title: row.title, price, compare_at_price: compare, available: true });
    byHandle.set(row.handle, product);
  }
  // The listings the brief warns about: other prices, Rp0, same-looking titles.
  const decoys = [
    { handle: 'inside-out-moringa-protocol', variants: [{ id: 1, title: '90 Moringa Capsules + 30ml Moringa Oil', price: '925000.00', available: true }, { id: 2, title: '180 Moringa Capsules + 30ml Moringa Oil', price: '1265000.00', available: true }] },
    { handle: 'bamboo-scoop', variants: [{ id: 3, title: 'Default Title', price: '0.00', available: true }] },
    { handle: 'organic-moringa-capsules-1', variants: [{ id: 4, title: '90 Moringa Capsules', price: '399000.00', available: true }] },
  ];
  return [...decoys, ...byHandle.values()];
}

const NOV17 = new Date('2026-11-17T06:05:00Z'); // 14:05 WITA

/* ------------------------------------------------------------------ products */

test('17 products, exactly in the order and keys of the brief', () => {
  const { body } = buildCatalog({ storefrontProducts: storefront(), config: defaultConfig(), configSource: 'dashboard', now: NOV17 });
  assert.deepEqual(body.products.map((p) => p.key), [
    'kapsul_90', 'kapsul_180', 'kapsul_270', 'powder_45', 'powder_90', 'powder_180', 'oil_30', 'oil_60',
    'insideout_30', 'insideout_60', 'discovery', 'ritual_set', 'ritual_starter', 'ritual_daily', 'ritual_complete', 'whisk', 'scoop',
  ]);
  assert.ok(body.products.every((p) => p.url === `https://treelogy.com/products/${VARIANT_MAP.find((r) => r.key === p.key).handle}`));
});

test('prices come from the whitelisted handles only, never from the decoys', () => {
  const { products } = catalogProducts(storefront());
  const price = (key) => products.find((p) => p.key === key).price;
  assert.equal(price('kapsul_90'), 455000);
  assert.equal(price('powder_45'), 370000);
  assert.equal(price('insideout_30'), 810000, 'bukan 925.000 dari listing dobel');
  assert.equal(price('insideout_60'), 1045000, 'bukan 1.265.000 dari listing dobel');
  assert.equal(price('scoop'), 90000, 'bukan Rp0 dari bamboo-scoop');
  assert.ok(BLOCKED_HANDLES.includes('inside-out-moringa-protocol'));
});

test('price_text reads "Rp 1.145.000": dots, no ,00, no IDR', () => {
  assert.equal(rupiahText(1145000), 'Rp 1.145.000');
  assert.equal(rupiahText('455000.00'), 'Rp 455.000');
  assert.equal(rupiahText(90000), 'Rp 90.000');
  assert.equal(rupiahText(0), 'Rp 0');
  const { products } = catalogProducts(storefront());
  for (const p of products) assert.match(p.price_text, /^Rp \d{1,3}(\.\d{3})*$/);
  assert.equal(products.find((p) => p.key === 'kapsul_90').compare_at_price_text, null);
  assert.equal(products.find((p) => p.key === 'kapsul_180').compare_at_price_text, 'Rp 910.000');
});

test('a variant whose title has a double space is still matched once its pinned id is gone', () => {
  assert.equal(normalizeTitle('Up to  30 servings'), normalizeTitle('up to 30 SERVINGS '));
  const products = new Map([['organic-moringa-powder', { handle: 'organic-moringa-powder', variants: [{ id: 999, title: 'Up to 30 servings', price: '370000.00', available: true }] }]]);
  const row = VARIANT_MAP.find((r) => r.key === 'powder_45');
  const { variant, how } = findVariant(products, row);
  assert.equal(how, 'title');
  assert.equal(variant.id, 999);

  const { products: rows, warnings } = catalogProducts(storefront({ dropIds: true }));
  assert.equal(rows.find((p) => p.key === 'powder_45').price, 370000);
  assert.equal(warnings.length, 17, 'setiap kecocokan lewat judul dicatat');
});

test('a whitelisted variant that is missing is unavailable with no price, not an error', () => {
  const shop = storefront().filter((p) => p.handle !== 'bamboo-whisk');
  const { products, warnings } = catalogProducts(shop);
  const whisk = products.find((p) => p.key === 'whisk');
  assert.deepEqual([whisk.available, whisk.price, whisk.price_text], [false, null, null]);
  assert.deepEqual(warnings, [{ key: 'whisk', how: 'missing_product' }]);
});

/* --------------------------------------------------------------------- dates */

test('dates are WITA and ends_at is inclusive: HARGATETAP shows on 30 Nov, gone on 1 Dec', () => {
  const voucher = defaultConfig().vouchers.find((v) => v.code === 'HARGATETAP');
  // 30 Nov 23:59 WITA = 30 Nov 15:59 UTC; 1 Dec 00:00 WITA = 30 Nov 16:00 UTC.
  assert.equal(witaToday(new Date('2026-11-30T15:59:59Z')), '2026-11-30');
  assert.equal(witaToday(new Date('2026-11-30T16:00:00Z')), '2026-12-01');
  assert.equal(itemStatus(voucher, '2026-11-30'), 'active');
  assert.equal(itemStatus(voucher, '2026-12-01'), 'expired');
  const on = (iso) => buildCatalog({ storefrontProducts: storefront(), config: defaultConfig(), configSource: 'dashboard', now: new Date(iso) }).body.vouchers;
  assert.equal(on('2026-11-30T15:59:59Z').length, 1);
  assert.equal(on('2026-11-30T16:00:00Z').length, 0);
});

test('starts_at holds an offer back until its day; null means no limit', () => {
  const items = [{ id: 'a', starts_at: '2026-12-01', ends_at: null }, { id: 'b', starts_at: null, ends_at: null }];
  assert.deepEqual(activeItems(items, '2026-11-30').map((i) => i.id), ['b']);
  assert.deepEqual(activeItems(items, '2026-12-01').map((i) => i.id), ['a', 'b']);
  assert.equal(witaIso(NOV17), '2026-11-17T14:05:00+08:00');
});

/* -------------------------------------------------------------------- config */

test('the response follows the brief: amounts as numbers and text, gift_active, small', () => {
  const config = { ...defaultConfig(), gifts: [{ id: 'g', name: 'Mystery Gift', detail: 'Gratis untuk Inside Out 60 hari.', applies_to: ['insideout_60'], url: 'https://treelogy.com/pages/x', starts_at: null, ends_at: '2026-12-31' }] };
  const { body } = buildCatalog({ storefrontProducts: storefront(), config, configSource: 'dashboard', now: NOV17 });
  assert.equal(body.ok, true);
  assert.equal(body.config_source, 'dashboard');
  assert.deepEqual(body.free_shipping, { min_amount: 700000, min_amount_text: 'Rp 700.000', scope: 'Khusus pembelian di website treelogy.com, seluruh Indonesia' });
  assert.equal(body.gift_active, true);
  assert.deepEqual(Object.keys(body.promos[0]), ['id', 'name', 'detail', 'code', 'ends_at']);
  assert.ok(Buffer.byteLength(JSON.stringify(body)) < 8 * 1024, 'di bawah 8 KB');
  assert.ok(!JSON.stringify(body).includes('body_html'));
});

test('a gift rides on its variant row: products[].gift names it, only while it is active', () => {
  const config = { ...defaultConfig(), gifts: [
    { id: 'hadiah_kapsul_270', name: 'Gratis Moringa Seed Oil 3 ml', detail: 'x', applies_to: ['kapsul_270'], url: null, starts_at: null, ends_at: null },
    { id: 'hadiah_insideout_60', name: 'Gratis Travel Pouch', detail: 'x', applies_to: ['insideout_60'], url: null, starts_at: null, ends_at: '2026-11-16' },
  ] };
  const { body } = buildCatalog({ storefrontProducts: storefront(), config, configSource: 'dashboard', now: NOV17 });
  const row = (key) => body.products.find((p) => p.key === key);
  assert.equal(row('kapsul_270').gift, 'Gratis Moringa Seed Oil 3 ml');
  assert.equal(row('insideout_60').gift, null, 'hadiah yang sudah berakhir tidak dikirim');
  assert.equal(row('kapsul_90').gift, null);
  assert.deepEqual(body.gifts.map((g) => g.id), ['hadiah_kapsul_270']);
  assert.deepEqual(Object.keys(row('kapsul_90')), ['key', 'name', 'price', 'price_text', 'compare_at_price_text', 'available', 'gift', 'url']);
});

test('a missing, broken or unreadable stored config falls back to the defaults and says so', async () => {
  assert.equal((await loadAgentConfig()).source, 'fallback', 'belum pernah disimpan');
  await writeDoc(CONFIG_DOC, { version: 1, config: { free_shipping: { min_amount: 'banyak' } } });
  const broken = await loadAgentConfig();
  assert.equal(broken.source, 'fallback');
  assert.match(broken.problem, /tidak valid/);
  assert.equal(broken.config.free_shipping.min_amount, 700000);
  const down = await loadAgentConfig({ read: async () => { throw new Error('redis mati'); } });
  assert.equal(down.source, 'fallback');
});

test('validation refuses what would confuse the bot', () => {
  assert.throws(() => cleanItem('vouchers', { id: 'v1', name: 'V', detail: 'x' }), /wajib punya kode/);
  assert.throws(() => cleanItem('promos', { id: 'p1', name: 'P', detail: 'x', starts_at: '2026-12-02', ends_at: '2026-12-01' }), /tidak boleh setelah/);
  assert.throws(() => cleanItem('promos', { id: 'p1', name: 'P', detail: 'x', ends_at: '2026-02-30' }), /YYYY-MM-DD/);
  assert.throws(() => cleanItem('gifts', { id: 'g1', name: 'G', detail: 'x', applies_to: ['kapsul_999'] }), /tidak dikenal/);
  assert.throws(() => cleanItem('gifts', { id: 'g1', name: 'G', detail: 'x', url: 'https://evil.example/' }), /treelogy\.com/);
  assert.equal(cleanItem('vouchers', { id: 'v1', name: 'V', detail: 'x', code: 'hargatetap' }).code, 'HARGATETAP');
  assert.throws(() => validateConfig({ ...defaultConfig(), promos: [defaultConfig().promos[0], defaultConfig().promos[0]] }), /dua kali/);
  assert.equal(slugId('Voucher harga lama!'), 'voucher_harga_lama');
  assert.ok(!slugId('Gratis Moringa Seed Oil 3 ml di halaman promo').endsWith('_'), 'tidak berakhir garis bawah setelah dipotong');
});

test('saving stores a whole valid config, with who saved it, and edits and deletes by id', async () => {
  const by = { id: 'u1', name: 'Dewi', email: 'd@x' };
  const ship = await saveShipping({ min_amount: '650000', scope: 'Seluruh Indonesia' }, by);
  assert.equal(ship.changed, true);
  assert.equal(ship.before.min_amount, 700000);
  const added = await saveItem('gifts', { name: 'Travel Pouch', detail: 'Gratis pouch.', applies_to: ['insideout_60'] }, '', by);
  assert.equal(added.after.id, 'hadiah_insideout_60', 'hadiah satu varian dinamai menurut variannya');
  const again = await saveItem('gifts', { name: 'Travel Pouch', detail: 'Lagi.', applies_to: ['insideout_60'] }, '', by);
  assert.equal(again.after.id, 'hadiah_insideout_60_2', 'id yang sudah dipakai diberi nomor');
  const edited = await saveItem('vouchers', { name: 'Voucher harga lama', code: 'HARGATETAP', detail: 'Baru.', ends_at: '2026-12-15' }, 'hargatetap', by);
  assert.equal(edited.before.ends_at, '2026-11-30');
  assert.equal(edited.after.ends_at, '2026-12-15');
  await deleteItem('gifts', 'hadiah_insideout_60_2', by);
  await assert.rejects(() => deleteItem('gifts', 'hadiah_insideout_60_2', by), /sudah tidak ada/);

  const stored = await readDoc(CONFIG_DOC);
  assert.equal(stored.updatedBy.name, 'Dewi');
  const loaded = await loadAgentConfig();
  assert.equal(loaded.source, 'dashboard');
  assert.equal(loaded.config.free_shipping.min_amount, 650000);
  assert.deepEqual(loaded.config.gifts.map((g) => g.id), ['hadiah_insideout_60']);
});

/* ------------------------------------------------------------------ endpoint */

function call(handler, { method = 'GET', headers = {} } = {}, deps) {
  return new Promise((resolve) => {
    const res = {
      status: 0, headers: {}, body: '',
      writeHead(status, h) { this.status = status; Object.assign(this.headers, h); },
      end(chunk) { this.body = chunk ?? ''; resolve(this); },
    };
    handler({ method, headers }, res, deps);
  });
}

test('the endpoint answers 200 with cache headers, and 503 catalog_unavailable when products.json is down', async () => {
  const ok = await call(catalogHandler, {}, { load: () => loadCatalog({ products: async () => storefront(), now: NOV17 }) });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(ok.headers['Cache-Control'], 's-maxage=300, stale-while-revalidate=600');
  assert.equal(JSON.parse(ok.body).products.length, 17);

  const down = await call(catalogHandler, {}, { load: () => loadCatalog({ products: async () => { throw new Error('ECONNRESET token=shpat_secret'); } }) });
  assert.equal(down.status, 503);
  assert.deepEqual(JSON.parse(down.body), { ok: false, error: 'catalog_unavailable' });
  assert.ok(!down.body.includes('shpat'), 'tidak ada error mentah di response');
});

test('only the config failing still answers 200, from the fallback', async () => {
  const out = await loadCatalog({ products: async () => storefront(), config: async () => { throw new Error('x'); }, now: NOV17 });
  assert.equal(out.status, 200);
  assert.equal(out.body.config_source, 'fallback');
});

test('CATALOG_API_KEY: a wrong or missing x-api-key is 401; unset means open', async () => {
  const load = () => loadCatalog({ products: async () => storefront(), now: NOV17 });
  process.env.CATALOG_API_KEY = 'rahasia-qontak';
  try {
    assert.equal((await call(catalogHandler, { headers: { 'x-api-key': 'salah' } }, { load })).status, 401);
    assert.equal((await call(catalogHandler, {}, { load })).status, 401);
    assert.equal((await call(catalogHandler, { headers: { 'x-api-key': 'rahasia-qontak' } }, { load })).status, 200);
  } finally {
    delete process.env.CATALOG_API_KEY;
  }
  assert.equal(apiKeyAccepted(undefined), true);
  assert.equal((await call(catalogHandler, { method: 'POST' }, { load })).status, 405);
});

test('the storefront read keeps only the whitelisted handles and the fields the payload needs', async () => {
  const fetchImpl = async (url, init) => {
    assert.equal(url, 'https://treelogy.com/products.json?limit=250');
    assert.equal(init.timeout, 5000);
    return { ok: true, json: async () => ({ products: [{ handle: 'bamboo-whisk', body_html: '<p>x</p>', images: [1], variants: [{ id: 1, title: 'Bamboo Whisk', price: '290000.00', compare_at_price: null, available: true, sku: 'W' }] }, { handle: 'mystery-gift', variants: [] }] }) };
  };
  const products = await fetchStorefrontProducts({ fetchImpl });
  assert.deepEqual(products, [{ handle: 'bamboo-whisk', variants: [{ id: 1, title: 'Bamboo Whisk', price: '290000.00', compare_at_price: null, available: true }] }]);
  await assert.rejects(() => fetchStorefrontProducts({ fetchImpl: async () => ({ ok: false, status: 502 }) }), /502/);
});

/* --------------------------------------------------------------- dashboard */

const { handleWrite } = await import('../api/dashboard.js');
const owner = { id: 'owner', email: 'o@x', name: 'Owner', role: 'owner', status: 'active' };
const viewer = { id: 'v', email: 'v@x', name: 'Viewer', role: 'viewer', status: 'active' };
const form = (pairs) => { const f = new URLSearchParams(); for (const [k, v] of pairs) f.append(k, v); return f; };

test('a viewer cannot change what the bot says', async () => {
  await assert.rejects(() => handleWrite(form([['action', 'agent_shipping'], ['min_amount', '1'], ['scope', 'x']]), '127.0.0.1', viewer, 'c'), /hanya bisa melihat/);
  assert.equal(await readDoc(CONFIG_DOC), null);
});

test('dashboard writes return an activity-log entry with before and after', async () => {
  const ship = await handleWrite(form([['action', 'agent_shipping'], ['min_amount', '650000'], ['scope', 'Seluruh Indonesia']]), '127.0.0.1', owner, 'c');
  assert.equal(ship.view, 'agent');
  assert.equal(ship.audit.menu, 'agent');
  assert.deepEqual(ship.audit.changes[0], { field: 'minimal belanja', from: 'Rp 700.000', to: 'Rp 650.000' });

  const gift = await handleWrite(form([['action', 'agent_item_save'], ['kind', 'gifts'], ['name', 'Mystery Gift'], ['detail', 'Gratis.'], ['applies_to', 'insideout_60'], ['applies_to', 'insideout_30'], ['ends_at', '2026-12-31']]), '127.0.0.1', owner, 'c');
  assert.equal(gift.audit.verb, 'add');
  assert.deepEqual((await loadAgentConfig()).config.gifts[0].applies_to, ['insideout_30', 'insideout_60']);

  const gone = await handleWrite(form([['action', 'agent_item_delete'], ['kind', 'gifts'], ['id', 'mystery_gift']]), '127.0.0.1', owner, 'c');
  assert.equal(gone.audit.verb, 'delete');
  await assert.rejects(() => handleWrite(form([['action', 'agent_item_save'], ['kind', 'secrets'], ['name', 'x'], ['detail', 'y']]), '127.0.0.1', owner, 'c'), /tidak dikenal/);
});

test('the AI Agent page asks before every write and escapes what people typed', async () => {
  const range = { preset: '7d', from: '2026-11-11', to: '2026-11-17', label: '7 hari', clamped: false };
  const meta = { ...(await loadAgentConfig()) };
  meta.config.promos[0].name = 'Promo <script>alert(1)</script>';
  const catalog = await loadCatalog({ products: async () => storefront(), config: async () => meta, now: NOV17 });
  const html = renderAgent({ catalog, meta, endpoint: 'https://api.example/api/catalog', keyed: false, today: '2026-11-17', user: owner, csrf: 'c', flash: null, range, errors: {}, shopeeShop: null, generatedAt: Date.now() });

  const posts = [...html.matchAll(/<form method="post"[^>]*>/g)].map((m) => m[0]);
  assert.ok(posts.length >= 4, 'ongkir, editor, dan hapus per item');
  for (const tag of posts) assert.match(tag, /data-confirm(-text)?="[^"]+"/, `form tanpa konfirmasi: ${tag}`);
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /Rp 1\.045\.000/);
  assert.match(html, /CATALOG_API_KEY<\/code> belum disetel/);
  assert.match(html, /data-ag-new="gifts" data-for="kapsul_90"/, 'baris varian punya tombol tambah hadiah');
  assert.ok(!html.includes('id="ag-h-gifts"'), 'hadiah tidak lagi punya bagian terpisah');
  assert.match(html, /<form method="post" id="ag-ed-del" data-confirm-text=/);
  for (const [, body] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Function(body);

  const readOnly = renderAgent({ catalog, meta, endpoint: 'x', keyed: true, today: '2026-11-17', user: viewer, csrf: 'c', flash: null, range, errors: {}, shopeeShop: null, generatedAt: Date.now() });
  assert.ok(!/<form method="post"/.test(readOnly), 'peninjau tidak mendapat form');
});
