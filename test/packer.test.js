import test from 'node:test';
import assert from 'node:assert/strict';
import { can, canView, homeView, ASSIGNABLE_ROLES, ROLES } from '../src/users.js';
import { applyAssign, applyUnassign, assignmentFor, assignedTo, pruneAssignments } from '../src/label-assign.js';
import { renderLabels } from '../src/dashboard-page.js';

const packer = { email: 'budi@treelogy.com', name: 'Budi', role: 'packer', status: 'active' };
const agas = { email: 'agas@treelogy.com', name: 'Agas', role: 'operator', status: 'active' };

test('a packer may print and open the label page, and nothing else', () => {
  assert.equal(can(packer, 'orders'), true, 'the parcel needs a name and an address');
  assert.equal(can(packer, 'write'), false);
  assert.equal(can(packer, 'assign'), false);
  assert.equal(can(agas, 'assign'), true);
  assert.equal(canView(packer, 'labels'), true);
  assert.equal(canView(packer, 'orders'), false);
  assert.equal(canView(packer, 'process'), false);
  assert.equal(homeView(packer), 'labels');
  assert.ok(ASSIGNABLE_ROLES.includes('packer'));
  assert.equal(ROLES.packer.label, 'Packer');
});

test('labels are handed to one packer at a time, taken back, and forgotten after a fortnight', () => {
  const t0 = 1_800_000_000_000;
  let doc = applyAssign(null, ['shopee:1', 'shopify:#2'], packer, agas, t0);
  assert.deepEqual(assignmentFor(doc, { channel: 'shopee', id: '1' }), { to: 'budi@treelogy.com', name: 'Budi', by: 'agas@treelogy.com', at: t0 });
  const other = { email: 'cici@treelogy.com', name: 'Cici' };
  doc = applyAssign(doc, ['shopee:1'], other, agas, t0 + 1);
  assert.equal(assignmentFor(doc, { channel: 'shopee', id: '1' }).to, 'cici@treelogy.com', 'handed again: moved, not split');
  const orders = [{ channel: 'shopee', id: '1' }, { channel: 'shopify', id: '#2' }, { channel: 'tiktok_shop', id: '3' }];
  assert.deepEqual(assignedTo(doc, orders, 'budi@treelogy.com').map((o) => o.id), ['#2']);
  doc = applyUnassign(doc, ['shopify:#2'], t0 + 2);
  assert.equal(assignmentFor(doc, { channel: 'shopify', id: '#2' }), null);
  assert.equal(Object.keys(pruneAssignments(doc, t0 + 15 * 86400_000).orders).length, 0);
});

const order = (id, buyer) => ({ channel: 'shopify', id, stage: 'to_ship', buyer, buyerPhone: '0812', shipTo: 'Bali', carrier: 'JNE', createdAt: 1794271940, lines: [{ sku: 'OMC-90-001', name: 'Organic Moringa Capsules', variant: '90', qty: 2 }] });
const base = { range: {}, errors: {}, shopeeShop: null, generatedAt: 0, csrf: 't', flash: null, sizes: { a6: { label: 'A6' } }, defaultSize: 'a6', arranged: { '#1': 1, '#2': 1 } };
const assignments = applyAssign(null, ['shopify:#1'], packer, agas);

test('the packer sees one row per parcel with its own print button, and none of the management', () => {
  const images = { 'OMC-90-001': { thumb: 'https://img.example/caps90.jpg' } };
  const html = renderLabels({ ...base, user: packer, isPacker: true, orders: [order('#1', 'Wiwiek')], assignments, packers: [packer], images, bench: { online: true, seenAt: Date.now(), agent: { name: 'Laptop packing' } } });
  assert.match(html, /class="pq__row" data-key="shopify:#1"/);
  assert.match(html, /data-print="shopify:#1"/, 'a print button per row');
  assert.doesNotMatch(html, /type="checkbox" name="order"/, 'nothing to tick, one at a time');
  assert.match(html, /"name":"Organic Moringa Capsules","variant":"90","qty":2,"sku":"OMC-90-001","img":"https:\/\/img.example\/caps90.jpg"/, 'what goes in the box, with its picture');
  assert.match(html, /Laptop packing siap/);
  assert.match(html, /<dialog class="pq__sheet"/);
  assert.doesNotMatch(html, /Tandai sudah dicetak|Cetak ulang|name="packer"|id="lbq"|class="pagehead"|<div class="strip">/);
  const offline = renderLabels({ ...base, user: packer, isPacker: true, orders: [order('#1', 'Wiwiek')], assignments, packers: [packer], bench: null });
  assert.match(offline, /id="pq-pair"/, 'a phone without a printer is offered to pair one');
  assert.match(offline, /format: format/);
  const none = renderLabels({ ...base, user: packer, isPacker: true, orders: [], assignments, packers: [packer] });
  assert.match(none, /Belum ada paket yang ditugaskan kepadamu/);
});

test('whoever may write gets the hand-out tools, the chip on the row and a pile per packer', () => {
  const html = renderLabels({ ...base, user: agas, orders: [order('#1', 'Wiwiek'), order('#2', 'Budi')], assignments, packers: [packer] });
  assert.match(html, /<select class="dr__in" name="packer" id="lb-packer"><option value="budi@treelogy.com">Budi<\/option>/);
  assert.match(html, /value="label_assign">Tugaskan</);
  assert.match(html, /value="label_unassign">Lepas</);
  assert.match(html, /lb-to"[^>]*>.*Budi/, 'the row says who has it');
  assert.match(html, /packer=none">Belum ditugaskan &middot; 1/);
  assert.match(html, /packer=budi%40treelogy.com">Budi &middot; 1/);
  const viewer = renderLabels({ ...base, user: { ...agas, role: 'viewer' }, orders: [order('#1', 'Wiwiek')], assignments, packers: [packer] });
  assert.doesNotMatch(viewer, /value="label_assign"/, 'a viewer hands nothing out');
  const noPackers = renderLabels({ ...base, user: agas, orders: [order('#1', 'Wiwiek')], assignments: null, packers: [] });
  assert.doesNotMatch(noPackers, /class="filters lb-packers"/, "no packers, no piles");
});

test('an assigned row can be taken back by itself, without ticking anything', async () => {
  const html = renderLabels({ ...base, user: agas, orders: [order('#1', 'Wiwiek'), order('#2', 'Budi')], assignments, packers: [packer] });
  assert.match(html, /class="lb-free" type="submit" formaction="\/api\/dashboard" formtarget="_self" formnovalidate name="unassign" value="shopify:#1"/);
  assert.equal((html.match(/class="lb-free"/g) ?? []).length, 1, 'only the assigned row has one');
  const viewer = renderLabels({ ...base, user: { ...agas, role: 'viewer' }, orders: [order('#1', 'Wiwiek')], assignments, packers: [packer] });
  assert.doesNotMatch(viewer, /class="lb-free"/, 'a viewer takes nothing back');
  const fs = await import('node:fs');
  const dash = fs.readFileSync(new URL('../api/dashboard.js', import.meta.url), 'utf8');
  assert.match(dash, /const action = form\.get\('unassign'\) \? 'label_unassign'/, 'the button is an unassign');
  assert.match(dash, /\(one \? \[one\] : form\.getAll\('order'\)\)/, 'of that row only');
});

test('a parcel the shelf cannot fill cannot be printed, and says what is missing', async () => {
  const { shortagesFor, shortageText } = await import('../src/warehouse-reserve.js');
  const { recipeOf } = await import('../src/warehouse.js');
  const code = Object.keys(recipeOf('OMC-90-001'))[0];
  const shelf = { items: { [code]: { name: 'Organic Moringa Capsules 90', qty: 1 } }, orders: {}, recipes: {} };
  const o = order('#1', 'Wiwiek');                                   // 2 x OMC-90-001
  assert.deepEqual(shortagesFor(shelf, o), [{ code, name: 'Organic Moringa Capsules 90', need: 2, have: 1 }]);
  assert.equal(shortageText(shortagesFor(shelf, o)), 'Stok di rak kurang: Organic Moringa Capsules 90 (perlu 2, ada 1)');
  assert.deepEqual(shortagesFor({ ...shelf, items: { [code]: { name: 'x', qty: 5 } } }, o), []);
  assert.deepEqual(shortagesFor({ ...shelf, orders: { 'shopify|#1': { picked: 1 } } }, o), [], 'already taken off the shelf');
  assert.equal(shortageText(shortagesFor({ ...shelf, items: { [code]: { name: 'C90', qty: -143 } } }, o)), 'Stok di rak kurang: C90 (perlu 2, ada 0)');
  const html = renderLabels({ ...base, user: packer, isPacker: true, orders: [o], assignments, packers: [packer], shelf });
  assert.match(html, /class="pq__row is-short"/);
  assert.match(html, /data-print="shopify:#1" disabled/);
  assert.match(html, /Stok kosong/);
  assert.match(html, /pq__short" role="note">.*Stok di rak kurang: Organic Moringa Capsules 90 \(perlu 2, ada 1\)/s);
  const fine = renderLabels({ ...base, user: packer, isPacker: true, orders: [o], assignments, packers: [packer], shelf: { ...shelf, items: { [code]: { name: 'x', qty: 9 } } } });
  assert.doesNotMatch(fine, /data-print="shopify:#1" disabled/);
  // The page keeps judging after it is drawn: each row carries what it needs, the note
  // is there (hidden) to be filled, and the shelf is polled.
  assert.ok(fine.includes(`data-need="${JSON.stringify({ [code]: 2 }).replace(/"/g, '&quot;')}"`), 'the row says what it takes off the shelf');
  assert.match(fine, /pq__short" role="note" hidden>/);
  assert.match(fine, /view=labels&shelf=1/);
  const scripts = [...fine.matchAll(/<script(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  for (const js of scripts) assert.doesNotThrow(() => new Function(js), 'page script parses');
  const { shelfPulse } = await import('../src/warehouse-reserve.js');
  const pulse = shelfPulse(shelf);
  assert.deepEqual(pulse.items, { [code]: { q: 1, n: 'Organic Moringa Capsules 90' } });
});

test('the packer page has two tabs: what is left to print, and what the printer produced', () => {
  const now = Math.floor(Date.now() / 1000);
  const printedOne = order('#2', 'Sari');
  const html = renderLabels({ ...base, user: packer, isPacker: true, orders: [order('#1', 'Wiwiek')], assignments, packers: [packer],
    packerDone: [{ order: printedOne, entry: { at: now, by: packer.email, times: 2 } }] });
  assert.match(html, /role="tablist"/);
  assert.match(html, /id="pq-t-todo"[^>]*aria-selected="true"[^>]*>Belum dicetak<span class="pq__badge mono" id="pq-n-todo">1</);
  assert.match(html, /id="pq-t-done"[^>]*>Sudah dicetak<span class="pq__badge mono" id="pq-n-done">1</);
  // The printed one sits under today, with its time, opens its contents and cannot be pressed.
  const done = html.slice(html.indexOf('id="pq-done"'), html.indexOf('id="pq-e-done"'));
  assert.match(done, /Hari ini/);
  assert.match(done, /#2/);
  assert.match(done, /dicetak 2&times;/);
  assert.match(done, /data-view/);
  assert.doesNotMatch(done, /data-print=/);
  const todo = html.slice(html.indexOf('id="pq-todo"'), html.indexOf('id="pq-e-todo"'));
  assert.match(todo, /data-print="shopify:#1"/);
  assert.doesNotMatch(todo, /#2/);
  // Nothing handed out at all reads differently from everything printed.
  const none = renderLabels({ ...base, user: packer, isPacker: true, orders: [], assignments, packers: [packer] });
  assert.match(none, /Belum ada paket yang ditugaskan kepadamu/);
  const all = renderLabels({ ...base, user: packer, isPacker: true, orders: [], assignments, packers: [packer], packerDone: [{ order: printedOne, entry: { at: now, times: 1 } }] });
  assert.match(all, /Semua paketmu sudah dicetak/);
});

test('a print to the phone is put on record only when the phone confirms it', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../api/labels.js', import.meta.url), 'utf8');
  // The tspl road hands out a ticket and records nothing; confirm ok=1 marks, ok=0 logs a failure.
  assert.match(src, /const deferred = form\.get\('format'\) === 'tspl';\s*if \(printedKeys\.length && !deferred\)/);
  assert.match(src, /if \(!deferred\) await recordActivity/);
  assert.match(src, /if \(ok\) \{\s*await markPrinted/);
  const page = renderLabels({ ...base, user: packer, isPacker: true, orders: [order('#1', 'W')], assignments, packers: [packer] });
  assert.match(page, /format: 'confirm'/);
  assert.match(page, /printer belum tersambung/, 'not connected is said, not hidden behind a PDF');
});

test('without a connected printer the packer is asked to pick one before anything prints', async () => {
  const page = renderLabels({ ...base, user: packer, isPacker: true, orders: [order('#1', 'W')], assignments, packers: [packer] });
  assert.match(page, /function printerOk\(\) \{ return host \? hostLive/);
  assert.match(page, /if \(!printerOk\(\)\) \{ choosePrinter\(\); return; \}/);
  assert.match(page, /'Pilih printer'/);
  assert.match(page, /type: 'dp:choose'/);
  const { hostScript, directPrinterFor } = await import('../src/direct-print.js');
  assert.match(hostScript(directPrinterFor(packer)), /m\.type === 'dp:choose'/);
});

test('a parcel handed to a packer is printed by that packer only - one rule, every road', async () => {
  const { mayPrint, splitPrintable, heldText } = await import('../src/label-assign.js');
  const toBudi = { to: packer.email, name: 'Budi' };
  assert.equal(mayPrint(packer, toBudi), true);
  assert.equal(mayPrint(packer, null), false, 'a packer prints only what was handed to them');
  assert.equal(mayPrint(agas, null), true);
  assert.equal(mayPrint(agas, toBudi), false, 'Agas cannot print what he handed to Budi');
  assert.equal(mayPrint(agas, { to: agas.email, name: 'Agas' }), true);
  const split = splitPrintable(assignments, ['shopify:#1', 'shopify:#9'], agas);
  assert.deepEqual(split.mine, ['shopify:#9']);
  assert.equal(split.held[0].key, 'shopify:#1');
  assert.match(heldText(split.held, agas), /#1 sudah ditugaskan ke Budi - hanya Budi yang bisa mencetaknya/);

  // On Agas's label page: the row stays tickable (for Lepas) but starts unticked, says who
  // prints it, and is never counted or sent with a print.
  const html = renderLabels({ ...base, user: agas, orders: [order('#1', 'W'), order('#2', 'S')], assignments, packers: [packer] });
  assert.match(html, /value="shopify:#1"[^>]*data-held="Budi"/);
  assert.doesNotMatch(html, /value="shopify:#1" checked/);
  assert.match(html, /value="shopify:#2" checked/);
  assert.match(html, /dicetak oleh Budi - lepas tugasnya dulu/);
  assert.match(html, /Cetak <span id="n">1<\/span> label/);

  const fs = await import('node:fs');
  const api = fs.readFileSync(new URL('../api/labels.js', import.meta.url), 'utf8');
  assert.match(api, /splitPrintable\(handed,/, 'the print road asks the shared rule');
  const dash = fs.readFileSync(new URL('../api/dashboard.js', import.meta.url), 'utf8');
  assert.match(dash, /const \{ held \} = splitPrintable\(await loadAssignments\(\), keys, user\);\s*if \(held\.length\) throw/, '"sudah dicetak" too');
});

test('after a print the sheet offers the next parcel, which prints at once; with none left it says Tutup', () => {
  const page = renderLabels({ ...base, user: packer, isPacker: true, orders: [order('#1', 'W')], assignments, packers: [packer] });
  assert.match(page, /id="pq-next" hidden>/);
  assert.match(page, /<b>Pesanan berikutnya<\/b>/);
  assert.match(page, /id="pq-x" aria-label="Tutup"/, 'an exit that is always there');
  // The next one is the first row that can actually print now, and pressing it prints.
  assert.match(page, /function nextRow\(\) \{\s*if \(!printerOk\(\)\) return null;/);
  assert.match(page, /nextBtn\.addEventListener\('click', function \(\) \{ var r = nextRow\(\); if \(r && !busy\) press\(r\);/);
  assert.match(page, /closeBtn\.hidden = !!nxt;/, 'Tutup gives way to the next parcel, and comes back when there is none');
});

test('goods missing from the shelf stop the parcel for everyone: no print, no hand-out', async () => {
  const { recipeOf } = await import('../src/warehouse.js');
  const code = Object.keys(recipeOf('OMC-90-001'))[0];
  const shelf = { items: { [code]: { name: 'Organic Moringa Capsules 90', qty: 0 } }, orders: {}, recipes: {} };
  const html = renderLabels({ ...base, user: agas, orders: [order('#1', 'W'), order('#2', 'S')], assignments: null, packers: [packer], shelf });
  assert.match(html, /value="shopify:#2"[^>]*data-short="1"/);
  assert.doesNotMatch(html, /value="shopify:#2" checked/);
  assert.match(html, /lb-short">.*Stok di rak kurang: Organic Moringa Capsules 90 \(perlu 2, ada 0\)/s);
  assert.match(html, /Cetak <span id="n">0<\/span> label/);
  const fs = await import('node:fs');
  const api = fs.readFileSync(new URL('../api/labels.js', import.meta.url), 'utf8');
  assert.match(api, /const short = await shelfShortages\(/, 'checked for whoever prints');
  assert.doesNotMatch(api, /if \(user\.role === 'packer'\) \{\s*\/\/ Goods/, 'not only for packers');
  const dash = fs.readFileSync(new URL('../api/dashboard.js', import.meta.url), 'utf8');
  assert.match(dash, /const short = await shelfShortages\(keys\);\s*if \(short\.length\) throw new Error\(`tidak bisa ditugaskan/);
  const { shortRefusal } = await import('../src/shelf-gate.js');
  assert.equal(shortRefusal([{ id: '#2', short: [{ name: 'Pouch', need: 1, have: 0 }] }, { id: '#3', short: [] }]), '#2: Stok di rak kurang: Pouch (perlu 1, ada 0) (dan 1 pesanan lain)');
});
