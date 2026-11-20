import test from 'node:test';
import assert from 'node:assert/strict';
import { courierFor } from '../src/shipments/couriers.js';
import { normaliseTracking, trackWaybill, KlikResiError, loadKlikResiConfig } from '../src/shipments/klikresi.js';
import { readFulfillments, markDelivered, fulfillmentKey } from '../src/shipments/shopify.js';
import { syncShipments, shipmentsAlert, rowFor } from '../src/shipments/sync.js';

/**
 * The daily Klik Resi pull. Every case runs on fakes: the real API bills Rp15 per answer and
 * the real Shopify call writes to live orders, so neither may be reached from a test.
 */

// Shape copied from a real answer (Lion Parcel, 20 Nov 2026), names and addresses replaced.
const LION_DELIVERED = {
  status: 'Delivered',
  origin: { contact_name: 'TREELOGY', address: 'Gudang' },
  destination: { contact_name: 'PENERIMA', address: 'Alamat' },
  histories: [
    { status: 'Delivered', message: 'Paketmu telah diterima Penerima (YBS)', date: '2026-11-16T07:38:26Z' },
    { status: 'OutForDelivery', message: 'Paketmu diantar oleh kurir', date: '2026-11-16T01:34:17Z' },
    { status: 'InTransit', message: 'Paketmu sampai di Gudang Sortir kota tujuan JAKARTA', date: '2026-11-15T12:32:58Z' },
  ],
};
// J&T answers with a +07:00 offset rather than Z.
const JNT_IN_TRANSIT = {
  status: 'InTransit',
  origin: { contact_name: 'TREELOGY', address: 'Gudang' },
  destination: { contact_name: 'PENERIMA', address: 'Alamat' },
  histories: [{ status: 'InTransit', message: 'Paket telah sampai di DC_JATINEGARA.', date: '2026-11-18T00:37:05+07:00' }],
};

const NOW = Date.parse('2026-11-20T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600_000).toISOString();

test('the courier comes from the carrier name first, then from the waybill shape', () => {
  assert.equal(courierFor('Lion Parcel', '11LP1794499838883'), 'lion');
  assert.equal(courierFor('J&T Express', 'JD0605968343'), 'jnt');
  // "Other" carried 26 J&T waybills in Nov 2026.
  assert.equal(courierFor('Other', 'JD0606326838'), 'jnt');
  assert.equal(courierFor('Other', '11LP1795002450047'), 'lion');
  assert.equal(courierFor('JNE', 'CM52959065211'), 'jne');
  // A GrabExpress link is not a waybill, and an unplaceable number is not guessed.
  assert.equal(courierFor('Other', 'https://express.grab.com/eTzBbu7J0CxS'), null);
  assert.equal(courierFor('Other', 'ABC123'), null);
  assert.equal(courierFor('Lion Parcel', ''), null);
});

test('a Delivered answer carries the courier\'s delivery moment, normalised to UTC', () => {
  const t = normaliseTracking(LION_DELIVERED);
  assert.equal(t.status, 'Delivered');
  assert.equal(t.deliveredAt, '2026-11-16T07:38:26.000Z');
  assert.equal(t.histories.length, 3);
  const j = normaliseTracking(JNT_IN_TRANSIT);
  assert.equal(j.deliveredAt, null);
  assert.equal(j.histories[0].date, '2026-11-17T17:37:05.000Z');
});

test('the client never holds a key under the test runner', () => {
  assert.equal(loadKlikResiConfig().apiKey, '');
});

test('trackWaybill asks the documented path with x-api-key; "not found" is a free answer, not a failure', async () => {
  const config = { apiKey: 'k', baseUrl: 'https://klikresi.test' };
  const seen = [];
  const ok = async (url, init) => { seen.push([url, init.headers['x-api-key']]); return new Response(JSON.stringify({ data: LION_DELIVERED }), { status: 200 }); };
  const t = await trackWaybill('11LP1794499838883', 'lion', { config, fetchImpl: ok });
  assert.deepEqual(seen, [['https://klikresi.test/api/trackings/11LP1794499838883/couriers/lion', 'k']]);
  assert.equal(t.status, 'Delivered');

  let calls = 0;
  const missing = async () => { calls += 1; return new Response('{"message":"tracking information not found or expired"}', { status: 400 }); };
  await assert.rejects(() => trackWaybill('X', 'lion', { config, fetchImpl: missing }), (e) => e instanceof KlikResiError && e.notFound && !e.retryable);
  assert.equal(calls, 1, 'a 400 is not retried');
});

test('fulfillments are matched by waybill inside the order, so a split order marks the right parcel', async () => {
  const graphql = async () => ({
    nodes: [{
      id: 'gid://shopify/Order/1',
      fulfillments: [
        { id: 'gid://shopify/Fulfillment/A', createdAt: hoursAgo(48), displayStatus: 'FULFILLED', deliveredAt: null, trackingInfo: [{ number: '11LPAAAA' }] },
        { id: 'gid://shopify/Fulfillment/B', createdAt: hoursAgo(48), displayStatus: 'FULFILLED', deliveredAt: null, trackingInfo: [{ number: 'jd0000000002' }] },
      ],
    }],
  });
  const found = await readFulfillments([{ gid: 'gid://shopify/Order/1', awb: 'JD0000000002' }], { graphql });
  assert.equal(found.get(fulfillmentKey('gid://shopify/Order/1', 'JD0000000002')).id, 'gid://shopify/Fulfillment/B');
});

test('markDelivered believes the read-back, and reports Shopify\'s own refusal', async () => {
  const sent = [];
  const confirms = async (query, vars) => {
    if (query.includes('fulfillmentEventCreate')) { sent.push(vars.fulfillmentEvent); return { fulfillmentEventCreate: { fulfillmentEvent: { id: 'e' }, userErrors: [] } }; }
    return { fulfillment: { id: 'F', displayStatus: 'DELIVERED', deliveredAt: '2026-11-16T07:38:26Z' } };
  };
  const r = await markDelivered('F', { happenedAt: '2026-11-16T07:38:26.000Z', message: 'diterima' }, { graphql: confirms, readBackDelays: [0] });
  assert.equal(r.outcome, 'confirmed');
  assert.deepEqual(sent, [{ fulfillmentId: 'F', status: 'DELIVERED', happenedAt: '2026-11-16T07:38:26.000Z', message: 'diterima' }]);

  const silent = async (query) => query.includes('fulfillmentEventCreate')
    ? { fulfillmentEventCreate: { userErrors: [] } }
    : { fulfillment: { id: 'F', displayStatus: 'FULFILLED', deliveredAt: null } };
  assert.equal((await markDelivered('F', {}, { graphql: silent, readBackDelays: [0, 0] })).outcome, 'unconfirmed');

  const refused = async () => ({ fulfillmentEventCreate: { userErrors: [{ field: ['fulfillmentId'], message: 'Fulfillment does not exist' }] } });
  assert.deepEqual(await markDelivered('F', {}, { graphql: refused, readBackDelays: [0] }), { outcome: 'failed', message: 'Fulfillment does not exist' });
});

// --- the whole run, on fakes -----------------------------------------------------------

const ship = (n, awb, carrier = 'Lion Parcel', createdH = 72) => ({
  channel: 'shopify', orderId: `#${n}`, gid: `gid://shopify/Order/${n}`, awb, carrier, createdAt: hoursAgo(createdH),
});
const ful = (n, { ageH = 72, status = 'FULFILLED', deliveredAt = null } = {}) => ({
  id: `gid://shopify/Fulfillment/${n}`, createdAt: hoursAgo(ageH), displayStatus: status, deliveredAt,
});

function harness({ shipments, fulfillments = {}, rows = new Map(), balance = 1000, answers = {}, markOutcome = 'confirmed' }) {
  const calls = { track: [], mark: [], saved: [], balance: 0, shopifyReads: 0 };
  const deps = {
    now: NOW,
    readShipments: async () => shipments.map((s) => ({ ...s })),
    readRows: async () => rows,
    saveRows: async (r) => { calls.saved.push(...r); return r.length; },
    readShopify: async (wanted) => {
      calls.shopifyReads += 1;
      return new Map(wanted.filter((w) => fulfillments[w.awb]).map((w) => [fulfillmentKey(w.gid, w.awb), fulfillments[w.awb]]));
    },
    balance: async () => { calls.balance += 1; return balance; },
    track: async (awb, courier) => {
      calls.track.push([awb, courier]);
      const a = answers[awb];
      if (a instanceof Error) throw a;
      return normaliseTracking(a ?? JNT_IN_TRANSIT);
    },
    mark: async (id, event) => { calls.mark.push([id, event]); return markOutcome === 'confirmed' ? { outcome: 'confirmed' } : { outcome: markOutcome, message: 'tidak terbaca' }; },
  };
  return { deps, calls };
}

test('an order Shopify already shows as delivered is never paid for, and the balance is not even read', async () => {
  const { deps, calls } = harness({
    shipments: [ship(1, '11LP0001')],
    fulfillments: { '11LP0001': ful(1, { status: 'DELIVERED', deliveredAt: '2026-11-17T00:00:00Z' }) },
  });
  const r = await syncShipments(deps);
  assert.equal(r.skipped.deliveredOnShopify, 1);
  assert.deepEqual([calls.track.length, calls.balance, calls.mark.length], [0, 0, 0]);
  assert.equal(calls.saved[0].shopify_marked_at, '2026-11-17T00:00:00Z');
});

test('a finished journey is not asked again, not even of Shopify', async () => {
  const rows = new Map([
    ['#1|11LP0001', rowFor(ship(1, '11LP0001'), null, { status: 'Delivered', shopify_marked_at: hoursAgo(30) })],
    ['#2|11LP0002', rowFor(ship(2, '11LP0002'), null, { status: 'ReturnToSender' })],
  ]);
  const { deps, calls } = harness({ shipments: [ship(1, '11LP0001'), ship(2, '11LP0002'), ship(3, 'https://express.grab.com/x', 'Other')], rows });
  const r = await syncShipments(deps);
  assert.deepEqual([r.skipped.finished, r.skipped.unknownCourier, calls.shopifyReads], [2, 1, 0]);
});

test('a parcel handed over less than two days ago, or one already checked today, waits', async () => {
  const rows = new Map([['#2|11LP0002', rowFor(ship(2, '11LP0002'), null, { status: 'InTransit', checked_at: hoursAgo(3) })]]);
  const { deps, calls } = harness({
    shipments: [ship(1, '11LP0001'), ship(2, '11LP0002')],
    fulfillments: { '11LP0001': ful(1, { ageH: 30 }), '11LP0002': ful(2) },
    rows,
  });
  const r = await syncShipments(deps);
  assert.deepEqual([r.skipped.tooFresh, r.skipped.recentlyChecked, calls.track.length], [1, 1, 0]);
});

test('the run spends only what the balance covers, oldest first, and counts the rest', async () => {
  const { deps, calls } = harness({
    shipments: [ship(1, '11LP0001', 'Lion Parcel', 200), ship(2, '11LP0002', 'Lion Parcel', 150), ship(3, 'JD0000000003', 'J&T Express', 100)],
    fulfillments: { '11LP0001': ful(1), '11LP0002': ful(2), JD0000000003: ful(3) },
    balance: 44, // two requests' worth
  });
  const r = await syncShipments(deps);
  assert.deepEqual(calls.track, [['11LP0001', 'lion'], ['11LP0002', 'lion']]);
  assert.deepEqual([r.tracked, r.cost, r.unaffordable], [2, 30, 1]);
  assert.match(shipmentsAlert(r).html, /1 resi<\/b> tidak dicek/);
});

test('a delivered parcel is marked on Shopify with the courier\'s time, and stored only once confirmed', async () => {
  const { deps, calls } = harness({
    shipments: [ship(1, '11LP0001')],
    fulfillments: { '11LP0001': ful(1) },
    answers: { '11LP0001': LION_DELIVERED },
  });
  const r = await syncShipments(deps);
  assert.deepEqual(calls.mark, [['gid://shopify/Fulfillment/1', { happenedAt: '2026-11-16T07:38:26.000Z', message: 'Paketmu telah diterima Penerima (YBS)' }]]);
  assert.deepEqual(r.marked, { confirmed: 1, unconfirmed: 0, failed: 0 });
  const row = calls.saved.find((x) => x.awb === '11LP0001');
  assert.equal(row.status, 'Delivered');
  assert.equal(row.delivered_at, '2026-11-16T07:38:26.000Z');
  assert.equal(row.shopify_status, 'DELIVERED');
  assert.equal(row.shopify_marked_at, new Date(NOW).toISOString());
  assert.equal(row.checks, 1);
  assert.equal(shipmentsAlert(r), null, 'a good day says nothing');
});

test('a mark Shopify does not show is a failure the team hears about, and is retried tomorrow without paying again', async () => {
  const first = harness({ shipments: [ship(1, '11LP0001')], fulfillments: { '11LP0001': ful(1) }, answers: { '11LP0001': LION_DELIVERED }, markOutcome: 'unconfirmed' });
  const r = await syncShipments(first.deps);
  assert.equal(r.marked.unconfirmed, 1);
  assert.match(shipmentsAlert(r).html, /Shopify belum menampilkan DELIVERED/);
  const stored = first.calls.saved[0];
  assert.equal(stored.shopify_marked_at, null);

  const next = harness({ shipments: [ship(1, '11LP0001')], fulfillments: { '11LP0001': ful(1) }, rows: new Map([['#1|11LP0001', stored]]) });
  const again = await syncShipments({ ...next.deps, now: NOW + 24 * 3600_000 });
  assert.deepEqual([next.calls.track.length, next.calls.mark.length, again.marked.confirmed], [0, 1, 1]);
});

test('a waybill the courier does not know yet costs nothing and is not a failure', async () => {
  const notFound = new KlikResiError('tracking information not found or expired', { status: 400 });
  const { deps, calls } = harness({ shipments: [ship(1, '11LP0001')], fulfillments: { '11LP0001': ful(1) }, answers: { '11LP0001': notFound } });
  const r = await syncShipments(deps);
  assert.deepEqual([r.notFound, r.cost, r.failures.length], [1, 0, 0]);
  assert.equal(calls.saved[0].status, 'NotFound');
  assert.equal(calls.saved[0].checked_at, new Date(NOW).toISOString());
});

test('dry-run reads only free sources and writes nothing', async () => {
  const { deps, calls } = harness({ shipments: [ship(1, '11LP0001'), ship(2, '11LP0002')], fulfillments: { '11LP0001': ful(1), '11LP0002': ful(2) }, balance: 1000 });
  const r = await syncShipments({ ...deps, dryRun: true });
  assert.deepEqual([calls.track.length, calls.mark.length, calls.saved.length], [0, 0, 0]);
  assert.deepEqual([r.plan.length, r.cost], [2, 30]);
});

test('every stored row carries the same columns, which PostgREST bulk upsert requires', async () => {
  const notFound = new KlikResiError('tracking information not found or expired', { status: 400 });
  const { deps, calls } = harness({
    shipments: [ship(1, '11LP0001'), ship(2, '11LP0002'), ship(3, '11LP0003')],
    fulfillments: { '11LP0001': ful(1), '11LP0002': ful(2, { status: 'DELIVERED' }) },
    answers: { '11LP0001': notFound },
  });
  await syncShipments(deps);
  const shapes = new Set(calls.saved.map((r) => Object.keys(r).sort().join(',')));
  assert.equal(calls.saved.length, 3);
  assert.equal(shapes.size, 1);
});
