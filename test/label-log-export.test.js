import test from 'node:test';
import assert from 'node:assert/strict';
import { labelEvents, buildLabelLogExport, labelLogDays, labelLogFilename } from '../src/export/labels.js';
import { renderLabels } from '../src/dashboard-page.js';

const day = (iso) => Math.floor(Date.parse(iso) / 1000);
const entries = [
  { at: day('2026-11-15T03:00:00Z'), menu: 'labels', action: 'print_labels', actor: { name: 'Agas', email: 'agas@treelogy.com' },
    changes: [{ field: 'shopify #13131', to: 'dicetak' }, { field: 'shopee 261109SQ', to: 'gagal', note: 'Shopee belum membuat dokumennya' }] },
  { at: day('2026-11-16T02:00:00Z'), menu: 'labels', action: 'print_labels', actor: { name: 'Budi', email: 'budi@treelogy.com' },
    changes: [{ field: 'shopify #13131', to: 'dicetak' }] },
  { at: day('2026-11-16T04:00:00Z'), menu: 'labels', action: 'label_printed', actor: { name: 'Agas', email: 'agas@treelogy.com' },
    changes: [{ field: 'tiktok_shop:5800', to: 'sudah dicetak' }] },
  { at: day('2026-11-16T05:00:00Z'), menu: 'labels', action: 'label_assign', actor: { name: 'Agas' }, changes: [{ field: 'shopify:#1', to: 'Budi' }] },
];

test('every parcel in a print run is a row; marked ones and failures are said as such', () => {
  const ev = labelEvents(entries);
  assert.deepEqual(ev.map((e) => [e.channel, e.id, e.status]), [
    ['shopify', '#13131', 'Dicetak'], ['shopee', '261109SQ', 'Gagal'], ['shopify', '#13131', 'Dicetak'], ['tiktok_shop', '5800', 'Ditandai tanpa cetak'],
  ]);
});

test('the file is newest first, counts which print this was from the whole log, and keeps to the range', () => {
  const sheet = buildLabelLogExport(entries, { from: '2026-11-16', to: '2026-11-16' });
  assert.deepEqual(sheet.rows.map((r) => [r.order, r.status, r.nth, r.by]), [
    ['5800', 'Ditandai tanpa cetak', 1, 'Agas'],
    ['#13131', 'Dicetak', 2, 'Budi'],
  ], 'the second print of #13131, though the first was the day before');
  const both = buildLabelLogExport(entries, { from: '2026-11-15', to: '2026-11-16' });
  assert.equal(both.rows.find((r) => r.status === 'Gagal').note, 'Shopee belum membuat dokumennya');
  assert.deepEqual(labelLogDays(entries), { '2026-11-15': [2, 1, 1], '2026-11-16': [2, 2, 0] });
  assert.equal(labelLogFilename('2026-11-01', '2026-11-16'), 'Log Cetak Label 1 - 16 Nov 2026.xlsx');
});

test('the label page offers the download to those who run it, never to a packer', () => {
  const base = { range: {}, errors: {}, shopeeShop: null, generatedAt: 0, csrf: 't', flash: null, sizes: { a6: { label: 'A6' } }, defaultSize: 'a6', orders: [] };
  const html = renderLabels({ ...base, user: { role: 'operator', status: 'active', email: 'a@t.com' } });
  assert.match(html, /id="label-export-open"/);
  assert.match(html, /data-days-url="\/api\/export\?dataset=labels&amp;summary=1"/);
  assert.match(html, /name="dataset" value="labels"/);
  const packer = renderLabels({ ...base, user: { role: 'packer', status: 'active', email: 'p@t.com' }, isPacker: true });
  assert.doesNotMatch(packer, /label-export/);
});

test('the Stok page carries the stock download, now that the picklist is gone (20 Nov)', async () => {
  const { renderWarehouse } = await import('../src/pages/warehouse.js');
  const { openWarehouse, emptyWarehouse, OPENING_AT } = await import('../src/warehouse.js');
  const warehouse = openWarehouse(emptyWarehouse(), { now: (OPENING_AT + 60) * 1000 });
  const html = renderWarehouse({ warehouse, range: { preset: '7d' }, errors: {}, generatedAt: 0, user: { role: 'owner', status: 'active', email: 'k@t.com' }, csrf: 't', stockExport: { today: '2026-11-16', first: '2026-10-06', days: {} } });
  assert.match(html, /id="stock-export-open"/);
  assert.match(html, /id="stock-export"/);
  assert.match(html, /name="dataset" value="inventory"/);
});
