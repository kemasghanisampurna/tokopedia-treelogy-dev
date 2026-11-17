import fs from 'node:fs';
import { readDoc, updateDoc } from '../store/index.js';
import { validateConfig, cleanItem, cleanShipping, slugId, KINDS } from './catalog.js';

/**
 * The offers the bot reads - free shipping, promos, vouchers, gifts - kept in our own
 * store and edited from the AI Agent menu.
 *
 * The brief put them in a Shopify shop metafield. The dashboard does not write Shopify
 * (team rule since 7 Oct 2026), and keeping them here gives every change a name in the
 * activity log and reaches the bot on its next call, with no CDN in between.
 *
 * Reading never throws: a store that is down, a document that is missing or one that no
 * longer validates all fall back to the defaults in the repo, and say so, because a bot
 * quoting yesterday's voucher is better than a bot with no answer at all.
 */

export const CONFIG_DOC = 'agent/cs-config.json';
const DEFAULT_FILE = new URL('../../config/cs_config.default.json', import.meta.url);

let defaults = null;
export function defaultConfig() {
  if (!defaults) defaults = validateConfig(JSON.parse(fs.readFileSync(DEFAULT_FILE, 'utf8')));
  return structuredClone(defaults);
}

/**
 * @returns {Promise<{config: object, source: 'dashboard'|'fallback', problem: string|null, updatedAt: number|null, updatedBy: object|null}>}
 */
export async function loadAgentConfig({ read = readDoc } = {}) {
  let doc;
  try {
    doc = await read(CONFIG_DOC);
  } catch (error) {
    console.warn(`agent: config tidak terbaca, memakai default - ${error.message}`);
    return { config: defaultConfig(), source: 'fallback', problem: 'penyimpanan tidak terbaca', updatedAt: null, updatedBy: null };
  }
  if (!doc) return { config: defaultConfig(), source: 'fallback', problem: 'belum pernah disimpan dari dashboard', updatedAt: null, updatedBy: null };
  try {
    return { config: validateConfig(doc.config), source: 'dashboard', problem: null, updatedAt: doc.updatedAt ?? null, updatedBy: doc.updatedBy ?? null };
  } catch (error) {
    console.warn(`agent: config tersimpan tidak valid, memakai default - ${error.message}`);
    return { config: defaultConfig(), source: 'fallback', problem: `config tersimpan tidak valid: ${error.message}`, updatedAt: doc.updatedAt ?? null, updatedBy: doc.updatedBy ?? null };
  }
}

/** What the next save builds on: the stored config if it is sound, the defaults if not. */
function baseOf(doc) {
  try { return validateConfig(doc?.config); } catch { return defaultConfig(); }
}

const stamp = (config, by) => ({
  version: 1,
  config,
  updatedAt: Math.floor(Date.now() / 1000),
  updatedBy: by ? { id: by.id, name: by.name, email: by.email } : null,
});

/**
 * Change the config in one transaction. `change` gets a copy of the current config and
 * returns `{ config, before, after }`; it may run more than once (see updateDoc), so it
 * must not do anything but compute. The last run's result is the one returned.
 */
async function mutate(change, by, { update = updateDoc } = {}) {
  let outcome = null;
  await update(CONFIG_DOC, (doc) => {
    outcome = change(structuredClone(baseOf(doc)));
    // Nothing changed: the document stays as it was. The first save ever still stores the
    // defaults, so the bot stops reading "fallback" from the moment somebody confirmed them.
    if (!outcome.changed) return doc ?? stamp(outcome.config, by);
    // Validated again as a whole, so nothing that would make the bot fall back is ever stored.
    return stamp(validateConfig(outcome.config), by);
  }, null);
  return outcome;
}

export async function saveShipping(raw, by, options) {
  const next = cleanShipping(raw);
  return mutate((config) => {
    const before = config.free_shipping;
    const changed = before.min_amount !== next.min_amount || before.scope !== next.scope;
    return { changed, before, after: next, config: { ...config, free_shipping: next } };
  }, by, options);
}

/**
 * Add or edit one promo, voucher or gift. `originalId` empty means new; the id is then
 * made from the name and numbered if it is already taken.
 */
export async function saveItem(kind, raw, originalId, by, options) {
  if (!Object.hasOwn(KINDS, kind)) throw new Error('jenis penawaran tidak dikenal');
  // A gift for one variant is named after it ("hadiah_kapsul_270"), so the id says what it is.
  const one = kind === 'gifts' && Array.isArray(raw?.applies_to) && raw.applies_to.length === 1 ? `hadiah_${raw.applies_to[0]}` : null;
  const draft = cleanItem(kind, { ...raw, id: originalId || one || slugId(raw?.name) });
  let missing = false;
  const out = await mutate((config) => {
    const list = config[kind];
    if (originalId) {
      const index = list.findIndex((item) => item.id === originalId);
      if (index === -1) { missing = true; return { changed: false, config }; }
      missing = false;
      const before = list[index];
      const changed = JSON.stringify(before) !== JSON.stringify(draft);
      list[index] = draft;
      return { changed, before, after: draft, config };
    }
    missing = false;
    let id = draft.id;
    for (let n = 2; list.some((item) => item.id === id); n += 1) id = `${draft.id.slice(0, 44)}_${n}`;
    const item = { ...draft, id };
    list.push(item);
    return { changed: true, before: null, after: item, config };
  }, by, options);
  if (missing) throw new Error(`${KINDS[kind].one} ${originalId} sudah tidak ada - muat ulang halaman`);
  return out;
}

export async function deleteItem(kind, id, by, options) {
  if (!Object.hasOwn(KINDS, kind)) throw new Error('jenis penawaran tidak dikenal');
  let missing = false;
  const out = await mutate((config) => {
    const before = config[kind].find((item) => item.id === id);
    missing = !before;
    if (!before) return { changed: false, config };
    config[kind] = config[kind].filter((item) => item.id !== id);
    return { changed: true, before, after: null, config };
  }, by, options);
  if (missing) throw new Error(`${KINDS[kind].one} ${id} sudah tidak ada - muat ulang halaman`);
  return out;
}
