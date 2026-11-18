import { channelMeta } from './omni.js';
import { PREFIXES } from './mekari/prefix.js';
import { labelReadiness } from './labels.js';

/**
 * The hand-out board: every parcel given to a packer, on one side until its label has
 * come out of the printer and on the other side after.
 *
 * Read off the two records that already decide this everywhere else - the assignment
 * document (who was handed what, when) and the printed ledger (what actually came out,
 * a phone print only once the phone confirmed it). Nothing here is stored; the board is
 * those two documents looked at side by side, so it can never disagree with the
 * packer's own page.
 *
 * Left: still to print, oldest hand-out first - the parcel waiting longest is the one
 * somebody should ask about. Right: printed, newest first, over a short window, so the
 * column reads as what is happening now rather than a history.
 */

export const BOARD_PRINTED_WINDOW_SEC = 24 * 3600;
export const BOARD_PRINTED_MAX = 80;

const idOf = (key) => key.slice(key.indexOf(':') + 1);
const channelOf = (key) => key.slice(0, key.indexOf(':'));

/** The chip a card wears: the marketplace, or for a typed-in sale its source. */
export function boardTag(channel, source = null) {
  const meta = channelMeta(channel);
  const label = channel === 'manual' && source ? PREFIXES[source]?.label : null;
  return { label: label ?? meta.label, accent: meta.accent };
}

/**
 * @param {object} p
 * @param {{orders?: Record<string, {to: string, name?: string, by?: string|null, at: number}>}} p.assignments
 * @param {Record<string, {at: number, by?: string, stale?: boolean, marked?: boolean}>} p.printed
 * @param {Array<object>} p.outstanding the label worklist's orders
 * @param {Record<string, object>} [p.arranged]
 * @param {Record<string, {buyer?: string, source?: string}>} [p.known] buyers of orders no longer on the worklist
 * @param {Record<string, string>} [p.people] email -> name
 * @param {number} [p.now] seconds
 */
export function boardSnapshot({ assignments, printed = {}, outstanding = [], arranged = {}, known = {}, people = {}, now = Math.floor(Date.now() / 1000) }) {
  const open = new Map(outstanding.map((o) => [`${o.channel}:${o.id}`, o]));
  const nameOf = (email) => (email ? people[email] || email : null);
  const since = now - BOARD_PRINTED_WINDOW_SEC;
  const pending = [];
  const done = [];

  for (const [key, a] of Object.entries(assignments?.orders ?? {})) {
    if (!a?.to) continue;
    const order = open.get(key) ?? null;
    const entry = printed[key];
    const card = {
      key,
      id: order?.id ?? idOf(key),
      channel: order?.channel ?? channelOf(key),
      tag: boardTag(order?.channel ?? channelOf(key), order?.source ?? known[key]?.source ?? null),
      buyer: order?.buyer ?? known[key]?.buyer ?? null,
      to: a.to,
      packer: a.name || nameOf(a.to),
      by: nameOf(a.by),
      assignedAt: Math.floor((a.at ?? 0) / 1000),
    };
    // Printed, and the sheet still says what the order says. An edit since the print
    // (`stale`) sends the parcel back to the left: that label is not the one to pack.
    if (entry && !entry.stale) {
      if (entry.at >= since) done.push({ ...card, printedAt: entry.at, printedBy: nameOf(entry.by), marked: !!entry.marked });
      continue;
    }
    // Not printed: on the left only while the worklist still has it to print. Cancelled,
    // refunded or shipped some other way, it is nobody's job any more.
    if (order && labelReadiness(order, printed, arranged).state === 'needsPrint') pending.push(card);
  }

  pending.sort((x, y) => x.assignedAt - y.assignedAt || x.key.localeCompare(y.key));
  done.sort((x, y) => y.printedAt - x.printedAt || x.key.localeCompare(y.key));
  return {
    at: now,
    pending,
    printed: done.slice(0, BOARD_PRINTED_MAX),
    printedTotal: done.length,
  };
}

/** Printed keys whose buyer the worklist no longer knows - read back once by id. */
export function boardUnknown(snapshotInput) {
  const { assignments, printed = {}, outstanding = [], known = {}, now = Math.floor(Date.now() / 1000) } = snapshotInput;
  const open = new Set(outstanding.map((o) => `${o.channel}:${o.id}`));
  const since = now - BOARD_PRINTED_WINDOW_SEC;
  return Object.keys(assignments?.orders ?? {})
    .filter((key) => !open.has(key) && !(key in known) && printed[key] && !printed[key].stale && printed[key].at >= since);
}
