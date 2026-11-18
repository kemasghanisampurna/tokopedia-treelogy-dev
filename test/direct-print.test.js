import test from 'node:test';
import assert from 'node:assert/strict';
import { packMono, tsplJob, escposJob, inkBands, placePage, directPrinterFor, directPrintScript, directPrintHostPage, hostScript, safeGo, HOST_PATH } from '../src/direct-print.js';
import { renderLabels } from '../src/dashboard-page.js';

// 16x2 image: top row all black, bottom row white except the last pixel.
const rgba = new Uint8Array(16 * 2 * 4);
for (let x = 0; x < 16; x += 1) { rgba.set([0, 0, 0, 255], x * 4); rgba.set([255, 255, 255, 255], (16 + x) * 4); }
rgba.set([0, 0, 0, 255], (16 + 15) * 4);

test('pixels pack to one bit each, MSB first, with either polarity', () => {
  const ink1 = packMono(rgba, 16, 2, { black: 1 });
  assert.deepEqual([...ink1.bytes], [0xff, 0xff, 0x00, 0x01]);
  const ink0 = packMono(rgba, 16, 2, { black: 0 });
  assert.deepEqual([...ink0.bytes], [0x00, 0x00, 0xff, 0xfe]);
  assert.equal(ink1.widthBytes, 2);
});

test('a transparent pixel is paper', () => {
  const px = new Uint8Array([0, 0, 0, 0]);
  assert.deepEqual([...packMono(px, 1, 1).bytes], [0x00]);
});

test('the TSPL job names the label size and carries the raw rows, then prints once', () => {
  const mono = packMono(rgba, 16, 2, { black: 0 });
  const text = Buffer.from(tsplJob(mono, { widthMm: 100, heightMm: 150, gapMm: 2 })).toString('latin1');
  assert.match(text, /^SIZE 100 mm,150 mm\r\nGAP 2 mm,0 mm\r\nDIRECTION 0\r\nCLS\r\nBITMAP 0,0,2,2,0,/);
  assert.ok(text.endsWith('\r\nPRINT 1,1\r\n'));
  assert.equal(text.indexOf('\x00\x00\xff\xfe'), text.indexOf('BITMAP 0,0,2,2,0,') + 'BITMAP 0,0,2,2,0,'.length);
});

test('the ESC/POS job is a GS v 0 raster with little-endian dimensions', () => {
  const mono = packMono(rgba, 16, 2);
  const bytes = [...escposJob(mono)];
  assert.deepEqual(bytes.slice(0, 10), [0x1b, 0x40, 0x1d, 0x76, 0x30, 0x00, 2, 0, 2, 0]);
  assert.deepEqual(bytes.slice(10, 14), [0xff, 0xff, 0x00, 0x01]);
});

test('only the packers get the direct printer, and only their pages carry the panel', () => {
  assert.equal(directPrinterFor({ email: 'KEMAS@treelogy.com' })?.model, 'OKAY D100');
  assert.equal(directPrinterFor({ email: 'agas@treelogy.com' })?.model, 'OKAY D100', 'Agas packs at the same bench');
  assert.equal(directPrinterFor({ email: 'vanya@treelogy.com', role: 'viewer', status: 'active' }), null);
  assert.equal(directPrinterFor(null), null);
  const args = { orders: [], range: {}, errors: {}, shopeeShop: null, generatedAt: 0, csrf: 't', flash: null, sizes: { a6: { label: 'A6' } }, defaultSize: 'a6' };
  assert.doesNotMatch(renderLabels(args), /id="dp"/);
  const kemas = { email: 'kemas@treelogy.com', name: 'Kemas', role: 'owner' };
  // Not on the label page for the rest (18 Nov): they print to PDF or the bench. Agas keeps it.
  const his = renderLabels({ ...args, user: kemas, directPrinter: directPrinterFor(kemas) });
  assert.doesNotMatch(his, /id="dp-go"/);
  assert.doesNotMatch(his, /dp:hello/);
  const agas = { email: 'agas@treelogy.com', name: 'Agas', role: 'operator', status: 'active' };
  const hers = renderLabels({ ...args, user: agas, directPrinter: directPrinterFor(agas) });
  assert.match(hers, /id="dp-go"/, 'Agas packs at the bench with the phone printer');
  assert.match(hers, /dp:hello/);
  const vanya = { email: 'vanya@treelogy.com', name: 'Vanya', role: 'operator', status: 'active' };
  assert.doesNotMatch(renderLabels({ ...args, user: vanya, directPrinter: directPrinterFor(vanya) }), /id="dp-go"/, 'another operator does not');
  const panel = directPrintScript({ model: 'x' });
  assert.match(panel, /dp:hello/, 'the panel asks the host, it does not own the printer');
  assert.doesNotMatch(panel, /requestDevice/);
  assert.doesNotMatch(renderLabels(args), /dp\.host/);
});

test('the host script is self-contained: the encoders are inlined, not imported', () => {
  const script = hostScript({ model: 'x', widthMm: 100, heightMm: 150, gapMm: 2, dotsPerMm: 8, fit: 0.65 });
  assert.doesNotMatch(script, /\bimport\b|\brequire\(/);
  assert.match(script, /function packMono/);
  assert.match(script, /function tsplJob/);
  assert.match(script, /requestDevice/);
  new Function(script); // parses
  new Function(directPrintScript({ model: 'x' })); // so does the panel's
});

test('the chooser lists printers only, the whole room only on request, and Tes says which printer is held', () => {
  const script = hostScript({ model: 'x', widthMm: 100, heightMm: 150, gapMm: 2, dotsPerMm: 8, fit: 0.7 });
  // Filtered by printer services and printer-like names - D100 among them.
  assert.match(script, /var filters = SERVICES\.map\(function \(u\) \{ return \{ services: \[u\] \}; \}\);/);
  assert.match(script, /"D100"/);
  assert.match(script, /return \{ filters: filters, optionalServices: SERVICES \};/);
  // Printers only - no list of every device in the room, not even behind a button.
  assert.doesNotMatch(script, /acceptAllDevices/);
  assert.doesNotMatch(script, /Semua perangkat|semua perangkat/);
  // One phone, one printer: the last one it was connected to, by id and by name.
  assert.match(script, /store\.set\('dp\.device', dev\.id\); prefs\.device = dev\.id; if \(dev\.name\) store\.set\('dp\.name', dev\.name\);/);
  assert.match(script, /var mine = store\.get\('dp\.name'\);/, "the phone's own printer is always in its list");
  assert.match(script, /filter\(function \(d\) \{ return d\.id === prefs\.device; \}\)/, 'on opening it reaches for that printer only');
  // Tes prints the printer's own Bluetooth name on it.
  assert.match(script, /ctx\.fillText\('PRINTER INI', 40, 40\);/);
  assert.match(script, /ctx\.fillText\(name, 40, 140\);/);
  const page = directPrintHostPage({ printer: { model: 'OKAY D100', widthMm: 100, heightMm: 150, gapMm: 2, dotsPerMm: 8, fit: 0.7 }, go: '/api/dashboard?view=labels' });
  assert.match(page, /<button class="btn" type="button" id="test" hidden/);
  assert.doesNotMatch(page, /id="all"/);
});

test('an open printer bar reloads itself once when the page in its frame comes from a newer server', async () => {
  const { DP_BUILD, directPrintEnterScript } = await import('../src/direct-print.js');
  assert.ok(directPrintEnterScript().startsWith(`window.__dpBuild=${JSON.stringify(DP_BUILD)};`));
  const script = hostScript({ model: 'x', widthMm: 100, heightMm: 150, gapMm: 2, dotsPerMm: 8, fit: 0.7 });
  assert.match(script, new RegExp(`var BUILD = "${DP_BUILD}";`));
  assert.match(script, /drawn !== BUILD && !busy && sessionStorage\.getItem\('dp\.reloadedFor'\) !== drawn/, 'once per server, never mid-print');
  new Function(script);
});

test('the host frames only dashboard pages, never itself or another site', () => {
  assert.equal(safeGo('/api/dashboard?view=labels&reprint=1'), '/api/dashboard?view=labels&reprint=1');
  assert.equal(safeGo('/api/dashboard'), '/api/dashboard');
  assert.equal(safeGo('https://evil.example/x'), '/api/dashboard?view=labels');
  assert.equal(safeGo('//evil.example/x'), '/api/dashboard?view=labels');
  assert.equal(safeGo('/api/labels'), '/api/dashboard?view=labels');
  assert.equal(safeGo(HOST_PATH + '&go=x'), '/api/dashboard?view=labels', 'no host inside the host');
  assert.equal(safeGo(null), '/api/dashboard?view=labels');
  const html = directPrintHostPage({ printer: directPrinterFor({ email: 'kemas@treelogy.com' }), go: '/api/dashboard?view=orders&q="x"' });
  assert.match(html, /<iframe id="frame" src="\/api\/dashboard\?view=orders&amp;q=&quot;x&quot;"/);
  assert.match(html, /id="connect"/);
  assert.match(html, /dp:print/);
});

test('blank rows are not sent: one BITMAP per band of ink, close bands merged', () => {
  // 8 px wide, 40 rows: ink on rows 2-3, 30, and 36-39 (gap of 5 blank rows from 30).
  const rgba = new Uint8Array(8 * 40 * 4).fill(255);
  const inkRow = (y) => { for (let x = 0; x < 8; x += 1) rgba.set([0, 0, 0, 255], (y * 8 + x) * 4); };
  [2, 3, 30, 36, 37, 38, 39].forEach(inkRow);
  const mono = packMono(rgba, 8, 40, { black: 0 });
  assert.deepEqual(inkBands(mono), [[2, 4], [30, 40]]);
  const text = Buffer.from(tsplJob(mono)).toString('latin1');
  assert.match(text, /BITMAP 0,2,1,2,0,\x00\x00\r\nBITMAP 0,30,1,10,0,/);
  assert.equal((text.match(/BITMAP/g) ?? []).length, 2);
  assert.ok(text.endsWith('PRINT 1,1\r\n'));
  // A white label sends no bitmap at all.
  const white = packMono(new Uint8Array(8 * 4 * 4).fill(255), 8, 4, { black: 0 });
  assert.doesNotMatch(Buffer.from(tsplJob(white)).toString('latin1'), /BITMAP/);
  // The inverted polarity reads 0x00 as blank.
  assert.deepEqual(inkBands(packMono(rgba, 8, 40, { black: 1 }), { blank: 0x00 }), [[2, 4], [30, 40]]);
});

test('a page is drawn at the calibrated size, centred across and flush to the top', () => {
  const full = placePage(298, 420, { width: 800, height: 1200, fit: 1 });
  assert.equal(Math.round(298 * full.scale), 800);
  assert.deepEqual([full.x, full.y], [0, 0]);
  // The measured D100: 1.5x enlargement about the centre, down from the top.
  const d100 = placePage(298, 420, { width: 800, height: 1200, fit: 0.70 });
  assert.equal(Math.round(298 * d100.scale), 560);
  assert.equal(d100.x, 120, 'centred: the printer enlarges about the middle of the paper');
  assert.equal(d100.y, 0, 'flush to the top: the printer runs down from the top edge');
  assert.ok(420 * d100.scale <= 840);
  assert.equal(directPrinterFor({ email: 'kemas@treelogy.com' }).fit, 0.70, 'the measured figure, fixed in code');
});

test('the panel has nothing to calibrate, and the label page no longer carries it for non-packers', () => {
  const args = { orders: [], range: {}, errors: {}, shopeeShop: null, generatedAt: 0, csrf: 't', flash: null, sizes: { a6: { label: 'A6' } }, defaultSize: 'a6', directPrinter: directPrinterFor({ email: 'kemas@treelogy.com' }) };
  const reprint = renderLabels({ ...args, showReprints: true });
  assert.doesNotMatch(reprint, /id="dp-go"/);
  assert.doesNotMatch(directPrintScript({ model: 'x', fit: 0.65 }), /dp\.fit/, 'the scale is never read from the phone');
  assert.doesNotMatch(directPrintScript({ model: 'x', fit: 0.65 }), /alibrasi/);
});

test('an iPhone is told about Bluefy, and the host writes in a way every implementation takes', () => {
  const panel = directPrintScript({ model: 'x' });
  assert.match(panel, /Bluefy/);
  assert.match(panel, /bluefy:\/\/open\?url=/);
  assert.match(panel, /apps\.apple\.com\/app\/id1492822055/);
  const host = hostScript({ model: 'x', widthMm: 100, heightMm: 150, gapMm: 2, dotsPerMm: 8, fit: 0.7 });
  assert.match(host, /part\.slice\(0\)\.buffer/, 'a fresh ArrayBuffer, not a view with an offset');
  assert.match(host, /typeof ch\.writeValueWithoutResponse === 'function'/);
  assert.match(host, /var careful = !\(window\.chrome && \/Android\//, 'outside Chrome Android every packet is acknowledged');
  assert.match(host, /sizes: \[180, 100, 20\], remember: false/, 'and the size is never remembered across sessions there');
  assert.match(host, /getPrimaryService\(SERVICES\[u\]\)/, 'service by service where listing all is refused');
  new Function(panel); new Function(host);
  const page = directPrintHostPage({ printer: directPrinterFor({ email: 'kemas@treelogy.com' }), go: null });
  assert.match(page, /100dvh/);
  assert.match(page, /id="nb"/);
});

test('one phone, one printer: the link is kept, its way in remembered, and labels arrive as TSPL', () => {
  const host = hostScript({ model: 'x', widthMm: 100, heightMm: 150, gapMm: 2, dotsPerMm: 8, fit: 0.7 });
  assert.doesNotMatch(host, /HOLD_MS|dilepas agar HP lain/, 'nothing lends the printer out');
  assert.match(host, /store\.set\('dp\.svc', prefs\.svc\); store\.set\('dp\.chr', prefs\.chr\)/, 'service and characteristic remembered');
  assert.match(host, /getPrimaryService\(prefs\.svc\)\)\.getCharacteristic\(prefs\.chr\)/, 'and asked for directly next time');
  assert.match(host, /if \(tspl && tspl\.length\) jobs = tspl\.map\(fromBase64\)/, 'server-rendered pages go straight out');
  assert.match(host, /queue = queue\.then/, 'a second press waits its turn');
  assert.match(host, /visibilitychange/, 'reconnects when the page is looked at again');
  assert.match(directPrintScript({ model: 'x' }), /body\.set\('format', 'tspl'\)/);
  new Function(host);
  assert.equal(directPrinterFor({ email: 'budi@treelogy.com', role: 'packer', status: 'active' })?.model, 'OKAY D100', 'every packer');
  assert.equal(directPrinterFor({ email: 'v@treelogy.com', role: 'viewer', status: 'active' }), null);
  assert.equal(directPrinterFor({ email: 'f@treelogy.com', role: 'factory', status: 'active' }), null);
});

test('the host keeps reaching for a printer it once had, instead of waiting to be told it is on', async () => {
  const { hostScript, directPrinterFor } = await import('../src/direct-print.js');
  const js = hostScript(directPrinterFor({ role: 'packer', status: 'active', email: 'p@t.com' }));
  assert.doesNotMatch(js, /Menunggu printer menyala/);
  assert.match(js, /function keepLink\(dev\)/);
  assert.match(js, /gattserverdisconnected[\s\S]*keepLink\(dev\)/, 'a drop is chased at once');
  assert.match(js, /Math\.min\(10000/, 'never more than ten seconds between tries');
});
