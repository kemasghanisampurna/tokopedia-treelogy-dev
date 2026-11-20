import { shopifyGraphql } from '../shopify/client.js';

/**
 * The one write this system makes to Shopify orders: "this parcel was delivered".
 *
 * Shopify is otherwise changed in Shopify, never from here (team rule, 7 Oct 2026 - see
 * test/shopify-readonly.test.js). This is a deliberate, narrow exception the owner asked for
 * on 20 Nov 2026: Lion Parcel and J&T never tell Shopify a parcel arrived, so every Shopify
 * order stayed "Fulfilled" forever while the marketplaces showed "Delivered". The write adds
 * a DELIVERED event to a fulfillment that already exists - no order, line, price, stock or
 * tracking number is touched - and needs write_fulfillments, granted to Omni Treelogy in app
 * version omni-treelogy-6.
 *
 * All three operations were validated against the live Admin schema (2026-07) before use.
 */

const FULFILLMENTS_QUERY = `query ShipmentFulfillments($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on Order {
      id
      fulfillments(first: 10) {
        id
        createdAt
        displayStatus
        deliveredAt
        trackingInfo(first: 5) { number }
      }
    }
  }
}`;

const MARK_DELIVERED = `mutation MarkDelivered($fulfillmentEvent: FulfillmentEventInput!) {
  fulfillmentEventCreate(fulfillmentEvent: $fulfillmentEvent) {
    fulfillmentEvent { id status happenedAt }
    userErrors { field message }
  }
}`;

const READ_BACK = `query FulfillmentDelivered($id: ID!) {
  fulfillment(id: $id) { id displayStatus deliveredAt }
}`;

/** Orders per nodes() call. Each brings at most ten fulfillments, so this stays cheap. */
const NODES_PER_QUERY = 50;

const normalise = (number) => String(number ?? '').trim().toUpperCase();

/**
 * The fulfillment carrying each waybill, read from Shopify itself.
 *
 * Matching is by tracking number inside the order, never "the order's first fulfillment":
 * an order split across two parcels has two fulfillments, and marking the wrong one
 * delivered would tell the buyer the other parcel arrived.
 *
 * @param {Array<{gid: string, awb: string}>} wanted
 * @returns {Promise<Map<string, {id: string, createdAt: string, displayStatus: string, deliveredAt: string|null}>>}
 *   keyed by `${gid}|${AWB}`; a waybill with no fulfillment on that order is simply absent
 */
export async function readFulfillments(wanted, { graphql = shopifyGraphql } = {}) {
  const found = new Map();
  const gids = [...new Set(wanted.map((w) => w.gid).filter(Boolean))];
  for (let i = 0; i < gids.length; i += NODES_PER_QUERY) {
    const data = await graphql(FULFILLMENTS_QUERY, { ids: gids.slice(i, i + NODES_PER_QUERY) });
    for (const order of data?.nodes ?? []) {
      if (!order?.id) continue;
      for (const f of order.fulfillments ?? []) {
        for (const t of f.trackingInfo ?? []) {
          found.set(`${order.id}|${normalise(t.number)}`, {
            id: f.id, createdAt: f.createdAt, displayStatus: f.displayStatus, deliveredAt: f.deliveredAt ?? null,
          });
        }
      }
    }
  }
  return found;
}

export const fulfillmentKey = (gid, awb) => `${gid}|${normalise(awb)}`;

export const isDeliveredOnShopify = (f) => f?.displayStatus === 'DELIVERED' || Boolean(f?.deliveredAt);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Add a DELIVERED event, then read the fulfillment back to see whether Shopify took it.
 *
 * A clean mutation response is not proof (see the Shopee ship_order lesson): the outcome
 * reported is what the read-back shows, with the platform's own message on failure.
 *
 * @returns {Promise<{outcome: 'confirmed'|'unconfirmed'|'failed', message?: string, deliveredAt?: string|null}>}
 */
export async function markDelivered(fulfillmentId, { happenedAt, message }, {
  graphql = shopifyGraphql,
  readBackDelays = [1500, 3000, 5000],
} = {}) {
  let data;
  try {
    data = await graphql(MARK_DELIVERED, {
      fulfillmentEvent: {
        fulfillmentId,
        status: 'DELIVERED',
        ...(happenedAt ? { happenedAt } : {}),
        ...(message ? { message: message.slice(0, 255) } : {}),
      },
    });
  } catch (error) {
    return { outcome: 'failed', message: error.message };
  }
  const errors = data?.fulfillmentEventCreate?.userErrors ?? [];
  if (errors.length > 0) return { outcome: 'failed', message: errors.map((e) => e.message).join('; ') };

  for (const delay of readBackDelays) {
    await sleep(delay);
    try {
      const back = await graphql(READ_BACK, { id: fulfillmentId });
      if (isDeliveredOnShopify(back?.fulfillment)) {
        return { outcome: 'confirmed', deliveredAt: back.fulfillment.deliveredAt ?? null };
      }
    } catch {
      // A failed read is not a failed write; keep looking until the delays run out.
    }
  }
  return { outcome: 'unconfirmed', message: 'event terkirim tetapi Shopify belum menampilkan DELIVERED' };
}
