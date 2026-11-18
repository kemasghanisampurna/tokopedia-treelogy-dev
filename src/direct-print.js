/**
 * Printing a label straight to a Bluetooth label printer from the phone, no print dialog.
 *
 * Kemas prints from an Android phone to an OKAY D100 (110 mm thermal, USB + Bluetooth;
 * the seller lists TSPL/EPL/ZPL/DPL emulation). Chrome on Android talks to it over Web
 * Bluetooth (BLE GATT): the label PDF the server already builds is rendered page by page
 * in the browser, turned into 1-bit dots at 8 dots/mm and sent as a TSPL job. Confirmed
 * on 13 Nov 2026: the printer took TSPL over BLE and printed.
 *
 * What the first prints taught:
 *
 * - The output came out 1.5x too large: cut evenly on the left and right, running off
 *   the bottom, measured from two photos against a label the Windows driver printed.
 *   So the printer enlarges what we send about the centre of the paper and down from
 *   the top - what a 300 dpi head does with a job written in 203 dpi dots, and also
 *   what a narrower sticker in the middle of the head would show. Either way the cure
 *   is the same: draw the label at `fit` of the bitmap, centred across, flush to the
 *   top. The figure is measured and fixed here: the paper never changes, so there is
 *   nothing for the person printing to set.
 * - A full label is 120 KB of dots and BLE moves a few hundred bytes per packet, so the
 *   bytes are what the print costs. Blank rows are not sent at all (one BITMAP per band
 *   of ink), the packet size is probed upward from the safe 20 bytes and remembered.
 * - A Bluetooth connection belongs to a page, and every menu, filter and button on the
 *   dashboard loads a new page - so "sambungkan" came back on every move. The
 *   connection therefore lives in a host page that never navigates: a slim bar holding
 *   the printer, with the whole dashboard in a frame beneath it. Pages inside the frame
 *   ask the host to print over postMessage; the host answers with progress. Entering
 *   the host once is remembered on the phone, so every later visit lands in it.
 *
 * Offered per person: the printer is a device on the packing bench, named for the people
 * who stand at it, not a property of the shop. Everybody else keeps the print dialog.
 */

// 0.65 printed whole but a touch small (83% of the paper's width against the driver's
// 85%, and shorter); 0.70 is the second measurement, 13 Nov 2026 afternoon.
// SPEED 6 (inches a second) and DENSITY 10: the head runs faster and a shade darker than
// its defaults; a printer that cannot do 6 clamps to its best and says nothing.
export const OKAY_D100 = { model: 'OKAY D100', widthMm: 100, heightMm: 150, gapMm: 2, dotsPerMm: 8, fit: 0.70, speed: 6, density: 10 };

/**
 * One phone, one printer (16 Nov 2026). Every person who prints labels gets the direct
 * Bluetooth road; the phone remembers its own printer, so the pairing is a phone's, not
 * a person's. The listed emails are kept for history; the role is what decides now.
 */
export const DIRECT_PRINTERS = {
  'kemas@treelogy.com': OKAY_D100,
  'agas@treelogy.com': OKAY_D100,
};
const PRINTING_ROLES = new Set(['owner', 'admin', 'operator', 'packer']);

export function directPrinterFor(user) {
  if (!user || (user.status && user.status !== 'active')) return null;
  const email = String(user.email ?? '').toLowerCase();
  if (DIRECT_PRINTERS[email]) return DIRECT_PRINTERS[email];
  return PRINTING_ROLES.has(user.role) ? OKAY_D100 : null;
}

/**
 * Who keeps the "Sambungkan printer" panel on the label page itself. The packers print
 * from their own page; everybody else prints to PDF or the bench (18 Nov) - except Agas,
 * who packs at the bench with the phone printer (18 Nov, the same afternoon).
 */
export const LABEL_PAGE_PANEL = new Set(['agas@treelogy.com']);
export const hasLabelPagePanel = (user) => LABEL_PAGE_PANEL.has(String(user?.email ?? '').toLowerCase());

/** Where the host frame starts: only a dashboard path, never the host itself. */
export const HOST_PATH = '/api/dashboard?view=printer';
export function safeGo(value, fallback = '/api/dashboard?view=labels') {
  const go = String(value ?? '');
  if (!/^\/api\/dashboard(\?[^#\s]*)?$/.test(go)) return fallback;
  if (/[?&]view=printer(&|$)/.test(go)) return fallback;
  return go;
}

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/*
 * The encoders below run in the browser - their source is sent with the page - and are
 * exported so the exact bytes can be checked here. Keep them self-contained: no imports,
 * no closures over module scope.
 */

/**
 * RGBA pixels to packed 1-bit rows, MSB first, `black` bits set for dark pixels.
 * Returns { bytes, widthBytes, height }.
 */
export function packMono(rgba, width, height, { threshold = 160, black = 1 } = {}) {
  const widthBytes = Math.ceil(width / 8);
  const bytes = new Uint8Array(widthBytes * height);
  if (!black) bytes.fill(0xff);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const alpha = rgba[i + 3] / 255;
      // Transparent counts as paper, not ink.
      const lum = (0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]) * alpha + 255 * (1 - alpha);
      if (lum < threshold) {
        const at = y * widthBytes + (x >> 3);
        const bit = 0x80 >> (x & 7);
        if (black) bytes[at] |= bit; else bytes[at] &= ~bit;
      }
    }
  }
  return { bytes, widthBytes, height };
}

const ascii = (text) => Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);
const join = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/**
 * The rows that carry ink, as [from, to) bands. `blank` is the byte value of a row with
 * no ink (0xff when 0 means black, as TSPL has it). Bands closer than `gap` rows are
 * merged, because a BITMAP header costs more than a few empty rows.
 */
export function inkBands(mono, { blank = 0xff, gap = 8 } = {}) {
  const { bytes, widthBytes, height } = mono;
  const bands = [];
  let start = -1;
  for (let y = 0; y < height; y += 1) {
    let ink = false;
    const row = y * widthBytes;
    for (let b = 0; b < widthBytes; b += 1) { if (bytes[row + b] !== blank) { ink = true; break; } }
    if (ink && start < 0) start = y;
    if (!ink && start >= 0) {
      const last = bands[bands.length - 1];
      if (last && start - last[1] < gap) last[1] = y; else bands.push([start, y]);
      start = -1;
    }
  }
  if (start >= 0) {
    const last = bands[bands.length - 1];
    if (last && start - last[1] < gap) last[1] = height; else bands.push([start, height]);
  }
  return bands;
}

/**
 * One TSPL label: the size, then one BITMAP per band of ink, then PRINT. TSPL's BITMAP
 * prints a dot where the bit is 0, so the image is packed with `black: 0`.
 */
export function tsplJob(mono, { widthMm = 100, heightMm = 150, gapMm = 2, rotate = false, blank = 0xff, speed = null, density = null } = {}) {
  const tuning = `${speed ? `SPEED ${speed}\r\n` : ''}${density ? `DENSITY ${density}\r\n` : ''}`;
  const parts = [ascii(`SIZE ${widthMm} mm,${heightMm} mm\r\nGAP ${gapMm} mm,0 mm\r\n${tuning}DIRECTION ${rotate ? 1 : 0}\r\nCLS\r\n`)];
  for (const [from, to] of inkBands(mono, { blank })) {
    parts.push(ascii(`BITMAP 0,${from},${mono.widthBytes},${to - from},0,`));
    parts.push(mono.bytes.subarray(from * mono.widthBytes, to * mono.widthBytes));
    parts.push(ascii('\r\n'));
  }
  parts.push(ascii('PRINT 1,1\r\n'));
  return join(parts);
}

/** The same image as ESC/POS raster (GS v 0), a dot where the bit is 1, then a feed. */
export function escposJob(mono) {
  const { widthBytes, height } = mono;
  return join([
    Uint8Array.of(0x1b, 0x40),
    Uint8Array.of(0x1d, 0x76, 0x30, 0x00, widthBytes & 0xff, widthBytes >> 8, height & 0xff, height >> 8),
    mono.bytes,
    Uint8Array.of(0x1b, 0x64, 0x03),
  ]);
}

/**
 * Where a page goes on the bitmap: scaled to `fit` of the label, centred across and
 * flush to the top - the way this printer enlarges it back. {x, y, scale} for a page
 * of `pageW`x`pageH` points.
 */
export function placePage(pageW, pageH, { width, height, fit = 1 }) {
  const scale = Math.min((width * fit) / pageW, (height * fit) / pageH);
  return { x: Math.round((width - pageW * scale) / 2), y: 0, scale };
}

/**
 * BLE services cheap thermal printers expose their write characteristic under. Web
 * Bluetooth only lets a page reach services it named up front, so the common ones are
 * all named; the first writable characteristic found is used.
 */
export const PRINTER_SERVICES = [
  '000018f0-0000-1000-8000-00805f9b34fb',
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  '0000fee7-0000-1000-8000-00805f9b34fb',
  '0000ae30-0000-1000-8000-00805f9b34fb',
  '0000af30-0000-1000-8000-00805f9b34fb',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
];

/**
 * How thermal printers tend to name themselves over Bluetooth. With the services above,
 * these narrow the phone's chooser to printers: "every device" listed the earbuds, the
 * phones and the TVs of the whole room, and with two identical D100s on the bench (18 Nov)
 * nobody could find theirs by trying them one by one. Case matters to the chooser.
 */
export const PRINTER_NAME_PREFIXES = ['D100', 'OKAY', 'Okay', 'Printer', 'PRINTER', 'printer', 'Thermal', 'Label', 'MPT', 'MTP', 'PT-', 'XP-', 'GP-', 'HM-', 'RPP', 'T58', 'P58'];

/* ------------------------------------------------------------------ the pages */

export const BLUEFY_STORE = 'https://apps.apple.com/app/id1492822055';

/**
 * Safari on iPhone has no Web Bluetooth and Apple has said it will not add it. The one
 * way in on iOS is Bluefy, a free browser built on Web Bluetooth. Pages say so plainly,
 * carry the link to the app, and try to hand the current address over to it.
 *
 * Runs in the browser; kept self-contained like the encoders.
 */
function noBluetoothNoticeFn() {
  return `function (mount) {
    var ua = navigator.userAgent || '';
    var ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var here = location.href;
    var esc = function (t) { return String(t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
    if (ios) {
      mount.innerHTML = '<p class="nb__p">Safari di iPhone tidak bisa Bluetooth. Buka halaman ini di aplikasi <b>Bluefy</b> (gratis), lalu sambungkan printer dari sana.</p>'
        + '<div class="nb__row"><a class="chip nb__a" href="bluefy://open?url=' + encodeURIComponent(here) + '">Buka di Bluefy</a>'
        + '<a class="chip nb__a" href="${BLUEFY_STORE}" target="_blank" rel="noopener">Pasang Bluefy</a>'
        + '<button class="chip" type="button" id="nb-copy">Salin tautan</button></div>'
        + '<p class="nb__p dim">Kalau tombol pertama tidak membuka apa-apa: salin tautan, buka Bluefy, tempel di kolom alamatnya.</p>';
      var copy = mount.querySelector('#nb-copy');
      copy.addEventListener('click', function () {
        var done = function () { copy.textContent = 'Tersalin'; setTimeout(function () { copy.textContent = 'Salin tautan'; }, 1500); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(here).then(done, function () { window.prompt('Salin tautan ini:', here); });
        else window.prompt('Salin tautan ini:', here);
      });
    } else {
      mount.innerHTML = '<p class="nb__p">Browser ini tidak mendukung Bluetooth. Gunakan Chrome di Android, atau Bluefy di iPhone.</p>';
    }
    return ios;
  }`;
}


/**
 * Put at the top of every dashboard page this person loads: once they have entered the
 * host on this phone, every later visit that lands outside it is moved inside, before
 * anything is drawn. Inside the frame (or on the host itself) it does nothing.
 */
/**
 * Which server drew a page: set once when the server starts. The host page never
 * navigates, so after a deploy it kept running the old printer bar (18 Nov: the new
 * "Semua perangkat" never showed). Every page inside the frame carries this; the host
 * compares and reloads itself once when the frame is newer.
 */
export const DP_BUILD = String(Date.now());

export function directPrintEnterScript() {
  return `window.__dpBuild=${JSON.stringify(DP_BUILD)};(function(){try{if(window.top!==window.self)return;if(/[?&]view=printer(&|$)/.test(location.search))return;
if(localStorage.getItem('dp.host')!=='1')return;
location.replace(${JSON.stringify(HOST_PATH)}+'&go='+encodeURIComponent(location.pathname+location.search));}catch(e){}})();`;
}

/**
 * The panel on the label page. Inside the host it is the print button and a mirror of
 * the host's status; outside it, it is the door into the host.
 */
export function directPrintPanel(printer, { escape = esc } = {}) {
  return `<section class="dp" id="dp" aria-label="Cetak langsung ke ${escape(printer.model)}">
    <div class="dp__head">
      <span class="dp__dot" id="dp-dot" aria-hidden="true"></span>
      <span class="dp__name">${escape(printer.model)}</span>
      <span class="dp__state" id="dp-state" role="status" aria-live="polite">Memeriksa printer…</span>
    </div>
    <button class="cta dp__go" type="button" id="dp-go" disabled>
      <span class="dp__go-label">Cetak langsung</span><span class="dp__go-n" id="dp-n"></span>
    </button>
    <div class="dp__bar" id="dp-bar" hidden><span id="dp-fill"></span></div>
    <div class="dp__tools"><button class="dp__link" type="button" id="dp-enter" hidden>Sambungkan printer</button></div>
    <div class="dp__nb" id="dp-nb" hidden></div>
  </section>`;
}

export const DIRECT_PRINT_CSS = `
.dp{margin:.75rem 0 1rem; padding:.9rem 1rem 1rem; border:1px solid var(--line); border-radius:12px; background:var(--panel-2)}
.dp__head{display:flex; flex-wrap:wrap; align-items:center; gap:.3rem .5rem; margin-bottom:.7rem; min-height:1.5rem}
.dp__dot{width:.6rem; height:.6rem; border-radius:50%; background:var(--dim); flex:none; transition:background .2s}
.dp__dot.is-busy{background:var(--warn)} .dp__dot.is-on{background:var(--good); box-shadow:0 0 8px var(--good)} .dp__dot.is-off{background:var(--bad)}
.dp__name{font-weight:600; white-space:nowrap}
.dp__state{color:var(--muted); font-size:.9rem; flex-basis:100%; padding-left:1.1rem}
.dp__go{width:100%; min-height:48px; justify-content:center; gap:.5rem; font-size:1.05rem; cursor:pointer}
.dp__go:disabled{opacity:.5; cursor:default}
.dp__go-n:not(:empty)::before{content:'· '}
.dp__bar{height:4px; margin:.6rem 0 0; border-radius:2px; background:var(--line); overflow:hidden}
.dp__bar span{display:block; height:100%; width:0; background:var(--good); transition:width .15s}
.dp__tools{display:flex; flex-wrap:wrap; align-items:center; gap:.25rem 1rem; margin-top:.4rem}
.dp__link{background:none; border:0; padding:.5rem 0; color:var(--muted); font:inherit; font-size:.9rem; cursor:pointer; text-decoration:underline; text-underline-offset:3px; text-decoration-color:transparent; transition:color .15s, text-decoration-color .15s}
.dp__link:hover, .dp__link:focus-visible{color:var(--fg); text-decoration-color:currentColor; outline:none}
.dp__nb{margin-top:.5rem} .nb__p{margin:.3rem 0; font-size:.9rem; color:var(--muted)} .nb__p b{color:var(--fg)}
.nb__row{display:flex; flex-wrap:wrap; gap:.4rem; margin:.5rem 0} .nb__a{text-decoration:none}
@media (prefers-reduced-motion: reduce){.dp__dot,.dp__bar span,.dp__link{transition:none}}
`;

/** The panel's script: talks to the host over postMessage, or leads into it. */
export function directPrintScript(printer) {
  return `
(function () {
  var box = document.getElementById('dp');
  var form = document.getElementById('lbform');
  if (!box) return;
  var $ = function (id) { return document.getElementById(id); };
  var dot = $('dp-dot'), state = $('dp-state'), goBtn = $('dp-go'), goN = $('dp-n'), bar = $('dp-bar'), fill = $('dp-fill'), enterBtn = $('dp-enter');
  var HOST = ${JSON.stringify(HOST_PATH)};
  var host = null, connected = false, busy = false, printing = null;

  function say(text, tone) { state.textContent = text; dot.className = 'dp__dot ' + (tone || ''); }
  function picked() { return form ? form.querySelectorAll('.pick:checked:not(:disabled):not([data-held])').length : 0; }
  function ready() {
    var n = picked();
    goN.textContent = n ? n + ' label' : '';
    goBtn.disabled = !connected || busy || n === 0;
  }
  if (form) { form.addEventListener('change', ready); new MutationObserver(ready).observe(form, { childList: true, subtree: true }); }
  function progress(frac) { bar.hidden = false; fill.style.width = Math.round(frac * 100) + '%'; }
  function progressOff() { bar.hidden = true; fill.style.width = '0'; }

  /* ---- outside the host: one tap leads in, and is remembered ---- */
  var noBluetoothNotice = ${noBluetoothNoticeFn()};
  function outside(reason) {
    connected = false;
    if (!navigator.bluetooth) {
      // No door to lead through: say what this phone can do instead.
      say('Bluetooth tidak tersedia di browser ini.', 'is-off');
      var nb = $('dp-nb'); nb.hidden = false; noBluetoothNotice(nb);
      enterBtn.hidden = true; ready(); return;
    }
    say(reason || 'Printer belum tersambung.', '');
    enterBtn.hidden = false; ready();
  }
  enterBtn.addEventListener('click', function () {
    try { localStorage.setItem('dp.host', '1'); } catch (e) {}
    window.top.location.href = HOST + '&go=' + encodeURIComponent(location.pathname + location.search);
  });

  /* ---- inside the host: mirror its state, hand it the labels ---- */
  var inFrame = false;
  try { inFrame = window.parent !== window && window.parent.location.origin === location.origin; } catch (e) { inFrame = false; }
  if (!inFrame) { outside(); return; }
  host = window.parent;
  var answered = false;
  window.addEventListener('message', function (e) {
    if (e.origin !== location.origin || !e.data || typeof e.data.type !== 'string') return;
    var m = e.data;
    if (m.type === 'dp:state') {
      answered = true; enterBtn.hidden = true;
      connected = !!m.connected; busy = !!m.busy;
      if (!busy) say(m.text || (connected ? 'Siap' : 'Ketuk Sambungkan di bilah atas.'), connected ? 'is-on' : (m.tone || ''));
      ready();
    } else if (m.type === 'dp:progress') {
      busy = true; say(m.text || 'Mengirim…', 'is-busy'); progress(m.frac || 0); ready();
    } else if (m.type === 'dp:done') {
      var job = printing;
      // Put on record only what the printer took: the server is told the verdict, and
      // a row turns "dicetak" only once that is written down.
      var verdict = job ? confirmPrint(job, !m.error, m.error) : Promise.resolve(null);
      if (m.error) {
        busy = false; progressOff(); printing = null;
        say('Gagal: ' + m.error + ' · label belum dicetak, coba lagi', 'is-off'); ready();
        return;
      }
      say('Mencatat…', 'is-busy');
      verdict.then(function (err) {
      busy = false; progressOff();
      if (err) { say('Label terkirim ke printer, tapi gagal dicatat: ' + err, 'is-off'); printing = null; ready(); return; }
      printing = job;
      {
        var failed = (printing && printing.failures) || [];
        say(m.pages + ' label terkirim' + (failed.length ? ' · ' + failed.length + ' gagal: ' + failed.map(function (f) { return f.id; }).join(', ') : ''), failed.length ? 'is-busy' : 'is-on');
        // The print is on record server-side; take the printed rows off the list here.
        ((printing && printing.orders) || []).forEach(function (v) {
          var id = v.slice(v.indexOf(':') + 1).toLowerCase();
          var row = form && form.querySelector('tr[data-id="' + id.replace(/"/g, '') + '"]');
          if (!row) return;
          var pick = row.querySelector('.pick');
          if (pick) { pick.checked = false; pick.disabled = true; }
          var note = row.querySelector('td:last-child');
          if (note && !failed.some(function (f) { return String(f.id).toLowerCase() === id; })) note.innerHTML = '<span class="ok">dicetak langsung</span>';
        });
        if (form) form.dispatchEvent(new Event('change'));
      }
      printing = null; ready();
      });
    }
  });
  async function confirmPrint(job, ok, error) {
    var body = new URLSearchParams();
    body.set('csrf', form ? (form.elements.csrf && form.elements.csrf.value) || '' : '');
    body.set('format', 'confirm'); body.set('ticket', job.ticket || ''); body.set('ok', ok ? '1' : '0');
    if (error) body.set('error', String(error).slice(0, 200));
    job.orders.forEach(function (o) { body.append('order', o); });
    for (var t = 0; t < 3; t++) {
      try {
        var r = await fetch('/api/labels', { method: 'POST', body: body, credentials: 'same-origin' });
        if (r.ok) return null;
        var o = await r.json().catch(function () { return {}; });
        if (r.status < 500) return o.error || ('HTTP ' + r.status);
      } catch (e) {}
      await new Promise(function (res) { setTimeout(res, 800 * (t + 1)); });
    }
    return 'server tidak menjawab';
  }
  host.postMessage({ type: 'dp:hello' }, location.origin);
  setTimeout(function () { if (!answered) outside(); }, 1500);

  goBtn.addEventListener('click', async function () {
    if (!form || busy || !connected) return;
    // Enough on the shelf for what is ticked, or the person picks what goes (stockCheckKit).
    if (window.treelogyStockCheck && !(await window.treelogyStockCheck('print')).ok) return;
    var body = new URLSearchParams(new FormData(form));
    // A parcel handed to a packer is theirs to print: ticked for Tugaskan/Lepas, never sent.
    var heldKeys = Array.prototype.map.call(form.querySelectorAll('.pick[data-held]'), function (p) { return p.value; });
    var keep = body.getAll('order').filter(function (v) { return heldKeys.indexOf(v) < 0; });
    body.delete('order'); keep.forEach(function (v) { body.append('order', v); });
    // Rendered on the server, in the printer's own language: the phone only sends bytes.
    body.set('format', 'tspl');
    var orders = body.getAll('order');
    if (!orders.length) { say('Centang pesanan dulu.', 'is-on'); return; }
    busy = true; ready();
    try {
      say('Menyiapkan ' + orders.length + ' label…', 'is-busy'); progress(0);
      var res = await fetch('/api/labels', { method: 'POST', body: body, credentials: 'same-origin' });
      var out = await res.json();
      if (!res.ok) throw new Error(out.error || ('HTTP ' + res.status));
      if (!out.pages || !out.pages.length) throw new Error((out.failures && out.failures[0] && out.failures[0].reason) || 'label tidak tersedia');
      printing = { orders: orders, failures: out.failures || [], ticket: out.ticket || '' };
      host.postMessage({ type: 'dp:print', tspl: out.pages }, location.origin);
    } catch (e) {
      busy = false; progressOff(); say('Gagal: ' + e.message, 'is-off'); ready();
    }
  });
  ready();
})();
`;
}

/**
 * The host: a bar that owns the printer, and the dashboard in a frame under it. The
 * bar never navigates, so the Bluetooth link outlives every page the frame moves to.
 */
export function directPrintHostPage({ printer, go, escape = esc }) {
  const start = safeGo(go);
  return `<!doctype html><html lang="id"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Treelogy</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<meta name="theme-color" content="#141B19">
<style>
:root{--bg:#141B19; --fg:#F1F3EE; --muted:#A7B3A6; --dim:#839187; --line:#2C3934; --good:#6FBF8B; --warn:#E2B252; --bad:#E08573; --cta:#C2531C}
@media (prefers-color-scheme: light){:root{--bg:#F3F4EF; --fg:#161E1B; --muted:#4F5C56; --dim:#7B877F; --line:#DADFD3; --good:#2F7D4F; --warn:#8A5A12; --bad:#A8412E}}
html,body{height:100%; margin:0; background:var(--bg); color:var(--fg); font:15px/1.4 Inter,system-ui,-apple-system,sans-serif}
body{display:flex; flex-direction:column}
.bar{display:flex; align-items:center; gap:.6rem; padding:.45rem .9rem; border-bottom:1px solid var(--line); min-height:44px; flex:none}
.dot{width:.6rem; height:.6rem; border-radius:50%; background:var(--dim); flex:none; transition:background .2s}
.dot.is-busy{background:var(--warn)} .dot.is-on{background:var(--good); box-shadow:0 0 8px var(--good)} .dot.is-off{background:var(--bad)}
.name{font-weight:600; white-space:nowrap}
.state{color:var(--muted); font-size:.9rem; min-width:0; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.btn{min-height:36px; padding:0 .9rem; border-radius:999px; border:1px solid var(--line); background:transparent; color:var(--fg); font:inherit; font-size:.9rem; cursor:pointer; white-space:nowrap}
.btn:hover,.btn:focus-visible{border-color:var(--fg); outline:none}
.btn:disabled{opacity:.5; cursor:default}
.btn--go{background:var(--cta); border-color:var(--cta); color:#fff; font-weight:600}
.leave{color:var(--muted); font-size:.85rem; text-decoration:underline; text-underline-offset:3px; white-space:nowrap; background:none; border:0; padding:0; cursor:pointer; font-family:inherit}
.prog{height:3px; background:var(--line); flex:none}
.prog span{display:block; height:100%; width:0; background:var(--good); transition:width .15s}
iframe{flex:1; width:100%; border:0; background:var(--bg)}
.nb{padding:.6rem .9rem; border-bottom:1px solid var(--line); font-size:.9rem} .nb__p{margin:.3rem 0; color:var(--muted)} .nb__p b{color:var(--fg)}
.nb__row{display:flex; flex-wrap:wrap; gap:.4rem; margin:.5rem 0}
.chip{display:inline-flex; align-items:center; min-height:36px; padding:0 .9rem; border-radius:999px; border:1px solid var(--line); background:transparent; color:var(--fg); font:inherit; font-size:.9rem; cursor:pointer; text-decoration:none}
@media (max-width:480px){.name{display:none} .bar{flex-wrap:wrap; gap:.4rem .6rem; padding:.5rem .8rem} .state{flex:1 1 calc(100% - 1.4rem)}}
@supports (height: 100dvh){html,body{height:100dvh}}
@media (prefers-reduced-motion: reduce){.dot,.prog span{transition:none}}
</style>
</head><body>
<div class="bar" role="region" aria-label="Printer">
  <span class="dot" id="dot" aria-hidden="true"></span>
  <span class="name">${escape(printer.model)}</span>
  <span class="state" id="state" role="status" aria-live="polite">Mencari printer…</span>
  <button class="btn" type="button" id="test" hidden title="Cetak penanda di printer yang tersambung">Tes</button>
  <button class="btn btn--go" type="button" id="connect">Sambungkan</button>
  <button class="leave" type="button" id="leave" title="Keluar dari mode printer">Keluar</button>
</div>
<div class="prog" id="prog" hidden><span id="fill"></span></div>
<div class="nb" id="nb" hidden></div>
<iframe id="frame" src="${escape(start)}" title="Dashboard Treelogy"></iframe>
<script>${hostScript(printer)}</script>
</body></html>`;
}

/** The host's script: the printer, the frame, and the messages between them. */
export function hostScript(printer) {
  return `
(function () {
  var printer = ${JSON.stringify(printer)};
  var SERVICES = ${JSON.stringify(PRINTER_SERVICES)};
  var NAMES = ${JSON.stringify(PRINTER_NAME_PREFIXES)};
  var HOST = ${JSON.stringify(HOST_PATH)};
  var BUILD = ${JSON.stringify(DP_BUILD)};
  var packMono = ${packMono.toString()};
  var ascii = ${ascii.toString()};
  var join = ${join.toString()};
  var inkBands = ${inkBands.toString()};
  var tsplJob = ${tsplJob.toString()};
  var placePage = ${placePage.toString()};

  var $ = function (id) { return document.getElementById(id); };
  var dot = $('dot'), state = $('state'), connectBtn = $('connect'), testBtn = $('test'), leaveBtn = $('leave'), frame = $('frame'), prog = $('prog'), fill = $('fill');
  var store = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
                set: function (k, v) { try { localStorage.setItem(k, String(v)); } catch (e) {} },
                del: function (k) { try { localStorage.removeItem(k); } catch (e) {} } };
  var prefs = { chunk: Number(store.get('dp.chunk')) || 0, device: store.get('dp.device') || '', fit: printer.fit || 1,
                svc: store.get('dp.svc') || '', chr: store.get('dp.chr') || '' };
  var device = null, ch = null, busy = false, lastText = '', lastTone = '';
  /*
   * One phone, one printer: the link is kept, not lent out. It is opened once and held
   * for as long as this page is open; a printer that naps or a phone that locks drops it,
   * and it is taken back quietly - on the drop itself and whenever the page is looked at
   * again - so the next press finds it already there.
   */
  var releasing = false;
  function usable() { return !!device; }
  function holdThenRelease() {}
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && device && !(ch && device.gatt.connected)) { linkTry = 0; keepLink(device); }
  });
  window.addEventListener('pagehide', function () { releasing = true; try { if (device && device.gatt.connected) device.gatt.disconnect(); } catch (e) {} });

  /* ---- the frame: keep the address bar honest, and the page's title ---- */
  function framePath() {
    try { var l = frame.contentWindow.location; return l.pathname + l.search; } catch (e) { return null; }
  }
  frame.addEventListener('load', function () {
    var path = framePath();
    if (path) history.replaceState(null, '', HOST + '&go=' + encodeURIComponent(path));
    // A page from a newer server than this bar: the bar reloads itself (once per server),
    // onto the same page, and finds its printer again on its own (resume).
    try {
      var drawn = frame.contentWindow.__dpBuild;
      if (drawn && drawn !== BUILD && !busy && sessionStorage.getItem('dp.reloadedFor') !== drawn) {
        sessionStorage.setItem('dp.reloadedFor', drawn);
        location.reload();
        return;
      }
    } catch (e) {}
    try { document.title = frame.contentDocument.title || 'Treelogy'; } catch (e) {}
    tell();
  });
  leaveBtn.addEventListener('click', function () {
    store.del('dp.host');
    if (device && device.gatt.connected) device.gatt.disconnect();
    location.href = framePath() || '/api/dashboard?view=labels';
  });

  /* ---- status, shown here and mirrored into the frame ---- */
  function say(text, tone) { lastText = text; lastTone = tone || ''; state.textContent = text; dot.className = 'dot ' + lastTone; }
  function tell() {
    try { frame.contentWindow.postMessage({ type: 'dp:state', connected: usable(), live: !!ch, busy: busy, text: lastText, tone: lastTone, name: device ? (device.name || printer.model) : '' }, location.origin); } catch (e) {}
  }
  function ready() {
    connectBtn.textContent = usable() ? 'Ganti' : 'Sambungkan'; connectBtn.disabled = busy; connectBtn.classList.toggle('btn--go', !usable());
    testBtn.hidden = !(ch && device && device.gatt.connected); testBtn.disabled = busy;
    tell();
  }
  function progress(frac, text) {
    prog.hidden = false; fill.style.width = Math.round(frac * 100) + '%';
    if (text) say(text, 'is-busy');
    try { frame.contentWindow.postMessage({ type: 'dp:progress', frac: frac, text: text || lastText }, location.origin); } catch (e) {}
  }
  function progressOff() { prog.hidden = true; fill.style.width = '0'; }

  var noBluetoothNotice = ${noBluetoothNoticeFn()};
  if (!navigator.bluetooth) {
    say('Bluetooth tidak tersedia di browser ini.', 'is-off'); connectBtn.disabled = true;
    var nb = $('nb'); nb.hidden = false; noBluetoothNotice(nb);
  }

  /* ---- connection ---- */
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  /*
   * One phone, one printer (18 Nov: two D100s on the bench, one for each phone). The
   * phone remembers its own printer and only ever reaches for that one - never the other
   * phone's, even when its own is off - so the two never take each other's. "Ganti"
   * picks a different printer and that one becomes this phone's.
   */
  function wire(dev) {
    device = dev;
    if (dev._dpWired) return;
    dev._dpWired = true;
    dev.addEventListener('gattserverdisconnected', function () {
      if (dev !== device) return;
      ch = null;
      // Let go on purpose: nothing to chase. Dropped mid-print: get it back now.
      if (releasing) { releasing = false; ready(); return; }
      // Taken back at once, quietly, and kept being taken back: the next press should
      // find the link already open.
      say('Menyambung ulang ke ' + (dev.name || printer.model) + '…', 'is-busy'); ready();
      if (!busy) { linkTry = 0; keepLink(dev); }
    });
  }
  /*
   * Once connected, connected for good. A printer that naps, a phone that locks, a
   * walk out of range: the link drops, and this keeps reaching for it - at once, then
   * every few seconds, never more than ten apart - until it is back. It does not give
   * up and ask for a tap; it says it is still trying. Paused while the page is hidden
   * (and resumed the moment it is looked at), and never while a print holds the link.
   */
  var linkTimer = null, linkTry = 0, linkSince = 0, linking = null;
  function keepLink(dev) {
    if (linkTimer || releasing || !dev) return;
    if (!linkSince) linkSince = Date.now();
    var wait = linkTry === 0 ? 0 : Math.min(10000, 1000 * Math.pow(2, Math.min(linkTry - 1, 4)));
    linkTimer = setTimeout(function () {
      linkTimer = null;
      if (ch && dev.gatt.connected) { linkTry = 0; linkSince = 0; return; }
      if (document.hidden) return;
      if (busy) { keepLink(dev); return; }
      attach(dev, 1).then(function () { linkTry = 0; linkSince = 0; }, function () {
        linkTry += 1;
        var long = Date.now() - linkSince > 20000;
        say(long ? 'Printer HP ini (' + (dev.name || printer.model) + ') tidak terjangkau · pastikan menyala & dekat · terus mencoba…' : 'Menyambung ulang ke ' + (dev.name || printer.model) + '…', long ? 'is-off' : 'is-busy');
        ready(); keepLink(dev);
      });
    }, wait);
  }
  // One attempt at a time: the keeper and a print reaching for the link share it.
  function attach(dev, tries) {
    if (linking) return linking;
    linking = attachNow(dev, tries).then(function (v) { linking = null; return v; }, function (e) { linking = null; throw e; });
    return linking;
  }
  async function attachNow(dev, tries) {
    var server = null, err = null;
    for (var t = 0; t < (tries || 1) && !server; t++) {
      try { server = await dev.gatt.connect(); } catch (e) { err = e; await sleep(600 * (t + 1)); }
    }
    if (!server) throw err || new Error('tidak tersambung');
    // The way in this printer showed last time, asked for directly: two round trips
    // instead of walking every service and characteristic it has.
    ch = null;
    if (prefs.svc && prefs.chr) {
      try {
        var known = await (await server.getPrimaryService(prefs.svc)).getCharacteristic(prefs.chr);
        if (known.properties.writeWithoutResponse || known.properties.write) ch = known;
      } catch (e) { ch = null; }
    }
    if (ch) { store.set('dp.device', dev.id); prefs.device = dev.id; if (dev.name) store.set('dp.name', dev.name); say('Siap · ' + (dev.name || printer.model), 'is-on'); ready(); return; }
    // Listing every service needs no argument in Chrome; implementations that insist on
    // one are asked for each known printer service in turn.
    var services = [];
    try { services = await server.getPrimaryServices(); } catch (e) {}
    if (!services.length) {
      for (var u = 0; u < SERVICES.length; u++) { try { services.push(await server.getPrimaryService(SERVICES[u])); } catch (e) {} }
    }
    ch = null;
    for (var s = 0; s < services.length && !ch; s++) {
      var chars = await services[s].getCharacteristics();
      for (var c = 0; c < chars.length; c++) {
        if (chars[c].properties.writeWithoutResponse || chars[c].properties.write) { ch = chars[c]; break; }
      }
    }
    if (!ch) throw new Error('printer tersambung tapi tidak ada jalur tulis Bluetooth (BLE) yang dikenal');
    // This printer is now this phone's: the next opening reaches for it, and only it.
    store.set('dp.device', dev.id); prefs.device = dev.id; if (dev.name) store.set('dp.name', dev.name);
    try { prefs.svc = ch.service.uuid; prefs.chr = ch.uuid; store.set('dp.svc', prefs.svc); store.set('dp.chr', prefs.chr); } catch (e) {}
    say('Siap · ' + (dev.name || printer.model), 'is-on'); ready();
  }
  // The link for a print: taken if it is not held, waiting out another phone's turn.
  async function hold() {
    if (ch && device && device.gatt.connected) return;
    if (!device) throw new Error('printer belum dipilih - ketuk Sambungkan di bilah atas');
    say('Menyambung ke printer…', 'is-busy'); ready();
    try { await attach(device, 4); }
    catch (e) { linkTry = 1; keepLink(device); throw new Error('printer mati atau di luar jangkauan - nyalakan, lalu coba lagi'); }
  }
  /*
   * The chooser lists printers only (18 Nov): anything offering a printer service, or
   * named the way printers name themselves, or named like the printer this phone had
   * before. Nothing else in the room is offered - no list of everything to dig through.
   */
  function chooser() {
    var filters = SERVICES.map(function (u) { return { services: [u] }; });
    var mine = store.get('dp.name');
    NAMES.concat(mine ? [mine] : []).forEach(function (n) { if (n) filters.push({ namePrefix: String(n) }); });
    return { filters: filters, optionalServices: SERVICES };
  }
  async function choose() {
    say('Pilih printer di daftar…', 'is-busy');
    var dev = await navigator.bluetooth.requestDevice(chooser());
    wire(dev);
    // A different printer: forget what the last one taught.
    if (dev.id !== prefs.device) { prefs.chunk = 0; store.set('dp.chunk', 0); prefs.svc = ''; prefs.chr = ''; store.del('dp.svc'); store.del('dp.chr'); }
    await attach(dev, 1);
  }
  // Without a tap, where Chrome hands back devices this origin was allowed before.
  async function resume() {
    if (!navigator.bluetooth) return;
    if (!prefs.device || !navigator.bluetooth.getDevices) { say('Ketuk Sambungkan untuk memilih printer.', ''); ready(); return; }
    try {
      var known = (await navigator.bluetooth.getDevices()).filter(function (d) { return d.id === prefs.device; })[0];
      if (!known) { say('Ketuk Sambungkan untuk memilih printer.', ''); ready(); return; }
      say('Menyambung ke ' + (known.name || printer.model) + '…', 'is-busy'); ready();
      wire(known);
      try { await attach(known, 2); return; } catch (e) {}
      // Not there yet: keep reaching for it, and jump the queue the moment it is heard.
      if (known.watchAdvertisements) {
        known.addEventListener('advertisementreceived', function () {
          if (ch && known.gatt.connected) return;
          if (linkTimer) { clearTimeout(linkTimer); linkTimer = null; }
          linkTry = 0; keepLink(known);
        });
        known.watchAdvertisements().catch(function () {});
      }
      linkTry = 1; keepLink(known);
      say('Menyambung ulang ke ' + (known.name || printer.model) + '…', 'is-busy');
    } catch (e) { say('Ketuk Sambungkan untuk memilih printer.', ''); }
    ready();
  }
  connectBtn.addEventListener('click', function () {
    if (linkTimer) { clearTimeout(linkTimer); linkTimer = null; }
    if (device && device.gatt.connected) { releasing = true; device.gatt.disconnect(); }
    choose().catch(function (e) {
      ch = null;
      // Closed without a pick - often because the printer was not in the list: say why.
      if (e.name === 'NotFoundError') say('Printer tidak ada di daftar? Pastikan menyala, dekat HP, dan tidak sedang tersambung ke HP lain.', 'is-off');
      else say('Gagal menyambung: ' + e.message, 'is-off');
      ready();
    });
  });

  /*
   * "Which of the two is mine?" Two printers of the same model look the same in the list
   * and on the bench. Tes prints a short slip on the printer this phone holds - its
   * Bluetooth name in big letters - so the one that speaks is the one connected.
   */
  testBtn.addEventListener('click', async function () {
    if (busy || !device) return;
    busy = true; ready();
    try {
      await hold();
      var c = blankCanvas(), ctx = c.getContext('2d');
      var name = device.name || printer.model;
      ctx.fillStyle = '#000'; ctx.textBaseline = 'top';
      ctx.font = 'bold 76px sans-serif'; ctx.fillText('PRINTER INI', 40, 40);
      ctx.font = 'bold 56px sans-serif'; ctx.fillText(name, 40, 140);
      ctx.font = '40px sans-serif'; ctx.fillText('tersambung ke HP ini', 40, 220);
      ctx.font = '32px sans-serif'; ctx.fillText(new Date().toLocaleString('id-ID'), 40, 285);
      await send(job(c), function (f) { progress(f, 'Tes cetak…'); });
      progressOff(); say('Tes terkirim · ' + name, 'is-on');
    } catch (e) { progressOff(); say('Tes gagal: ' + e.message, 'is-off'); }
    busy = false; ready();
  });

  /* ---- transfer ----
   *
   * Two kinds of link. Chrome on Android negotiates a large MTU and its write-without-
   * response has real back-pressure, so the biggest packet it takes is probed once and
   * remembered, and nothing waits. Everywhere else (Bluefy on iPhone, 13 Nov 2026) a
   * write-without-response bigger than the link's limit is dropped without a word: the
   * probe "succeeded" at 244 bytes, every packet vanished, and the page said "terkirim"
   * to a printer that had heard nothing. So outside Chrome Android each packet is
   * written WITH a response - the printer acknowledges it or the write fails - and the
   * size steps down on failure. Only when the printer offers no acknowledged write at
   * all is write-without-response used, at the 20 bytes every link carries.
   */
  var careful = !(window.chrome && /Android/.test(navigator.userAgent || ''));
  var quick = function () { return !!(ch.properties.writeWithoutResponse && typeof ch.writeValueWithoutResponse === 'function'); };
  var acked = function () { return !!(ch.properties.write && typeof ch.writeValue === 'function'); };
  function plan() {
    if (!careful) return { resp: !quick(), sizes: [244, 180, 120, 60, 20], remember: true };
    if (acked()) return { resp: true, sizes: [180, 100, 20], remember: false };
    return { resp: false, sizes: [20], remember: false };
  }
  // A fresh ArrayBuffer of exactly these bytes: a view with an offset is handed to some
  // implementations as its whole underlying buffer, and a bridged one may not take a view.
  async function writeChunk(part, resp) {
    var buf = part.slice(0).buffer;
    if (resp) await ch.writeValue(buf); else await ch.writeValueWithoutResponse(buf);
  }
  var sessionChunk = 0;
  async function probeChunk(p) {
    var known = p.remember ? prefs.chunk : sessionChunk;
    if (known) return known;
    var size = p.sizes[p.sizes.length - 1];
    for (var i = 0; i < p.sizes.length; i++) {
      try { await writeChunk(ascii('\\r\\n'.padEnd(p.sizes[i], ' ')), p.resp); size = p.sizes[i]; break; } catch (e) {}
    }
    if (p.remember) { prefs.chunk = size; store.set('dp.chunk', size); } else sessionChunk = size;
    return size;
  }
  async function send(bytes, onProgress) {
    var p = plan();
    var size = await probeChunk(p);
    for (var at = 0; at < bytes.length; at += size) {
      try { await writeChunk(bytes.subarray(at, at + size), p.resp); }
      catch (e) {
        var smaller = p.sizes.filter(function (s) { return s < size; })[0];
        if (!smaller) throw e;
        size = smaller;
        if (p.remember) { prefs.chunk = size; store.set('dp.chunk', size); } else sessionChunk = size;
        await sleep(50); at -= size; continue;
      }
      if (!p.resp && !careful && ((at / size) & 3) === 3) await sleep(2);
      if (onProgress) onProgress(Math.min(1, (at + size) / bytes.length));
    }
  }

  /* ---- image to job ---- */
  function blankCanvas() {
    var c = document.createElement('canvas');
    c.width = printer.widthMm * printer.dotsPerMm; c.height = printer.heightMm * printer.dotsPerMm;
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    return c;
  }
  function job(canvas) {
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    var px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    var mono = packMono(px, canvas.width, canvas.height, { black: 0 });
    return tsplJob(mono, { widthMm: printer.widthMm, heightMm: printer.heightMm, gapMm: printer.gapMm, blank: 0xff, speed: printer.speed || null, density: printer.density || null });
  }
  var pdfjsPromise = null;
  function pdfjsLoad() { return pdfjsPromise || (pdfjsPromise = new Promise(function (resolve, reject) {
    var tag = document.createElement('script');
    tag.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    tag.onload = function () {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      resolve(window.pdfjsLib);
    };
    tag.onerror = function () { reject(new Error('pembaca PDF gagal dimuat')); };
    document.head.appendChild(tag);
  })); }
  async function renderPages(base64) {
    var lib = await pdfjsLoad();
    var raw = atob(base64), data = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i);
    var doc = await lib.getDocument({ data: data }).promise;
    var canvases = [];
    for (var p = 1; p <= doc.numPages; p++) {
      var page = await doc.getPage(p);
      var base = page.getViewport({ scale: 1 });
      var canvas = blankCanvas();
      var at = placePage(base.width, base.height, { width: canvas.width, height: canvas.height, fit: prefs.fit });
      var ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.save(); ctx.translate(at.x, at.y);
      await page.render({ canvasContext: ctx, viewport: page.getViewport({ scale: at.scale }) }).promise;
      ctx.restore();
      canvases.push(canvas);
    }
    return canvases;
  }

  /* ---- what the pages ask for ---- */
  function fromBase64(b64) {
    var raw = atob(b64), out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  // Pages the server already rendered into TSPL go straight to the printer; nothing is
  // drawn on the phone. PDFs are the old road, kept for a server that sends them.
  async function print(groups, tspl) {
    await hold();
    var jobs;
    if (tspl && tspl.length) jobs = tspl.map(fromBase64);
    else {
      var canvases = [];
      for (var g = 0; g < (groups || []).length; g++) canvases = canvases.concat(await renderPages(groups[g]));
      jobs = canvases.map(job);
    }
    var total = jobs.reduce(function (s, j) { return s + j.length; }, 0), sent = 0;
    for (var j = 0; j < jobs.length; j++) {
      var before = sent;
      await send(jobs[j], function (f) { progress((before + f * jobs[j].length) / total, 'Mengirim ' + (j + 1) + '/' + jobs.length + '…'); });
      sent += jobs[j].length;
    }
    // Honest about the end, too: a link that dropped while the last packets were in
    // flight did not print them, whatever the writes said.
    if (device && device.gatt && !device.gatt.connected) throw new Error('sambungan ke printer terputus sebelum label selesai terkirim');
    return jobs.length;
  }
  window.addEventListener('message', async function (e) {
    if (e.origin !== location.origin || !e.data || typeof e.data.type !== 'string') return;
    var m = e.data, reply = function (msg) { try { e.source.postMessage(msg, location.origin); } catch (err) {} };
    if (m.type === 'dp:hello') { tell(); return; }
    // "Pilih printer" pressed inside the page: the tap there activates this frame too, so
    // the chooser opens here, where the link lives.
    if (m.type === 'dp:choose') { if (!busy && navigator.bluetooth) connectBtn.click(); else tell(); return; }
    if (m.type !== 'dp:print') return;
    // A second press while the first is still sending waits its turn, it is not refused.
    queue = queue.then(async function () {
      busy = true; ready();
      try {
        progress(0, 'Mengirim ke printer…');
        var pages = await print(m.groups || [], m.tspl || null);
        say('Siap · ' + (device.name || printer.model) + ' · ' + pages + ' label terkirim', 'is-on');
        reply({ type: 'dp:done', pages: pages, id: m.id || null });
      } catch (err) {
        say('Gagal: ' + err.message, 'is-off');
        reply({ type: 'dp:done', error: err.message, id: m.id || null });
      } finally { busy = false; progressOff(); ready(); }
    });
  });
  var queue = Promise.resolve();

  ready();
  resume();
})();
`;
}

/* ------------------------------------------------------------ the bench queue */

/**
 * The panel when the bench has an agent: the printer belongs to nobody's phone, labels
 * are rendered on the server and queued, and the agent on the bench laptop prints them.
 * Shown to everyone who can print; "online" means the agent asked within the last
 * minute and a half.
 */
export function benchPanel(bench, { escape = esc } = {}) {
  const online = Boolean(bench?.online);
  const waiting = (bench?.pending ?? 0) + (bench?.printing ?? 0);
  const seen = bench?.seenAt ? new Date(bench.seenAt).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' }) : '';
  const state = online
    ? (waiting ? `Siap · ${waiting} antri` : 'Siap')
    : `Agen printer tidak aktif${seen ? ` · terakhir ${seen} WIB` : ''}`;
  return `<section class="dp" id="bp" aria-label="Printer gudang" data-online="${online ? 1 : 0}">
    <div class="dp__head">
      <span class="dp__dot ${online ? 'is-on' : 'is-off'}" id="bp-dot" aria-hidden="true"></span>
      <span class="dp__name">Printer gudang</span>
      <span class="dp__state" id="bp-state" role="status" aria-live="polite">${escape(state)}</span>
    </div>
    <button class="cta dp__go" type="button" id="bp-go" disabled>
      <span class="dp__go-label">Cetak langsung</span><span class="dp__go-n" id="bp-n"></span>
    </button>
    <div class="dp__bar" id="bp-bar" hidden><span id="bp-fill"></span></div>
  </section>`;
}

/** The panel's script: send the ticked labels to the queue, then watch them print. */
export function benchScript() {
  return `
(function () {
  var box = document.getElementById('bp');
  var form = document.getElementById('lbform');
  if (!box) return;
  var $ = function (id) { return document.getElementById(id); };
  var dot = $('bp-dot'), state = $('bp-state'), goBtn = $('bp-go'), goN = $('bp-n'), bar = $('bp-bar'), fill = $('bp-fill');
  var online = box.getAttribute('data-online') === '1', busy = false;

  function say(text, tone) { state.textContent = text; dot.className = 'dp__dot ' + (tone || ''); }
  function picked() { return form ? form.querySelectorAll('.pick:checked:not(:disabled):not([data-held])').length : 0; }
  function ready() {
    var n = picked();
    goN.textContent = n ? n + ' label' : '';
    goBtn.disabled = !online || busy || n === 0;
  }
  if (form) { form.addEventListener('change', ready); new MutationObserver(ready).observe(form, { childList: true, subtree: true }); }
  function progress(frac) { bar.hidden = false; fill.style.width = Math.round(frac * 100) + '%'; }
  function progressOff() { bar.hidden = true; fill.style.width = '0'; }
  function stamp(at) { try { return new Date(at).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }

  async function snapshot() {
    var res = await fetch(location.pathname + '?view=labels&bench=1', { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }
  function show(b) {
    online = !!b.online;
    if (busy) return;
    var waiting = (b.pending || 0) + (b.printing || 0);
    say(online ? (waiting ? 'Siap · ' + waiting + ' antri' : 'Siap') : ('Agen printer tidak aktif' + (b.seenAt ? ' · terakhir ' + stamp(b.seenAt) + ' WIB' : '')), online ? 'is-on' : 'is-off');
    ready();
  }
  // The bench's pulse, read while the page is open; nothing is sent when it is hidden.
  setInterval(function () { if (!document.hidden) snapshot().then(show).catch(function () {}); }, 10000);

  function markPrinted(orders, failures) {
    orders.forEach(function (v) {
      var id = v.slice(v.indexOf(':') + 1).toLowerCase();
      var row = form && form.querySelector('tr[data-id="' + id.replace(/"/g, '') + '"]');
      if (!row) return;
      var pick = row.querySelector('.pick');
      if (pick) { pick.checked = false; pick.disabled = true; }
      var note = row.querySelector('td:last-child');
      if (note && !failures.some(function (f) { return String(f.id).toLowerCase() === id; })) note.innerHTML = '<span class="ok">dicetak di gudang</span>';
    });
    if (form) form.dispatchEvent(new Event('change'));
  }

  goBtn.addEventListener('click', async function () {
    if (!form || busy || !online) return;
    // Enough on the shelf for what is ticked, or the person picks what goes (stockCheckKit).
    if (window.treelogyStockCheck && !(await window.treelogyStockCheck('print')).ok) return;
    var body = new URLSearchParams(new FormData(form));
    // A parcel handed to a packer is theirs to print: ticked for Tugaskan/Lepas, never sent.
    var heldKeys = Array.prototype.map.call(form.querySelectorAll('.pick[data-held]'), function (p) { return p.value; });
    var keep = body.getAll('order').filter(function (v) { return heldKeys.indexOf(v) < 0; });
    body.delete('order'); keep.forEach(function (v) { body.append('order', v); });
    body.set('format', 'queue');
    var orders = body.getAll('order');
    if (!orders.length) { say('Centang pesanan dulu.', 'is-on'); return; }
    busy = true; ready();
    try {
      say('Menyiapkan ' + orders.length + ' label…', 'is-busy'); progress(0.1);
      var res = await fetch('/api/labels', { method: 'POST', body: body, credentials: 'same-origin' });
      var out = await res.json();
      if (!res.ok) throw new Error(out.error || ('HTTP ' + res.status));
      var failures = out.failures || [];
      say(out.pages + ' label masuk antrian…', 'is-busy'); progress(0.3);
      // Watch the job until the bench says it printed. Three minutes is far longer than
      // any print; after that the agent's reclaim rule takes over and the page lets go.
      var started = Date.now(), status = 'pending';
      while (Date.now() - started < 180000) {
        // Quick looks while it is live: a label is on paper within a second or two.
        await new Promise(function (r) { setTimeout(r, Date.now() - started < 15000 ? 400 : 1500); });
        var b = await snapshot().catch(function () { return null; });
        if (!b) continue;
        var job = (b.recent || []).filter(function (j) { return j.id === out.jobId; })[0];
        if (!job) continue;
        status = job.status;
        if (status === 'printing') { say('Sedang dicetak…', 'is-busy'); progress(0.7); }
        if (status === 'done' || status === 'failed') { if (status === 'failed') throw new Error(job.error || 'printer gagal'); break; }
      }
      if (status !== 'done') throw new Error('belum ada kabar dari agen printer - cek laptop di meja packing');
      say(out.pages + ' label dicetak' + (failures.length ? ' · ' + failures.length + ' gagal disiapkan: ' + failures.map(function (f) { return f.id; }).join(', ') : ''), failures.length ? 'is-busy' : 'is-on');
      markPrinted(orders, failures);
    } catch (e) {
      say('Gagal: ' + e.message, 'is-off');
    } finally { busy = false; progressOff(); ready(); }
  });
  ready();
})();
`;
}
