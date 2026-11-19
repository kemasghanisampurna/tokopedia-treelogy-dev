import { readDoc, updateDoc } from '../store/index.js';
import { numberOrNull } from '../numbers.js';

/**
 * What is left of the month's package, counted here because Jurnal will not say.
 *
 * The per-minute limiter next door solves a different problem: it stops a burst from
 * earning a 429. It has never known how much of the month is gone, so nothing stopped a
 * run of scans from spending a fortnight's worth of allowance in an afternoon - which is
 * how the account reached 10,886 of 12,000 with fifteen days still to go.
 *
 * `GET /public/jurnal/sales_invoices/quota` answers 404; the figure exists only in the
 * Mekari console. So the operator types it in and this counts down from it. A number
 * entered by hand and decremented honestly is worth more than a number nobody has.
 *
 * Two ideas make it useful rather than merely accurate:
 *
 *   A reserve. Posting today's sales is the one thing that must not stop, so everything
 *   else - a corpus scan, a dedupe, an audit - refuses once the remainder falls to the
 *   reserve. The books keep being written after the tools have stopped.
 *
 *   A daily ration. Fifteen days of allowance spent in one is the failure this exists to
 *   prevent, so a caller can ask whether today's share is gone rather than only whether
 *   the month's is.
 */

export const BUDGET_DOC = 'mekari/budget.json';

/** Below this, only posting invoices may spend. */
export const RESERVE = 150;

/**
 * The month's package, which the counter starts from again on each renewal. Set from
 * the console (12,000 on the Jurnal API Bundle 1x + Free Quota); MEKARI_MONTHLY_QUOTA
 * when the package changes.
 */
export const PACKAGE = Number(process.env.MEKARI_MONTHLY_QUOTA) > 0 ? Math.floor(Number(process.env.MEKARI_MONTHLY_QUOTA)) : 12_000;

/** The same day of the month, a month on (the 31st of a short month falls on its last day). */
export function nextRenewal(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d, last))).toISOString().slice(0, 10);
}

/**
 * The package renewed since the counter was last set: start again from the full package,
 * once per renewal that has passed. The counter was typed in on 3 October with a renewal
 * of 3 November, nobody reset it, and on 19 November it read 134 left - stopping the
 * books - while the console said 6,194 of 12,000 used.
 */
export function renewed(doc, now = Date.now()) {
  if (!doc?.renewsOn || known(doc.remaining) === null) return doc;
  let renewsOn = doc.renewsOn;
  let rolled = false;
  for (let i = 0; i < 24 && Date.parse(`${renewsOn}T00:00:00Z`) <= now; i++) { renewsOn = nextRenewal(renewsOn); rolled = true; }
  return rolled ? { ...doc, remaining: PACKAGE, renewsOn, renewedAt: new Date(now).toISOString() } : doc;
}

const EMPTY = { version: 1, remaining: null, at: null, renewsOn: null, spent: {} };

const day = (now) => new Date(now).toISOString().slice(0, 10);

/** The remainder, or null when nobody has entered one. See numberOrNull for why. */
const known = numberOrNull;

export async function loadBudget() {
  try {
    return renewed({ ...EMPTY, ...((await readDoc(BUDGET_DOC)) ?? {}) });
  } catch {
    return structuredClone(EMPTY);
  }
}

/**
 * Tell the counter what the console says. Everything else is derived from this.
 *
 * @param {{remaining: number, renewsOn?: string|null}} reading
 */
export async function setBudget({ remaining, renewsOn = null }, { now = Date.now() } = {}) {
  return updateDoc(BUDGET_DOC, (current) => ({
    ...EMPTY, ...(current ?? {}),
    remaining: Math.max(0, Math.floor(Number(remaining) || 0)),
    renewsOn: renewsOn ?? current?.renewsOn ?? null,
    at: new Date(now).toISOString(),
  }), structuredClone(EMPTY));
}

/**
 * How many requests a day may have, if the rest of the month is to be survivable.
 *
 * Null when nobody has told us the remainder or when the package has no known renewal -
 * an unknown budget must read as unknown rather than as zero, or a missing setting would
 * stop the books being written.
 */
export function dailyRation(budget, { now = Date.now() } = {}) {
  const remaining = known(budget?.remaining);
  if (remaining === null) return null;
  const renews = Date.parse(`${budget?.renewsOn ?? ''}T00:00:00Z`);
  if (!Number.isFinite(renews)) return null;
  const daysLeft = Math.max(1, Math.ceil((renews - now) / 86_400_000));
  return Math.floor(remaining / daysLeft);
}

/**
 * Take one request's worth, or refuse.
 *
 * `essential` is what may dip into the reserve: writing an invoice for a sale that has
 * already happened. A scan is never essential, however much somebody wants the answer.
 *
 * Refusing is reported, never thrown from here - the caller decides whether a refusal
 * means "stop the run" or "skip this one", and those are different for a sweep and for a
 * dedupe.
 *
 * @returns {Promise<{allowed: boolean, remaining: number|null, reason?: string}>}
 */
export async function spend(count = 1, { essential = false, now = Date.now() } = {}) {
  let outcome = { allowed: true, remaining: null };
  try {
    await updateDoc(BUDGET_DOC, (current) => {
      const doc = renewed({ ...EMPTY, ...(current ?? {}) }, now);
      const remaining = known(doc.remaining);

      // Nobody has entered a figure. Counting spend is still useful - it is what tells
      // an operator what a day actually costs - but it must not gate anything.
      if (remaining === null) {
        outcome = { allowed: true, remaining: null };
        return { ...doc, spent: bump(doc.spent, now, count) };
      }

      const floor = essential ? 0 : RESERVE;
      if (remaining - count < floor) {
        outcome = {
          allowed: false,
          remaining,
          // Said as what it is: this counter's reading, not Mekari's refusal - so a wrong
          // counter is caught by comparing with the console, not taken as the quota.
          reason: essential
            ? `penghitung kuota dashboard habis (${remaining} tersisa) - cek angka di console Mekari`
            : `penghitung kuota dashboard: sisa ${remaining}, di bawah cadangan ${RESERVE} - hanya posting faktur yang boleh jalan (cek angka di console Mekari)`,
          local: true,
        };
        return doc;
      }

      outcome = { allowed: true, remaining: remaining - count };
      return { ...doc, remaining: remaining - count, spent: bump(doc.spent, now, count) };
    }, structuredClone(EMPTY));
  } catch {
    // A counter that cannot be read must never stop the books being written. The
    // per-minute limiter still applies, and the console still has the real figure.
    return { allowed: true, remaining: null };
  }
  return outcome;
}

/** Kept per day, and only the last fortnight of them: this is a gauge, not a ledger. */
function bump(spent, now, count) {
  const key = day(now);
  const next = { ...(spent ?? {}), [key]: (spent?.[key] ?? 0) + count };
  const keys = Object.keys(next).sort();
  for (const old of keys.slice(0, Math.max(0, keys.length - 14))) delete next[old];
  return next;
}
