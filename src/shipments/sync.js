import { mapLimit } from '../omni.js';
import { courierFor } from './couriers.js';
import { trackWaybill, klikResiBalance, TRACK_PRICE } from './klikresi.js';
import { readFulfillments, fulfillmentKey, isDeliveredOnShopify, markDelivered } from './shopify.js';
import { readShopifyShipments, readTrackingRows, saveTrackingRows } from './store.js';

/**
 * Once a day (19:00 WIB, treelogy-shipments.timer): where is every Shopify parcel, and has
 * one arrived that Shopify still calls merely "Fulfilled"?
 *
 * Klik Resi has no webhook, so this is a pull, and every successful pull costs Rp15 from a
 * prepaid balance. Most of the shape below is about not paying for a question whose answer
 * is already known:
 *
 *   - an order Shopify already shows as DELIVERED is never asked about (the Shopify read is free);
 *   - a journey that already ended (Delivered and marked, returned, expired) is never asked again;
 *   - a fulfillment younger than MIN_AGE_HOURS is skipped. Lion and J&T took 3-4 days on the
 *     first real answers (20 Nov 2026), so asking on day one or two mostly buys "InTransit";
 *     at 48 hours the first paid question is usually also the last;
 *   - a waybill checked within RECHECK_HOURS is skipped, so a manual run after the timer
 *     does not pay twice the same day;
 *   - the run reads the balance first and asks only as many as it can pay for, oldest
 *     order first (the likeliest to have arrived). The rest wait for tomorrow and are counted,
 *     never silently dropped.
 *
 * A waybill the courier does not know yet answers 400 and is free; it is simply asked again
 * the next day until the window closes.
 */

export const WINDOW_DAYS = 14;
export const MIN_AGE_HOURS = 48;
export const RECHECK_HOURS = 20;

/** Statuses after which nothing more will happen to a parcel. */
const ENDED = new Set(['ReturnToSender', 'Expired']);

const HOUR = 3600_000;

/** The full column set, so a bulk upsert never mixes row shapes (PGRST102). */
export function rowFor(shipment, prior, patch = {}) {
  const base = {
    channel: shipment.channel,
    order_id: shipment.orderId,
    awb: shipment.awb,
    courier: prior?.courier ?? shipment.courier ?? '',
    status: prior?.status ?? '',
    last_message: prior?.last_message ?? '',
    last_event_at: prior?.last_event_at ?? null,
    delivered_at: prior?.delivered_at ?? null,
    histories: prior?.histories ?? [],
    checks: prior?.checks ?? 0,
    checked_at: prior?.checked_at ?? null,
    error: prior?.error ?? '',
    shopify_fulfillment_id: prior?.shopify_fulfillment_id ?? '',
    shopify_status: prior?.shopify_status ?? '',
    shopify_marked_at: prior?.shopify_marked_at ?? null,
    shopify_error: prior?.shopify_error ?? '',
  };
  return { ...base, ...patch };
}

const isBalanceError = (error) => error?.status === 402 || /saldo|balance|insufficient|top ?up/i.test(error?.message ?? '');

/**
 * @returns {Promise<object>} a report; nothing in it is assumed - every "marked" was read back
 */
export async function syncShipments({
  now = Date.now(),
  windowDays = WINDOW_DAYS,
  limit = Infinity,
  dryRun = false,
  only = null,
  concurrency = 3,
  readShipments = readShopifyShipments,
  readRows = readTrackingRows,
  saveRows = saveTrackingRows,
  readShopify = readFulfillments,
  balance = klikResiBalance,
  track = trackWaybill,
  mark = markDelivered,
} = {}) {
  const sinceIso = new Date(now - windowDays * 24 * HOUR).toISOString();
  const nowIso = new Date(now).toISOString();
  const report = {
    window: sinceIso,
    shipments: 0,
    skipped: { unknownCourier: 0, finished: 0, deliveredOnShopify: 0, noFulfillment: 0, tooFresh: 0, recentlyChecked: 0 },
    toTrack: 0,
    balance: null,
    cost: 0,
    unaffordable: 0,
    tracked: 0,
    notFound: 0,
    delivered: 0,
    marked: { confirmed: 0, unconfirmed: 0, failed: 0 },
    failures: [],
    dryRun,
  };

  let shipments = await readShipments(sinceIso);
  if (only) shipments = shipments.filter((s) => s.awb === only || s.orderId === only);
  report.shipments = shipments.length;

  const rows = await readRows(sinceIso);
  const out = new Map();
  const put = (shipment, prior, patch) => {
    const row = rowFor(shipment, out.get(`${shipment.orderId}|${shipment.awb}`) ?? prior, patch);
    out.set(`${shipment.orderId}|${shipment.awb}`, row);
    return row;
  };

  // 1. What can be decided without asking anyone.
  const open = [];
  for (const s of shipments) {
    s.courier = courierFor(s.carrier, s.awb);
    if (!s.courier) { report.skipped.unknownCourier += 1; continue; }
    const prior = rows.get(`${s.orderId}|${s.awb}`);
    if (prior?.shopify_marked_at || ENDED.has(prior?.status)) { report.skipped.finished += 1; continue; }
    open.push({ s, prior });
  }

  // 2. What Shopify already knows - free.
  const fulfillments = open.length ? await readShopify(open.map(({ s }) => ({ gid: s.gid, awb: s.awb }))) : new Map();
  const toTrack = [];
  const toMark = [];
  for (const { s, prior } of open) {
    const f = fulfillments.get(fulfillmentKey(s.gid, s.awb));
    if (!f) {
      report.skipped.noFulfillment += 1;
      put(s, prior, { shopify_error: 'resi ini tidak ada di fulfillment Shopify order ini' });
      continue;
    }
    if (isDeliveredOnShopify(f)) {
      report.skipped.deliveredOnShopify += 1;
      put(s, prior, { shopify_fulfillment_id: f.id, shopify_status: 'DELIVERED', shopify_marked_at: f.deliveredAt ?? nowIso, shopify_error: '' });
      continue;
    }
    if (prior?.status === 'Delivered' && prior?.delivered_at) {
      // Arrived on an earlier run, but Shopify did not take the mark then. Try again, free.
      toMark.push({ s, prior, f });
      continue;
    }
    if (now - Date.parse(f.createdAt) < MIN_AGE_HOURS * HOUR) { report.skipped.tooFresh += 1; continue; }
    if (prior?.checked_at && now - Date.parse(prior.checked_at) < RECHECK_HOURS * HOUR) { report.skipped.recentlyChecked += 1; continue; }
    toTrack.push({ s, prior, f });
  }
  report.toTrack = toTrack.length;

  // 3. Spend only what the balance covers.
  if (toTrack.length > 0) report.balance = await balance();
  const affordable = report.balance === null ? 0 : Math.floor(report.balance / TRACK_PRICE);
  const take = Math.min(toTrack.length, affordable, limit);
  report.unaffordable = Math.max(0, Math.min(toTrack.length, limit) - take);

  if (dryRun) {
    report.cost = take * TRACK_PRICE;
    report.plan = toTrack.slice(0, take).map(({ s }) => ({ orderId: s.orderId, awb: s.awb, courier: s.courier }));
    report.remarks = toMark.length;
    return report;
  }

  let halted = false;
  await mapLimit(toTrack.slice(0, take), concurrency, async ({ s, prior, f }) => {
    if (halted) { report.unaffordable += 1; return; }
    try {
      const t = await track(s.awb, s.courier);
      report.tracked += 1;
      report.cost += TRACK_PRICE;
      const latest = t.histories[0] ?? null;
      const row = put(s, prior, {
        courier: s.courier,
        status: t.status,
        last_message: latest?.message ?? '',
        last_event_at: latest?.date ?? null,
        delivered_at: t.deliveredAt,
        histories: t.histories,
        checks: (prior?.checks ?? 0) + 1,
        checked_at: nowIso,
        error: '',
        shopify_fulfillment_id: f.id,
        shopify_status: f.displayStatus ?? '',
      });
      if (t.status === 'Delivered' && t.deliveredAt) {
        report.delivered += 1;
        toMark.push({ s, prior: row, f });
      }
    } catch (error) {
      if (error?.notFound) {
        report.notFound += 1;
        put(s, prior, { courier: s.courier, status: prior?.status || 'NotFound', checks: (prior?.checks ?? 0) + 1, checked_at: nowIso, error: error.message, shopify_fulfillment_id: f.id });
        return;
      }
      if (isBalanceError(error)) halted = true;
      report.failures.push({ orderId: s.orderId, awb: s.awb, step: 'lacak', message: error.message });
      put(s, prior, { courier: s.courier, error: error.message, shopify_fulfillment_id: f.id });
    }
  });

  // Checkpoint: what was paid for is stored before anything else can go wrong. A run that
  // dies while marking leaves rows that say Delivered without shopify_marked_at, and the next
  // run marks those again for free instead of paying to track them again.
  await saveRows([...out.values()]);

  // 4. Tell Shopify, a few at a time, and believe only the read-back.
  await mapLimit(toMark, concurrency, async ({ s, prior, f }) => {
    const latest = out.get(`${s.orderId}|${s.awb}`) ?? prior;
    const result = await mark(f.id, { happenedAt: latest.delivered_at, message: latest.last_message });
    report.marked[result.outcome] += 1;
    if (result.outcome !== 'confirmed') report.failures.push({ orderId: s.orderId, awb: s.awb, step: 'shopify', message: result.message });
    put(s, latest, {
      shopify_fulfillment_id: f.id,
      shopify_status: result.outcome === 'confirmed' ? 'DELIVERED' : (f.displayStatus ?? ''),
      shopify_marked_at: result.outcome === 'confirmed' ? nowIso : null,
      shopify_error: result.outcome === 'confirmed' ? '' : (result.message ?? ''),
    });
  });

  await saveRows([...out.values()]);
  return report;
}

const esc = (text) => String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * What, if anything, the team needs to hear about a run.
 *
 * Only what somebody can act on: parcels left unchecked because the balance ran short (top
 * up), and marks Shopify did not take (look at the order). A good day says nothing - the
 * same restraint as every other alert on this box.
 *
 * @returns {{key: string, html: string}|null}
 */
export function shipmentsAlert(report, { day = new Date().toISOString().slice(0, 10) } = {}) {
  const lines = [];
  if (report.unaffordable > 0) {
    lines.push(`💳 Saldo Klik Resi ${report.balance === null ? '?' : `Rp${report.balance.toLocaleString('id-ID')}`} tidak cukup: <b>${report.unaffordable} resi</b> tidak dicek hari ini (Rp${TRACK_PRICE}/resi). Top up di klikresi.com.`);
  }
  const shopify = report.failures.filter((f) => f.step === 'shopify');
  if (shopify.length > 0) {
    lines.push(`⚠️ ${shopify.length} paket sudah sampai tapi Shopify belum menampilkan DELIVERED:`);
    for (const f of shopify.slice(0, 6)) lines.push(`• ${esc(f.orderId)} <code>${esc(f.awb)}</code> - ${esc(f.message).slice(0, 120)}`);
  }
  const lacak = report.failures.filter((f) => f.step === 'lacak');
  if (lacak.length > 0) lines.push(`❗ ${lacak.length} resi gagal dilacak (bukan "belum ditemukan"): ${esc(lacak[0].message).slice(0, 120)}`);
  if (lines.length === 0) return null;
  return { key: `shipments:${day}`, html: `<b>📦 Lacak resi Shopify</b>\n${lines.join('\n')}` };
}
