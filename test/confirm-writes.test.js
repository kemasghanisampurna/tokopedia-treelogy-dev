import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmCatalog, confirmListing, confirmPublished, editAndConfirm } from '../src/confirm-writes.js';
import { invoiceGone } from '../src/mekari/discard.js';
import { refundOrder } from '../src/mekari/refund.js';
import { customIdFor } from '../src/mekari/invoice.js';

const noWait = { waits: [1, 1], wait: async () => {} };
const catalog = (field, ...values) => ({ skus: [{ sku: 'A', tiktok: { rows: values.map((v) => ({ [field]: v })) } }], errors: {} });
const written = (field, to) => ({ sku: 'A', channel: 'tiktok', field, to, status: 'ok' });
const reads = (...answers) => async () => answers.length > 1 ? answers.shift() : answers[0];

test('a price is confirmed only when every listing reads the new figure', async () => {
  const [good] = await confirmCatalog([written('price', 100)], { read: reads(catalog('price', 100, 100)), ...noWait });
  assert.equal(good.status, 'ok');
  const [bad] = await confirmCatalog([written('price', 100)], { read: reads(catalog('price', 100, 90)), ...noWait });
  assert.equal(bad.status, 'unconfirmed');
  assert.match(bad.error, /harga masih terbaca 90, seharusnya 100/);
});

test('a figure that lands a moment later is confirmed, a refused write keeps its own words', async () => {
  const refused = { ...written('qty', 5), status: 'failed', error: 'TikTok menolak' };
  const results = await confirmCatalog([written('qty', 5), refused], { read: reads(catalog('qty', 4), catalog('qty', 5)), ...noWait });
  assert.equal(results[0].status, 'ok');
  assert.deepEqual(results[1], refused);
});

test('a channel that cannot be read, or a listing not found, is never a success', async () => {
  const down = { skus: [], errors: { tiktok: 'timeout' } };
  const [a] = await confirmCatalog([written('qty', 5)], { read: reads(down), ...noWait });
  assert.match(a.error, /tidak terbaca \(timeout\)/);
  const [b] = await confirmCatalog([written('qty', 5)], { read: reads({ skus: [], errors: {} }), ...noWait });
  assert.equal(b.status, 'unconfirmed');
  const [c] = await confirmCatalog([written('qty', 5)], { read: async () => { throw new Error('putus'); }, ...noWait });
  assert.match(c.error, /putus/);
});

test('a listing edit is compared field by field, whitespace aside', async () => {
  const read = async () => ({ title: 'Baru', description: 'satu\n\ndua', weightGram: 200, dims: { l: 1, w: 2, h: 3 } });
  const same = { title: 'Baru', description: 'satu dua', weightGram: '200', dims: { l: '1', w: '2', h: '3' } };
  assert.equal((await confirmListing('shopee', {}, { patch: same }, { read, ...noWait })).status, 'ok');
  const out = await confirmListing('shopee', {}, { patch: { ...same, title: 'Lain', weightGram: 300 } }, { read, ...noWait });
  assert.equal(out.status, 'unconfirmed');
  assert.match(out.error, /judul, berat belum sesuai/);
});

test('on and off are read from the listing status of each channel', async () => {
  const says = (status) => async () => ({ status });
  assert.equal((await confirmListing('shopee', {}, { active: true }, { read: says('NORMAL'), ...noWait })).status, 'ok');
  assert.equal((await confirmListing('tiktok', {}, { active: false }, { read: says('SELLER_DEACTIVATED'), ...noWait })).status, 'ok');
  const pending = await confirmListing('tiktok', {}, { active: true }, { read: says('PENDING'), ...noWait });
  assert.match(pending.error, /status PENDING belum sesuai/);
  const down = await confirmListing('shopee', {}, { active: true }, { read: async () => { throw new Error('putus'); }, ...noWait });
  assert.match(down.error, /tidak terbaca \(putus\)/);
});

test('an invoice is gone only when Jurnal says so', async () => {
  const missing = Object.assign(new Error('not found'), { status: 404 });
  assert.equal(await invoiceGone(async () => { throw missing; }, 1), true);
  assert.equal(await invoiceGone(async () => ({ sales_invoice: { id: 1 } }), 1), false);
  assert.equal(await invoiceGone(async () => { throw new Error('timeout'); }, 1), false);
});

test('a refund says which sales return it booked, and never deletes the invoice', async () => {
  const seen = [];
  const call = async ({ method, path }) => {
    seen.push(method ?? 'GET');
    if (method === 'POST') return { sales_return: { id: 3, transaction_no: 'SR-1' } };
    return { sales_invoice: { id: 9, transaction_no: 'INV-9', transaction_lines_attributes: [{ id: 1, quantity: 2 }] } };
  };
  const order = { id: '#1', channel: 'shopify', total: 10 };
  const deps = {
    read: async () => order, call, saveLedger: async () => {}, update: async () => {},
    loadLedger: async () => ({ orders: { [customIdFor(order)]: { invoice_id: 9 } } }),
  };
  const out = await refundOrder({ channel: 'shopify', id: '#1' }, deps);
  assert.equal(out.returned, true);
  assert.equal(out.returnNo, 'SR-1');
  assert.ok(!seen.includes('DELETE'));
});

test('new pictures must show on the listing, and differ from what it showed before', async () => {
  const shop = (after) => {
    let edited = false;
    return { shopee: { read: async () => ({ images: edited ? after : ['old'] }), edit: async () => { edited = true; return { changed: ['image'] }; } } };
  };
  const file = [{ name: 'a.jpg' }];
  assert.equal((await editAndConfirm('shopee', {}, {}, file, { channels: shop(['new']), ...noWait })).status, 'ok');
  const same = await editAndConfirm('shopee', {}, {}, file, { channels: shop(['old']), ...noWait });
  assert.equal(same.status, 'unconfirmed');
  assert.match(same.error, /foto belum sesuai/);
});

test('a new listing has to read back in the state it was asked for', async () => {
  const says = (status) => ({ read: async () => ({ status }), ...noWait });
  assert.equal((await confirmPublished('shopee', '1', {}, says('NORMAL'))).status, 'ok');
  assert.equal((await confirmPublished('shopee', '1', { draft: true }, says('UNLIST'))).status, 'ok');
  const review = await confirmPublished('tiktok', '1', {}, says('PENDING'));
  assert.equal(review.status, 'unconfirmed');
  assert.match(review.error, /status PENDING/);
});
