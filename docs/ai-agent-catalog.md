# AI Agent: `GET /api/catalog`

What the WhatsApp AI agent on Qontak may say about prices and offers. Read by the Qontak
action `get_catalog`; edited on the dashboard's **AI Agent** menu.

## Sources

| Data | Source | Fresh after |
|---|---|---|
| Prices, compare-at, stock of 17 variants | `https://treelogy.com/products.json?limit=250` (public) | ≤ 1 minute (in-process cache, 10 min stale on failure) |
| Free shipping, promos, vouchers, gifts (gifts per variant, edited on the product row) | store doc `agent/cs-config.json`, edited on **AI Agent** | the next call |
| Fallback when the store is empty, unreadable or invalid | `config/cs_config.default.json` (`config_source: "fallback"`) | — |

Only the 17 rows in `VARIANT_MAP` (`src/agent/catalog.js`) count: pinned variant id first, title
after collapsing whitespace second. Duplicate and archived listings (`BLOCKED_HANDLES`) are
never read. A row that cannot be found is sent as `available: false`, `price_text: null`, and the
dashboard shows a warning.

Dates are WITA (Asia/Makassar). An offer is sent while `starts_at <= today <= ends_at`; `null`
means no limit, and `ends_at` counts: a voucher ending 30 Nov is offered all of 30 Nov.

## Env (`/etc/treelogy/env` on the VPS, never committed)

| Var | Meaning |
|---|---|
| `CATALOG_API_KEY` | If set, requests need header `x-api-key` with this value (else 401). Empty = open. |

No Shopify token is needed: prices come from the public storefront.

## Editing (dashboard → AI Agent)

- Owner, admin, operator can edit; viewer sees only; factory and packer do not see the menu.
- Every save and delete asks first in the confirmation dialog, naming the item and its end date.
- Every change lands in **Log aktivitas** (menu AI Agent) with before/after.
- "Ambil harga" re-reads treelogy.com right now instead of waiting for the one-minute cache.

## Responses

- `200` body as in the brief; `config_source` is `dashboard` or `fallback`.
- `503 {"ok":false,"error":"catalog_unavailable"}` when products.json fails and no recent copy exists.
- `401 {"ok":false,"error":"unauthorized"}` on a wrong/missing key; `405` for anything but GET/HEAD.
- `Cache-Control: s-maxage=300, stale-while-revalidate=600` (no CDN in front today).

```bash
curl -s https://api.treelogy-services.my.id/api/catalog -H "x-api-key: $CATALOG_API_KEY" | jq '.products[0], .vouchers'
```

## Qontak (done in Qontak, not here)

1. API Integrations → action **`get_catalog`**: GET, the URL above, header `x-api-key`.
2. Description: "Panggil action ini setiap kali akan menyebut harga produk, batas gratis ongkir,
   promo, voucher, atau hadiah. Jangan menyebut angka harga atau promo dari ingatan."
3. Attach to capabilities **faq** and **order_placement**.
4. Policy: "Harga, ongkir, promo, voucher, dan hadiah hanya boleh diambil dari hasil get_catalog.
   Kalau action gagal, arahkan ke https://treelogy.com atau teruskan ke tim, jangan menebak."
5. Remove the VARIABEL HARGA & PROMO block from `treelogy_v3_produk_harga.txt` and re-upload it.

## Departures from the brief

- Lives on this VPS, not in the Vercel project `api-nopesanan-qontak`; `POST /api/orders/by-name`
  there is untouched.
- Offers are stored in our store and edited on the dashboard instead of the shop metafield
  `treelogy.cs_config`: the dashboard does not write Shopify (team rule, 7 Oct 2026), and this way
  each change has an author in the activity log and reaches the bot on the next call.
  Hence no metafield seeding script.
