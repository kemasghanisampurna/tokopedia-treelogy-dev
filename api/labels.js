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
import { loadAssignments } from '../src/label-assign.js';
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
    wantsJson = form.get('format') === 'json' || form.get('format') === 'queue';
  } catch {
    fail(400, 'Permintaan terlalu besar', 'Pilih lebih sedikit pesanan sekaligus.');
    return;
  }
  if (!csrfValid(session, form.get('csrf'))) {
    fail(403, 'Permintaan ditolak', 'Token formulir tidak cocok. Muat ulang halaman dan coba lagi.');
    return;
  }

  const selected = new Map();
  for (const value of form.getAll('order')) {
    const match = SELECTION.exec(String(value));
    if (match) selected.set(match[2], match[1]);
  }
  // A packer's print is held to the parcels handed to them, whatever the form says.
  if (user.role === 'packer') {
    const mine = (await loadAssignments().catch(() => ({ orders: {} }))).orders;
    for (const [id, channel] of [...selected]) if (mine[`${channel}:${id}`]?.to !== user.email) selected.delete(id);
    if (selected.size === 0) {
      fail(403, 'Bukan tugasmu', 'Tidak ada pesanan yang ditugaskan kepadamu di pilihan ini.');
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
    const queueing = form.get('format') === 'queue';
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
    if (printedKeys.length) {
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
    await recordActivity({
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
    if (form.get('format') === 'queue') {
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
