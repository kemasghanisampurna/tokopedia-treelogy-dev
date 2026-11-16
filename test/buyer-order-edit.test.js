import test from 'node:test';
import assert from 'node:assert/strict';
import { activeHold, withHolds, isHeld, holdOrder, releaseOrder, heldOrders, MAX_HOLD_SECONDS } from '../src/shopify/hold.js';
import { nextAction } from '../src/fulfillment.js';
import { labelReadiness } from '../src/labels.js';
import { editability, availableFor, authorized } from '../api/internal/order-edit.js';
import { amendRefusal } from '../src/mekari/amend.js';
import { financeFromShopify, shopifyShipping } from '../src/omni.js';
import { mapOrder } from '../src/shopify/shop.js';
import { OPENING_AT } from '../src/warehouse.js';

/*
 * A buyer fixing their own Shopify order from the thank-you page (treelogy-order-edit).
 * When the fix costs more they pay by QRIS and the edit lands only once the money has
 * arrived; for those minutes the order is held so the bench does not send the old one.
 */

const NOW = 1_800_000_000;
const shopifyOrder = (extra = {}) => ({ channel: 'shopify', id: '#13987', stage: 'to_ship', createdAt: OPENING_AT + 100, lines: [{ sku: 'OMC-180-001', qty: 1 }], ...extra });

test('a hold counts only while it runs, and only for Shopify', () => {
  const holds = { '#13987': { until: NOW + 60, ref: 'e1' } };
  assert.ok(activeHold(holds, shopifyOrder(), NOW));
  assert.equal(activeHold(holds, shopifyOrder(), NOW + 61), null);
  assert.equal(activeHold(holds, { channel: 'shopee', id: '#13987' }, NOW), null);
});

test('held orders are marked on a worklist, the rest are left exactly as they were', () => {
  const other = shopifyOrder({ id: '#1' });
  const data = withHolds({ orders: [shopifyOrder(), other], total: 2 }, { '#13987': { until: NOW + 60, ref: 'e1' } }, NOW);
  assert.equal(data.orders[0].heldUntil, NOW + 60);
  assert.equal(data.orders[1], other);
  assert.equal(data.total, 2);
  assert.equal(withHolds({ orders: [other] }, {}, NOW).orders[0], other);
});

test('a held order is neither offered for arranging nor for printing', () => {
  const held = shopifyOrder({ heldUntil: Math.floor(Date.now() / 1000) + 600 });
  assert.equal(nextAction(held, {}), null);
  assert.equal(nextAction(shopifyOrder(), {}).action, 'arrange_local');

  const arranged = { '#13987': { at: 1 } };
  assert.equal(labelReadiness(held, {}, arranged).state, 'waiting');
  assert.match(labelReadiness(held, {}, arranged).note, /pembeli sedang mengubah/);
  assert.equal(labelReadiness(shopifyOrder(), {}, arranged).state, 'needsPrint');
  // An expired hold is no hold.
  assert.equal(labelReadiness(shopifyOrder({ heldUntil: 1 }), {}, arranged).state, 'needsPrint');
  assert.equal(isHeld(shopifyOrder({ heldUntil: 1 })), false);
});

test('a hold is capped, a release only lifts the hold of the edit that placed it', async () => {
  const now = Math.floor(Date.now() / 1000);
  const hold = await holdOrder('#20001', { until: now + 99_999, ref: 'edit-a', now });
  assert.equal(hold.until, now + MAX_HOLD_SECONDS);
  // A late release from an abandoned edit leaves the current one alone.
  await holdOrder('#20001', { until: now + 600, ref: 'edit-b', now });
  assert.equal(await releaseOrder('#20001', { ref: 'edit-a', now }), false);
  assert.equal((await heldOrders())['#20001'].ref, 'edit-b');
  assert.equal(await releaseOrder('#20001', { ref: 'edit-b', now }), true);
  assert.equal((await heldOrders())['#20001'], undefined);
  await assert.rejects(holdOrder('#20001', { until: now - 1, ref: 'x', now }), /sudah lewat/);
});

test('an order may be edited until its label has been printed, and never after', () => {
  assert.deepEqual(editability(shopifyOrder()), { editable: true, reason: 'ok' });
  assert.equal(editability(shopifyOrder(), { printed: { 'shopify:#13987': { at: 1, first: 1 } } }).reason, 'label_printed');
  assert.equal(editability(shopifyOrder({ stage: 'shipping' })).reason, 'shipped');
  assert.equal(editability(shopifyOrder({ stage: 'cancelled' })).reason, 'cancelled');
  assert.equal(editability(shopifyOrder({ stage: 'unpaid' })).reason, 'unpaid');
  assert.equal(editability(shopifyOrder({ channel: 'shopee' })).reason, 'not_shopify');
  assert.equal(editability(null).reason, 'not_found');
});

test('what the shelf can promise an edit includes the units the order already claims', () => {
  // 3 jars of 180 on the shelf; this order claims 1, another open order claims 2.
  const warehouse = { items: { 'M-037': { qty: 3 }, 'M-038': { qty: 0 } }, orders: {}, recipes: {} };
  const mine = shopifyOrder();
  const others = [shopifyOrder({ id: '#2', lines: [{ sku: 'OMC-180-001', qty: 2 }] })];
  const free = availableFor(mine, ['OMC-180-001', 'OMO-30-001', 'NOT-A-SKU'], warehouse, [mine, ...others]);
  assert.equal(free['OMC-180-001'], 1); // 3 - (1 + 2) + its own 1
  assert.equal(free['OMO-30-001'], 0);
  assert.equal(free['NOT-A-SKU'], null);
});

test('the internal route answers only loopback callers with the secret, never through nginx', () => {
  const req = (headers = {}, remote = '127.0.0.1') => ({ headers, socket: { remoteAddress: remote } });
  const auth = { authorization: 'Bearer s3cret-value' };
  assert.equal(authorized(req(auth), 's3cret-value'), true);
  assert.equal(authorized(req({ authorization: 'Bearer wrong-value' }), 's3cret-value'), false);
  assert.equal(authorized(req({ ...auth, 'x-forwarded-for': '1.2.3.4' }), 's3cret-value'), false);
  assert.equal(authorized(req(auth, '10.0.0.5'), 's3cret-value'), false);
  assert.equal(authorized(req(auth), ''), false);
});

test('a web-shop invoice paid only by its own deposit may be restated, nothing else may', () => {
  const invoice = { transaction_no: 'SI-1', payment_received_amount: '795000' };
  const built = { sales_invoice: { deposit: 1145000, deposit_to_name: 'Pooling Account for Website' } };
  const entry = { total: 795000 };
  assert.match(amendRefusal(invoice, built, entry, { allowDepositRestate: false }), /sudah menerima pembayaran/);
  assert.equal(amendRefusal(invoice, built, entry, { allowDepositRestate: true }), null);
  // A payment somebody recorded by hand on top of ours: refused.
  assert.ok(amendRefusal({ ...invoice, payment_received_amount: '900000' }, built, entry, { allowDepositRestate: true }));
  // A rebuild without a deposit would erase the payment: refused.
  assert.ok(amendRefusal(invoice, { sales_invoice: {} }, entry, { allowDepositRestate: true }));
  // An unpaid invoice was never refused in the first place.
  assert.equal(amendRefusal({ payment_received_amount: '0', deletable: true }, built, entry), null);
});

test('shipping is read from the lines the order carries now, after an edit replaced one', () => {
  const money = (amount) => ({ shopMoney: { amount: String(amount) } });
  const base = { lineItems: { nodes: [] }, discountApplications: { nodes: [] }, totalPriceSet: money(0) };
  // Checkout charged Bali (15rb); the buyer moved the parcel to Papua (85rb).
  const edited = { ...base, shippingLine: { originalPriceSet: money(15000) }, shippingLines: { nodes: [{ originalPriceSet: money(85000), discountAllocations: [] }] } };
  assert.equal(financeFromShopify(edited).shipping, 85000);
  // A payload stored before shippingLines was read still reads the old way.
  assert.equal(financeFromShopify({ ...base, shippingLine: { originalPriceSet: money(15000) } }).shipping, 15000);
  assert.deepEqual(shopifyShipping({}), []);
});

test('a re-read order keeps its note and weight for the label', () => {
  const money = (amount) => ({ shopMoney: { amount: String(amount), currencyCode: 'IDR' } });
  const mapped = mapOrder({
    id: 'gid://shopify/Order/1', name: '#13987', note: 'Titip di pos satpam', totalWeight: 550, createdAt: '2026-11-16T05:47:00Z',
    displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED',
    totalPriceSet: money(795000), lineItems: { nodes: [] }, discountApplications: { nodes: [] },
  });
  assert.equal(mapped.note, 'Titip di pos satpam');
  assert.equal(mapped.weightGram, 550);
});

test('arranging a batch skips an order whose buyer started paying after the page was opened', async () => {
  const { massArrange } = await import('../src/fulfillment.js');
  const { arrangedOrders } = await import('../src/shopify/label.js');
  const now = Math.floor(Date.now() / 1000);
  await holdOrder('#30001', { until: now + 600, ref: 'edit-x', now });
  const page = [shopifyOrder({ id: '#30001' }), shopifyOrder({ id: '#30002' })];
  const result = await massArrange(page, { refresh: async () => ({ orders: [] }), waits: [] });
  const byId = Object.fromEntries(result.results.map((r) => [r.id, r]));
  assert.equal(byId['#30001'].status, 'failed');
  assert.match(byId['#30001'].error, /pembeli sedang mengubah/);
  assert.equal(byId['#30002'].status, 'ok');
  const arranged = await arrangedOrders();
  assert.equal(arranged['#30001'], undefined);
  assert.ok(arranged['#30002']);
  await releaseOrder('#30001', { ref: 'edit-x' });
});
