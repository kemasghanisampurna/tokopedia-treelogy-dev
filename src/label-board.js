import { channelMeta } from './omni.js';
import { PREFIXES } from './mekari/prefix.js';
import { labelReadiness } from './labels.js';
import { findProduct } from './master.js';

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
 * somebody should ask about. Right: printed, newest first, over the last few days; the
 * dialog narrows both to one day (today, yesterday, the day before).
 */

// Three calendar days back (the board filters today, yesterday and the day before), with
// a day's margin so the oldest of them is whole whatever the hour.
export const BOARD_PRINTED_WINDOW_SEC = 4 * 86400;
export const BOARD_PRINTED_MAX = 400;

const idOf = (key) => key.slice(key.indexOf(':') + 1);
const channelOf = (key) => key.slice(0, key.indexOf(':'));

/** The chip a card wears: the marketplace, or for a typed-in sale its source. */
export function boardTag(channel, source = null) {
  const meta = channelMeta(channel);
  const label = channel === 'manual' && source ? PREFIXES[source]?.label : null;
  return { label: label ?? meta.label, accent: meta.accent };
}

/** A product's picture by its SKU, its master SKU, or its first part (as the packer's sheet). */
function pictureOf(images, product, sku) {
  const hit = images[sku] ?? (product && images[product.sku])
    ?? (product?.components ?? []).map((c) => images[c.sku] ?? images[findProduct(c.sku)?.sku]).find(Boolean);
  return hit?.thumb || hit?.url || '';
}

/**
 * What goes into the box, named as the Produk page names it.
 *
 * Each channel spells a product its own way - a forty-word Tokopedia title, TikTok's
 * OMC90, Shopee's "Oil-3ml" - and the board lists all channels side by side, so every line
 * is folded onto the master catalogue: "Moringa Capsules · 270 caps", the same words on
 * every card. A bundle says what it is made of, as the packer will pick it. A SKU the
 * catalogue does not know stays as it was sold rather than guessed.
 *
 * @returns {Array<{sku, name, variant, qty, img, parts: Array<{name, variant, qty}>}>}
 */
export function boardGoods(lines, images = {}) {
  const out = [];
  const at = new Map();
  for (const line of lines ?? []) {
    const qty = Number(line?.qty) || 0;
    if (qty <= 0) continue;
    const sold = String(line.sku ?? '').trim();
    const product = sold ? findProduct(sold) : null;
    const sku = product?.sku ?? sold;
    // The same product twice in one order (a channel's own SKU and a free one) is one line.
    const seen = sku ? at.get(sku) : undefined;
    if (seen !== undefined) { out[seen].qty += qty; for (const part of out[seen].parts) part.qty = part.per * out[seen].qty; continue; }
    const parts = (product?.components ?? []).map((c) => {
      const p = findProduct(c.sku);
      const per = Number(c.qty) || 1;
      return { name: p?.name ?? c.sku, variant: p?.variant ?? '', qty: per * qty, per };
    });
    if (sku) at.set(sku, out.length);
    out.push({
      sku,
      name: product?.name ?? (String(line.name ?? '').trim() || sold || 'Produk tanpa nama'),
      variant: product ? (product.variant ?? '') : String(line.variant ?? '').trim(),
      qty,
      img: pictureOf(images, product, sold),
      parts,
    });
  }
  return out.map((g) => ({ ...g, parts: g.parts.map(({ per, ...part }) => part) }));
}

/**
 * @param {object} p
 * @param {{orders?: Record<string, {to: string, name?: string, by?: string|null, at: number}>}} p.assignments
 * @param {Record<string, {at: number, by?: string, stale?: boolean, marked?: boolean}>} p.printed
 * @param {Array<object>} p.outstanding the label worklist's orders
 * @param {Record<string, object>} [p.arranged]
 * @param {Record<string, {buyer?: string, source?: string, lines?: Array<object>}>} [p.known] orders no longer on the worklist
 * @param {Record<string, string>} [p.people] email -> name
 * @param {number} [p.now] seconds
 * @param {Record<string, {thumb?: string, url?: string}>} [p.images] product pictures by SKU
 */
export function boardSnapshot({ assignments, printed = {}, outstanding = [], arranged = {}, known = {}, people = {}, images = {}, now = Math.floor(Date.now() / 1000) }) {
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
      goods: boardGoods(order?.lines ?? known[key]?.lines ?? [], images),
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
