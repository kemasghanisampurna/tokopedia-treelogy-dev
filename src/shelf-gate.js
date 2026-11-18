import { loadWarehouse } from './warehouse-run.js';
import { ordersByIds } from './db/orders.js';
import { loadAssignments } from './label-assign.js';
import { printedLabels } from './shopify/label.js';
import { shortagesInTurn, shortageText, needsFor } from './warehouse-reserve.js';

/**
 * Goods that are not on the shelf cannot be packed - so their label is not printed,
 * by a packer or by anybody else, and the parcel is not handed to a packer either.
 *
 * One check for every road that would send a parcel towards the bench: printing
 * (/api/labels, whoever prints) and handing out (label_assign). Measured against "di
 * rak" as it stands at the moment of asking, read fresh, through the same recipes the
 * shelf counts with - and shared out in turn (shortagesInTurn): a parcel already handed
 * to a packer holds its goods until its label comes out, so three oils on the shelf are
 * three parcels' worth, not three for every parcel asked about. The pages show the same
 * verdict in advance; this is the one that holds when a page is out of date.
 */

const toRef = (k) => ({ channel: k.slice(0, k.indexOf(':')), id: k.slice(k.indexOf(':') + 1) });

/** The shelf, the hand-outs, and every order that queues for the shelf with these keys. */
async function readTurn(keys) {
  const [shelf, assignments, printed] = await Promise.all([
    loadWarehouse(),
    loadAssignments(),
    printedLabels().catch(() => ({})),
  ]);
  // Handed out and not printed: those still hold goods. A printed one has taken its goods
  // off the shelf already (or will, at the next sweep, and needsFor knows), so it is not read.
  const holding = Object.keys(assignments.orders ?? {}).filter((k) => !printed[k]);
  const wanted = [...new Set([...holding, ...keys])];
  const rows = wanted.length ? await ordersByIds(wanted.map(toRef)) : [];
  const list = Array.isArray(rows) ? rows : rows?.orders ?? [];
  return { shelf, assignments, orders: list, printed };
}

/**
 * @param {string[]} keys order keys, "channel:id"
 * @param {{handingOut?: boolean}} [opts] handing out: these queue behind every parcel
 *   already handed out. Printing: a handed-out parcel keeps its place in the queue.
 * @returns {Promise<Array<{key, id, short}>>} the parcels that cannot be filled, in the order asked
 */
export async function shelfShortages(keys, { handingOut = false } = {}) {
  if (!keys.length) return [];
  const { shelf, assignments, orders } = await readTurn(keys);
  const asked = new Set(keys);
  // Asked-for orders queue in the order asked, behind the parcels already holding goods.
  const byKey = new Map(orders.map((o) => [`${o.channel}:${o.id}`, o]));
  const queue = [...orders.filter((o) => !asked.has(`${o.channel}:${o.id}`)), ...keys.map((k) => byKey.get(k)).filter(Boolean)];
  const turn = shortagesInTurn(shelf, queue, assignments, { fresh: handingOut ? keys : [] });
  return keys
    .map((key) => ({ key, id: byKey.get(key)?.id ?? key.slice(key.indexOf(':') + 1), short: turn.get(key) ?? [] }))
    .filter((x) => x.short.length);
}

/**
 * The verdict on every handed-out parcel still to print, for the packer page to poll:
 * {key: "Stok di rak kurang: ..."} for the ones the shelf cannot fill now.
 */
export async function handedOutShortages() {
  const { shelf, assignments, orders, printed } = await readTurn([]);
  const turn = shortagesInTurn(shelf, orders, assignments);
  // Handed out and printed (unchanged since), with when: the packer's page moves such a
  // row to Sudah dicetak, whichever page or phone printed it.
  const done = {};
  for (const [key, a] of Object.entries(assignments.orders ?? {})) {
    const entry = printed[key];
    if (entry && !entry.stale && a?.to) done[key] = { to: a.to, at: Number(entry.at) * 1000 };
  }
  const short = {};
  for (const [key, list] of turn) if (list.length && assignments.orders?.[key]) short[key] = { to: assignments.orders[key].to, text: shortageText(list) };
  // What the handed-out parcels hold between them, {code: qty}: the label page takes it
  // off "di rak" before it lets more parcels be handed out or printed (stock check popup).
  const held = {};
  for (const o of orders) {
    if (o.stage !== 'to_ship' || !assignments.orders?.[`${o.channel}:${o.id}`]) continue;
    for (const [code, qty] of Object.entries(needsFor(shelf, o))) held[code] = (held[code] ?? 0) + qty;
  }
  return { short, held, done };
}

/** "#13131: Stok di rak kurang: Pouch Treelogy (perlu 1, ada 0) (dan 2 pesanan lain)" */
export const shortRefusal = (short) => `${short[0].id}: ${shortageText(short[0].short)}${short.length > 1 ? ` (dan ${short.length - 1} pesanan lain)` : ''}`;
