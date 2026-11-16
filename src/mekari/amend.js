import { mekari } from './client.js';
import { buildInvoice, verifyInvoice, customIdFor } from './invoice.js';
import { loadSyncLedger, saveSyncLedger } from './sync.js';
import { postingAccounts } from './accounts.js';
import { forgetCatalogue } from './catalogue.js';
import { refusalFor } from './discard.js';
import { isReadOnly, ReadOnlyError } from '../stock-sync.js';
import { invoiceSignature } from './drift.js';

/**
 * Correcting an invoice in place, rather than deleting it and writing another.
 *
 * Jurnal's PATCH on a sales invoice takes the whole thing - transaction_lines_attributes
 * included - so an edited sale keeps its Sales Invoice number, its place in the sequence
 * and whatever anybody has already written down about it. That matters: a WhatsApp
 * customer who adds a jar mid-conversation should not cause an invoice number to vanish
 * from the books and another to appear.
 *
 * The same thing is rebuilt from the same builder the create path uses, so an amended
 * invoice is byte-for-byte what a fresh one would have been. Nothing bespoke is sent.
 *
 * What it refuses is what the delete path refuses, for the same reason: an invoice with a
 * payment recorded against it has a counterpart in the bank, and rewriting its lines
 * would leave that payment attached to a sale that no longer says what it said.
 */

const INVOICES_PATH = '/public/jurnal/api/v1/sales_invoices';

/**
 * Whether a paid invoice may still be rewritten, and why not when it may not.
 *
 * The refusal above protects payments somebody recorded by hand. But a web-shop invoice
 * is born paid: buildInvoice marks it settled on deposit into the Website pooling account
 * in the same request that creates it (invoice.js, `deposit`). That payment is ours, it is
 * restated by every rebuild, and redate.js already replaces such invoices whole and keeps
 * the payment's id (see the long note there). So when the only money on the invoice is the
 * deposit this code posted - the amount it last wrote - and the rebuild carries a deposit
 * again, rewriting it moves the payment with it rather than orphaning it.
 *
 * That is what a buyer editing their own order needs (treelogy-order-edit): the new total
 * is what they have now paid, original checkout plus the QRIS difference, or less a
 * refund CS sends back.
 *
 * Off unless MEKARI_AMEND_DEPOSIT_PAID=1. Restating a deposit to a DIFFERENT amount has
 * not been observed against the live Jurnal yet - redate only ever restated the same sum -
 * so it is switched on after one supervised edit, not by a deploy.
 *
 * @returns {string|null} the reason to refuse, or null to go ahead
 */
export function amendRefusal(invoice, built, entry, { allowDepositRestate = process.env.MEKARI_AMEND_DEPOSIT_PAID === '1' } = {}) {
  const refusal = refusalFor(invoice);
  if (!refusal) return null;
  if (!allowDepositRestate) return refusal;
  const stated = invoice?.payment_received_amount;
  const received = stated === undefined || stated === null || stated === '' ? null : Math.round(Number(stated));
  const posted = Math.round(Number(entry?.total));
  const ours = received !== null && Number.isFinite(posted) && posted > 0 && received === posted;
  if (ours && built?.sales_invoice?.deposit !== undefined && built.sales_invoice.deposit_to_name) return null;
  return refusal;
}

/**
 * @param {object} order  the rebuilt order, already carrying the edit
 * @returns {Promise<{customId: string, invoiceId: number|null, transactionNo: string|null,
 *   total: number, amended: boolean}>}
 */
/**
 * One rewrite of an invoice at a time, per invoice.
 *
 * Shopify can deliver orders/edited twice in quick succession - two edits, or its own
 * redelivery when our first answer was slow - and the second PATCH then meets the first
 * still in progress: Jurnal answers 423 "Resource is currently being updated" (order 13166,
 * 10 Nov 2026). Queued behind each other, the second simply rewrites the invoice again
 * with the same payload, which is harmless because a PATCH is a full replace.
 */
const inFlight = new Map();

export function amendManualInvoice(order, options = {}) {
  const key = customIdFor(order);
  const previous = inFlight.get(key) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(() => amendNow(order, options));
  const settled = run.catch(() => {});
  inFlight.set(key, settled);
  settled.then(() => { if (inFlight.get(key) === settled) inFlight.delete(key); });
  return run;
}

async function amendNow(order, {
  accounts = null, call = mekari, loadLedger = loadSyncLedger, saveLedger = saveSyncLedger, forget = forgetCatalogue,
} = {}) {
  const customId = customIdFor(order);
  const ledger = await loadLedger().catch(() => ({ orders: {} }));
  const entry = ledger.orders?.[customId] ?? null;
  const invoiceId = entry?.voided ? null : (entry?.invoice_id ?? null);

  const chart = accounts ?? await postingAccounts();
  const built = buildInvoice({ order, accounts: chart });
  // The same check the create path makes, on the same builder: an invoice whose lines do
  // not add up to its own total is one nobody can explain afterwards.
  verifyInvoice(built, built.expectedTotal);

  // Nothing in Jurnal to correct. The caller decides whether that means "post it now" or
  // "leave it"; here it simply means there was no invoice to rewrite.
  if (!invoiceId) return { customId, invoiceId: null, transactionNo: null, total: built.expectedTotal, amended: false };

  if (isReadOnly()) throw new ReadOnlyError(`ubah faktur ${customId}`);

  const found = await call({ path: `${INVOICES_PATH}/${invoiceId}` });
  const invoice = found?.sales_invoice ?? found;
  const refusal = amendRefusal(invoice, built, entry);
  if (refusal) throw new Error(refusal);

  await call({ method: 'PATCH', path: `${INVOICES_PATH}/${invoiceId}`, body: { sales_invoice: built.sales_invoice } });

  // Landed: whatever was waiting to be retried is now done.
  const { amend_pending: _pending, ...rest } = entry ?? {};
  ledger.orders[customId] = {
    ...rest,
    total: built.expectedTotal,
    amended_at: new Date().toISOString(),
    // The invoice now matches this order; the next change is measured from here.
    sig: invoiceSignature(order),
  };
  await saveLedger(ledger);

  // The cached scan still holds the figures this invoice had a moment ago, and anything
  // that changes what Jurnal holds has to drop it - otherwise the next reconcile, recap
  // and dedupe all read the amount this edit just corrected away.
  await forget().catch(() => {});

  return {
    customId,
    invoiceId,
    transactionNo: invoice?.transaction_no ?? null,
    total: built.expectedTotal,
    amended: true,
  };
}
