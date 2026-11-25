import { findProduct } from './master.js';
import { boardGoods } from './label-board.js';
import { recipeOf, shelfProducts, OPENING_ITEMS } from './warehouse.js';

/**
 * What a packer puts in the box, item by item.
 *
 * A line says what was sold; the hands need what to take. "Inside Out Protocol" is a jar of
 * 90 capsules and a 30 ml oil, a Ritual Set is a bowl, a whisk, a scoop and a wooden box,
 * and 270 caps is three 90-cap jars. That is the shelf recipe (src/warehouse.js, editable
 * on the Stok page) - the same one the stock is counted by, so what the packer reads and
 * what leaves the shelf cannot differ. Named and pictured as the Produk page does.
 */

const OPENING_NAME = Object.fromEntries(OPENING_ITEMS.map(([code, name]) => [code, name]));
/** Shelf items nobody has photographed get a drawing of what they are. */
const DRAWN = { 'M-093': 'bowl', 'M-094': 'crate', 'M-051': 'pouch', 'M-052': 'pouch' };
const picture = (images, product) => {
  const hit = product && images[product.sku];
  return hit?.thumb || hit?.url || '';
};

/**
 * One line's items, or [] when the line is itself the one thing to take.
 *
 * @returns {Array<{name: string, variant: string, qty: number, each: number, img: string, icon: string}>}
 */
export function packParts(sku, qty, images = {}, shelf = null) {
  const product = findProduct(sku);
  if (!product) return [];
  const edited = shelf?.recipes ?? {};
  const recipe = recipeOf(product.sku, edited);
  if (recipe) {
    const entries = Object.entries(recipe).filter(([, n]) => Number(n) > 0);
    if (entries.length === 0 || (entries.length === 1 && Number(entries[0][1]) === 1)) return [];
    const products = shelfProducts(edited);
    return entries.map(([code, n]) => {
      const p = products[code];
      return {
        name: p?.name ?? shelf?.items?.[code]?.name ?? OPENING_NAME[code] ?? code,
        variant: p?.variant ?? '',
        qty: Number(n) * qty,
        each: Number(n),
        img: picture(images, p),
        icon: DRAWN[code] ?? 'cube',
      };
    });
  }
  // No recipe on the shelf: the catalogue's own parts still say what is inside.
  return (product.components ?? []).map((c) => {
    const p = findProduct(c.sku);
    const each = Number(c.qty) || 1;
    return { name: p?.name ?? c.sku, variant: p?.variant ?? '', qty: each * qty, each, img: picture(images, p), icon: 'cube' };
  });
}

/**
 * Everything in one parcel: its lines, each with what it is made of, and how many things
 * end up in the box - the number the packer counts against before closing it.
 */
export function packList(order, images = {}, shelf = null) {
  const goods = boardGoods(order?.lines, images).map(({ name, variant, qty, sku, img }) => ({
    name, variant, qty, sku, img, parts: packParts(sku, qty, images, shelf),
  }));
  const units = goods.reduce((n, g) => n + g.qty, 0);
  const items = goods.reduce((n, g) => n + (g.parts.length ? g.parts.reduce((m, p) => m + p.qty, 0) : g.qty), 0);
  return { goods, units, items };
}
