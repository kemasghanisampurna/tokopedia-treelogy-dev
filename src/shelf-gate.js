import { loadWarehouse } from './warehouse-run.js';
import { ordersByIds } from './db/orders.js';
import { shortagesFor, shortageText } from './warehouse-reserve.js';

/**
 * Goods that are not on the shelf cannot be packed - so their label is not printed,
 * by a packer or by anybody else, and the parcel is not handed to a packer either.
 *
 * One check for every road that would send a parcel towards the bench: printing
 * (/api/labels, whoever prints) and handing out (label_assign). Measured against "di
 * rak" as it stands at the moment of asking, read fresh, through the same recipes the
 * shelf counts with (shortagesFor). The pages show the same verdict in advance; this is
 * the one that holds when a page is out of date.
 *
 * @param {string[]} keys order keys, "channel:id"
 * @returns {Promise<Array<{key, id, short}>>} the parcels that cannot be filled
 */
export async function shelfShortages(keys) {
  if (!keys.length) return [];
  const [shelf, rows] = await Promise.all([
    loadWarehouse(),
    ordersByIds(keys.map((k) => ({ channel: k.slice(0, k.indexOf(':')), id: k.slice(k.indexOf(':') + 1) }))),
  ]);
  const list = Array.isArray(rows) ? rows : rows?.orders ?? [];
  return list
    .map((o) => ({ key: `${o.channel}:${o.id}`, id: o.id, short: shortagesFor(shelf, o) }))
    .filter((x) => x.short.length);
}

/** "#13131: Stok di rak kurang: Pouch Treelogy (perlu 1, ada 0) (dan 2 lainnya)" */
export const shortRefusal = (short) => `${short[0].id}: ${shortageText(short[0].short)}${short.length > 1 ? ` (dan ${short.length - 1} pesanan lain)` : ''}`;
