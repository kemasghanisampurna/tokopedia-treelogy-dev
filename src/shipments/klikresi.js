import { readEnv } from '../env-file.js';
import { ENV_PATH, ENV_LOCAL_PATH } from '../config.js';
import { fetchWithTimeout, TIMEOUTS } from '../http.js';

/**
 * Klik Resi: where a Shopify parcel's journey is read from.
 *
 * Shopify knows a tracking number but not what became of the parcel - none of the couriers
 * we ship Shopify orders with (Lion Parcel, J&T) report back to it. Klik Resi reads the
 * courier and answers with a normalised status, so "Delivered" means the same thing for
 * every courier and nothing here has to parse Indonesian courier prose.
 *
 * BinderByte was tried first (20 Nov 2026) and answered "Data not found" for every waybill,
 * including the vendor's own dashboard tool - this is the replacement.
 *
 * Billing is per *successful* tracking request (Rp15). A waybill the courier does not know
 * yet answers 400 "tracking information not found or expired" and costs nothing - measured
 * against the live account on 20 Nov 2026, balance unchanged across the 400. /api/me is not
 * a billed endpoint and returns the balance, which is what lets a run spend only what it has.
 *
 * Hand-written rather than the official @klikresi/node-sdk for the same reason as every other
 * client here: deadlines, which errors are worth retrying, and what the message says on a bad
 * day have to be ours. The SDK's own source (v1.1.0) was read for the paths and the envelope.
 */

export const KLIKRESI_BASE_URL = 'https://klikresi.com';

/** Rupiah per successful tracking request. */
export const TRACK_PRICE = 15;

/** Klik Resi's normalised statuses (TRACKING_STATUSES in the SDK). */
export const TRACKING_STATUSES = [
  'InfoReceived', 'InTransit', 'OutForDelivery', 'FailedAttempt', 'Delivered',
  'ReturnToSender', 'Exception', 'Expired', 'Pending',
];

/**
 * The test runner never reaches the paid API, and this check comes first.
 *
 * .env holds the live key and the deploy runs `npm test` on the box: a suite that reached a
 * real tracking call would spend real money on every deploy.
 */
const testing = () => Boolean(process.env.NODE_TEST_CONTEXT);

export function loadKlikResiConfig() {
  if (testing()) return { apiKey: '', baseUrl: KLIKRESI_BASE_URL };
  const file = readEnv(ENV_PATH);
  const local = readEnv(ENV_LOCAL_PATH);
  const get = (key) => process.env[key] ?? local[key] ?? file[key] ?? '';
  return {
    apiKey: get('KLIK_RESI_API') || get('KLIKRESI_API_KEY'),
    baseUrl: (get('KLIKRESI_BASE_URL') || KLIKRESI_BASE_URL).replace(/\/$/, ''),
  };
}

export const isKlikResiConfigured = (config = loadKlikResiConfig()) => Boolean(config.apiKey);

export class KlikResiError extends Error {
  constructor(message, { status = 0 } = {}) {
    super(message);
    this.name = 'KlikResiError';
    this.status = status;
    // The courier not knowing a waybill is an answer, not a failure: it costs nothing and
    // the same waybill is simply asked again tomorrow.
    this.notFound = status === 400 && /not found|expired/i.test(message);
    this.retryable = status === 0 || status === 429 || status >= 500;
  }
}

const RETRIES = 3;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(path, { config = loadKlikResiConfig(), fetchImpl = fetchWithTimeout, retries = RETRIES } = {}) {
  if (!isKlikResiConfigured(config)) throw new KlikResiError('KLIK_RESI_API belum diisi');
  const url = `${config.baseUrl}${path}`;
  let last = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { 'x-api-key': config.apiKey, accept: 'application/json' },
        timeout: TIMEOUTS.api,
      });
    } catch (error) {
      last = new KlikResiError(`tidak bisa menghubungi Klik Resi: ${error.message}`);
      if (attempt === retries) throw last;
      await sleep(attempt * 500);
      continue;
    }
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { message: text.slice(0, 200) }; }
    if (response.ok) return body;
    last = new KlikResiError(body?.message || `HTTP ${response.status}`, { status: response.status });
    if (!last.retryable || attempt === retries) throw last;
    await sleep(attempt * 500);
  }
  throw last;
}

/**
 * One waybill's journey.
 *
 * @returns {Promise<{status: string, histories: Array<{status: string, message: string, date: string}>, deliveredAt: string|null}>}
 *   histories newest first, exactly as Klik Resi orders them; deliveredAt is the moment of
 *   the Delivered event, which is what Shopify is told - not the moment we happened to look.
 */
export async function trackWaybill(awb, courier, options = {}) {
  const path = `/api/trackings/${encodeURIComponent(awb)}/couriers/${encodeURIComponent(courier)}`;
  const body = await request(path, options);
  return normaliseTracking(body?.data);
}

export function normaliseTracking(data) {
  const histories = (Array.isArray(data?.histories) ? data.histories : []).map((h) => ({
    status: String(h?.status ?? ''),
    message: String(h?.message ?? ''),
    date: h?.date ? new Date(h.date).toISOString() : null,
  }));
  const status = String(data?.status ?? '');
  const delivered = histories.find((h) => h.status === 'Delivered' && h.date);
  return {
    status,
    histories,
    deliveredAt: status === 'Delivered' ? (delivered?.date ?? null) : null,
  };
}

/** Current balance in Rupiah. Not billed. */
export async function klikResiBalance(options = {}) {
  const body = await request('/api/me', options);
  const balance = Number(body?.data?.balance);
  if (!Number.isFinite(balance)) throw new KlikResiError('saldo Klik Resi tidak terbaca');
  return balance;
}
