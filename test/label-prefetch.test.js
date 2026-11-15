import test from 'node:test';
import assert from 'node:assert/strict';
import { prefetchLabels, cachedPages, rememberPages, renderOrder, resetPrefetch, aheadOfTime, cacheSize } from '../src/label-prefetch.js';

const o = (channel, id) => ({ channel, id, stage: 'to_ship', status: 'READY' });

test('marketplace labels are rendered ahead, a few at a time, and only once each', async () => {
  resetPrefetch();
  const seen = [];
  const render = async (order) => { seen.push(order.id); await new Promise((r) => setTimeout(r, 5)); return ['UEFHRQ==']; };
  const orders = [o('shopee', 'A'), o('tiktok_shop', 'B'), o('shopify', '#1'), o('shopee', 'C')];
  const first = prefetchLabels(orders, { render, log: {} });
  const again = prefetchLabels(orders, { render, log: {} });
  assert.equal(await first, 3, 'three marketplace labels, the Shopify one is left to the press');
  assert.equal(await again, 0, 'in flight is not started twice');
  assert.deepEqual(seen.sort(), ['A', 'B', 'C']);
  assert.deepEqual(cachedPages(o('shopee', 'A')), ['UEFHRQ==']);
  assert.equal(cachedPages(o('shopify', '#1')), null);
  assert.equal(aheadOfTime(o('shopify', '#1')), false);
  assert.equal(await prefetchLabels(orders, { render, log: {} }), 0, 'already here');
});

test('a label that fails to render is quietly skipped, and the rest still arrive', async () => {
  resetPrefetch();
  const warned = [];
  const render = async (order) => { if (order.id === 'bad') throw new Error('Shopee belum membuat dokumennya'); return ['X']; };
  const n = await prefetchLabels([o('shopee', 'bad'), o('shopee', 'good')], { render, log: { warn: (m) => warned.push(m) } });
  assert.equal(n, 1);
  assert.match(warned[0], /shopee:bad/);
  assert.equal(cachedPages(o('shopee', 'bad')), null, 'the press will try it again and say why');
});

test('what was rendered ahead expires, and the shelf never overflows', () => {
  resetPrefetch();
  rememberPages(o('shopee', 'old'), ['P'], 0);
  assert.equal(cachedPages(o('shopee', 'old'), 13 * 3600_000), null);
  for (let i = 0; i < 200; i += 1) rememberPages(o('shopee', String(i)), ['P']);
  assert.ok(cacheSize() <= 120, `${cacheSize()} kept`);
});

test('an order is rendered through the same sheet builder the print dialog uses', async () => {
  const built = [];
  const build = async ({ orders }) => { built.push(orders); return { groups: [{ bytes: new Uint8Array([1]), orders }], failures: [] }; };
  const raster = async () => [new Uint8Array([0x53, 0x49, 0x5a, 0x45])];
  const pages = await renderOrder(o('shopee', 'Z'), { build, raster });
  assert.deepEqual(pages, [Buffer.from('SIZE').toString('base64')]);
  assert.deepEqual(built[0], [{ id: 'Z', channel: 'shopee', stage: 'to_ship', status: 'READY' }]);
  await assert.rejects(renderOrder(o('shopee', 'Q'), { build: async () => ({ groups: [], failures: [{ reason: 'belum dibuat' }] }), raster }), /belum dibuat/);
});
