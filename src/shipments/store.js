import { request, selectAll } from '../db/client.js';

/**
 * Parcel journeys in Postgres (table public.shipment_tracking, see db/schema.sql).
 *
 * Kept beside `orders`, not inside its payload: ingest_orders replaces a row's payload with
 * every webhook and sweep, so anything written there would be erased by the next read of the
 * order. One row per (channel, order, waybill).
 */

const TABLE = 'shipment_tracking';

/** Shopify orders with a waybill, placed on or after `sinceIso`, oldest first. */
export async function readShopifyShipments(sinceIso) {
  const rows = await selectAll('orders', {
    select: 'id,created_at,tracking,carrier,stage,gid:payload->>gid',
    channel: 'eq.shopify',
    tracking: 'neq.',
    created_at: `gte.${sinceIso}`,
    order: 'created_at.asc,id.asc',
  });
  return rows
    .filter((r) => r.stage !== 'cancelled' && r.stage !== 'returned')
    .map((r) => ({ channel: 'shopify', orderId: r.id, gid: r.gid, awb: String(r.tracking).trim(), carrier: r.carrier ?? '', createdAt: r.created_at }));
}

/** Every stored journey first seen on or after `sinceIso`, keyed `${orderId}|${awb}`. */
export async function readTrackingRows(sinceIso) {
  const rows = await selectAll(TABLE, {
    select: '*',
    channel: 'eq.shopify',
    first_seen_at: `gte.${sinceIso}`,
  });
  return new Map(rows.map((r) => [`${r.order_id}|${r.awb}`, r]));
}

/**
 * Upsert rows.
 *
 * PostgREST refuses a bulk upsert whose objects do not all carry the same keys (PGRST102),
 * so callers send complete rows (see rowFor in sync.js), never patches.
 */
export async function saveTrackingRows(rows) {
  if (!rows.length) return 0;
  await request(TABLE, {
    method: 'POST',
    params: { on_conflict: 'channel,order_id,awb' },
    body: rows.map((r) => ({ ...r, updated_at: new Date().toISOString() })),
    prefer: 'resolution=merge-duplicates,return=minimal',
  });
  return rows.length;
}
