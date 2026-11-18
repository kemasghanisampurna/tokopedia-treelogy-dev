import { readDoc, updateDoc } from './store/index.js';

/**
 * Who packs which parcel.
 *
 * A packer is a person whose whole job at the dashboard is to print the labels they were
 * handed and pack those parcels. Agas (or anyone who may write) ticks orders on the
 * label page and hands them to a packer; the packer's page shows only those. The record
 * is one document: order key -> who it went to, by whom, when. An order is handed to one
 * packer at a time; handing it again moves it. Entries older than two weeks fall away -
 * a parcel is long gone by then.
 */

export const ASSIGN_DOC = 'labels/assignments.json';
const KEEP_MS = 14 * 86400_000;
const EMPTY = { orders: {} };

export const orderKey = (o) => `${o.channel}:${o.id}`;
const base = (doc) => ({ orders: doc?.orders && typeof doc.orders === 'object' ? doc.orders : {} });

export function pruneAssignments(doc, now = Date.now()) {
  const d = base(doc);
  const orders = Object.fromEntries(Object.entries(d.orders).filter(([, a]) => now - (a?.at ?? 0) < KEEP_MS));
  return { ...d, orders };
}

/** @param {{email: string, name?: string}} packer  @param {{email: string, name?: string}} by */
export function applyAssign(doc, keys, packer, by, now = Date.now()) {
  const d = pruneAssignments(doc, now);
  const orders = { ...d.orders };
  for (const key of keys) orders[key] = { to: packer.email, name: packer.name || packer.email, by: by?.email ?? null, at: now };
  return { ...d, orders };
}

export function applyUnassign(doc, keys, now = Date.now()) {
  const d = pruneAssignments(doc, now);
  const orders = { ...d.orders };
  for (const key of keys) delete orders[key];
  return { ...d, orders };
}

/** The assignment on this order, or null. */
export const assignmentFor = (doc, order) => base(doc).orders[orderKey(order)] ?? null;

/** The orders of this packer, out of a list. */
export const assignedTo = (doc, orders, email) => orders.filter((o) => assignmentFor(doc, o)?.to === email);

/**
 * Who may print a parcel - the one rule every print road asks.
 *
 * Handed to a packer, the parcel is theirs: only they print it, so it never comes out
 * of two printers. A packer prints only what was handed to them. Anybody else prints
 * what nobody has been handed; to print a handed parcel themselves, they take it back
 * first ("Lepas"), which the packer's page then shows.
 */
export function mayPrint(user, assignment, { printed = false } = {}) {
  if (!user) return false;
  if (user.role === 'packer') return assignment?.to === user.email;
  // Already printed (and unchanged since): the packer's job is done, and a reprint - a
  // torn or smudged label - is anybody's who prints. The hand-out held only the first
  // print; holding reprints too left "Cetak 0 label" on the reprint list (18 Nov).
  if (printed) return true;
  return !assignment || assignment.to === user.email;
}

/** A printed-ledger entry that still stands: printed, and not edited since. */
export const printedStill = (entry) => Boolean(entry && !entry.stale);

/**
 * "#14087 sudah dicetak 7 menit lalu ..." - why a packer's press was refused. A packer
 * prints each parcel once; a page that still showed a printed parcel (a second phone, a
 * page brought back with the back button) printed #14087 twice on 18 Nov.
 */
export function alreadyPrintedText(keys, ledger, now = Math.floor(Date.now() / 1000)) {
  const key = keys[0];
  const id = key.slice(key.indexOf(':') + 1);
  const mins = Math.max(0, Math.round((now - (Number(ledger?.[key]?.at) || now)) / 60));
  const ago = mins < 1 ? 'baru saja' : mins < 60 ? `${mins} menit lalu` : `${Math.floor(mins / 60)} jam lalu`;
  const more = keys.length > 1 ? ` (dan ${keys.length - 1} lainnya)` : '';
  return `${id}${more} sudah dicetak ${ago} - label tidak dicetak dua kali. Paket ini ada di Sudah dicetak.`;
}

/**
 * Order keys ("channel:id") split into what this person may print and what is held.
 * @param {Record<string, {stale?: boolean}>} [printed] the printed ledger: a parcel on it reprints freely
 */
export function splitPrintable(doc, keys, user, printed = {}) {
  const orders = base(doc).orders;
  const mine = [];
  const held = [];
  for (const key of keys) {
    const a = orders[key] ?? null;
    if (mayPrint(user, a, { printed: printedStill(printed?.[key]) })) mine.push(key);
    else held.push({ key, to: a?.to ?? null, name: a?.name || a?.to || null });
  }
  return { mine, held };
}

/** The refusal, in the words the person sees. */
export function heldText(held, user) {
  const first = held[0];
  const id = first.key.slice(first.key.indexOf(':') + 1);
  if (user?.role === 'packer') return `${id} tidak ditugaskan kepadamu.`;
  const more = held.length > 1 ? ` (dan ${held.length - 1} lainnya)` : '';
  return `${id}${more} sudah ditugaskan ke ${first.name} - hanya ${first.name} yang bisa mencetaknya. Lepas tugasnya dulu kalau mau dicetak sendiri.`;
}

/* ----------------------------------------------------------- the store */

export async function loadAssignments() {
  return pruneAssignments(await readDoc(ASSIGN_DOC).catch(() => null));
}

export async function assignLabels(keys, packer, by) {
  await updateDoc(ASSIGN_DOC, (current) => applyAssign(current, keys, packer, by), structuredClone(EMPTY));
}

export async function unassignLabels(keys) {
  await updateDoc(ASSIGN_DOC, (current) => applyUnassign(current, keys), structuredClone(EMPTY));
}
