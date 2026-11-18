import test from 'node:test';
import assert from 'node:assert/strict';

import { boardSnapshot, boardUnknown, BOARD_PRINTED_WINDOW_SEC } from '../src/label-board.js';

/*
 * The hand-out board is the assignment document and the printed ledger side by side.
 * Left: handed out, label not yet out of the printer, oldest hand-out first. Right:
 * printed, newest first, over the last day.
 */

const NOW = 1_800_000_000; // seconds
const order = (id, over = {}) => ({ channel: 'shopify', id, stage: 'to_ship', buyer: `Pembeli ${id}`, ...over });
const handed = (minutesAgo, to = 'yusa@x', name = 'Yusa', by = 'agas@x') => ({ to, name, by, at: (NOW - minutesAgo * 60) * 1000 });
const arranged = { '#1': { at: NOW }, '#2': { at: NOW }, '#3': { at: NOW }, '#4': { at: NOW } };

test('waiting parcels are listed oldest hand-out first, printed ones newest first', () => {
  const snap = boardSnapshot({
    assignments: { orders: {
      'shopify:#1': handed(5),
      'shopify:#2': handed(90, 'rifal@x', 'Rifal'),
      'shopify:#3': handed(200),
      'shopify:#4': handed(300),
    } },
    printed: { 'shopify:#3': { at: NOW - 600, by: 'yusa@x' }, 'shopify:#4': { at: NOW - 60, by: 'yusa@x' } },
    outstanding: [order('#1'), order('#2'), order('#3'), order('#4')],
    arranged,
    people: { 'agas@x': 'Agas', 'yusa@x': 'Yusa' },
    now: NOW,
  });
  assert.deepEqual(snap.pending.map((c) => c.id), ['#2', '#1']);
  assert.deepEqual(snap.printed.map((c) => c.id), ['#4', '#3']);
  assert.equal(snap.pending[0].packer, 'Rifal');
  assert.equal(snap.pending[0].by, 'Agas', 'who handed it out is named, not emailed');
  assert.equal(snap.printed[0].printedBy, 'Yusa');
  assert.equal(snap.pending[0].buyer, 'Pembeli #2');
});

test('a label edited since it was printed goes back to the left', () => {
  const snap = boardSnapshot({
    assignments: { orders: { 'shopify:#1': handed(30) } },
    printed: { 'shopify:#1': { at: NOW - 100, stale: true } },
    outstanding: [order('#1')],
    arranged,
    now: NOW,
  });
  assert.deepEqual(snap.pending.map((c) => c.id), ['#1']);
  assert.equal(snap.printed.length, 0);
});

test('an unprinted parcel that left the worklist is nobody\'s job and is not shown', () => {
  const snap = boardSnapshot({
    assignments: { orders: { 'shopify:#9': handed(30) } },
    printed: {},
    outstanding: [],
    now: NOW,
  });
  assert.equal(snap.pending.length, 0);
  assert.equal(snap.printed.length, 0);
});

test('the printed column keeps one day, and names buyers of parcels already gone', () => {
  const assignments = { orders: { 'shopify:#5': handed(2000), 'shopify:#6': handed(30) } };
  const printed = {
    'shopify:#5': { at: NOW - BOARD_PRINTED_WINDOW_SEC - 10 },
    'shopify:#6': { at: NOW - 60 },
  };
  assert.deepEqual(boardUnknown({ assignments, printed, outstanding: [], now: NOW }), ['shopify:#6']);
  const snap = boardSnapshot({ assignments, printed, outstanding: [], known: { 'shopify:#6': { buyer: 'Irma' } }, now: NOW });
  assert.deepEqual(snap.printed.map((c) => [c.id, c.buyer]), [['#6', 'Irma']]);
  assert.equal(snap.printed[0].tag.label.length > 0, true);
});

test('a parcel marked printed without printing says so', () => {
  const snap = boardSnapshot({
    assignments: { orders: { 'shopify:#1': handed(30) } },
    printed: { 'shopify:#1': { at: NOW - 60, marked: true } },
    outstanding: [order('#1')],
    arranged,
    now: NOW,
  });
  assert.equal(snap.printed[0].marked, true);
});
