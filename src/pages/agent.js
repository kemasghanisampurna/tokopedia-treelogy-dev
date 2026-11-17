import { shell, svg, escape } from '../dashboard-page.js';
import { can } from '../users.js';
import { KINDS, VARIANT_MAP, itemStatus, rupiahText, giftsFor } from '../agent/catalog.js';

/**
 * The AI Agent tab: what the WhatsApp bot on Qontak is allowed to say about prices and
 * offers, and the one place the team changes it.
 *
 * Left is what people edit - free shipping, promos, vouchers, gifts - each with where it
 * stands today in WITA. Right is exactly what the bot receives on its next call, built by
 * the same function the endpoint uses, so "what will the bot say" is never a guess.
 *
 * Every change asks first through the house confirmation dialog, with the actual name and
 * number in the question; deleting asks in the danger tone.
 */

/* Heroicons (outline, 24px) the shared icon set does not carry. */
const ICONS = {
  truck: '<path d="M8.25 18.75a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m3 0h6m-9 0H3.375a1.125 1.125 0 0 1-1.125-1.125V14.25m17.25 4.5a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m3 0h1.125c.621 0 1.129-.504 1.09-1.124a17.902 17.902 0 0 0-3.213-9.193 2.056 2.056 0 0 0-1.58-.86H14.25M16.5 18.75h-2.25m0-11.177v-.958c0-.568-.422-1.048-.987-1.106a48.554 48.554 0 0 0-10.026 0 1.106 1.106 0 0 0-.987 1.106v7.635m12-6.677v6.677m0 4.5v-4.5m0 0h-12"/>',
  promos: '<path d="M10.34 15.84c-.688-.06-1.386-.09-2.09-.09H7.5a4.5 4.5 0 1 1 0-9h.75c.704 0 1.402-.03 2.09-.09m0 9.18c.253.962.584 1.892.985 2.783.247.55.06 1.21-.463 1.511l-.657.38c-.551.318-1.26.117-1.527-.461a20.845 20.845 0 0 1-1.44-4.282m3.102.069a18.03 18.03 0 0 1-.59-4.59c0-1.586.205-3.124.59-4.59m0 9.18a23.848 23.848 0 0 1 8.835 2.535M10.34 6.66a23.847 23.847 0 0 0 8.835-2.535m0 0A23.74 23.74 0 0 0 18.795 3m.38 1.125a23.91 23.91 0 0 1 1.014 5.395m-1.014 8.855c-.118.38-.245.754-.38 1.125m.38-1.125a23.91 23.91 0 0 0 1.014-5.395m0-3.46c.495.413.811 1.035.811 1.73 0 .695-.316 1.317-.811 1.73m0-3.46a24.347 24.347 0 0 1 0 3.46"/>',
  vouchers: '<path d="M16.5 6v.75m0 3v.75m0 3v.75m0 3V18m-9-5.25h5.25M7.5 15h3M3.375 5.25c-.621 0-1.125.504-1.125 1.125v3.026a2.999 2.999 0 0 1 0 5.198v3.026c0 .621.504 1.125 1.125 1.125h17.25c.621 0 1.125-.504 1.125-1.125v-3.026a2.999 2.999 0 0 1 0-5.198V6.375c0-.621-.504-1.125-1.125-1.125H3.375Z"/>',
  gifts: '<path d="M21 11.25v8.25a1.5 1.5 0 0 1-1.5 1.5H5.25a1.5 1.5 0 0 1-1.5-1.5v-8.25M12 4.875A2.625 2.625 0 1 0 9.375 7.5H12m0-2.625V7.5m0-2.625A2.625 2.625 0 1 1 14.625 7.5H12m0 0V21m-8.625-9.75h18c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125h-18c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z"/>',
  bot: '<path d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z"/>',
  copy: '<path d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 0 1 1.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 0 0-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 0 1-1.125-1.125v-9.25m12 6.625v-1.875a3.375 3.375 0 0 0-3.375-3.375h-1.5a1.125 1.125 0 0 1-1.125-1.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H9.75"/>',
  link: '<path d="M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244"/>',
};
const ico = (name, cls = '') =>
  `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

const KIND_COPY = {
  promos: { title: 'Promo', hint: 'Potongan yang tidak butuh kode khusus, mis. diskon pembelian pertama.', empty: 'Belum ada promo. Bot menjawab tidak ada promo yang berjalan.' },
  vouchers: { title: 'Voucher', hint: 'Kode yang diketik pembeli di kolom discount saat checkout.', empty: 'Belum ada voucher. Bot tidak menyebut kode apa pun.' },
  gifts: { title: 'Hadiah', hint: 'Bonus barang untuk pembelian tertentu. Bot menyebut produk yang berlaku.', empty: 'Belum ada hadiah. Bot menjawab tidak ada hadiah yang berjalan.' },
};

const PRODUCT_NAME = Object.fromEntries(VARIANT_MAP.map((row) => [row.key, row.name]));

/** "2026-11-30" → "30 Nov 2026". Read as a calendar date, never shifted by a zone. */
const day = (value) => (value
  ? new Date(`${value}T00:00:00Z`).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
  : '');

const when = (epochSeconds) => (epochSeconds
  ? new Date(epochSeconds * 1000).toLocaleString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Makassar' })
  : '');

function period(item) {
  if (item.starts_at && item.ends_at) return `${day(item.starts_at)} – ${day(item.ends_at)}`;
  if (item.ends_at) return `s/d ${day(item.ends_at)}`;
  if (item.starts_at) return `mulai ${day(item.starts_at)}`;
  return 'tanpa batas waktu';
}

const STATUS = {
  active: { tone: 'good', label: 'Aktif', note: 'dikirim ke bot' },
  scheduled: { tone: 'info', label: 'Terjadwal', note: 'belum dikirim' },
  expired: { tone: 'off', label: 'Berakhir', note: 'tidak dikirim' },
};

const hidden = (csrf, action) =>
  `<input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="view" value="agent"><input type="hidden" name="action" value="${action}">`;

function itemCard({ kind, item, today, csrf, editable }) {
  const status = itemStatus(item, today);
  const s = STATUS[status];
  const one = KINDS[kind].one;
  const products = kind === 'gifts' && item.applies_to?.length
    ? `<p class="ag-it__meta">${ico('gifts')}<span>Untuk: ${item.applies_to.map((key) => escape(PRODUCT_NAME[key] ?? key)).join(', ')}</span></p>`
    : kind === 'gifts' ? `<p class="ag-it__meta">${ico('gifts')}<span>Untuk semua produk</span></p>` : '';
  const link = item.url
    ? `<p class="ag-it__meta">${ico('link')}<a href="${escape(item.url)}" target="_blank" rel="noopener noreferrer">${escape(item.url.replace(/^https:\/\//, ''))}</a></p>`
    : '';
  const actions = editable ? `<div class="ag-it__acts">
      <button class="ag-btn" type="button" data-ag-edit data-kind="${kind}" data-item="${escape(JSON.stringify(item))}" aria-label="Ubah ${escape(one)} ${escape(item.name)}">${svg('pencil')}<span>Ubah</span></button>
      <form method="post" data-confirm-text="Hapus ${escape(one)} &quot;${escape(item.name)}&quot;? ${status === 'active' ? 'Bot langsung berhenti menyebutnya di jawaban berikutnya.' : 'Saat ini tidak dikirim ke bot.'}">
        ${hidden(csrf, 'agent_item_delete')}<input type="hidden" name="kind" value="${kind}"><input type="hidden" name="id" value="${escape(item.id)}">
        <button class="ag-btn ag-btn--bad um__act--bad" type="submit" aria-label="Hapus ${escape(one)} ${escape(item.name)}">${svg('trash')}<span>Hapus</span></button>
      </form>
    </div>` : '';
  return `<li class="ag-it ag-it--${status}">
    <div class="ag-it__head">
      <h4 class="ag-it__name">${escape(item.name)}</h4>
      <span class="ag-st ag-st--${s.tone}"><i aria-hidden="true"></i>${s.label}<span class="ag-st__n">· ${s.note}</span></span>
    </div>
    <div class="ag-it__row">
      ${item.code ? `<code class="ag-code">${escape(item.code)}</code>` : '<span class="ag-code ag-code--none">tanpa kode</span>'}
      <span class="ag-it__when">${escape(period(item))}</span>
    </div>
    <p class="ag-it__detail">${escape(item.detail)}</p>
    ${products}${link}
    ${actions}
  </li>`;
}

function kindSection({ kind, items, today, csrf, editable }) {
  const copy = KIND_COPY[kind];
  const active = items.filter((item) => itemStatus(item, today) === 'active').length;
  return `<section class="panel ag-sec" aria-labelledby="ag-h-${kind}">
    <header class="ag-sec__head">
      <span class="ag-sec__ico" aria-hidden="true">${ico(kind)}</span>
      <div class="ag-sec__t">
        <h3 id="ag-h-${kind}">${copy.title} <span class="ag-sec__count">${active} aktif dari ${items.length}</span></h3>
        <p>${escape(copy.hint)}</p>
      </div>
      ${editable ? `<button class="ag-btn ag-btn--add" type="button" data-ag-new="${kind}">${svg('plus')}<span>Tambah ${escape(KINDS[kind].one)}</span></button>` : ''}
    </header>
    ${items.length
      ? `<ul class="ag-list">${items.map((item) => itemCard({ kind, item, today, csrf, editable })).join('')}</ul>`
      : `<p class="ag-empty">${escape(copy.empty)}</p>`}
  </section>`;
}

function shippingCard({ shipping, csrf, editable }) {
  return `<section class="panel ag-sec ag-ship" aria-labelledby="ag-h-ship">
    <header class="ag-sec__head">
      <span class="ag-sec__ico" aria-hidden="true">${ico('truck')}</span>
      <div class="ag-sec__t">
        <h3 id="ag-h-ship">Gratis ongkir</h3>
        <p>Batas belanja yang disebut bot saat pembeli bertanya ongkir.</p>
      </div>
      <span class="ag-ship__now mono">${escape(rupiahText(shipping.min_amount))}</span>
    </header>
    ${editable ? `<form method="post" class="ag-ship__form" id="ag-ship" data-confirm="Simpan gratis ongkir?" data-was="${shipping.min_amount}">
      ${hidden(csrf, 'agent_shipping')}
      <div class="fld">
        <label for="ag-min">Minimal belanja</label>
        <div class="ag-rp"><span aria-hidden="true">Rp</span><input id="ag-min" name="min_amount" type="number" inputmode="numeric" min="0" max="100000000" step="1000" required value="${shipping.min_amount}"></div>
      </div>
      <div class="fld ag-ship__scope">
        <label for="ag-scope">Berlaku untuk</label>
        <input id="ag-scope" name="scope" type="text" required maxlength="200" value="${escape(shipping.scope)}">
      </div>
      <button class="ag-go" type="submit">${svg('check')}<span>Simpan</span></button>
    </form>` : `<p class="ag-empty">${escape(shipping.scope)}</p>`}
  </section>`;
}

/**
 * The gifts on one product row. A gift belongs to the variant it comes with, so it is
 * edited right here; the bot gets it as the row's `gift` and in `gifts`.
 */
function rowGifts({ key, name, gifts, today, editable }) {
  const own = giftsFor(gifts, key);
  const chips = own.map((g) => {
    const status = itemStatus(g, today);
    const s = STATUS[status];
    const when = g.ends_at || g.starts_at ? ` · ${period(g)}` : '';
    const label = `<span class="ag-gift__ico">${ico('gifts')}</span><span class="ag-gift__t">${escape(g.name)}</span>${status === 'active' ? '' : `<span class="ag-gift__st">${s.label}</span>`}`;
    return editable
      ? `<button type="button" class="ag-gift ag-gift--${status}" data-ag-edit data-kind="gifts" data-item="${escape(JSON.stringify(g))}" data-for="${key}" data-variant="${escape(name)}"
          title="${escape(`${s.label} - ${s.note}${when}`)}" aria-label="Ubah hadiah ${escape(g.name)} untuk ${escape(name)}">${label}${svg('pencil')}</button>`
      : `<span class="ag-gift ag-gift--${status}" title="${escape(`${s.label} - ${s.note}${when}`)}">${label}</span>`;
  }).join('');
  const add = editable
    ? `<button type="button" class="ag-gift ag-gift--add" data-ag-new="gifts" data-for="${key}" data-variant="${escape(name)}" aria-label="Tambah hadiah untuk ${escape(name)}">${svg('plus')}<span>Hadiah</span></button>`
    : '';
  return chips || add ? `<span class="ag-gifts">${chips}${own.length ? '' : add}</span>` : '';
}

function previewPanel({ catalog, warnings, endpoint, keyed, today, gifts, editable }) {
  if (catalog.status !== 200) {
    return `<section class="panel ag-bot" aria-labelledby="ag-h-bot">
      <header class="ag-bot__head"><h3 id="ag-h-bot">${ico('bot')}Yang dibaca bot</h3></header>
      <div class="alert">${svg('warn')}<span>treelogy.com/products.json tidak terjangkau. Bot saat ini menerima <code>catalog_unavailable</code> dan diarahkan untuk tidak menebak harga.</span>
        <a class="alert__btn" href="?view=agent&amp;fresh=1">${svg('refresh')}Coba lagi</a></div>
      <div class="ag-bot__scroll"><table class="ag-p">
        <thead><tr><th>Produk &amp; hadiah</th></tr></thead>
        <tbody>${VARIANT_MAP.map((row) => `<tr><td><span class="ag-p__n">${escape(row.name)}</span><span class="ag-p__k mono">${escape(row.key)}</span>${rowGifts({ key: row.key, name: row.name, gifts, today, editable })}</td></tr>`).join('')}</tbody>
      </table></div>
    </section>`;
  }
  const body = catalog.body;
  const json = JSON.stringify(body, null, 2);
  const size = Buffer.byteLength(JSON.stringify(body));
  const rows = body.products.map((p) => `<tr class="${p.available ? '' : 'is-off'}">
      <td><span class="ag-p__n">${escape(p.name)}</span><span class="ag-p__k mono">${escape(p.key)}</span>${rowGifts({ key: p.key, name: p.name, gifts, today, editable })}</td>
      <td class="num nowrap"><span class="ag-p__price mono">${p.price_text ? escape(p.price_text) : '—'}</span>${p.compare_at_price_text ? `<s class="ag-p__was mono" aria-label="harga coret">${escape(p.compare_at_price_text)}</s>` : ''}</td>
      <td class="num"><span class="ag-st ag-st--${p.available ? 'good' : 'bad'}"><i aria-hidden="true"></i>${p.available ? 'Tersedia' : 'Habis'}</span></td>
    </tr>`).join('');
  const warn = warnings.length
    ? `<div class="alert alert--soft">${svg('warn')}<span>${warnings.length} varian tidak cocok lewat ID yang dipin (${warnings.map((w) => escape(w.key)).join(', ')}). ${warnings.some((w) => w.how !== 'title') ? 'Yang tidak ditemukan dikirim sebagai habis tanpa harga.' : 'Dicocokkan lewat judul; perbarui VARIANT_MAP.'}</span></div>`
    : '';
  const curl = `curl -s ${endpoint}${keyed ? ' \\\n  -H "x-api-key: $CATALOG_API_KEY"' : ''}`;
  return `<section class="panel ag-bot" aria-labelledby="ag-h-bot">
    <header class="ag-bot__head">
      <div>
        <h3 id="ag-h-bot">${ico('bot')}Yang dibaca bot sekarang</h3>
        <p>Hari ini ${escape(day(today))} (WITA) &middot; harga dari treelogy.com, diperbarui tiap menit &middot; hadiah dipasang per varian di tabel ini</p>
      </div>
      <a class="ag-btn" href="?view=agent&amp;fresh=1" title="Ambil ulang harga dari treelogy.com">${svg('refresh')}<span>Ambil harga</span></a>
    </header>
    ${warn}
    <div class="ag-bot__scroll"><table class="ag-p">
      <thead><tr><th>Produk</th><th class="num">Harga</th><th class="num">Stok</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <details class="ag-json">
      <summary><span>Payload JSON</span><span class="ag-json__size mono">${(size / 1024).toFixed(1)} KB</span></summary>
      <div class="ag-json__box">
        <button class="ag-copy" type="button" data-copy="#ag-json-pre" aria-label="Salin payload JSON">${ico('copy')}<span>Salin</span></button>
        <pre id="ag-json-pre" class="mono" tabindex="0">${escape(json)}</pre>
      </div>
    </details>
  </section>
  <section class="panel ag-qontak" aria-labelledby="ag-h-qontak">
    <h3 id="ag-h-qontak">${ico('link')}Sambungan ke Qontak</h3>
    <dl class="ag-kv">
      <div><dt>Action</dt><dd><code>get_catalog</code> &middot; GET, tanpa parameter</dd></div>
      <div><dt>URL</dt><dd class="ag-kv__copy"><code id="ag-url">${escape(endpoint)}</code><button class="ag-copy ag-copy--sm" type="button" data-copy="#ag-url" aria-label="Salin URL endpoint">${ico('copy')}</button></dd></div>
      <div><dt>Kunci</dt><dd>${keyed
        ? `<span class="ag-st ag-st--good"><i aria-hidden="true"></i>Terkunci</span> header <code>x-api-key</code> wajib`
        : '<span class="ag-st ag-st--warn"><i aria-hidden="true"></i>Terbuka</span> <code>CATALOG_API_KEY</code> belum disetel di server'}</dd></div>
    </dl>
    <div class="ag-json__box ag-curl">
      <button class="ag-copy" type="button" data-copy="#ag-curl" aria-label="Salin perintah curl">${ico('copy')}<span>Salin</span></button>
      <pre id="ag-curl" class="mono">${escape(curl)}</pre>
    </div>
  </section>`;
}

function editorDialog(csrf) {
  return `<dialog class="ag-ed" id="ag-ed" aria-labelledby="ag-ed-title">
    <form method="post" class="ag-ed__form" id="ag-ed-form" data-confirm="Simpan?">
      ${hidden(csrf, 'agent_item_save')}
      <input type="hidden" name="kind" id="ag-ed-kind" value="promos">
      <input type="hidden" name="original_id" id="ag-ed-orig" value="">
      <header class="ag-ed__head">
        <span class="ag-sec__ico" id="ag-ed-ico" aria-hidden="true"></span>
        <div><h2 id="ag-ed-title">Tambah promo</h2><p id="ag-ed-sub">Bot memakai data ini di jawaban berikutnya setelah disimpan.</p></div>
        <button class="ag-x" type="button" data-ag-close aria-label="Tutup">${svg('close')}</button>
      </header>
      <div class="ag-ed__body">
        <div class="fld">
          <label for="ag-f-name">Nama</label>
          <input id="ag-f-name" name="name" type="text" required maxlength="80" autocomplete="off" placeholder="mis. Voucher harga lama">
        </div>
        <div class="fld fld--mono" id="ag-f-code-wrap">
          <label for="ag-f-code">Kode <span class="dim" id="ag-f-code-opt">(opsional)</span></label>
          <input id="ag-f-code" name="code" type="text" maxlength="40" autocomplete="off" spellcheck="false" pattern="[A-Za-z0-9][A-Za-z0-9_\\-]{1,39}" placeholder="HARGATETAP">
          <span class="fld__hint">Huruf besar, angka, - dan _. Disimpan dalam huruf besar.</span>
        </div>
        <div class="fld">
          <label for="ag-f-detail">Keterangan untuk bot</label>
          <textarea id="ag-f-detail" name="detail" required maxlength="600" rows="4" placeholder="Siapa yang berhak, berapa kali, cara memakainya."></textarea>
          <span class="fld__hint"><span id="ag-f-count">0</span>/600 &middot; ditulis seperti yang akan dibacakan ke pembeli</span>
        </div>
        <div class="ag-ed__dates">
          <div class="fld"><label for="ag-f-start">Mulai</label><input id="ag-f-start" name="starts_at" type="date"></div>
          <div class="fld"><label for="ag-f-end">Berakhir</label><input id="ag-f-end" name="ends_at" type="date"></div>
        </div>
        <p class="fld__hint ag-ed__note">Kosong berarti tanpa batas. Tanggal dibaca dalam WITA dan ikut dihitung: berakhir 30 Nov masih tampil sepanjang 30 Nov.</p>
        <fieldset class="ag-ed__gift" id="ag-f-gift">
          <legend>Menempel ke varian</legend>
          <p class="ag-ed__variant" id="ag-f-variant"></p>
          <span id="ag-f-applies"></span>
          <div class="fld">
            <label for="ag-f-url">Tautan halaman promo <span class="dim">(opsional)</span></label>
            <input id="ag-f-url" name="url" type="url" maxlength="300" placeholder="https://treelogy.com/pages/...">
          </div>
        </fieldset>
      </div>
      <footer class="ag-ed__foot">
        <button class="ag-btn ag-btn--bad um__act--bad ag-ed__del" type="submit" form="ag-ed-del" id="ag-ed-delbtn" hidden>${svg('trash')}<span>Hapus hadiah</span></button>
        <button class="ag-btn" type="button" data-ag-close>Batal</button>
        <button class="ag-go" type="submit">${svg('check')}<span id="ag-ed-go">Simpan</span></button>
      </footer>
    </form>
    <form method="post" id="ag-ed-del" data-confirm-text="Hapus hadiah ini?">
      ${hidden(csrf, 'agent_item_delete')}<input type="hidden" name="kind" value="gifts"><input type="hidden" name="id" id="ag-ed-del-id" value="">
    </form>
  </dialog>`;
}

/**
 * @param {{catalog: {status:number, body:object, warnings?:object[], today?:string}, meta: object, endpoint: string, keyed: boolean, today: string, user, csrf, flash, range}} props
 */
export function renderAgent({ catalog, meta, endpoint, keyed, today, user, csrf, flash, ...common }) {
  const editable = can(user, 'write');
  const { config } = meta;
  const activeCount = (kind) => config[kind].filter((item) => itemStatus(item, today) === 'active').length;
  const products = catalog.status === 200 ? catalog.body.products : [];
  const available = products.filter((p) => p.available).length;

  const sourceChip = meta.source === 'dashboard'
    ? `<span class="ag-chip ag-chip--good">${svg('check2')}<span>Data dari dashboard${meta.updatedBy?.name ? ` &middot; ${escape(meta.updatedBy.name)}, ${escape(when(meta.updatedAt))}` : ''}</span></span>`
    : `<span class="ag-chip ag-chip--warn" title="${escape(meta.problem ?? '')}">${svg('warn')}<span>Memakai default repo &middot; ${escape(meta.problem ?? 'belum disimpan')}</span></span>`;

  const kpis = `<section class="strip ag-strip" aria-label="Ringkasan data bot">
    <span class="stat"><span class="stat__n ${catalog.status === 200 && available === products.length ? 'ok' : 'stop'}">${catalog.status === 200 ? `${available}/${products.length}` : '—'}</span><span class="stat__l">produk tersedia</span></span>
    <span class="stat"><span class="stat__n">${escape(rupiahText(config.free_shipping.min_amount).replace('Rp ', 'Rp'))}</span><span class="stat__l">gratis ongkir</span></span>
    <span class="stat"><span class="stat__n">${activeCount('promos')}</span><span class="stat__l">promo aktif</span></span>
    <span class="stat"><span class="stat__n">${activeCount('vouchers')}</span><span class="stat__l">voucher aktif</span></span>
    <span class="stat"><span class="stat__n">${activeCount('gifts')}</span><span class="stat__l">hadiah aktif</span></span>
    <span class="strip__grow"></span>
    ${sourceChip}
  </section>`;

  const readOnly = editable ? '' : `<div class="alert alert--soft">${svg('info')}<span>Peran Anda hanya bisa melihat. Perubahan dilakukan oleh admin atau operator.</span></div>`;

  const body = `${readOnly}<div class="ag">
    <div class="ag__main">
      ${shippingCard({ shipping: config.free_shipping, csrf, editable })}
      ${['promos', 'vouchers'].map((kind) => kindSection({ kind, items: config[kind], today, csrf, editable })).join('')}
    </div>
    <aside class="ag__side">${previewPanel({ catalog, warnings: catalog.warnings ?? [], endpoint, keyed, today, gifts: config.gifts, editable })}</aside>
  </div>
  ${editable ? editorDialog(csrf) : ''}
  <script type="application/json" id="ag-icons">${JSON.stringify({ promos: ico('promos'), vouchers: ico('vouchers'), gifts: ico('gifts') }).replace(/</g, '\\u003c')}</script>`;

  return shell({
    ...common, csrf, flash, title: 'AI Agent', view: 'agent', kpis, body, hideRangeControls: true, user,
    scope: 'data harga & promo untuk bot WhatsApp Qontak', style: STYLE, script: SCRIPT,
  });
}

const STYLE = `
.ag{display:grid; grid-template-columns:minmax(0,1.05fr) minmax(0,1fr); gap:1rem; align-items:start}
.ag__main{display:flex; flex-direction:column; gap:1rem; min-width:0}
.ag__side{display:flex; flex-direction:column; gap:1rem; position:sticky; top:var(--top-offset); min-width:0}
@media (max-width:1100px){ .ag{grid-template-columns:minmax(0,1fr)} .ag__side{position:static} }
.ag-strip{margin-bottom:1rem}

.ag-chip{display:inline-flex; align-items:center; gap:.45rem; font-size:.78rem; padding:.4rem .75rem; border-radius:8px; border:1px solid var(--line); color:var(--muted); max-width:100%}
.ag-chip span{overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.ag-chip .ico{width:16px; height:16px; flex:none}
.ag-chip--good{color:var(--good); border-color:color-mix(in srgb,var(--good) 40%,transparent); background:color-mix(in srgb,var(--good) 10%,transparent)}
.ag-chip--warn{color:var(--warn); border-color:color-mix(in srgb,var(--warn) 45%,transparent); background:color-mix(in srgb,var(--warn) 10%,transparent)}

.ag-sec{padding:1.15rem 1.25rem}
.ag-sec__head{display:flex; align-items:flex-start; gap:.85rem}
.ag-sec__ico{width:40px; height:40px; border-radius:11px; display:grid; place-items:center; flex:none; color:#fff;
  background:linear-gradient(155deg,var(--fill-a),var(--fill-b)); box-shadow:0 10px 22px -16px rgba(0,0,0,.8)}
.ag-sec__ico .ico{width:20px; height:20px}
.ag-sec__t{flex:1; min-width:0}
.ag-sec__t h3{margin:0; font-size:1rem; font-weight:600; letter-spacing:-.01em; display:flex; align-items:baseline; gap:.5rem; flex-wrap:wrap}
.ag-sec__t p{margin:.2rem 0 0; font-size:.8rem; line-height:1.5; color:var(--muted)}
.ag-sec__count{font-size:.72rem; font-weight:500; color:var(--dim)}
.ag-empty{margin:1rem 0 0; padding:1rem; font-size:.84rem; line-height:1.5; color:var(--muted); border:1px dashed var(--line); border-radius:var(--radius-s); text-align:center}

.ag-ship__now{font-size:1.15rem; font-weight:600; color:var(--fg); white-space:nowrap; align-self:center}
.ag-ship__form{display:grid; grid-template-columns:minmax(150px,200px) minmax(0,1fr) auto; gap:.75rem; align-items:end; margin-top:1rem}
@media (max-width:640px){ .ag-ship__form{grid-template-columns:minmax(0,1fr)} }
.ag-rp{display:flex; align-items:stretch; border:1px solid var(--line); border-radius:8px; background:var(--panel-2); overflow:hidden}
.ag-rp:focus-within{outline:2px solid var(--brand); outline-offset:1px}
.ag-rp span{display:grid; place-items:center; padding:0 .6rem; font-size:.8rem; color:var(--muted); border-right:1px solid var(--line)}
.fld .ag-rp input{border:0; border-radius:0; background:transparent; outline:none; font-variant-numeric:tabular-nums}

.ag-list{list-style:none; margin:1rem 0 0; padding:0; display:flex; flex-direction:column; gap:.6rem}
.ag-it{padding:.9rem 1rem; border:1px solid var(--line); border-radius:var(--radius-s); background:var(--panel-2);
  transition:border-color var(--t-fast) var(--ease-out)}
.ag-it:hover{border-color:color-mix(in srgb,var(--brand) 55%,var(--line))}
.ag-it--expired{opacity:.62}
.ag-it--expired:hover,.ag-it--expired:focus-within{opacity:1}
.ag-it__head{display:flex; align-items:flex-start; justify-content:space-between; gap:.4rem .75rem; flex-wrap:wrap}
.ag-it__name{margin:0; font-size:.92rem; font-weight:600; line-height:1.35}
.ag-it__row{display:flex; align-items:center; gap:.6rem; flex-wrap:wrap; margin-top:.45rem}
.ag-it__when{font-size:.76rem; color:var(--muted)}
.ag-it__detail{margin:.55rem 0 0; font-size:.83rem; line-height:1.55; color:var(--fg); max-width:70ch; white-space:pre-line}
.ag-it__meta{display:flex; align-items:flex-start; gap:.4rem; margin:.45rem 0 0; font-size:.76rem; line-height:1.45; color:var(--muted)}
.ag-it__meta .ico{width:15px; height:15px; flex:none; margin-top:.1rem}
.ag-it__meta a{color:var(--brand); text-underline-offset:3px; word-break:break-all}
.ag-it__acts{display:flex; justify-content:flex-end; gap:.4rem; margin-top:.75rem}
.ag-it__acts form{margin:0}

.ag-code{font-family:"Fira Code",ui-monospace,monospace; font-size:.76rem; font-weight:600; letter-spacing:.04em; padding:.2rem .5rem; border-radius:6px;
  color:var(--fg); background:var(--glass-2); border:1px dashed color-mix(in srgb,var(--brand) 60%,transparent)}
.ag-code--none{font-weight:400; letter-spacing:0; color:var(--dim); border-color:var(--line)}

.ag-st{display:inline-flex; align-items:center; gap:.35rem; font-size:.72rem; font-weight:600; padding:.22rem .55rem; border-radius:999px; white-space:nowrap}
.ag-st i{width:7px; height:7px; border-radius:50%; background:currentColor; flex:none}
.ag-st__n{font-weight:400; opacity:.85}
.ag-st--good{color:var(--good); background:color-mix(in srgb,var(--good) 14%,transparent)}
.ag-st--info{color:var(--info); background:color-mix(in srgb,var(--info) 14%,transparent)}
.ag-st--warn{color:var(--warn); background:color-mix(in srgb,var(--warn) 14%,transparent)}
.ag-st--bad{color:var(--bad); background:color-mix(in srgb,var(--bad) 14%,transparent)}
.ag-st--off{color:var(--muted); background:var(--glass-2)}
.ag-st--off i{background:transparent; border:1.5px solid currentColor}

.ag-btn{display:inline-flex; align-items:center; justify-content:center; gap:.4rem; font:inherit; font-size:.8rem; font-weight:500; padding:.45rem .8rem; min-height:40px;
  border-radius:10px; border:1px solid var(--line); background:var(--panel-2); color:var(--fg); cursor:pointer; text-decoration:none; white-space:nowrap;
  transition:color var(--t-fast), border-color var(--t-fast), background var(--t-fast)}
.ag-btn .ico{width:16px; height:16px}
.ag-btn:hover{border-color:var(--brand); background:color-mix(in srgb,var(--brand) 10%,var(--panel-2))}
.ag-btn:focus-visible,.ag-go:focus-visible,.ag-copy:focus-visible,.ag-x:focus-visible{outline:2px solid var(--brand); outline-offset:2px}
.ag-btn--bad{color:var(--muted)}
.ag-btn--bad:hover{color:var(--bad); border-color:var(--bad); background:color-mix(in srgb,var(--bad) 10%,var(--panel-2))}
.ag-btn--add{flex:none}
.ag-go{display:inline-flex; align-items:center; justify-content:center; gap:.45rem; font:inherit; font-size:.88rem; font-weight:600; padding:.6rem 1.15rem; min-height:44px;
  border-radius:999px; cursor:pointer; color:#fff; border:1px solid transparent; background:linear-gradient(155deg,var(--cta-a),var(--cta-b));
  box-shadow:0 1px 0 rgba(255,255,255,.14) inset, 0 12px 26px -14px color-mix(in srgb,var(--cta-a) 85%,transparent); transition:filter var(--t-base) var(--ease-out)}
.ag-go:hover{filter:brightness(1.08)}
.ag-go:disabled{opacity:.6; cursor:progress}
.ag-go .ico{width:17px; height:17px}
@media (max-width:640px){ .ag-btn{min-height:44px} .ag-btn--add span{display:none} .ag-btn--add{width:44px; padding:0} }

.ag-bot,.ag-qontak{padding:1.15rem 1.25rem}
.ag-bot__head{display:flex; align-items:flex-start; justify-content:space-between; gap:.75rem; margin-bottom:.85rem}
.ag-bot h3,.ag-qontak h3{margin:0; display:flex; align-items:center; gap:.5rem; font-size:1rem; font-weight:600; letter-spacing:-.01em}
.ag-bot h3 .ico,.ag-qontak h3 .ico{width:20px; height:20px; color:var(--brand)}
.ag-bot__head p{margin:.25rem 0 0; font-size:.76rem; color:var(--muted)}
.ag-bot__scroll{overflow:auto; border:1px solid var(--line); border-radius:var(--radius-s); max-height:min(78vh,920px)}
.ag-p{width:100%; border-collapse:collapse; font-size:.82rem}
.ag-p th{position:sticky; top:0; z-index:1; text-align:left; font-size:.66rem; letter-spacing:.09em; text-transform:uppercase; font-weight:600; color:var(--muted);
  padding:.6rem .75rem; background:var(--panel); border-bottom:1px solid var(--line)}
.ag-p th.num{text-align:right}
.ag-p td{padding:.6rem .75rem; border-bottom:1px solid var(--line); vertical-align:middle}
.ag-p tr:last-child td{border-bottom:0}
.ag-p tbody tr:hover td{background:var(--glass)}
.ag-p tr.is-off td{color:var(--muted)}
.ag-p__n{display:block; font-weight:500; line-height:1.35}
.ag-p__k{display:block; font-size:.7rem; color:var(--dim); margin-top:.1rem}
.ag-p__price{font-weight:600}
.ag-gifts{display:flex; flex-wrap:wrap; gap:.3rem; margin-top:.4rem}
.ag-gift{display:inline-flex; align-items:center; gap:.35rem; max-width:100%; font:inherit; font-size:.72rem; font-weight:500; line-height:1.3;
  padding:.28rem .55rem; min-height:28px; border-radius:999px; border:1px solid color-mix(in srgb,var(--act) 45%,transparent);
  color:var(--act); background:color-mix(in srgb,var(--act) 11%,transparent); text-align:left; transition:background var(--t-fast), border-color var(--t-fast)}
button.ag-gift{cursor:pointer}
button.ag-gift:hover{background:color-mix(in srgb,var(--act) 20%,transparent)}
.ag-gift:focus-visible{outline:2px solid var(--brand); outline-offset:2px}
.ag-gift .ico{width:13px; height:13px; flex:none}
.ag-gift > .ico:last-child{opacity:.6}
.ag-gift__ico{display:inline-grid}
.ag-gift__t{overflow:hidden; text-overflow:ellipsis}
.ag-gift__st{font-size:.64rem; font-weight:600; text-transform:uppercase; letter-spacing:.06em; opacity:.85}
.ag-gift--scheduled{color:var(--info); border-color:color-mix(in srgb,var(--info) 45%,transparent); background:color-mix(in srgb,var(--info) 10%,transparent)}
.ag-gift--expired{color:var(--muted); border-color:var(--line); background:var(--glass); text-decoration:line-through; text-decoration-thickness:1px}
.ag-gift--add{color:var(--muted); border:1px dashed var(--line); background:transparent}
button.ag-gift--add:hover{color:var(--fg); border-color:var(--brand); background:var(--glass)}
@media (max-width:640px){ .ag-gift{min-height:36px} }
.ag-p__was{display:block; font-size:.72rem; color:var(--dim)}

.ag-json{margin-top:.85rem; border:1px solid var(--line); border-radius:var(--radius-s); background:var(--panel-2)}
.ag-json summary{display:flex; justify-content:space-between; align-items:center; gap:.5rem; padding:.7rem .9rem; cursor:pointer; font-size:.84rem; font-weight:500; min-height:44px; list-style:none}
.ag-json summary::-webkit-details-marker{display:none}
.ag-json summary::before{content:""; width:7px; height:7px; border-right:1.6px solid var(--muted); border-bottom:1.6px solid var(--muted); transform:rotate(-45deg); transition:transform var(--t-fast); margin-right:.2rem}
.ag-json[open] summary::before{transform:rotate(45deg)}
.ag-json summary span:first-of-type{flex:1}
.ag-json summary:focus-visible{outline:2px solid var(--brand); outline-offset:-2px; border-radius:var(--radius-s)}
.ag-json__size{font-size:.72rem; color:var(--dim)}
.ag-json__box{position:relative}
.ag-json pre,.ag-curl pre{margin:0; padding:1rem; max-height:420px; overflow:auto; font-size:.74rem; line-height:1.6; color:var(--fg);
  background:var(--ink); border-top:1px solid var(--line); border-radius:0 0 var(--radius-s) var(--radius-s); white-space:pre}
:root[data-theme="light"] .ag-json pre,:root[data-theme="light"] .ag-curl pre{color:#E8EDE6}
.ag-curl{margin-top:.85rem}
.ag-curl pre{border:1px solid var(--line); border-radius:var(--radius-s); padding-right:6rem}
.ag-copy{position:absolute; top:.55rem; right:.55rem; display:inline-flex; align-items:center; gap:.35rem; font:inherit; font-size:.72rem; font-weight:500;
  padding:.35rem .6rem; min-height:32px; border-radius:8px; cursor:pointer; color:#E8EDE6; background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.14);
  transition:background var(--t-fast)}
.ag-copy:hover{background:rgba(255,255,255,.16)}
.ag-copy .ico{width:14px; height:14px}
.ag-copy.is-done{color:var(--good)}
.ag-copy--sm{position:static; min-height:32px; padding:.3rem .45rem; color:var(--muted); background:var(--panel-2); border-color:var(--line)}
.ag-kv{margin:.85rem 0 0; display:flex; flex-direction:column; gap:.55rem}
.ag-kv div{display:grid; grid-template-columns:4.5rem minmax(0,1fr); gap:.6rem; align-items:center; font-size:.8rem}
.ag-kv dt{color:var(--muted); font-size:.72rem; text-transform:uppercase; letter-spacing:.08em}
.ag-kv dd{margin:0; display:flex; align-items:center; gap:.45rem; flex-wrap:wrap; min-width:0}
.ag-kv code{font-family:"Fira Code",ui-monospace,monospace; font-size:.76rem; word-break:break-all}

.ag-ed{border:0; padding:0; width:min(600px,calc(100% - 2rem)); max-height:calc(100dvh - 2rem); border-radius:var(--radius); color:var(--fg);
  background:var(--panel); box-shadow:0 30px 80px -30px rgba(0,0,0,.85); overflow:hidden}
.ag-ed::backdrop{background:rgba(6,10,9,.6); backdrop-filter:blur(4px); -webkit-backdrop-filter:blur(4px)}
@media (prefers-reduced-motion:no-preference){ .ag-ed[open]{animation:ag-in var(--t-base) var(--ease-out)} }
@keyframes ag-in{from{opacity:0; transform:translateY(10px) scale(.985)}}
.ag-ed__form{display:flex; flex-direction:column; max-height:calc(100dvh - 2rem)}
.ag-ed__head{display:flex; align-items:flex-start; gap:.85rem; padding:1.15rem 1.25rem; border-bottom:1px solid var(--line)}
.ag-ed__head div{flex:1; min-width:0}
.ag-ed__head h2{margin:0; font-size:1.05rem; font-weight:600; letter-spacing:-.01em}
.ag-ed__head p{margin:.2rem 0 0; font-size:.78rem; color:var(--muted)}
.ag-x{width:40px; height:40px; display:grid; place-items:center; border-radius:10px; border:1px solid transparent; background:transparent; color:var(--muted); cursor:pointer; flex:none}
.ag-x:hover{color:var(--fg); background:var(--glass-2)}
.ag-x .ico{width:18px; height:18px}
.ag-ed__body{padding:1.1rem 1.25rem; overflow:auto; display:flex; flex-direction:column; gap:.9rem}
.ag-ed__body textarea{resize:vertical; min-height:96px; line-height:1.5}
.ag-ed__dates{display:grid; grid-template-columns:1fr 1fr; gap:.75rem}
.ag-ed__note{margin:-.4rem 0 0}
.ag-ed__gift{margin:0; padding:0; border:0; display:flex; flex-direction:column; gap:.8rem}
.ag-ed [hidden]{display:none !important}
.ag-ed__gift legend{font-size:.74rem; color:var(--muted); margin-bottom:.45rem; padding:0}
.ag-ed__variant{margin:0; padding:.6rem .75rem; border-radius:8px; font-size:.84rem; font-weight:500; background:var(--panel-2); border:1px solid var(--line)}
.ag-ed__del{margin-right:auto}
.ag-ed__foot{display:flex; justify-content:flex-end; gap:.6rem; padding:.9rem 1.25rem; border-top:1px solid var(--line); background:var(--panel-2)}
.ag-ed__foot .ag-btn{min-height:44px}
@media (max-width:520px){ .ag-ed__dates{grid-template-columns:1fr} .ag-ed__foot .ag-go,.ag-ed__foot .ag-btn{flex:1} }
`;

const SCRIPT = `
(function () {
  var rupiah = function (n) { return 'Rp ' + String(Math.round(Number(n) || 0)).replace(/\\B(?=(\\d{3})+(?!\\d))/g, '.'); };

  // Free shipping: the question carries the old and the new number.
  var ship = document.getElementById('ag-ship');
  if (ship) {
    ship.addEventListener('submit', function () {
      var was = Number(ship.dataset.was);
      var now = Number(ship.querySelector('[name=min_amount]').value);
      ship.dataset.confirm = (was === now ? 'Simpan gratis ongkir (minimal ' + rupiah(now) + ')?' : 'Ubah batas gratis ongkir dari ' + rupiah(was) + ' menjadi ' + rupiah(now) + '?')
        + ' Bot WhatsApp langsung memakai data ini di jawaban berikutnya.';
    });
  }

  // The editor: one dialog for every promo, voucher and gift, new or existing.
  var dlg = document.getElementById('ag-ed');
  if (dlg) {
    var form = document.getElementById('ag-ed-form');
    var icons = {};
    try { icons = JSON.parse(document.getElementById('ag-icons').textContent); } catch (e) {}
    var LABEL = { promos: 'promo', vouchers: 'voucher', gifts: 'hadiah' };
    var $ = function (id) { return document.getElementById(id); };
    var detail = $('ag-f-detail');
    var count = function () { $('ag-f-count').textContent = detail.value.length; };
    detail.addEventListener('input', count);

    var open = function (kind, item, forKey, forName) {
      form.reset();
      $('ag-ed-kind').value = kind;
      $('ag-ed-orig').value = item ? item.id : '';
      $('ag-ed-ico').innerHTML = icons[kind] || '';
      $('ag-ed-title').textContent = (item ? 'Ubah ' : 'Tambah ') + LABEL[kind];
      $('ag-ed-go').textContent = item ? 'Simpan perubahan' : 'Tambahkan';
      $('ag-f-name').value = item ? item.name : '';
      $('ag-f-name').placeholder = { promos: 'mis. Potongan pembelian pertama', vouchers: 'mis. Voucher harga lama', gifts: 'mis. Mystery Gift + Travel Pouch' }[kind];
      $('ag-f-code').value = item && item.code ? item.code : '';
      detail.value = item ? item.detail : '';
      $('ag-f-start').value = item && item.starts_at ? item.starts_at : '';
      $('ag-f-end').value = item && item.ends_at ? item.ends_at : '';
      $('ag-f-url').value = item && item.url ? item.url : '';
      // A gift is attached to the variant row it was opened from; an older gift that covers
      // several variants keeps all of them.
      var applies = item ? (item.applies_to || []) : (forKey ? [forKey] : []);
      $('ag-f-applies').innerHTML = applies.map(function (k) { return '<input type="hidden" name="applies_to" value="' + k.replace(/[^a-z0-9_]/g, '') + '">'; }).join('');
      $('ag-f-variant').textContent = !applies.length ? 'Semua produk' : applies.length > 1 ? (forName + ' dan ' + (applies.length - 1) + ' varian lain') : (forName || applies[0]);
      form.dataset.variant = forName || '';
      if (kind === 'gifts') $('ag-ed-title').textContent = (item ? 'Ubah hadiah' : 'Tambah hadiah') + (forName ? ' · ' + forName : '');
      var del = $('ag-ed-delbtn');
      del.hidden = !(item && kind === 'gifts');
      if (item && kind === 'gifts') {
        $('ag-ed-del-id').value = item.id;
        $('ag-ed-del').dataset.confirmText = 'Hapus hadiah "' + item.name + '"' + (forName ? ' dari ' + forName : '') + '? Bot langsung berhenti menyebutnya di jawaban berikutnya.';
      }
      var voucher = kind === 'vouchers';
      $('ag-f-code').required = voucher;
      $('ag-f-code-opt').textContent = voucher ? '(wajib)' : '(opsional)';
      $('ag-f-code-wrap').hidden = kind === 'gifts';
      $('ag-f-gift').hidden = kind !== 'gifts';
      count();
      if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
      $('ag-f-name').focus();
    };

    document.addEventListener('click', function (e) {
      var add = e.target.closest('[data-ag-new]');
      if (add) { open(add.getAttribute('data-ag-new'), null, add.getAttribute('data-for'), add.getAttribute('data-variant')); return; }
      var edit = e.target.closest('[data-ag-edit]');
      if (edit) {
        var item = null;
        try { item = JSON.parse(edit.getAttribute('data-item')); } catch (err) {}
        if (item) open(edit.getAttribute('data-kind'), item, edit.getAttribute('data-for'), edit.getAttribute('data-variant'));
        return;
      }
      if (e.target.closest('[data-ag-close]')) dlg.close();
    });
    dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });

    // Runs before the house confirmation reads the question, so it names what is saved.
    form.addEventListener('submit', function () {
      var kind = $('ag-ed-kind').value;
      var name = $('ag-f-name').value.trim();
      var isNew = !$('ag-ed-orig').value;
      var end = $('ag-f-end').value;
      var endText = end ? new Date(end + 'T00:00:00Z').toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';
      form.dataset.confirm = (isNew ? 'Tambahkan ' : 'Simpan perubahan ') + LABEL[kind] + ' "' + name + '"'
        + (kind === 'gifts' && form.dataset.variant ? ' untuk ' + form.dataset.variant : '')
        + (end ? ', berlaku sampai ' + endText : ', tanpa batas waktu') + '? Bot WhatsApp langsung memakai data ini di jawaban berikutnya.';
    });
  }

  // Copy buttons: the payload, the URL and the curl line.
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-copy]');
    if (!btn) return;
    var src = document.querySelector(btn.getAttribute('data-copy'));
    if (!src || !navigator.clipboard) return;
    navigator.clipboard.writeText(src.textContent).then(function () {
      var label = btn.querySelector('span');
      var was = label ? label.textContent : '';
      btn.classList.add('is-done');
      if (label) label.textContent = 'Tersalin';
      window.setTimeout(function () { btn.classList.remove('is-done'); if (label) label.textContent = was; }, 1600);
    });
  });
})();
`;
