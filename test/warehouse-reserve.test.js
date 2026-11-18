import test from 'node:test';
import assert from 'node:assert/strict';
import { reserveFor, figuresFor } from '../src/warehouse-reserve.js';
import { OPENING_AT, recipeOf } from '../src/warehouse.js';
import { renderWarehouse } from '../src/pages/warehouse.js';

const at = OPENING_AT + 86400;
const order = (id, lines, extra = {}) => ({ channel: 'shopify', id, stage: 'to_ship', createdAt: at, lines, ...extra });
const caps90 = Object.keys(recipeOf('OMC-90-001'))[0];

test('a paid order not yet printed claims its goods; a printed, cancelled or unpaid one does not', () => {
  const doc = { items: { [caps90]: { qty: 10 } }, orders: { 'shopify|#2': { picked: 1 } }, recipes: {} };
  const orders = [
    order('#1', [{ sku: 'OMC-90-001', qty: 2 }]),
    order('#2', [{ sku: 'OMC-90-001', qty: 5 }]),                      // already taken off the shelf
    order('#3', [{ sku: 'OMC-90-001', qty: 1 }], { stage: 'cancelled' }),
    order('#4', [{ sku: 'OMC-90-001', qty: 1 }], { stage: 'unpaid' }),
    order('#5', [{ sku: 'OMC-90-001', qty: 1 }], { stage: 'shipping' }),
  ];
  const r = reserveFor(doc, orders);
  assert.equal(r.items[caps90], 2);
  assert.equal(r.orders, 1);
  assert.deepEqual(figuresFor(doc.items[caps90], r, caps90), { shelf: 10, claimed: 2, available: 8 });
});

test('a bundle claims its parts, through the same recipes the shelf uses; a stranger is named', () => {
  const doc = { items: {}, orders: {}, recipes: {} };
  const r = reserveFor(doc, [order('#9', [{ sku: 'Inside-Out-Protocol', qty: 1 }, { sku: 'NOPE-1', qty: 1 }])]);
  const parts = recipeOf('Inside-Out-Protocol');
  assert.ok(parts && Object.keys(parts).length >= 2, 'the bundle has a recipe');
  for (const [code, n] of Object.entries(parts)) assert.equal(r.items[code], n);
  assert.deepEqual(r.unknown, ['NOPE-1']);
  assert.equal(r.orders, 1);
});

test('an order taken off the shelf and then undone claims again until it is re-taken', () => {
  const doc = { items: {}, orders: { 'shopify|#7': { picked: 1, undone: true } }, recipes: {} };
  const r = reserveFor(doc, [order('#7', [{ sku: 'OMC-90-001', qty: 3 }])]);
  assert.equal(r.items[caps90], 3);
});

test('the shelf page shows the three figures and counts the orders still to process', () => {
  const warehouse = { version: 1, items: { [caps90]: { name: 'Organic Moringa Capsules 90', group: 'goods', qty: 10, uom: 'pcs' } }, moves: [], orders: {}, folded: {}, tokens: {}, recipes: {}, refunds: {}, opened_at: at };
  const reserve = reserveFor(warehouse, [order('#1', [{ sku: 'OMC-90-001', qty: 4 }])]);
  const html = renderWarehouse({ warehouse, reserve, csrf: 't', flash: null, user: { role: 'owner', status: 'active', email: 'k@t.com' }, range: {}, errors: {}, shopeeShop: null, generatedAt: 0 });
  assert.match(html, /wh__fig--shelf"[^>]*><b class="mono">10<\/b>/);
  assert.match(html, /wh__fig--claimed"[^>]*><b class="mono">4<\/b>/);
  assert.match(html, /wh__fig--avail"[^>]*><b class="mono">6<\/b>/);
  assert.match(html, /1<\/span><span class="stat__l">pesanan perlu diproses/);
  const short = renderWarehouse({ warehouse, reserve: reserveFor(warehouse, [order('#1', [{ sku: 'OMC-90-001', qty: 14 }])]), csrf: 't', flash: null, user: null, range: {}, errors: {}, shopeeShop: null, generatedAt: 0 });
  assert.match(short, /wh__fig--avail"[^>]*><b class="mono is-short">-4<\/b>/, 'more claimed than on the shelf is said in red');
});

/*
 * The shelf is one pile: three sample oils fill three parcels, not every parcel that needs
 * one. Fifteen of them went to one packer on 18 Nov because each was asked about alone.
 */
test('the shelf is shared out in turn: handed-out parcels first, oldest hand-out first, then the rest', async () => {
  const { shortagesInTurn, shortageText } = await import('../src/warehouse-reserve.js');
  const doc = { items: { [caps90]: { name: 'Caps 90', qty: 3 } }, orders: { 'shopify|#9': { picked: 1 } }, recipes: {} };
  const one = (id, extra) => order(id, [{ sku: 'OMC-90-001', qty: 1 }], extra);
  const handed = { orders: { 'shopify:#1': { at: 300 }, 'shopify:#2': { at: 100 }, 'shopify:#3': { at: 200 }, 'shopify:#4': { at: 400 } } };
  const orders = [one('#5'), one('#1'), one('#2'), one('#3'), one('#4'), one('#9'), one('#6', { stage: 'cancelled' })];
  const turn = shortagesInTurn(doc, orders, handed);
  const short = (k) => turn.get(`shopify:${k}`).length > 0;
  assert.deepEqual(['#2', '#3', '#1'].map(short), [false, false, false], 'the three oldest hand-outs fit');
  assert.equal(short('#4'), true, 'the fourth hand-out does not');
  assert.equal(short('#5'), true, 'nor a parcel nobody has been handed yet');
  assert.equal(short('#9'), false, 'one already taken off the shelf needs nothing');
  assert.deepEqual(turn.get('shopify:#4'), [{ code: caps90, name: 'Caps 90', need: 1, have: 0, shelf: 3 }]);
  assert.equal(shortageText(turn.get('shopify:#4')), 'Stok di rak kurang: Caps 90 (perlu 1, 3 di rak sudah untuk pesanan lain)');

  // Handing out: the ticked ones queue behind everything already handed out.
  const fresh = shortagesInTurn(doc, [one('#7'), one('#8')], { orders: { 'shopify:#1': { at: 1 } } }, { fresh: ['shopify:#7', 'shopify:#8'] });
  assert.equal(fresh.get('shopify:#7').length, 0);
  assert.equal(fresh.get('shopify:#8').length, 0, 'the hand-out on file is not on the worklist, so it holds nothing');
  const busy = shortagesInTurn(doc, [one('#7'), one('#1'), one('#8'), one('#2'), one('#3')], handed, { fresh: ['shopify:#7', 'shopify:#8'] });
  assert.deepEqual([busy.get('shopify:#7').length > 0, busy.get('shopify:#8').length > 0], [true, true]);

  // A parcel the remainder cannot fill takes nothing, so a smaller one further down still fits.
  const big = order('#20', [{ sku: 'OMC-90-001', qty: 3 }]);
  const mix = shortagesInTurn(doc, [one('#21'), big, one('#22')]);
  assert.deepEqual([mix.get('shopify:#21').length, mix.get('shopify:#20').length > 0, mix.get('shopify:#22').length], [0, true, 0]);
  assert.equal(shortageText(mix.get('shopify:#20')), 'Stok di rak kurang: Caps 90 (perlu 3, sisa 2 - 1 dari 3 di rak sudah untuk pesanan lain)');
});
