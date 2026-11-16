import test from 'node:test';
import assert from 'node:assert/strict';
import { can, canView, homeView, ASSIGNABLE_ROLES, ROLES } from '../src/users.js';
import { applyAssign, applyUnassign, assignmentFor, assignedTo, pruneAssignments } from '../src/label-assign.js';
import { renderLabels } from '../src/dashboard-page.js';

const packer = { email: 'budi@treelogy.com', name: 'Budi', role: 'packer', status: 'active' };
const agas = { email: 'agas@treelogy.com', name: 'Agas', role: 'operator', status: 'active' };

test('a packer may print and open the label page, and nothing else', () => {
  assert.equal(can(packer, 'orders'), true, 'the parcel needs a name and an address');
  assert.equal(can(packer, 'write'), false);
  assert.equal(can(packer, 'assign'), false);
  assert.equal(can(agas, 'assign'), true);
  assert.equal(canView(packer, 'labels'), true);
  assert.equal(canView(packer, 'orders'), false);
  assert.equal(canView(packer, 'process'), false);
  assert.equal(homeView(packer), 'labels');
  assert.ok(ASSIGNABLE_ROLES.includes('packer'));
  assert.equal(ROLES.packer.label, 'Packer');
});

test('labels are handed to one packer at a time, taken back, and forgotten after a fortnight', () => {
  const t0 = 1_800_000_000_000;
  let doc = applyAssign(null, ['shopee:1', 'shopify:#2'], packer, agas, t0);
  assert.deepEqual(assignmentFor(doc, { channel: 'shopee', id: '1' }), { to: 'budi@treelogy.com', name: 'Budi', by: 'agas@treelogy.com', at: t0 });
  const other = { email: 'cici@treelogy.com', name: 'Cici' };
  doc = applyAssign(doc, ['shopee:1'], other, agas, t0 + 1);
  assert.equal(assignmentFor(doc, { channel: 'shopee', id: '1' }).to, 'cici@treelogy.com', 'handed again: moved, not split');
  const orders = [{ channel: 'shopee', id: '1' }, { channel: 'shopify', id: '#2' }, { channel: 'tiktok_shop', id: '3' }];
  assert.deepEqual(assignedTo(doc, orders, 'budi@treelogy.com').map((o) => o.id), ['#2']);
  doc = applyUnassign(doc, ['shopify:#2'], t0 + 2);
  assert.equal(assignmentFor(doc, { channel: 'shopify', id: '#2' }), null);
  assert.equal(Object.keys(pruneAssignments(doc, t0 + 15 * 86400_000).orders).length, 0);
});

const order = (id, buyer) => ({ channel: 'shopify', id, stage: 'to_ship', buyer, buyerPhone: '0812', shipTo: 'Bali', carrier: 'JNE', createdAt: 1794271940, lines: [{ sku: 'OMC-90-001', name: 'Organic Moringa Capsules', variant: '90', qty: 2 }] });
const base = { range: {}, errors: {}, shopeeShop: null, generatedAt: 0, csrf: 't', flash: null, sizes: { a6: { label: 'A6' } }, defaultSize: 'a6', arranged: { '#1': 1, '#2': 1 } };
const assignments = applyAssign(null, ['shopify:#1'], packer, agas);

test('the packer sees one row per parcel with its own print button, and none of the management', () => {
  const images = { 'OMC-90-001': { thumb: 'https://img.example/caps90.jpg' } };
  const html = renderLabels({ ...base, user: packer, isPacker: true, orders: [order('#1', 'Wiwiek')], assignments, packers: [packer], images, bench: { online: true, seenAt: Date.now(), agent: { name: 'Laptop packing' } } });
  assert.match(html, /class="pq__row" data-key="shopify:#1"/);
  assert.match(html, /data-print="shopify:#1"/, 'a print button per row');
  assert.doesNotMatch(html, /type="checkbox" name="order"/, 'nothing to tick, one at a time');
  assert.match(html, /"name":"Organic Moringa Capsules","variant":"90","qty":2,"sku":"OMC-90-001","img":"https:\/\/img.example\/caps90.jpg"/, 'what goes in the box, with its picture');
  assert.match(html, /Laptop packing siap/);
  assert.match(html, /<dialog class="pq__sheet"/);
  assert.doesNotMatch(html, /Tandai sudah dicetak|Cetak ulang|name="packer"|id="lbq"|class="pagehead"|<div class="strip">/);
  const offline = renderLabels({ ...base, user: packer, isPacker: true, orders: [order('#1', 'Wiwiek')], assignments, packers: [packer], bench: null });
  assert.match(offline, /id="pq-pair"/, 'a phone without a printer is offered to pair one');
  assert.match(offline, /format: format/);
  const none = renderLabels({ ...base, user: packer, isPacker: true, orders: [], assignments, packers: [packer] });
  assert.match(none, /Belum ada paket yang ditugaskan kepadamu/);
});

test('whoever may write gets the hand-out tools, the chip on the row and a pile per packer', () => {
  const html = renderLabels({ ...base, user: agas, orders: [order('#1', 'Wiwiek'), order('#2', 'Budi')], assignments, packers: [packer] });
  assert.match(html, /<select class="dr__in" name="packer" id="lb-packer"><option value="budi@treelogy.com">Budi<\/option>/);
  assert.match(html, /value="label_assign">Tugaskan</);
  assert.match(html, /value="label_unassign">Lepas</);
  assert.match(html, /lb-to"[^>]*>.*Budi/, 'the row says who has it');
  assert.match(html, /packer=none">Belum ditugaskan &middot; 1/);
  assert.match(html, /packer=budi%40treelogy.com">Budi &middot; 1/);
  const viewer = renderLabels({ ...base, user: { ...agas, role: 'viewer' }, orders: [order('#1', 'Wiwiek')], assignments, packers: [packer] });
  assert.doesNotMatch(viewer, /value="label_assign"/, 'a viewer hands nothing out');
  const noPackers = renderLabels({ ...base, user: agas, orders: [order('#1', 'Wiwiek')], assignments: null, packers: [] });
  assert.doesNotMatch(noPackers, /class="filters lb-packers"/, "no packers, no piles");
});
