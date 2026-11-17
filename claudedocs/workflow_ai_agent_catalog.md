# Workflow: menu "AI Agent" + `GET /api/catalog`

Source: `BRIEF_api_catalog_treelogy_1.md` (17 Nov 2026). Strategy: systematic, depth: deep.

## Decisions (where this departs from the brief, and why)

| Brief | Here | Why |
|---|---|---|
| New endpoint in the Vercel project `api-nopesanan-qontak` | `GET /api/catalog` on this VPS (`api.treelogy-services.my.id`) | The team asked for the data to be managed from our dashboard; the old Vercel project and `POST /api/orders/by-name` are not touched at all. |
| Config lives in shop metafield `treelogy.cs_config`, edited in Shopify admin | Config lives in our store (`agent/cs-config.json`, Redis), edited from the **AI Agent** menu | Team rule since 7 Oct 2026: Shopify is never written from the dashboard (only `treelogy.unique_buyers`). The store also gives every change an author in the activity log, and a save reaches the bot at once instead of after a CDN cache. |
| `config_source: "metafield" \| "fallback"` | `"dashboard" \| "fallback"` | Same meaning: `fallback` still means "the team's data could not be read, these are the defaults in the repo". |
| `Cache-Control: s-maxage=300, stale-while-revalidate=600` | Same header, plus an in-process 60 s cache on `products.json` only | No CDN sits in front of nginx; the config is read fresh from local Redis on every call so a dashboard save is live immediately. |

Everything else follows the brief: whitelist of 17 pinned variant IDs with a normalised-title fallback, prices from public `treelogy.com/products.json`, Rupiah text, WITA date window (`ends_at` inclusive), 503 `catalog_unavailable` when products fail, fallback config when config fails, optional `CATALOG_API_KEY` → `x-api-key`, < 8 KB response, no raw errors.

## Phases

1. **Domain core** `src/agent/catalog.js` (pure, unit-tested)
   - `VARIANT_MAP` (key, handle, pinned variant id, Shopify title, display name)
   - `normalizeTitle`, `findVariant` (id first, title fallback)
   - `rupiahText`, `witaToday`, `witaIso`, `itemStatus` (active / scheduled / expired), `activeItems`
   - `validateConfig` (used on save and to decide fallback), `buildCatalog`
2. **Config store** `src/agent/config-store.js` + `config/cs_config.default.json`
   - `loadAgentConfig()` → `{ config, source, updatedAt, updatedBy }`, never throws
   - `saveShipping`, `saveItem`, `deleteItem` via `updateDoc` (transactional), each returning before/after for the audit
3. **Endpoint** `api/catalog.js`, routed in `server.js`
   - GET only (405 otherwise), timing-safe API key, parallel products + config, 5 s timeout
4. **Dashboard menu** `src/pages/agent.js`, view `agent` ("AI Agent")
   - KPI strip, editor for free shipping / promo / voucher / gift (dialog), live preview of exactly what the bot receives, JSON payload, `curl` for Qontak
   - **Every change asks first** through the house confirmation dialog (`data-confirm`), deletes in the danger tone
   - Writes: `agent_shipping`, `agent_item_save`, `agent_item_delete` → `write` permission, `audit` block with before/after
5. **Tests** `test/agent-catalog.test.js` — the acceptance list in brief §8
6. **Docs** `docs/ai-agent-catalog.md` — env, how to edit, `curl`, Qontak action text

## Checkpoints
- [ ] unit tests green, full suite no new failures vs HEAD
- [ ] page renders in both themes at 390 px and 1440 px
- [ ] live `products.json` read gives 17/17 with the brief's prices
- [ ] push → VPS deploy runs `npm test`; then set `CATALOG_API_KEY` in `/etc/treelogy/env`
