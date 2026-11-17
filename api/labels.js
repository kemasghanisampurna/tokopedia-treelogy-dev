import { randomUUID } from 'node:crypto';
import { markPrinted } from '../src/shopify/label.js';
import { heldOrders, activeHold } from '../src/shopify/hold.js';
import { warehouseSweep } from '../src/warehouse-run.js';
import { buildLabelSheet, LABEL_SIZES, DEFAULT_SIZE } from '../src/labels.js';
import { dashboardError, renderLabelReport } from '../src/dashboard-page.js';
import {
  COOKIE_NAME, isConfigured, parseCookies, authenticate, csrfValid, csrfToken, readFormBody, callerIp,
} from '../src/dashboard-auth.js';
import { recordActivity } from '../src/audit.js';
import { can } from '../src/users.js';
import { loadAssignments, splitPrintable, heldText } from '../src/label-assign.js';
import { loadWarehouse } from '../src/warehouse-run.js';
import { shortagesFor, shortageText } from '../src/warehouse-reserve.js';
import { ordersByIds } from '../src/db/orders.js';
import { directPrinterFor } from '../src/direct-print.js';
import { rasterizePdf } from '../src/label-raster.js';
import { enqueueJob } from '../src/print-queue.js';
import { cachedPages, rememberPages, aheadOfTime, resolvers } from '../src/label-prefetch.js';

/**
 * Streams a merged, print-ready PDF of official carrier waybills.
 *
 * Kept separate from /api/dashboard because it answers with a binary body rather than a
 * page, and because label fetching is the slowest thing here - it deserves its own
 * timeout budget instead of sharing one with the dashboard render.
 */

// Selections are posted as "channel:id" pairs; anything else is ignored rather than trusted.
// Shopify names an order "#10926", so the id charset carries the hash it prints with.
const SELECTION = /^(tokopedia|tiktok_shop|shopee|shopify|manual):([A-Za-z0-9_#-]{1,64})$/;
const MAX_LABELS = 100;

/*
 * A label sent to a phone's own printer is not printed until the phone says so.
 *
 * The bytes leave here long before paper leaves the printer, and the printer may never
 * be reached at all - out of range, switched off, paired to another phone. Recording
 * the print at render time took a parcel off the packer's list and off the shelf for a
 * label that never came out. So a `tspl` answer carries a ticket, and the print is put
 * on record only when the page comes back with `format=confirm` and the printer's
 * verdict: sent, or failed and why. Kept in memory for half an hour; a confirm that
 * outlives a restart falls back to the order keys it carries, without the fingerprints.
 */
const TICKET_MS = 30 * 60_000;
const tickets = new Map();
function keepTicket(entry) {
  const now = Date.now();
  for (const [id, t] of tickets) if (now - t.at > TICKET_MS) tickets.delete(id);
  const id = randomUUID();
  tickets.set(id, { ...entry, at: now });
  return id;
}
export const _tickets = tickets;

export default async function handler(req, res) {
  let wantsJson = false;
  const fail = (status, heading, detail) => {
    res.statusCode = status;
    res.setHeader('Cache-Control', 'no-store');
    // The direct-print page reads the answer itself, so it needs words it can show.
    if (wantsJson) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: `${heading}: ${detail}` }));
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(dashboardError(heading, detail));
  };

  if (req.method !== 'POST') {
    fail(405, 'Metode tidak didukung', 'Halaman ini hanya menerima POST dari formulir cetak.');
    return;
  }
  if (!isConfigured()) {
    fail(500, 'Dashboard belum dikonfigurasi', 'Kredensial login belum disetel.');
    return;
  }

  const session = parseCookies(req.headers.cookie)[COOKIE_NAME];
  const user = await authenticate(session);
  if (!user) {
    fail(401, 'Sesi berakhir', 'Masuk kembali lewat dashboard, lalu ulangi pencetakan.');
    return;
  }
  // A role held to the stock and forecast menus never sees an order, a buyer or a label.
  if (!can(user, 'orders')) {
    fail(403, 'Tidak berwenang', 'Peran ini tidak bisa mencetak label.');
    return;
  }

  let form;
  try {
    // A hundred selections of ~30 bytes each still fits comfortably.
    form = await readFormBody(req, 16384);
    wantsJson = ['json', 'queue', 'tspl', 'confirm'].includes(form.get('format'));
  } catch {
    fail(400, 'Permintaan terlalu besar', 'Pilih lebih sedikit pesanan sekaligus.');
    return;
  }
  if (!csrfValid(session, form.get('csrf'))) {
    fail(403, 'Permintaan ditolak', 'Token formulir tidak cocok. Muat ulang halaman dan coba lagi.');
    return;
  }

  if (form.get('format') === 'confirm') {
    await confirmPrint(form, user, req, res, fail);
    return;
  }

  const selected = new Map();
  for (const value of form.getAll('order')) {
    const match = SELECTION.exec(String(value));
    if (match) selected.set(match[2], match[1]);
  }
  // One rule for every print road (src/label-assign.js mayPrint): a parcel handed to a
  // packer is printed by that packer and nobody else, and a packer prints only theirs.
  // Refused whole, by name, rather than quietly printed short.
  const handed = await loadAssignments().catch(() => null);
  if (!handed) { fail(503, 'Daftar tugas tidak terbaca', 'Coba lagi sebentar.'); return; }
  const { held } = splitPrintable(handed, [...selected].map(([id, channel]) => `${channel}:${id}`), user);
  if (held.length) {
    fail(403, user.role === 'packer' ? 'Bukan tugasmu' : 'Sudah ditugaskan ke packer', heldText(held, user));
    return;
  }
  if (user.role === 'packer') {
    // Goods that are not on the shelf cannot be packed; the label waits for them.
    const [shelf, rows] = await Promise.all([
      loadWarehouse().catch(() => null),
      ordersByIds([...selected].map(([id, channel]) => ({ channel, id }))).catch(() => []),
    ]);
    const short = (Array.isArray(rows) ? rows : rows?.orders ?? []).map((o) => ({ o, short: shortagesFor(shelf, o) })).filter((x) => x.short.length);
    if (short.length) {
      fail(409, 'Stok di rak kurang', `${short[0].o.id}: ${shortageText(short[0].short)}`);
      return;
    }
  }
  if (selected.size === 0) {
    fail(400, 'Tidak ada yang dipilih', 'Centang minimal satu pesanan sebelum mencetak.');
    return;
  }
  if (selected.size > MAX_LABELS) {
    fail(400, 'Terlalu banyak label', `Maksimal ${MAX_LABELS} label sekali cetak. Bagi menjadi beberapa batch.`);
    return;
  }

  const size = Object.hasOwn(LABEL_SIZES, form.get('size')) ? form.get('size') : DEFAULT_SIZE;

  try {
    // The selection carries ids only. TikTok labels are addressed by package id, which
    // has to be read from the order, so those are resolved server-side and a tampered
    // form cannot smuggle in a package that is not the seller's. Shopee needs no such
    // lookup: its API is scoped to this shop, so an id that is not ours simply fails.
    const picked = [...selected].map(([id, channel]) => ({ id, channel }));
    // Checked here, at the moment of printing, and not only on the page: the page may
    // have been open since before the buyer started paying for a change to the order.
    const holds = picked.some((o) => o.channel === 'shopify') ? await heldOrders().catch(() => ({})) : {};
    const chosen = picked.filter((o) => !activeHold(holds, o));
    if (chosen.length === 0) {
      fail(409, 'Pembeli sedang mengubah pesanan', 'Pesanan yang dipilih sedang diubah dan dibayar oleh pembeli. Tunggu beberapa menit lalu muat ulang.');
      return;
    }

    // Rendered ahead of time while the page was open: those never go back to the
    // platform; only the rest is fetched now. (Queue path only - the print dialog
    // still wants the PDF itself.)
    const queueing = form.get('format') === 'queue' || form.get('format') === 'tspl';
    const ahead = queueing ? chosen.filter((o) => cachedPages(o)) : [];
    const toBuild = queueing ? chosen.filter((o) => !cachedPages(o)) : chosen;

    const sheet = await buildLabelSheet({
      orders: toBuild,
      size,
      resolvePackages: resolvers.resolvePackages,
      // A Shopify label is drawn from the order, so the whole order has to be read back -
      // the form carries ids, and an address typed into a form is not an address. It is
      // read from our own database first: a hundred keyed rows cost one round trip, while
      // asking Shopify for them means scanning sixty days of history.
      resolveShopify: resolvers.resolveShopify,
    });

    // Shopify has no idea a label exists, so the fact that one came out is recorded here
    // or the order would ask to be printed again tomorrow.
    let unrecorded = '';
    const printedKeys = [...(sheet.printed ?? []), ...ahead.map((o) => `${o.channel}:${o.id}`)];
    // To a phone's printer: nothing is on record until the phone says it printed.
    const deferred = form.get('format') === 'tspl';
    if (printedKeys.length && !deferred) {
      await markPrinted(printedKeys, { by: user.email, sigs: sheet.sigs ?? {} }).catch((error) => {
        console.warn(`labels: gagal mencatat cetakan Shopify - ${error.message}`);
        unrecorded = error.message;
      });
      // Printed is on the picklist, and on the picklist is off the shelf - counted now.
      void warehouseSweep();
    }

    console.log(`labels: ${sheet.pageCount} pages for ${chosen.length} orders at ${size}, ${sheet.failures.length} failed`);
    // Printing is not a write to any marketplace, but "who printed the labels for these
    // parcels, and when" is exactly the question asked when a parcel goes missing.
    if (!deferred) await recordActivity({
      actor: user, ip: callerIp(req), menu: 'labels', action: 'print_labels', verb: 'print',
      target: `${chosen.length} pesanan`,
      summary: `Mencetak ${sheet.pageCount} label (${size}) untuk ${chosen.length} pesanan${sheet.failures.length ? `, ${sheet.failures.length} gagal` : ''}`,
      changes: [
        ...chosen.map((o) => ({ field: `${o.channel} ${o.id}`, to: 'dicetak' })).filter((c) => !sheet.failures.some((f) => c.field.endsWith(f.id))),
        ...sheet.failures.map((f) => ({ field: `${f.channel} ${f.id}`, to: 'gagal', note: f.reason })),
      ],
    });

    // Always the page, never the bare PDF. A run is now one stack per channel, and a
    // single stream could only ever hand over one of them; the page carries all of them,
    // opens a print tab each, and - the reason it existed before grouping - names every
    // parcel that did not make it instead of leaving the operator to count paper.
    if (sheet.failures.length > 0) {
      console.warn(`labels: ${sheet.failures.map((f) => `${f.id}:${f.reason}`).join('; ')}`);
    }
    // To the bench: rendered here into the printer's language and queued for the agent
    // on the packing laptop. Anybody who may print may queue; nothing to hold or pair.
    if (form.get('format') === 'queue' || form.get('format') === 'tspl') {
      const pages = [...ahead.flatMap((o) => cachedPages(o) ?? [])];
      for (const group of sheet.groups) {
        // eslint-disable-next-line no-await-in-loop
        const rendered = await rasterizePdf(group.bytes);
        for (const tspl of rendered) pages.push(Buffer.from(tspl).toString('base64'));
        // A single marketplace label rendered now is worth keeping for a reprint.
        if (group.orders?.length === 1 && rendered.length === 1 && aheadOfTime(group.orders[0])) {
          rememberPages(group.orders[0], [Buffer.from(rendered[0]).toString('base64')]);
        }
      }
      // Straight to the phone's own Bluetooth printer: the bytes, ready to send.
      if (form.get('format') === 'tspl') {
        console.log(`labels: ${pages.length} label TSPL ke HP ${user.email}${ahead.length ? ` (${ahead.length} sudah disiapkan)` : ''}`);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        const ticket = keepTicket({ by: user.email, keys: printedKeys, sigs: sheet.sigs ?? {}, size, failures: sheet.failures, chosen: chosen.map((o) => `${o.channel}:${o.id}`) });
        res.end(JSON.stringify({ pages, failures: sheet.failures, ticket }));
        return;
      }
      const job = await enqueueJob({
        by: user.email, label: `${pages.length} label · ${user.name || user.email}`,
        orders: chosen.map((o) => `${o.channel}:${o.id}`), pages,
      });
      console.log(`labels: ${pages.length} halaman masuk antrian gudang (${job.id}) oleh ${user.email}`);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ jobId: job.id, pages: pages.length, failures: sheet.failures, unrecorded }));
      return;
    }
    // Straight to a Bluetooth printer: the page renders and sends the PDFs itself, so it
    // wants the stacks as data rather than a report to open. Only for whoever has one.
    if (form.get('format') === 'json' && directPrinterFor(user)) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({
        pageCount: sheet.pageCount, failures: sheet.failures, unrecorded,
        groups: sheet.groups.map((group) => ({ key: group.key, label: group.label, pageCount: group.pageCount, pdfBase64: Buffer.from(group.bytes).toString('base64') })),
      }));
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Label-Pages', String(sheet.pageCount));
    res.end(renderLabelReport({
      pageCount: sheet.pageCount,
      requested: chosen.length,
      failures: sheet.failures,
      size,
      // The report is where a failed run is recovered from, so it carries the token that
      // lets it repost the selection. Without it the only way back is the label list and
      // seventeen checkboxes.
      csrf: csrfToken(session),
      retried: form.get('retried') === '1',
      unrecorded,
      groups: sheet.groups.map((group) => ({
        key: group.key,
        label: group.label,
        pageCount: group.pageCount,
        pdfBase64: Buffer.from(group.bytes).toString('base64'),
      })),
    }));
  } catch (error) {
    console.error(`labels: ${error.message}`);
    fail(502, 'Gagal menyiapkan label', error.message);
  }
}

/**
 * The phone's verdict on a `tspl` print: `ok=1` when every byte reached the printer,
 * `ok=0` with the error when it did not. Only `ok=1` marks the labels printed, counts
 * the goods off the shelf and writes "dicetak" to the log; a failure is logged as
 * "gagal" and leaves the parcel where it was, waiting to be printed.
 */
async function confirmPrint(form, user, req, res, fail) {
  const ok = form.get('ok') === '1';
  const reason = String(form.get('error') ?? '').slice(0, 200) || 'printer tidak mencetak';
  const ticket = tickets.get(String(form.get('ticket') ?? ''));
  if (ticket && ticket.by !== user.email) { fail(403, 'Bukan cetakanmu', 'Tiket cetak ini milik orang lain.'); return; }
  let keys = ticket?.keys ?? [];
  if (!ticket) {
    // Outlived a restart: the keys the page carries, held to what this person may print.
    keys = splitPrintable(await loadAssignments(), form.getAll('order').map(String).filter((v) => SELECTION.test(v)), user).mine;
  }
  if (keys.length === 0) { fail(400, 'Tidak ada yang dicatat', 'Tiket cetak tidak dikenal.'); return; }
  tickets.delete(String(form.get('ticket') ?? ''));
  const failed = new Set((ticket?.failures ?? []).map((f) => `${f.channel}:${f.id}`));
  let unrecorded = '';
  if (ok) {
    await markPrinted(keys, { by: user.email, sigs: ticket?.sigs ?? {} }).catch((error) => {
      console.warn(`labels: gagal mencatat cetakan - ${error.message}`);
      unrecorded = error.message;
    });
    if (unrecorded) { fail(502, 'Label tercetak, tapi gagal dicatat', unrecorded); return; }
    void warehouseSweep();
  }
  console.log(`labels: HP ${user.email} ${ok ? 'mencetak' : 'gagal mencetak'} ${keys.length} label${ok ? '' : ` - ${reason}`}`);
  await recordActivity({
    actor: user, ip: callerIp(req), menu: 'labels', action: 'print_labels', verb: 'print',
    target: `${keys.length} pesanan`,
    summary: ok ? `Mencetak ${keys.length} label ke printer HP` : `Gagal mencetak ${keys.length} label ke printer HP: ${reason}`,
    changes: [
      ...keys.map((k) => ({ field: k.replace(':', ' '), to: ok ? 'dicetak' : 'gagal', ...(ok ? {} : { note: reason }) })),
      ...[...failed].map((k) => ({ field: k.replace(':', ' '), to: 'gagal', note: (ticket.failures.find((f) => `${f.channel}:${f.id}` === k) || {}).reason })),
    ],
  }).catch(() => {});
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ ok, recorded: keys }));
}
