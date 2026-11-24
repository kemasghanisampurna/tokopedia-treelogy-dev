import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isOutage, postManual } from '../src/mekari/sync.js';
import { manualOutcome, buildManualOrder } from '../src/mekari/manual.js';
import { queueForRetry, loadRetryBook, recordOutcomes, forgetRetry, isDue } from '../src/mekari/retry.js';
import { amendManualInvoice } from '../src/mekari/amend.js';
import { discardManual } from '../src/mekari/discard.js';
import { MekariError, QuotaExhaustedError, UncertainWriteError } from '../src/mekari/client.js';
import { PRODUCTS } from '../src/master.js';

/**
 * 24 Nov 2026: Mekari's own firewall answered 403 to everything for hours, and no sale
 * could be typed in at the counter because saving one meant posting it first.
 */

const order = () => buildManualOrder({
  source: 'DP', code: 'DP-261124-00000TS', date: '2026-11-24', now: Date.parse('2026-11-24T04:00:00Z'),
  buyer: 'Ika', shipTo: 'Jl. Mawar 1', lines: [{ sku: PRODUCTS[0].sku, qty: 1, unitPrice: 100000 }],
});
const firewall = () => new MekariError('POST /contacts -> HTTP 403: "<!DOCTYPE html>"', { status: 403 });
const refused = () => new MekariError('POST /sales_invoices -> HTTP 422: "harga"', { status: 422 });

test('an outage is what the person typing cannot fix', () => {
  for (const status of [401, 403, 423, 429, 500, 503]) assert.equal(isOutage(new MekariError('x', { status })), true, String(status));
  assert.equal(isOutage(new MekariError('tidak terjangkau: ECONNRESET')), true);
  assert.equal(isOutage(new QuotaExhaustedError('habis')), true);
  assert.equal(isOutage(new UncertainWriteError('tidak dapat jawaban')), true);
  for (const status of [400, 404, 409, 422]) assert.equal(isOutage(new MekariError('x', { status })), false, String(status));
  assert.equal(isOutage(new Error('akun 11.00.11 tidak ada di Jurnal')), false);
  assert.equal(isOutage(null), false);
});

const post = (over) => postManual({ order: order(), dryRun: false, receivable: async () => 1, contact: async () => ({}), ...over });

test('a contact the firewall stopped leaves the sale queued and posts no invoice', async () => {
  let synced = false;
  const out = await post({ contact: async () => { throw firewall(); }, sync: async () => { synced = true; } });
  assert.equal(out.status, 'queued');
  assert.equal(out.customId, 'TRL-manual-DP-261124-00000TS');
  assert.match(out.error, /403/);
  assert.equal(synced, false);
});

test('an invoice the outage stopped is queued; one Jurnal refused is still refused', async () => {
  const sync = (result) => async () => ({ results: [result] });
  assert.equal((await post({ sync: sync({ status: 'failed', outage: true, error: '403' }) })).status, 'queued');
  assert.equal((await post({ sync: sync({ status: 'deferred', error: 'tenggat' }) })).status, 'queued');
  assert.equal((await post({ sync: sync({ status: 'failed', outage: false, error: '422' }) })).status, 'failed');
  assert.equal((await post({ sync: sync({ status: 'created' }) })).status, 'created');
  assert.equal((await post({ sync: async () => ({ results: [], ranOutOfTime: true }) })).status, 'queued');
  assert.equal((await post({ sync: async () => ({ results: [] }) })).status, 'failed');
  await assert.rejects(() => post({ contact: async () => { throw refused(); } }), /422/);
});

test('the screen says saved and waiting, and does not celebrate', () => {
  const out = manualOutcome({ status: 'queued', id: 'DP-1', total: 795000 });
  assert.equal(out.kind, 'ok');
  assert.equal(out.celebrate, undefined);
  assert.match(out.message, /tersimpan di daftar pesanan senilai Rp795\.000/);
  assert.match(out.message, /dikirim otomatis/);
});

test('a queued sale is due at once, never alerts for itself, and keeps a real failure count', async () => {
  const id = 'TRL-manual-DP-261124-00000TS';
  await forgetRetry(id);
  await queueForRetry(id, order(), '403');
  let entry = (await loadRetryBook()).orders[id];
  assert.equal(entry.attempts, 0);
  assert.equal(entry.order_id, 'DP-261124-00000TS');
  assert.equal(isDue(entry), true);

  await recordOutcomes([{ customId: id, id: entry.order_id, channel: 'manual', status: 'failed', error: 'x' }], { orders: [order()] });
  await queueForRetry(id, order(), '403');
  entry = (await loadRetryBook()).orders[id];
  assert.equal(entry.attempts, 1);

  await recordOutcomes([{ customId: id, status: 'created' }], {});
  assert.equal((await loadRetryBook()).orders[id], undefined);
});

test('a queued sale can be corrected and thrown away without Jurnal', async () => {
  const call = async () => { throw firewall(); };
  const out = await amendManualInvoice(order(), { call, loadLedger: async () => ({ orders: {} }) });
  assert.equal(out.amended, false);
  assert.equal(out.total, 100000);

  const forgot = [];
  const gone = await discardManual('DP-261124-00000TS', {
    read: async () => order(), drop: async () => 1, call,
    loadLedger: async () => ({ orders: {} }), forget: async (id) => { forgot.push(id); },
  });
  assert.equal(gone.wasInvoiced, false);
  assert.deepEqual(forgot, ['TRL-manual-DP-261124-00000TS']);
});

test('the sale is in the table before it is queued or leaves the shelf', () => {
  const source = readFileSync(new URL('../api/dashboard.js', import.meta.url), 'utf8');
  const start = source.indexOf("if (action === 'manual_invoice') {");
  const branch = source.slice(start, source.indexOf("if (action === 'user_invite')"));
  const at = (text) => { const i = branch.indexOf(text); assert.ok(i > 0, text); return i; };
  assert.ok(at("source: 'manual' }") < at('if (queued && !listed)'));
  assert.ok(at('if (queued && !listed)') < at('await queueForRetry('));
  assert.ok(at('if (queued && !listed)') < at('followAfterOrder(order)'));
});
