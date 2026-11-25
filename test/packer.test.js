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
  assert.match(html, /"name":"Moringa Capsules","variant":"90 caps","qty":2,"sku":"OMC-90-001","img":"https:\/\/img.example\/caps90.jpg"/, 'what goes in the box, with its picture');
  assert.match(html, /Laptop packing siap/);
  assert.match(html, /<dialog class="pq__sheet"/);
  assert.doesNotMatch(html, /Tandai sudah dicetak|Cetak ulang|name="packer"|id="lbq"|class="pagehead"|<div class="strip">/);
  const offline = renderLabels({ ...base, user: packer, isPacker: true, orders: [order('#1', 'Wiwiek')], assignments, packers: [packer], bench: null });
  assert.match(offline, /id="pq-pair"/, 'a phone without a printer is offered to pair one');
  assert.match(offline, /format: format/);
  const none = renderLabels({ ...base, user: packer, isPacker: true, orders: [], assignments, packers: [packer] });
  assert.match(none, /Belum ada paket yang ditugaskan kepadamu/);
});

test('the packer reads catalogue names, the same for every channel, on both tabs', () => {
  const sold = (channel, id, line) => ({ ...order(id, 'W'), channel, status: channel === 'shopee' ? 'PROCESSED' : '', lines: [line] });
  const orders = [
    sold('shopee', 'S1', { sku: 'The-IO60-Protocol180+30', name: 'TREELOGY - Inside Out Moringa Protocol 60 Days | Paket Set Suplemen', variant: 'The Inside Out 60', qty: 1 }),
    sold('shopify', '#2', { sku: 'Inside-Out-60-Protocol180+30', name: 'Inside Out Moringa Protocol', variant: '60 Days', qty: 1 }),
  ];
  const mine = applyAssign(null, ['shopee:S1', 'shopify:#2'], packer, agas);
  const goodsIn = (html) => [...html.matchAll(/class="pq__goods">(.*?)<\/script>/g)].flatMap((m) => JSON.parse(m[1])).map((g) => `${g.name} / ${g.variant}`);
  const same = 'Inside Out Protocol 60 Days / Caps 180 + Oil 30ml';
  const todo = renderLabels({ ...base, arranged: { S1: 1, '#2': 1 }, user: packer, isPacker: true, orders, assignments: mine, packers: [packer] });
  assert.deepEqual(goodsIn(todo), [same, same]);
  const done = renderLabels({ ...base, user: packer, isPacker: true, orders: [], assignments: mine, packers: [packer], packerDone: orders.map((o) => ({ order: o, entry: { at: 1794271940, times: 1 } })) });
  assert.deepEqual(goodsIn(done), [same, same]);
  assert.doesNotMatch(todo + done, /Paket Set Suplemen/);
});

test('a bundle is taken apart on the sheet, by the recipe the shelf is counted by', async () => {
  const { packList, packParts } = await import('../src/pack-list.js');
  const images = { 'OMC-180-001': { thumb: 'https://img/c180.jpg' }, 'OMO-30-001': { thumb: 'https://img/o30.jpg' } };
  const said = (parts) => parts.map((p) => `${p.name}|${p.variant}|${p.qty}`);

  const io = packList({ lines: [{ sku: 'The-IO60-Protocol180+30', name: 'TREELOGY - panjang', qty: 2 }, { sku: 'OMC90', qty: 1 }] }, images);
  assert.deepEqual(said(io.goods[0].parts), ['Moringa Capsules|180 caps|2', 'Moringa Seed Oil|30 ml|2']);
  assert.deepEqual(io.goods[0].parts.map((p) => p.img), ['https://img/c180.jpg', 'https://img/o30.jpg'], 'each item has its own picture');
  assert.deepEqual(io.goods[1].parts, [], 'a jar is the thing itself');
  assert.deepEqual([io.units, io.items], [3, 5], 'two bundles of two, and one jar');

  // Not a bundle in the catalogue, and still more than one thing to take.
  assert.deepEqual(said(packParts('OMC-270-001', 2)), ['Moringa Capsules|90 caps|6']);
  const set = packParts('MRS-002', 1);
  assert.deepEqual(said(set), ['Bowl||1', 'Bamboo Whisk|120 prongs|1', 'Bamboo Scoop||1', 'Wooden Box||1', 'Moringa Powder|45 gram|1']);
  assert.deepEqual([set[0].img, set[0].icon, set[3].icon], ['', 'bowl', 'crate'], 'never photographed: a drawing of it');

  // A recipe changed on the Stok page is what the packer reads.
  const shelf = { recipes: { 'Inside-Out-60-Protocol180+30': { 'M-036': 2, 'M-038': 1 } }, items: {} };
  assert.deepEqual(said(packParts('Inside-Out-60-Protocol180+30', 1, {}, shelf)), ['Moringa Capsules|90 caps|2', 'Moringa Seed Oil|30 ml|1']);
  assert.deepEqual(packParts('TIDAK-ADA', 1), [], 'an unknown SKU is not guessed at');

  const html = renderLabels({ ...base, user: packer, isPacker: true, orders: [{ ...order('#1', 'W'), lines: [{ sku: 'MRS-002', qty: 1 }] }], assignments, packers: [packer] });
  assert.match(html, /"name":"Wooden Box"/);
  assert.match(html, /<template data-pq-icon="bowl"><svg/);
  assert.match(html, /id="pq-total"/);
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
  assert.match(html, /class="lb-free" type="submit" formaction="\/api\/dashboard" formtarget="_self" formnovalidate name="unassign" value="shopify:#1" data-ask="#1 dari Budi"/);
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
  assert.deepEqual(shortagesFor(shelf, o), [{ code, name: 'Moringa Capsules 90 caps', need: 2, have: 1 }]);
  assert.equal(shortageText(shortagesFor(shelf, o)), 'Stok di rak kurang: Moringa Capsules 90 caps (perlu 2, ada 1)');
  assert.deepEqual(shortagesFor({ ...shelf, items: { [code]: { name: 'x', qty: 5 } } }, o), []);
  assert.deepEqual(shortagesFor({ ...shelf, orders: { 'shopify|#1': { picked: 1 } } }, o), [], 'already taken off the shelf');
  assert.equal(shortageText(shortagesFor({ ...shelf, items: { [code]: { name: 'C90', qty: -143 } } }, o)), 'Stok di rak kurang: Moringa Capsules 90 caps (perlu 2, ada 0)');
  const html = renderLabels({ ...base, user: packer, isPacker: true, orders: [o], assignments, packers: [packer], shelf });
  assert.match(html, /class="pq__row is-short"/);
  assert.match(html, /data-print="shopify:#1" disabled/);
  assert.match(html, /Stok kosong/);
  assert.match(html, /pq__short" role="note">.*Stok di rak kurang: Moringa Capsules 90 caps \(perlu 2, ada 1\)/s);
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
  assert.deepEqual(pulse.items, { [code]: { q: 1, n: 'Moringa Capsules 90 caps' } });
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
  assert.match(src, /const deferred = form\.get\('format'\) === 'tspl' \|\| form\.get\('format'\) === 'queue';\s*if \(printedKeys\.length && !deferred\)/);
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
  assert.match(html, /lb-short">.*Stok di rak kurang: Moringa Capsules 90 caps \(perlu 2, ada 0\)/s);
  assert.match(html, /Cetak <span id="n">0<\/span> label/);
  const fs = await import('node:fs');
  const api = fs.readFileSync(new URL('../api/labels.js', import.meta.url), 'utf8');
  assert.match(api, /const short = await shelfShortages\(/, 'checked for whoever prints');
  assert.doesNotMatch(api, /if \(user\.role === 'packer'\) \{\s*\/\/ Goods/, 'not only for packers');
  const dash = fs.readFileSync(new URL('../api/dashboard.js', import.meta.url), 'utf8');
  assert.match(dash, /const short = await shelfShortages\(keys, \{ handingOut: true \}\);/);
  assert.match(dash, /if \(!handed\.length\) throw new Error\(`tidak bisa ditugaskan/);
  assert.match(dash, /await assignLabels\(handed, packer, user\)/, 'only what the shelf can fill is handed out');
  const { shortRefusal } = await import('../src/shelf-gate.js');
  assert.equal(shortRefusal([{ id: '#2', short: [{ name: 'Pouch', need: 1, have: 0 }] }, { id: '#3', short: [] }]), '#2: Stok di rak kurang: Pouch (perlu 1, ada 0) (dan 1 pesanan lain)');
});

test("the packer's pile is oldest hand-out first, and a browser with no Bluetooth prints nothing it cannot confirm", async () => {
  let handed = applyAssign(null, ['shopify:#1'], packer, agas, 1000);
  handed = applyAssign(handed, ['shopify:#2'], packer, agas, 3000);
  handed = applyAssign(handed, ['shopify:#3'], packer, agas, 2000);
  const html = renderLabels({ ...base, arranged: { '#1': 1, '#2': 1, '#3': 1 }, user: packer, isPacker: true, orders: [order('#1', 'A'), order('#2', 'B'), order('#3', 'C')], assignments: handed, packers: [packer], now: 4 });
  const keys = [...html.matchAll(/class="pq__row[^"]*"[^>]*data-key="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(keys, ['shopify:#1', 'shopify:#3', 'shopify:#2']);
  assert.doesNotMatch(html, /id="pq-pdf"/, 'no PDF that would count as printed');
  assert.match(html, /browser ini tidak bisa menyambung ke printer Bluetooth/);
});

test('the packer can find a parcel by its order ID, in either tab', () => {
  const html = renderLabels({ ...base, user: packer, isPacker: true, orders: [order('#1', 'W')], assignments, packers: [packer] });
  assert.match(html, /<input type="search" id="pq-q" placeholder="Cari order ID"/);
  assert.match(html, /function find\(\)/);
});

test('handing out asks first, with how many and to whom', () => {
  const html = renderLabels({ ...base, user: agas, orders: [order('#1', 'W')], assignments: null, packers: [packer] });
  assert.match(html, /'Tugaskan ' \+ n \+ ' pesanan ke ' \+ who \+ '\?'/);
});

test('a parcel handed out earlier holds its goods: the next one on the page is short, for the operator and the packer', async () => {
  const { recipeOf } = await import('../src/warehouse.js');
  const { shortagesInTurn } = await import('../src/warehouse-reserve.js');
  const code = Object.keys(recipeOf('OMC-90-001'))[0];
  const shelf = { items: { [code]: { name: 'Caps 90', qty: 2 } }, orders: {}, recipes: {} };   // one parcel's worth
  let handed = applyAssign(null, ['shopify:#1'], packer, agas, 1000);
  handed = applyAssign(handed, ['shopify:#3'], packer, agas, 2000);
  const orders = [order('#2', 'S'), order('#3', 'T'), order('#1', 'W')];
  const shelfTurn = shortagesInTurn(shelf, orders, handed);
  const all = { ...base, arranged: { '#1': 1, '#2': 1, '#3': 1 } };
  const html = renderLabels({ ...all, user: agas, orders, assignments: handed, packers: [packer], shelf, shelfTurn });
  assert.match(html, /value="shopify:#2"[^>]*data-short="1"/, 'nobody handed it, and the shelf is promised already');
  assert.match(html, /Moringa Capsules 90 caps \(perlu 2, 2 di rak sudah untuk pesanan lain\)/);
  const page = renderLabels({ ...all, user: packer, isPacker: true, orders: assignedTo(handed, orders, packer.email), assignments: handed, packers: [packer], shelf, shelfTurn });
  assert.match(page, /data-key="shopify:#3" data-printed="0" data-state="short"/, 'the later hand-out waits');
  assert.match(page, /data-key="shopify:#1" data-printed="0" data-state="todo"/, 'the earlier one prints');
});

test('a bulk hand-out or print adds the ticked parcels up per shelf item and asks which go ahead when it runs short', async () => {
  const { recipeOf } = await import('../src/warehouse.js');
  const code = Object.keys(recipeOf('OMC-90-001'))[0];
  const shelf = { items: { [code]: { name: 'Caps 90', qty: 3 } }, orders: {}, recipes: {} };
  const all = { ...base, arranged: { '#1': 1, '#2': 1 } };
  const html = renderLabels({ ...all, user: agas, orders: [order('#1', 'W'), order('#2', 'S')], assignments: applyAssign(null, ['shopify:#1'], packer, agas), packers: [packer], shelf });
  // Each row carries what it takes off the shelf and what is in it, in catalogue names.
  assert.match(html, new RegExp(`value="shopify:#2"[^>]*data-need="\\{&quot;${code}&quot;:2\\}"[^>]*data-goods="\\[\\{&quot;n&quot;:&quot;Moringa Capsules 90 caps&quot;,&quot;q&quot;:2\\}\\]"`));
  assert.match(html, /value="shopify:#1"[^>]*data-assigned="1"/, 'a handed-out row is counted in what is held');
  assert.match(html, /<dialog class="stk" id="stk"/);
  assert.match(html, /window\.treelogyStockCheck = function \(mode, who\)/);
  assert.match(html, /var mode = b\.getAttribute\('value'\) === 'label_assign' \? 'assign' : \(b\.id === 'go' \? 'print' : ''\);/, 'asked before Tugaskan and Cetak');
  const fs = await import('node:fs');
  const print = fs.readFileSync(new URL('../src/direct-print.js', import.meta.url), 'utf8');
  assert.equal((print.match(/await window\.treelogyStockCheck\('print'\)/g) ?? []).length, 2, 'the bench and the phone printer ask too');
  const packerPage = renderLabels({ ...all, user: packer, isPacker: true, orders: [order('#1', 'W')], assignments: applyAssign(null, ['shopify:#1'], packer, agas), packers: [packer], shelf });
  assert.doesNotMatch(packerPage, /id="stk"/, 'a packer prints one parcel at a time and has no bulk to check');
});

test('every packer chip keeps its count whichever chip is pressed', () => {
  const two = { email: 'cici@treelogy.com', name: 'Cici', role: 'packer', status: 'active' };
  const handed = applyAssign(null, ['shopify:#1'], packer, agas);
  const counts = { all: 5, none: 2, by: { [packer.email]: 3 } };
  // Pressed "Budi": the page holds Budi's rows only, the counts are the whole worklist's.
  const html = renderLabels({ ...base, user: agas, orders: [order('#1', 'W')], assignments: handed, packers: [packer, two], packerFilter: packer.email, packerCounts: counts });
  assert.match(html, /href="\?view=labels">Semua &middot; 5</);
  assert.match(html, /Belum ditugaskan &middot; 2</);
  assert.match(html, /Budi &middot; 3</);
  assert.match(html, /Cici &middot; 0</);
});

test('the label table filters by channel and by courier from its headings', () => {
  const mk = (id, channel, carrier) => ({ ...order(id, 'W'), channel, carrier });
  const orders = [mk('#1', 'shopify', 'JNE REG'), mk('#2', 'shopify', 'J&T Express'), mk('#3', 'shopify', '')];
  const html = renderLabels({ ...base, arranged: { '#1': 1, '#2': 1, '#3': 1 }, user: agas, orders, assignments: null, packers: [packer] });
  assert.match(html, /<tr data-id="#1" data-ch="Shopify" data-carrier="JNE REG"/);
  assert.match(html, /data-filter="carrier"[^>]*><option value="\*">Semua kurir<\/option>/);
  assert.match(html, /<option value="">Belum ada kurir \(1\)<\/option>/, 'a parcel with no courier yet can be picked out too');
  assert.doesNotMatch(html, /data-filter="ch"/, 'one channel on the list: a plain heading');
  assert.match(html, /&& passes\(row\)/, 'applied with the search, so hidden rows are not printed');
});

test('the label table filters by product too, a bundle counting for its parts', () => {
  const mk = (id, lines) => ({ ...order(id, 'W'), lines });
  const orders = [mk('#1', [{ sku: 'OMC90', qty: 1 }, { sku: 'Oil-3ml', qty: 1 }]), mk('#2', [{ sku: 'Inside-Out-60-Protocol180+30', qty: 1 }])];
  const html = renderLabels({ ...base, arranged: { '#1': 1, '#2': 1 }, user: agas, orders, assignments: null, packers: [packer] });
  assert.match(html, /<tr data-id="#1"[^>]*data-products="\|Moringa Capsules 90 caps\|Moringa Seed Oil 3 ml\|"/, 'catalogue names, whatever the channel spelled');
  assert.match(html, /<tr data-id="#2"[^>]*data-products="\|Inside Out Protocol 60 Days Caps 180 \+ Oil 30ml\|Moringa Capsules 180 caps\|Moringa Seed Oil 30 ml\|"/);
  assert.match(html, /data-filter="products"[^>]*><option value="\*">Semua produk<\/option><option value="Inside Out Protocol/, 'listed by name');
  assert.match(html, /key === 'products' \? have\.indexOf\('\|' \+ f\.value \+ '\|'\) !== -1/);
});

test('the label size is not asked any more: every print goes out at the default, A6', () => {
  const html = renderLabels({ ...base, user: agas, orders: [order('#1', 'W')], assignments: null, packers: [packer] });
  assert.doesNotMatch(html, /Ukuran label/);
  assert.doesNotMatch(html, /<select[^>]*name="size"/);
  assert.match(html, /<input type="hidden" name="size" value="a6">/);
});

test('the label table has its own column for who a parcel was handed to', () => {
  const html = renderLabels({ ...base, user: agas, orders: [order('#1', 'W'), order('#2', 'S')], assignments: applyAssign(null, ['shopify:#1'], packer, agas), packers: [packer] });
  assert.match(html, /<th>Pembeli<\/th><th>Ditugaskan<\/th><th>Label<\/th>/);
  assert.match(html, /<td class="nowrap">W<\/td>\s*<td class="nowrap"><span class="lb-to" title="Ditugaskan ke Budi"><span class="lb-to__a" aria-hidden="true">B<\/span>Budi<button class="lb-free"/);
  assert.match(html, /<td class="nowrap">S<\/td>\s*<td class="nowrap"><span class="lb-none">Belum<\/span><\/td>/);
});

test('a yes to "Tugaskan n pesanan ke ...?" sends the hand-out, it does not ask again', () => {
  // The stock check runs first; the question after it. Its yes resubmits the form, and the
  // stock check let that through only once the fix was in - before, it checked again and
  // the same question came back for ever (18 Nov).
  const html = renderLabels({ ...base, user: agas, orders: [order('#1', 'W')], assignments: null, packers: [packer], shelf: { items: {}, orders: {}, recipes: {} } });
  assert.match(html, /if \(stockPassed \|\| assignAsked \|\| !b \|\| !window\.treelogyStockCheck\) return;/);
  const stock = html.indexOf('var stockPassed = false;');
  const ask = html.indexOf('window.treelogyConfirm(question)');
  assert.ok(stock > 0 && ask > stock, 'the stock check is bound before the question');
});

test('a label already printed reprints for anybody who prints; the hand-out holds only the first print', async () => {
  const { mayPrint, splitPrintable } = await import('../src/label-assign.js');
  const handed = applyAssign(null, ['shopify:#1', 'shopify:#2', 'shopify:#3'], packer, agas);
  const printed = { 'shopify:#1': { at: 1 }, 'shopify:#2': { at: 1, stale: true } };
  const owner = { email: 'kemas@x', role: 'owner' };
  // #1 printed: reprints. #2 printed but edited since: back to the packer. #3 not printed: the packer's.
  assert.deepEqual(splitPrintable(handed, ['shopify:#1', 'shopify:#2', 'shopify:#3'], owner, printed).mine, ['shopify:#1']);
  assert.equal(mayPrint(owner, handed.orders['shopify:#3']), false);
  assert.equal(mayPrint({ email: 'other@x', role: 'packer' }, handed.orders['shopify:#1'], { printed: true }), false, 'a packer still prints only theirs');
  assert.equal(mayPrint(packer, handed.orders['shopify:#1'], { printed: true }), true);
});

test('a packer prints each parcel once: the server refuses a second print, and the page moves a printed row away', async () => {
  const { alreadyPrintedText } = await import('../src/label-assign.js');
  const now = 1_800_000_000;
  assert.equal(alreadyPrintedText(['shopify:#14087'], { 'shopify:#14087': { at: now - 442 } }, now),
    '#14087 sudah dicetak 7 menit lalu - label tidak dicetak dua kali. Paket ini ada di Sudah dicetak.');
  const fs = await import('node:fs');
  const api = fs.readFileSync(new URL('../api/labels.js', import.meta.url), 'utf8');
  assert.match(api, /again = now \? printedKeys\.filter\(\(k\) => byKey\.has\(k\) && !labelOutdated\(ledger\[k\], byKey\.get\(k\)\)\) : \[\];/, 'refused only while the label still matches the order');
  assert.match(api, /if \(again\.length\) \{ fail\(409, 'Sudah dicetak', alreadyPrintedText\(again, ledger\)\); return; \}/);
  const dash = fs.readFileSync(new URL('../api/dashboard.js', import.meta.url), 'utf8');
  assert.match(dash, /\{ done: turn \? Object\.fromEntries\(Object\.entries\(turn\.done \?\? \{\}\)\.filter\(\(\[, v\]\) => v\.to === user\.email\)/, 'the pulse tells a packer which of theirs are printed');
  const page = renderLabels({ ...base, user: packer, isPacker: true, orders: [order('#1', 'W')], assignments: applyAssign(null, ['shopify:#1'], packer, agas), packers: [packer] });
  assert.match(page, /var at = printedSince\(row\);\s*if \(at && row !== busyRow\) moveToDone\(row, at\);/);
  assert.match(page, /return at && at > drawn \? at : 0;/, 'only a print newer than the row moves it');
  assert.match(page, /if \(printedSince\(row\)\) \{/, 'checked again right before a press');
});

test('a bench print is put on record when the agent reports it done, not when it is queued', async () => {
  const { applyEnqueue, applyFinish } = await import('../src/print-queue.js');
  const record = { by: 'agas@x', name: 'Agas', keys: ['shopify:#1'], sigs: {} };
  const { doc, job } = applyEnqueue(null, { by: 'agas@x', orders: ['shopify:#1'], pages: ['x'], record });
  assert.deepEqual(job.record, record, 'the queue keeps what to record');
  assert.equal(applyFinish(doc, job.id, { status: 'failed', error: 'kertas habis' }).jobs[0].status, 'failed');
  const fs = await import('node:fs');
  const labels = fs.readFileSync(new URL('../api/labels.js', import.meta.url), 'utf8');
  assert.match(labels, /const deferred = form\.get\('format'\) === 'tspl' \|\| form\.get\('format'\) === 'queue';/, 'queued is not printed');
  assert.match(labels, /export async function recordBenchJob\(job, \{ ok, error = null, ip = null \} = \{\}\) \{[\s\S]*?if \(ok\) \{\s*await markPrinted\(r\.keys/);
  const agent = fs.readFileSync(new URL('../api/print-agent.js', import.meta.url), 'utf8');
  assert.match(agent, /const finished = await finishJob\(id, \{ status, error: body\.error \}\);\s*\/\/[^\n]*\n\s*if \(finished\) await recordBenchJob\(finished, \{ ok: status === 'done'/);
});

test('#14087: an address edited after the print sends the label back to the packer, and the reprint is allowed', async () => {
  const { labelOutdated, labelSignature, labelReadiness } = await import('../src/labels.js');
  const o = { ...order('#14087', 'Rini'), shipTo: 'Jl Kemang Timur XI' };
  const ledger = { 'shopify:#14087': { at: 100, sig: labelSignature(o) } };
  const edited = { ...o, shipTo: 'Jl Kemang Timur XI Komplek Melati No. 1' };
  assert.equal(labelOutdated(ledger['shopify:#14087'], o), false);
  assert.equal(labelOutdated(ledger['shopify:#14087'], edited), true, 'the address moved: the sheet on the parcel is wrong');
  assert.equal(labelReadiness(edited, ledger, { '#14087': 1 }).state, 'needsPrint');
  // The packer page draws it with its last print time, so the shelf beat does not move it away.
  const page = renderLabels({ ...base, arranged: { '#14087': 1 }, user: packer, isPacker: true, orders: [edited], printed: ledger, assignments: applyAssign(null, ['shopify:#14087'], packer, agas), packers: [packer] });
  assert.match(page, /data-key="shopify:#14087" data-printed="100"/);
});

test('a label the order has outgrown asks the packer before it prints again: which order, when, what moved', async () => {
  const { labelSnapshot, labelSignature } = await import('../src/labels.js');
  const old = { ...order('#14087', 'Rini'), shipTo: 'Jl Kemang' };
  const now = { ...old, shipTo: 'Jl Kemang, Komplek Melati No. 1' };
  const printed = { 'shopify:#14087': { at: 1794989725, sig: labelSignature(old), as: labelSnapshot(old) } };
  const page = renderLabels({ ...base, arranged: { '#14087': 1 }, printed, user: packer, isPacker: true, orders: [now], assignments: applyAssign(null, ['shopify:#14087'], packer, agas), packers: [packer] });
  assert.match(page, /data-key="shopify:#14087" data-printed="1794989725" data-changed="1" data-what="alamat"/);
  assert.match(page, /data berubah: alamat/);
  assert.match(page, /<dialog class="pq__again" id="pq-again"/);
  assert.match(page, /Pesanan ini sudah pernah dicetak/);
  assert.match(page, /buang label lama/);
  assert.match(page, /if \(row\.getAttribute\('data-changed'\) === '1' && !row\._again\) \{ askAgain\(row\); return; \}/, 'every road into a print asks first - a tap, Pesanan berikutnya, the run after a print');
  const fresh = renderLabels({ ...base, arranged: { '#1': 1 }, user: packer, isPacker: true, orders: [order('#1', 'W')], assignments: applyAssign(null, ['shopify:#1'], packer, agas), packers: [packer] });
  assert.doesNotMatch(fresh, /data-changed=/, 'a first print is not asked about');
});
