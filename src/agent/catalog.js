/**
 * What the WhatsApp AI agent on Qontak may say about prices and offers.
 *
 * Until November 2026 the bot read prices, the free-shipping threshold, promos and
 * vouchers from a .txt file uploaded by hand into Qontak, so every price change was a
 * file nobody remembered to re-upload and the bot quoted last month's numbers. This is the
 * one place it reads them from instead: prices live from treelogy.com, offers from the
 * AI Agent menu on the dashboard.
 *
 * Everything here is pure - no fetch, no store, no clock unless one is passed in - so the
 * rules the brief is strict about (which listing counts, how a date window ends, how a
 * price is written) are proved by unit tests rather than by watching the bot.
 */

export const STOREFRONT = 'https://treelogy.com';

/**
 * The 17 variants the bot may quote, in the order it lists them.
 *
 * The storefront carries duplicates and archived listings with other prices (an old
 * Inside Out listing at 925.000, a Rp0 scoop), so only these handles count. The variant
 * id was read from treelogy.com/products.json on 17 Nov 2026 and is the real match; the
 * title is the fallback for a variant re-created in Shopify, compared after collapsing
 * whitespace because Shopify keeps the double space in "Up to  30 servings".
 */
export const VARIANT_MAP = [
  { key: 'kapsul_90', handle: 'organic-moringa-capsules', id: 44527085617340, title: '90 Moringa Capsules', name: 'Moringa Capsules 90 kapsul (1 bulan)' },
  { key: 'kapsul_180', handle: 'organic-moringa-capsules', id: 44527085650108, title: '180 Moringa Capsules', name: 'Moringa Capsules 180 kapsul (2 bulan)' },
  { key: 'kapsul_270', handle: 'organic-moringa-capsules', id: 47255408378044, title: '270 Moringa Capsules', name: 'Moringa Capsules 270 kapsul (3 bulan)' },
  { key: 'powder_45', handle: 'organic-moringa-powder', id: 44527088435388, title: 'Up to  30 servings', name: 'Moringa Powder 45 gr (hingga 30 sajian)' },
  { key: 'powder_90', handle: 'organic-moringa-powder', id: 44314284753084, title: 'Up to  60 servings', name: 'Moringa Powder 90 gr (hingga 60 sajian)' },
  { key: 'powder_180', handle: 'organic-moringa-powder', id: 44314284785852, title: 'Up to  120 servings', name: 'Moringa Powder 180 gr (hingga 120 sajian)' },
  { key: 'oil_30', handle: 'organic-moringa-oil', id: 44527091318972, title: '30 ml', name: 'Moringa Oil 30 ml' },
  { key: 'oil_60', handle: 'organic-moringa-oil', id: 44527091351740, title: '60 ml', name: 'Moringa Oil 60 ml' },
  { key: 'insideout_30', handle: 'moringa-inside-out-protocol', id: 46129731666108, title: '90 Moringa Capsules  + 30ml Moringa Oil', name: 'Inside Out Protocol 30 hari (90 kapsul + oil 30 ml)' },
  { key: 'insideout_60', handle: 'moringa-inside-out-protocol', id: 46129728487612, title: '180 Moringa Capsules  + 30ml Moringa Oil', name: 'Inside Out Protocol 60 hari (180 kapsul + oil 30 ml)' },
  { key: 'discovery', handle: 'the-discovery-pack', id: 45506369192124, title: 'The Discovery Pack', name: 'The Discovery Pack (kapsul, powder, oil)' },
  { key: 'ritual_set', handle: 'moringa-ritual-set', id: 44561387880636, title: 'Moringa Ritual Set', name: 'Moringa Ritual Set' },
  { key: 'ritual_starter', handle: 'moringa-ritual-set', id: 44562189451452, title: 'Ritual Starter Bundle', name: 'Ritual Starter Bundle' },
  { key: 'ritual_daily', handle: 'moringa-ritual-set', id: 44562190926012, title: 'Daily Wellness Bundle', name: 'Daily Wellness Bundle' },
  { key: 'ritual_complete', handle: 'moringa-ritual-set', id: 44562191548604, title: 'The Complete Ritual Bundle', name: 'The Complete Ritual Bundle' },
  { key: 'whisk', handle: 'bamboo-whisk', id: 45377907818684, title: 'Bamboo Whisk', name: 'Bamboo Whisk (120 prongs)' },
  { key: 'scoop', handle: 'bamboo-spoon', id: 47447701684412, title: 'Default Title', name: 'Bamboo Scoop' },
];

export const PRODUCT_KEYS = VARIANT_MAP.map((row) => row.key);

/** Listings that look right and are not: duplicates, archives and Rp0 freebies. */
export const BLOCKED_HANDLES = [
  'organic-moringa-capsules-1', 'organic-moringa-cold-pressed-seed-oil', 'inside-out-moringa-protocol',
  'bamboo-scoop', 'mystery-gift', 'travel-pouch', 'sample-free-pouch',
];

/** Dates are WITA: the brief, the team and Qontak all count days in Makassar time. */
export const AGENT_ZONE = 'Asia/Makassar';

export const KINDS = {
  promos: { label: 'Promo', one: 'promo' },
  vouchers: { label: 'Voucher', one: 'voucher' },
  gifts: { label: 'Hadiah', one: 'hadiah' },
};

export const normalizeTitle = (title) => String(title ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

export const productUrl = (handle) => `${STOREFRONT}/products/${handle}`;

/**
 * "Rp 1.145.000": dots for thousands, no ",00", no "IDR", so the bot reads it out as is.
 * Built by hand because Intl's id-ID output puts a no-break space after "Rp" on some
 * runtimes and none on others.
 */
export function rupiahText(amount) {
  const n = Math.round(Number(amount));
  if (!Number.isFinite(n)) return null;
  const digits = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${n < 0 ? '-' : ''}Rp ${digits}`;
}

/** Today's date in WITA, as YYYY-MM-DD. */
export function witaToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: AGENT_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** An ISO timestamp written in WITA, "2026-11-17T14:05:00+08:00". */
export function witaIso(now = new Date()) {
  const shifted = new Date(now.getTime() + 8 * 3600_000);
  return `${shifted.toISOString().slice(0, 19)}+08:00`;
}

/**
 * Where an offer stands on a given WITA day. Both ends are inclusive: a voucher ending
 * 2026-11-30 is still offered all of the 30th and gone from the 1st.
 *
 * @returns {'active'|'scheduled'|'expired'}
 */
export function itemStatus(item, today) {
  if (item?.starts_at && today < item.starts_at) return 'scheduled';
  if (item?.ends_at && today > item.ends_at) return 'expired';
  return 'active';
}

export const activeItems = (items, today) => (items ?? []).filter((item) => itemStatus(item, today) === 'active');

/* ------------------------------------------------------------------ validation */

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[a-z0-9][a-z0-9_]{1,47}$/;
const CODE = /^[A-Z0-9][A-Z0-9_-]{1,39}$/;

const isRealDate = (value) => {
  if (!DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
};

const text = (value, max) => {
  const t = String(value ?? '').replace(/\r\n?/g, '\n').trim();
  return t.length > max ? null : t;
};

/** A safe id from a name: "Voucher harga lama" → "voucher_harga_lama". */
export function slugId(name) {
  const slug = normalizeTitle(name).normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40).replace(/_+$/, '');
  return slug.length >= 2 ? slug : `item_${Date.now().toString(36)}`;
}

/**
 * One offer, cleaned, or an error that says which field and why - in Indonesian, because
 * it is shown to whoever typed it.
 *
 * @param {'promos'|'vouchers'|'gifts'} kind
 */
export function cleanItem(kind, raw) {
  if (!Object.hasOwn(KINDS, kind)) throw new Error('jenis penawaran tidak dikenal');
  const id = String(raw?.id ?? '').trim();
  if (!ID.test(id)) throw new Error('id hanya huruf kecil, angka dan garis bawah, 2-48 karakter');
  const name = text(raw?.name, 80);
  if (!name) throw new Error('nama wajib diisi, maksimal 80 karakter');
  const detail = text(raw?.detail, 600);
  if (!detail) throw new Error('keterangan wajib diisi, maksimal 600 karakter');

  const dates = {};
  for (const field of ['starts_at', 'ends_at']) {
    const value = String(raw?.[field] ?? '').trim();
    if (!value) { dates[field] = null; continue; }
    if (!isRealDate(value)) throw new Error(`${field === 'starts_at' ? 'tanggal mulai' : 'tanggal berakhir'} harus berformat YYYY-MM-DD`);
    dates[field] = value;
  }
  if (dates.starts_at && dates.ends_at && dates.starts_at > dates.ends_at) {
    throw new Error('tanggal mulai tidak boleh setelah tanggal berakhir');
  }

  const rawCode = String(raw?.code ?? '').trim().toUpperCase();
  if (rawCode && !CODE.test(rawCode)) throw new Error('kode hanya huruf besar, angka, - dan _, 2-40 karakter');
  const code = rawCode || null;
  if (kind === 'vouchers' && !code) throw new Error('voucher wajib punya kode');

  if (kind === 'gifts') {
    const appliesTo = [...new Set((Array.isArray(raw?.applies_to) ? raw.applies_to : []).map(String))];
    const unknown = appliesTo.filter((key) => !PRODUCT_KEYS.includes(key));
    if (unknown.length) throw new Error(`produk tidak dikenal: ${unknown.join(', ')}`);
    const url = String(raw?.url ?? '').trim();
    if (url && !/^https:\/\/(www\.)?treelogy\.com\/[^\s]*$/.test(url)) throw new Error('tautan hadiah harus diawali https://treelogy.com/');
    return { id, name, detail, applies_to: PRODUCT_KEYS.filter((key) => appliesTo.includes(key)), url: url || null, ...dates };
  }
  if (kind === 'promos') return { id, name, detail, code, ...dates };
  return { id, name, code, detail, ...dates };
}

export function cleanShipping(raw) {
  const amount = Number(String(raw?.min_amount ?? '').replace(/[^\d-]/g, ''));
  if (!Number.isInteger(amount) || amount < 0 || amount > 100_000_000) throw new Error('batas gratis ongkir harus angka rupiah 0 - 100.000.000');
  const scope = text(raw?.scope, 200);
  if (!scope) throw new Error('cakupan gratis ongkir wajib diisi, maksimal 200 karakter');
  return { min_amount: amount, scope };
}

/**
 * The whole config, cleaned, or a throw. Used both on save and to decide whether what is
 * stored can be trusted at all - anything that fails here is replaced by the defaults.
 */
export function validateConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('config bukan objek JSON');
  const config = { free_shipping: cleanShipping(raw.free_shipping) };
  for (const kind of Object.keys(KINDS)) {
    if (raw[kind] !== undefined && !Array.isArray(raw[kind])) throw new Error(`${kind} harus berupa daftar`);
    const items = (raw[kind] ?? []).map((item) => cleanItem(kind, item));
    const ids = new Set();
    for (const item of items) {
      if (ids.has(item.id)) throw new Error(`id ${item.id} dipakai dua kali di ${kind}`);
      ids.add(item.id);
    }
    config[kind] = items;
  }
  return config;
}

/* ---------------------------------------------------------------- the payload */

/**
 * The variant for one whitelisted row, by pinned id first and normalised title second,
 * and only ever from that row's own handle.
 */
export function findVariant(productsByHandle, row) {
  const product = productsByHandle.get(row.handle);
  if (!product) return { variant: null, how: 'missing_product' };
  const variants = product.variants ?? [];
  const byId = variants.find((v) => Number(v.id) === row.id);
  if (byId) return { variant: byId, how: 'id' };
  const wanted = normalizeTitle(row.title);
  const byTitle = variants.find((v) => normalizeTitle(v.title) === wanted);
  return byTitle ? { variant: byTitle, how: 'title' } : { variant: null, how: 'missing_variant' };
}

/** "455000.00" (products.json) → 455000. */
const toAmount = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
};

/**
 * The 17 rows the bot reads, plus what went wrong with any of them for the log and the
 * dashboard. A row that cannot be found is quoted as unavailable with no price, never as
 * an error the bot would have to interpret.
 */
export function catalogProducts(storefrontProducts) {
  const byHandle = new Map();
  for (const product of storefrontProducts ?? []) {
    if (product?.handle && !BLOCKED_HANDLES.includes(product.handle)) byHandle.set(product.handle, product);
  }
  const warnings = [];
  const products = VARIANT_MAP.map((row) => {
    const { variant, how } = findVariant(byHandle, row);
    if (how !== 'id') warnings.push({ key: row.key, how });
    const price = variant ? toAmount(variant.price) : null;
    const compare = variant ? toAmount(variant.compare_at_price) : null;
    return {
      key: row.key,
      name: row.name,
      price,
      price_text: price === null ? null : rupiahText(price),
      compare_at_price_text: compare !== null && price !== null && compare > price ? rupiahText(compare) : null,
      available: Boolean(variant && price !== null && variant.available),
      url: productUrl(row.handle),
    };
  });
  return { products, warnings };
}

/** The gifts that come with one variant. An empty `applies_to` means every product. */
export const giftsFor = (gifts, key) => (gifts ?? []).filter((g) => !g.applies_to?.length || g.applies_to.includes(key));

const forBot = {
  promos: ({ id, name, detail, code, ends_at }) => ({ id, name, detail, code, ends_at }),
  vouchers: ({ id, name, code, detail, ends_at }) => ({ id, name, code, detail, ends_at }),
  gifts: ({ id, name, detail, applies_to, url, ends_at }) => ({ id, name, detail, applies_to, url, ends_at }),
};

/**
 * The whole response body for GET /api/catalog.
 *
 * @param {{storefrontProducts: object[], config: object, configSource: string, now?: Date}} input
 */
export function buildCatalog({ storefrontProducts, config, configSource, now = new Date() }) {
  const today = witaToday(now);
  const { products: rows, warnings } = catalogProducts(storefrontProducts);
  const offers = Object.fromEntries(Object.keys(KINDS).map((kind) => [kind, activeItems(config[kind], today).map(forBot[kind])]));
  // A gift belongs to the variant it comes with, so the row the bot quotes a price from
  // already says what comes free with it; the details stay in `gifts`.
  const products = rows.map(({ url, ...row }) => {
    const gifts = giftsFor(offers.gifts, row.key);
    return { ...row, gift: gifts.length ? gifts.map((g) => g.name).join(' + ') : null, url };
  });
  return {
    body: {
      ok: true,
      updated_at: witaIso(now),
      config_source: configSource,
      free_shipping: {
        min_amount: config.free_shipping.min_amount,
        min_amount_text: rupiahText(config.free_shipping.min_amount),
        scope: config.free_shipping.scope,
      },
      products,
      promos: offers.promos,
      vouchers: offers.vouchers,
      gifts: offers.gifts,
      gift_active: offers.gifts.length > 0,
    },
    warnings,
    today,
  };
}
