import { businessDate, businessDayStart, offsetSeconds } from '../clock.js';
import { excelSerial, toCsv, toXlsx } from './sheet.js';

/**
 * The label print log as a file.
 *
 * Read off the activity log, where every print run already records who printed which
 * parcels and when (`print_labels`), and every "tandai sudah dicetak" (`label_printed`).
 * One row per parcel per run, newest first, so a parcel printed twice appears twice and
 * the "Cetakan ke" column says which time this was.
 */

export const LABEL_COLUMNS = [
  { label: 'Waktu', key: 'at', type: 'date', width: 17 },
  { label: 'Tanggal', key: 'day', type: 'day', width: 12 },
  { label: 'Kanal', key: 'channel', width: 11 },
  { label: 'No. Pesanan', key: 'order', width: 22 },
  { label: 'Status', key: 'status', width: 22 },
  { label: 'Cetakan ke', key: 'nth', type: 'int', width: 10 },
  { label: 'Dicetak oleh', key: 'by', width: 20 },
  { label: 'Email', key: 'email', width: 26 },
  { label: 'Keterangan', key: 'note', width: 40 },
];

const CHANNEL_LABEL = { shopee: 'Shopee', tiktok_shop: 'TikTok Shop', tokopedia: 'Tokopedia', shopify: 'Shopify', manual: 'Manual' };
const STATUS = { dicetak: 'Dicetak', gagal: 'Gagal', 'sudah dicetak': 'Ditandai tanpa cetak' };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function labelLogFilename(from, to, format = 'xlsx') {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const day = (y, m, d) => `${d} ${MONTHS[m - 1]} ${y}`;
  let span;
  if (from === to) span = day(ty, tm, td);
  else if (fy === ty && fm === tm) span = `${fd} - ${day(ty, tm, td)}`;
  else if (fy === ty) span = `${fd} ${MONTHS[fm - 1]} - ${day(ty, tm, td)}`;
  else span = `${day(fy, fm, fd)} - ${day(ty, tm, td)}`;
  return `Log Cetak Label ${span}.${format === 'csv' ? 'csv' : 'xlsx'}`;
}

/** "shopify #13131" or "shopify:#13131" -> { channel, id }. */
function parseOrder(field) {
  const text = String(field ?? '').trim();
  const m = /^([a-z_]+)[ :](.+)$/.exec(text);
  return m ? { channel: m[1], id: m[2] } : { channel: '', id: text };
}

/** Every parcel-level event in these activity entries, oldest first. */
export function labelEvents(entries) {
  const out = [];
  for (const e of entries ?? []) {
    if (e?.menu !== 'labels') continue;
    if (e.action !== 'print_labels' && e.action !== 'label_printed') continue;
    for (const c of e.changes ?? []) {
      const status = STATUS[String(c.to ?? '').toLowerCase()];
      if (!status) continue;
      const { channel, id } = parseOrder(c.field);
      if (!id) continue;
      out.push({ at: e.at, channel, id, status, by: e.actor?.name || e.actor?.email || '', email: e.actor?.email || '', note: c.note || '' });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

const stamp = (at) => {
  const local = new Date((at + offsetSeconds()) * 1000).toISOString();
  return { n: excelSerial(at + offsetSeconds()), s: `${local.slice(0, 10)} ${local.slice(11, 19)}` };
};

/** The rows for from..to (house calendar, both included), newest first. */
export function buildLabelLogExport(entries, { from, to }) {
  const start = businessDayStart(from);
  const end = businessDayStart(to) + 86400;
  const all = labelEvents(entries);
  // Which time this was, counted over everything read - not only the days asked for.
  const seen = new Map();
  const numbered = all.map((ev) => {
    const key = `${ev.channel}:${ev.id}`;
    const nth = ev.status === 'Gagal' ? null : (seen.get(key) ?? 0) + 1;
    if (nth) seen.set(key, nth);
    return { ...ev, nth };
  });
  const rows = numbered.filter((ev) => ev.at >= start && ev.at < end).reverse().map((ev) => ({
    at: stamp(ev.at),
    day: { n: excelSerial(businessDayStart(businessDate(ev.at)) + offsetSeconds()), s: businessDate(ev.at) },
    channel: CHANNEL_LABEL[ev.channel] ?? ev.channel,
    order: ev.id,
    status: ev.status,
    nth: ev.nth,
    by: ev.by,
    email: ev.email,
    note: ev.note,
  }));
  return { name: `Log_Cetak_Label_${to}`, columns: LABEL_COLUMNS, rows, from, to };
}

export function renderLabelLogExport(sheet, format) {
  if (format === 'csv') return { body: Buffer.from(toCsv(sheet), 'utf8'), type: 'text/csv; charset=utf-8' };
  return { body: toXlsx(sheet), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
}

/** Per house day: [parcels, printed or marked, failed] - what the sheet says a range holds. */
export function labelLogDays(entries) {
  const days = {};
  for (const ev of labelEvents(entries)) {
    const d = businessDate(ev.at);
    const day = (days[d] ??= [0, 0, 0]);
    day[0] += 1;
    day[ev.status === 'Gagal' ? 2 : 1] += 1;
  }
  return days;
}
