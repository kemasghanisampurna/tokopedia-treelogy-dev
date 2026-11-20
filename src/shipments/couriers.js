/**
 * Which Klik Resi courier code a Shopify fulfillment belongs to.
 *
 * Shopify's carrier name comes from whoever fulfilled the order, and Indonesian couriers are
 * not on Shopify's list, so the name is free text: in the 30 days to 20 Nov 2026 it read
 * "Lion Parcel" (1,999), "J&T Express" (271) and "Other" (26 - every one of them a J&T
 * JD... waybill). The name is therefore tried first and the waybill's own shape second.
 *
 * Unknown means unknown: a waybill we cannot place is left alone rather than guessed, because
 * a wrong courier code is still a billed question if the number happens to exist there.
 */

const BY_NAME = [
  [/lion/i, 'lion'],
  [/j\s*&\s*t|jnt|j&t/i, 'jnt'],
  [/\bjne\b/i, 'jne'],
  [/sicepat/i, 'sicepat'],
  [/anter\s*aja/i, 'anteraja'],
  [/ninja/i, 'ninja'],
  [/\bsap\b/i, 'sap'],
  [/id\s*express|\bide\b/i, 'ide'],
  [/shopee\s*express|\bspx\b/i, 'spx'],
  [/\bpos\b|pos\s*indonesia/i, 'pos'],
  [/tiki/i, 'tiki'],
  [/wahana/i, 'wahana'],
  [/\blex\b|lazada/i, 'lex'],
];

const BY_SHAPE = [
  // Lion Parcel STT, e.g. 11LP1794499838883.
  [/^\d{2}LP\d{10,}$/i, 'lion'],
  // J&T: two letters starting with J and ten digits, e.g. JD0605968343, JY2341799871.
  [/^J[A-Z]\d{10}$/i, 'jnt'],
  // Shopee Express.
  [/^SPX[A-Z]{2}\d+/i, 'spx'],
];

/** @returns {string|null} a Klik Resi courier code */
export function courierFor(carrier, awb) {
  const number = String(awb ?? '').trim();
  // A URL (GrabExpress hands out links, not waybills) is nothing a courier API can read.
  if (!number || /^https?:\/\//i.test(number) || /\s/.test(number)) return null;
  const name = String(carrier ?? '');
  for (const [pattern, code] of BY_NAME) if (pattern.test(name)) return code;
  for (const [pattern, code] of BY_SHAPE) if (pattern.test(number)) return code;
  return null;
}
