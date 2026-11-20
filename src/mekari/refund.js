import { mekari } from './client.js';
import { customIdFor } from './invoice.js';
import { loadSyncLedger, saveSyncLedger, returnInvoice, undoneRecord } from './sync.js';
import { orderById } from '../db/orders.js';
import { readDoc, updateDoc } from '../store/index.js';
import { isReadOnly, ReadOnlyError } from '../stock-sync.js';
import { invalidate } from '../cache.js';

/**
 * An order the team refunded: booked as a sales return against its Jurnal invoice (the
 * team's rule since 20 Nov: every refund is a sales return, never a deleted invoice) and
 * its row leaves the dashboard. The money itself is finance's job, done by hand - nothing here touches a
 * platform or a payment.
 *
 * The row cannot simply be deleted: the next sweep would bring it back from the platform.
 * So the order is remembered in REFUNDS_DOC and every list leaves it out. Its sync-ledger
 * entry is marked voided as well, invoiced or not, so the Jurnal sync never posts it again.
 */

export const REFUNDS_DOC = 'orders/refunded.json';

export const refundKey = (order) => `${order.channel}:${order.id}`;

export async function loadRefunds() {
  return (await readDoc(REFUNDS_DOC).catch(() => null))?.orders ?? {};
}

/** The orders a page shows, without the refunded ones. */
export function withoutRefunds(data, refunds) {
  if (!data?.orders || !Object.keys(refunds ?? {}).length) return data;
  return { ...data, orders: data.orders.filter((o) => !refunds[refundKey(o)]) };
}

/**
 * Invoice first, then the row - if Jurnal refuses (a payment recorded against it), nothing
 * else happens and the operator is told why.
 */
export async function refundOrder({ channel, id, by = '' }, {
  read = orderById, call = mekari, loadLedger = loadSyncLedger, saveLedger = saveSyncLedger, update = updateDoc,
} = {}) {
  if (!channel || !id) throw new Error('tidak ada pesanan yang disebut');
  if (channel === 'manual') throw new Error('transaksi manual dihapus lewat "Hapus transaksi", bukan refund');
  const order = await read(channel, id);
  if (!order) throw new Error(`pesanan ${id} tidak ada di daftar`);
  if (isReadOnly()) throw new ReadOnlyError(`refund ${id}`);

  const customId = customIdFor(order);
  const ledger = await loadLedger().catch(() => ({ orders: {} }));
  const entry = ledger.orders?.[customId] ?? null;
  const invoiceId = entry?.voided ? null : (entry?.invoice_id ?? null);

  // Every refund is a sales return; the invoice stays. A refusal stops everything, so the
  // order stays visible and the operator reads why.
  let outcome = null;
  if (invoiceId) {
    outcome = await returnInvoice(order, entry, { dryRun: false, call, memo: `Refund ${order.id} dari dashboard${by ? ` oleh ${by}` : ''}` });
    if (outcome.outcome !== 'returned' && outcome.outcome !== 'gone') throw new Error(outcome.reason ?? `retur penjualan ${id} gagal`);
  }
  const at = new Date().toISOString();
  ledger.orders = { ...(ledger.orders ?? {}), [customId]: {
    ...(entry ?? {}),
    ...(outcome ? undoneRecord(outcome, at) : { voided: true, voided_at: entry?.voided_at ?? at }),
    refunded: true,
  } };
  await saveLedger(ledger);

  await update(REFUNDS_DOC, (doc) => ({
    orders: { ...(doc?.orders ?? {}), [refundKey(order)]: { at, by, total: Number(order.total) || 0, invoice: outcome?.transactionNo ?? invoiceId, return: outcome?.returnNo ?? null } },
  }), { orders: {} });

  invalidate('orders');
  invalidate('jurnal');
  return {
    id: order.id, channel, total: Number(order.total) || 0, invoiceId,
    transactionNo: outcome?.transactionNo ?? null,
    returned: outcome?.outcome === 'returned', returnNo: outcome?.returnNo ?? null, existing: Boolean(outcome?.existing),
    gone: outcome?.outcome === 'gone',
  };
}
