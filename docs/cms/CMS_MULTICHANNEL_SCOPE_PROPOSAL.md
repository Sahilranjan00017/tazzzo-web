# Unified CMS multi-channel scope proposal

Status: DIRECTION APPROVED (decisions D1-D9 recorded in section 14); implementation NOT authorized. READ-ONLY AUDIT. No runtime code, migration, deployment config or customer app was changed.
Audited: backend `origin/main` `c3306b6e894cf5d2b09cc2ef0171b36f3d50d6dc` (static reading of an exported copy, no tests run),
`tazzzo-app` working tree, `tazzzo-web` `main` `175e609`. Citations are `services/catalog-service/src/main/java/com/tazzzo/...`.
Target architecture: ONE CMS -> ONE shared backend -> TWO customer platforms (app, website).

## 0. Verdict in five lines

1. The backend has **no** App/Web targeting. `ContentBlock` has no channel, audience or platform field, the public content
   endpoints read no client identifier, and a repo-wide search for `channel|platform|app_only|web_only|client_type|x-client`
   finds only unrelated hits (marketplace `offers_current.channel`, per-OS version fields in AppConfig).
2. Adding channel buttons to the CMS would not work. A new field sent to the current backend is **silently ignored** (typed
   records, no strict-unknown-field setting found), so the CMS could appear to save a channel that was never stored.
3. The "60-second cache" is only the response header `Cache-Control: public, max-age=60`; there is no server-side cache
   and no `Vary`. Publish/unpublish is visible at the origin immediately; downstream caches can lag up to 60 s.
4. **The app does not consume `/v1/content/home` at all today.** Its Home is hard-coded with bundled drawables. So "the app
   receives the banner automatically" needs an app change too, and the website does not exist (`tazzzo-web/apps` has only `admin`).
5. Everything except content blocks (banners, rails, grids, FAQs) and, arguably, app-config legal links is correctly
   shared-global and needs no channel dimension. There is no offer/campaign model in active code.

## 1. ALREADY IMPLEMENTED (backend main)

| Capability                                                                                                                    | Evidence                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Content blocks HOME: BANNER, PRODUCT_RAIL, CATEGORY_GRID; HELP: FAQ                                                           | `content/ContentBlock.java:16-34`                                             |
| Lifecycle DRAFT / PUBLISHED / ARCHIVED; unpublish = PUBLISHED->DRAFT; ARCHIVED is final                                       | `ContentBlock.java:39`; `ContentService.java:90-116`                          |
| Scheduling: optional `startsAt`/`endsAt`, start inclusive, end exclusive, server clock, evaluated per request                 | `ContentBlock.java:81,136-138`; `ContentService.java:137-149`                 |
| Optimistic concurrency (`expectedVersion`, 409 `STALE_VERSION`/`STATE_CONFLICT`) on update and status                         | `ContentService.java:90-116,215-223`; `ContentAdminController.java:86-96`     |
| Audit in the same transaction, actor from the authenticated principal                                                         | `ContentService.java:84,113,198`; `AdminActors.require`                       |
| Admin API: list/get/create/update/status, app-config get/put                                                                  | `ContentAdminController.java:67-109`                                          |
| Public API: `GET /v1/content/home`, `/v1/content/faqs`, `/v1/app-config`, anonymous, rate-limit charged                       | `PublicContentController.java:77,98,122`                                      |
| Public cache header `public, max-age=60`                                                                                      | `PublicContentController.java:39`                                             |
| Banner `link` grammar `product:TZP-..` / `category:TZ[SCGV]-nnnnnn` / `search:text`; rail <=20 ids; grid <=12 ids; title <=80 | `ContentBlock.java:71-102`                                                    |
| Prices: per-SKU selling + MRP (paise), effective window, no channel                                                           | `pricing/Price.java:12-64`                                                    |
| Media sets for PRODUCT/SKU with alt text, width, height, role, CAS                                                            | `media/MediaAsset.java`, `MediaAdminController.java:93-130`                   |
| App already tolerates unknown JSON keys and unknown enums, hides empty rails, shows a neutral well for missing images         | `tazzzo-app .../data/remote/ApiClient.kt`, `ui/common/ProductImage.kt:98-136` |

## 2. REUSABLE

- The whole content lifecycle, scheduling, CAS, audit and admin API: channel targeting is **one added dimension**, not a new system.
- `ContentService.live` query and `isLiveAt` (add a channel predicate).
- Shared-global modules stay as they are: catalogue, taxonomy, pricing, inventory, imports, serviceability, delivery slots,
  orders, notifications, audit. Both platforms already read these through the same `/v1` endpoints.
- CMS shell, `readAsAdmin`/BFF mutation layer, `callBff`, ConfirmDialog, Toast (merged W4 + open PRs).
- App image loader (https only, 6 MiB cap, 1024 px decode cap, `image/*` check) and its missing-image fallback.

## 3. MISSING

| Gap                            | Detail                                                                                                                                                                                                                                             |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Channel field on content       | None in domain, Mongo document, DTOs, public API, OpenAPI.                                                                                                                                                                                         |
| Channel-aware public retrieval | `/v1/content/home` refuses any query parameter (400, `PublicContentController.java:134`); no header read.                                                                                                                                          |
| Banner media model             | A banner has one bare `imageAssetKey`; no alt, no width/height, no variants; the key is **not validated** against any media set or storage. Media owner types are only PRODUCT and SKU (`MediaOwnerType`), so there is no upload path for banners. |
| Real storage provider          | `DisabledMediaStorage` default; uploads return 503 `MEDIA_STORAGE_NOT_CONFIGURED`.                                                                                                                                                                 |
| Offers / campaigns             | No active model. `campaigns` / `campaign_membership` exist only in bootstrap (`SchemaBootstrap.java:31,237`), unreferenced by services. `offers_current.channel` is legacy marketplace ingest with no callers.                                     |
| Cache invalidation             | Not applicable: header-only. No purge hook; no CDN configuration found in this audit.                                                                                                                                                              |
| App content consumption        | App never calls `/v1/content/home` or `/faqs`; Home hero/quality/bulk bands are bundled drawables with hard-coded copy.                                                                                                                            |
| Customer website               | Does not exist.                                                                                                                                                                                                                                    |
| Platform identification        | App sends only `X-Tazzzo-Installation-Id`; no app-version, platform or client header.                                                                                                                                                              |
| Delivery slots / ETA in app    | Mocked (`tazzzo-app/BLOCKERS.md:57-59`); out of scope here but affects "consistent availability".                                                                                                                                                  |

## 4. Module classification (shared-global vs channel publication)

| Module                       | Classification                                  | Reason                                                                                                                                                    |
| ---------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard                    | Shared-global (CMS-internal)                    | Operational counts; optionally a future per-channel split of content counts.                                                                              |
| Catalogue, Taxonomy          | Shared-global                                   | One product/category record; no duplicates. Channel **visibility** of a SKU is not supported by any approved contract: do not add.                        |
| Pricing, Inventory           | Shared-global                                   | Binding checkout price/stock is backend-computed; no channel dimension; channel pricing would be a separate business decision.                            |
| Bulk imports                 | Shared-global                                   | Feeds shared catalogue/price/stock.                                                                                                                       |
| Media                        | Both                                            | Product media shared; **banner media** needs per-target variants.                                                                                         |
| Home banners / rails / grids | **Channel publication**                         | The only module with a current need.                                                                                                                      |
| Campaigns and offers         | Not implemented                                 | A "campaign" today is a banner (+ rail). A true offer/discount model is new work; do not conflate with banners.                                           |
| Delivery areas, slots        | Shared-global                                   | Availability must be identical on both platforms.                                                                                                         |
| FAQ                          | Shared by default; optional channel publication | Same block mechanism; decision needed whether FAQ ever differs by channel.                                                                                |
| Legal content                | Shared-global                                   | Three https URLs in a single `system_config` document; not hosted content.                                                                                |
| App configuration            | Mostly shared; per-OS versions already exist    | `minAndroid/latestAndroid/minIos/latestIos` stay app-only; `storeOpen`/maintenance apply to both unless split (decision). Web has no min-version concept. |
| Notifications                | Shared-global                                   | Six order/support types; no marketing type, no channel.                                                                                                   |
| Audit                        | Shared-global                                   |                                                                                                                                                           |

## 5. Proposed backend change (NOT implemented)

### 5.1 Data model

Add to `ContentBlock` (and the Mongo `content_blocks` document) one optional top-level field:

```
audience: "APP_ONLY" | "WEB_ONLY" | "BOTH"      // proposed names, not existing enums
```

Missing/null in storage = legacy document. `content_blocks` has no `$jsonSchema` validator (`SchemaBootstrap.java:125`), so
no validator migration is needed. `toBlock` (`ContentService.java:252-261`) and `payloadDoc`/doc builder (`:241-250`) use
allow-lists and must be extended in both read and write paths, or the field is silently dropped.

Banner imagery (replaces the single `imageAssetKey` for new content, keeping it as the legacy fallback):

```
payload.images: {
  app?:     { assetKey, width, height, alt },
  mobile?:  { assetKey, width, height, alt },   // mobile web
  desktop?: { assetKey, width, height, alt }
}
```

Rules: `alt` required (<=300, plain text); width/height required (1..20000) so the client can reserve aspect ratio; at
least the variants matching `audience` must be present before PUBLISH (APP_ONLY needs `app`; WEB_ONLY needs `mobile`+`desktop`;
BOTH needs all three **or** an explicit fallback to legacy `imageAssetKey`). Keys must be validated against stored, verified
media rather than only `isSafeKey`.

### 5.2 Admin API (additive)

- `POST/PUT /api/v1/admin/content/blocks` accept `audience` and `payload.images`; `GET` returns them (NON_NULL already omits nulls).
- `GET /api/v1/admin/content/blocks?audience=` optional filter.
- Publishing a block whose required variants are missing returns 422 `INVALID_CONTENT` with a field-level reason.
- Existing rules stay: CAS on `version`, DRAFT-only creation, ARCHIVED final, audit events (add `audience` to the event detail).
- **Capability discovery (important):** because unknown fields are silently ignored by an older backend, the CMS must not rely
  on a successful 200. Require either a documented backend version/capability flag, or read-back verification of `audience`
  after every save and refuse to show the channel UI against a backend that does not echo it.
- **Full-replace hazard:** PUT replaces the payload and window; an older CMS build that does not send `audience`/`images`
  would erase them. Make `audience` omission on PUT mean "keep current" (or reject), decided in the contract.

### 5.3 Public API

Recommended: an explicit, optional query parameter, because `public` caches key on the full URL and there is no `Vary`:

```
GET /v1/content/home?channel=app|web        (also /v1/content/faqs if FAQs get audience)
```

- Parameter absent (including every currently shipped client): return only `BOTH` blocks, and legacy blocks according to the
  legacy-default decision below. Never return a channel-specific block without an explicit channel.
- `channel=app` returns APP_ONLY + BOTH (+ legacy per decision); `channel=web` returns WEB_ONLY + BOTH (+ legacy).
- Response block adds `images` (only the variants relevant to the requested channel) and keeps `imageUrl` as a legacy
  single image for old clients. Additive fields only; OpenAPI has no `additionalProperties: false`, so existing clients are safe.
- `PublicContentController.refuseQuery`/`onlyCategory` and `SurfaceClassifier` must allow the new parameter; the OpenAPI parity
  test (`ApiContractParityIT`) compares operations only, so parameters/schemas must be documented by hand.
- Header alternative (`X-Tazzzo-Client`) is **not recommended** for caching safety unless `Vary: X-Tazzzo-Client` is added and
  verified through the actual CDN. Decision required.
- Delivery of a banner whose media base URL is unconfigured is currently dropped silently (`PublicContentController.java:85-88`);
  keep dropping rather than emitting a broken banner, and add a metric/log.

### 5.4 Legacy content default (DECISION REQUIRED, not made here)

Existing blocks have no channel. Facts: no shipped client consumes them today, and the current API returns identical content
to every caller. Options:

| Option            | Effect                                                                                                      | Recommendation                                |
| ----------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Legacy = BOTH     | Preserves the existing "same for every caller" semantics exactly; first website shows old banners too.      | Recommended for API backward compatibility.   |
| Legacy = APP_ONLY | Prevents old content appearing on a website that has not been designed; matches the only intended consumer. | Safer if legacy banners are app-art-directed. |

Either way: do not rewrite stored documents. Interpret "field absent" at read time and record the chosen default in code and
OpenAPI. A later explicit backfill is optional. Product owner must choose.

### 5.5 Persistence and migration strategy

- No collection migration required for the field itself. A new index is optional (the 200-block cap per placement makes an
  in-memory channel check acceptable); if added, it needs a numbered migration (V0014+), and `MigrationRegistryTest` and
  `IndexContractIT` checksums must be updated.
- Rollout: (1) backend deploys additive read+write support; (2) verify capability echo; (3) CMS ships the channel UI; (4)
  clients adopt `channel=`; (5) only then author channel-specific content. Rolling back the backend before step 5 loses nothing.

### 5.6 Cache and publication guarantees (achievable, documented honestly)

- Origin: change visible on the next request after the Mongo transaction commits (no server cache exists).
- Downstream: up to **60 s** after publish, unpublish, archive and at `startsAt`/`endsAt` boundaries for any client or CDN
  honouring `max-age=60`. A cached response can show a block up to 60 s after `endsAt` or hide it up to 60 s after `startsAt`.
- Guarantee to state in the CMS: "live within about 1 minute of publishing; ends within about 1 minute of the end time."
- Options to tighten (decision): shorter max-age for content (cost: request rate), `ETag`/`304` revalidation (needs backend
  work and rate-limit review), or a CDN purge hook (needs an infrastructure dependency not found in this audit).
- Emergency unpublish has the same 60 s tail; document it.

## 6. Proposed CMS change

- Home-content module (existing plan CMS-12) gains: audience selector (3 values, with plain-language explanation of each),
  per-target image slots with live aspect-ratio crop previews (app / mobile web / desktop web), required alt text, schedule
  pickers in Asia/Kolkata with explicit start-inclusive/end-exclusive wording, draft/publish/unpublish/archive with
  ConfirmDialog, `expectedVersion` conflict handling, an "effective status" badge (draft / scheduled / live / ended /
  archived) computed from the server clock-independent fields plus a refresh, and a "may take up to a minute to appear" notice.
- Capability gate: if the backend does not echo `audience`, show the module read-only with a clear "backend update required" state.
- Broken-media states: variant missing, key unverified, media storage not configured (503), upload failure; publish disabled
  with an explanation until required variants are present.
- Media: banner upload flow through a backend-authorized signed upload (needs a banner owner type and a storage provider).
- Preview: channel switcher that renders the block as the app/mobile/desktop would, using documented layout ratios.
- Everything else in the CMS stays channel-agnostic. No per-channel pricing or stock UI.
- Authorization stays backend-authoritative: `cms-writer` for writes, `reader|cms-writer` for reads; no new roles.

## 7. Image strategy (derived from real layouts; web values need a web design)

Measured from `tazzzo-app` code (not invented):

| Target             | Layout (code)                                                                           | Ratio    | Source                                     |
| ------------------ | --------------------------------------------------------------------------------------- | -------- | ------------------------------------------ |
| App hero           | full width, `aspectRatio(588/330)`, crop anchored CenterEnd, text over left 56%         | 1.78 : 1 | `ui/home/RemoteHomeScreen.kt:214`          |
| App quality banner | 16 dp side padding, `aspectRatio(528/178)`, 18 dp radius, CenterEnd, text over left 58% | 2.97 : 1 | `RemoteHomeScreen.kt:268`, `Tokens.kt:138` |
| App bulk band      | full width, `aspectRatio(588/250)`, wave edge                                           | 2.35 : 1 | `RemoteHomeScreen.kt:312`                  |
| App decode cap     | 1024 px longest side; 6 MiB max download; https only                                    | n/a      | `image/RemoteImageLoader.kt`               |
| Reference width    | 390 dp                                                                                  | n/a      | `PdpModel.kt:65`                           |

Arithmetic (inference): at 390 dp x 3x, hero ~1170 x 657, quality ~1030 x 347; the 1024 px decode cap means larger app
images are wasted bytes. **Therefore app variants should be at most ~1024 px on the long edge** (or the loader cap must be raised).

Website sizes: **not derivable today**, because no web layout, breakpoint or design token set exists in any repo
(app tokens exist only in code: Green `#00411C`, Cream `#FAF9F6`, radii 8/14/18/22). Proposal: define web hero slots only after
the web design exists; until then the CMS stores `width`/`height` per uploaded image and the website chooses a crop at render
time. Provide **no** fixed web dimensions in the contract. Also note the app crops anchored at CenterEnd with text on the
left, so banner art needs a documented safe area; consider an optional `focalPoint`/`safeArea` field.
Image formats: backend allows jpeg/png/webp only (`MediaAsset`).

## 8. App change required (APP CHANGE REQUIRED)

1. Adopt `GET /v1/content/home?channel=app`: today Home is hard-coded. Render BANNER/PRODUCT_RAIL/CATEGORY_GRID blocks,
   skip unknown types, hide empty blocks, fall back to the bundled art when the endpoint is empty/unavailable.
2. Product rails/grids carry only ids: the app needs batch card lookup or per-id product fetch (no batch-by-ids endpoint was
   found; confirm) to resolve them with PIN-dependent price/stock/serviceability.
3. Revalidate on the documented cadence (<= 60 s HTTP cache) and handle missing/failed images (existing fallback).
4. Optionally send an app-version/platform header for diagnostics (not for targeting).
5. Category-grid blocks reference taxonomy nodes; categories have no image field today (affects grid art).

## 9. Website change required (WEBSITE CHANGE REQUIRED, future repo)

The website is not started. Contract it will need: `channel=web` content, `images.mobile/desktop` with width/height/alt,
unknown-block skipping, link grammar resolution (`product:`/`category:`/`search:`), PIN-dependent product cards, the same
price/stock/serviceability endpoints, a way to avoid the app's `X-Tazzzo-Installation-Id` (a web equivalent for rate
limiting must be decided), CORS for `www.tazzzo.com`, and the same cache semantics (<= 60 s). Prices and stock must come from
the same endpoints so both platforms agree; the website must never compute price.

## 10. Backward compatibility and rollout

- Additive only: new optional field, new optional query parameter, new response field; no removed or renamed field.
- Existing published content keeps its current visibility per the approved legacy default.
- Order: backend -> verify capability echo -> CMS UI -> app adoption -> website. CMS must refuse the channel UI on an old backend.
- Old CMS builds: define `audience` omission on PUT as "unchanged" to avoid erasing it.
- Rollback: unpublish via status change; revert CMS; channel field is harmless to older readers.

## 11. Security and performance risks

| Risk                                                               | Mitigation                                                                                              |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Silent drop of an unknown field gives a false "saved"              | Capability echo + read-back verification before the UI is offered                                       |
| Cache poisoning/leak across channels (`public`, no `Vary`)         | Channel in the URL (query param) so cache keys differ; never infer channel from a header without `Vary` |
| Channel-specific content leaking to the other platform             | Server-side filter; absent param returns BOTH only; tests below                                         |
| Unvalidated `imageAssetKey` pointing at arbitrary/unverified media | Validate keys against stored, verified media; https base only; allow-listed content types               |
| Missing media silently dropping a banner                           | Pre-publish validation in the backend and the CMS; keep server-side drop + metric                       |
| XSS via banner title/alt                                           | Already plain-text validated (`<>` rejected); render as text only                                       |
| Open links in banners                                              | Existing closed `link` grammar; keep                                                                    |
| Scheduling surprise (timezone)                                     | Store UTC Instants; CMS shows Asia/Kolkata and UTC; end exclusive                                       |
| Staleness on emergency unpublish                                   | Documented 60 s tail; optional shorter TTL/purge                                                        |
| Public endpoint abuse                                              | Existing admission charge; web needs its own identity for rate limiting                                 |
| Write-write conflicts                                              | Existing CAS; CMS shows conflict and reloads                                                            |
| Performance                                                        | 200-block cap per placement, one Mongo query per request; fine at current scale                         |

## 12. Acceptance tests (required before any release of this feature)

Backend (integration, Testcontainers/`ContentIT` style): APP_ONLY only for `channel=app`; WEB_ONLY only for `channel=web`;
BOTH for both; no param returns BOTH only; DRAFT never public; ARCHIVED never public; scheduled block hidden before
`startsAt`, visible at `startsAt` (inclusive), hidden at `endsAt` (exclusive); unpublish removes from every channel;
legacy documents (no field) follow the approved default; unauthorized publish rejected (403) for `reader`, `order-ops`,
`support-agent`, `audit-reader`; stale `expectedVersion` -> 409; PUT without `audience` keeps it; publish blocked without
required image variants; unverified/missing media key rejected; `images` limited to the requested channel; OpenAPI documents
the parameter and fields; `Cache-Control` equals the documented value on every channel response and URLs differ per channel.
CMS (component + Playwright against a capability-aware fake backend, labelled mock): audience selector; per-target previews;
required alt/size; schedule in IST; effective-status badge; publish disabled with explanation when variants are missing;
conflict message; read-only when the backend lacks the capability; permission-denied for `reader`.
App/website (their repos): channel param sent; unknown block skipped; missing image fallback; responsive variant selection;
both platforms show identical price/stock for the same PIN.
Real-environment: at least one staging check that app and web retrieve the same BOTH block and that an APP_ONLY block is absent from web,
with the observed publish-to-visible delay recorded. Mock results must never be reported as this.

## 13. Suggested PR breakdown

| PR  | Repo         | Content                                                                                | Depends on           | Rough size    |
| --- | ------------ | -------------------------------------------------------------------------------------- | -------------------- | ------------- |
| B1  | backend      | `audience` field, admin DTO/service read-write, audit, capability echo, tests          | decisions D1, D2     | M             |
| B2  | backend      | public `channel` param, filtering, `images` variants in response, OpenAPI, cache tests | B1                   | M             |
| B3  | backend      | banner media owner type, key validation, variant rules, pre-publish checks             | B1; storage provider | M-L           |
| B4  | backend      | optional shorter TTL / ETag / purge                                                    | D5, infra            | S-M, optional |
| C1  | web (CMS)    | Home-content module with audience selector and capability gate                         | B1                   | M             |
| C2  | web (CMS)    | Banner media variants, crop previews, alt text, publish validation                     | B3                   | M             |
| C3  | web (CMS)    | FAQ and app-config modules (channel-aware only if D3 says so)                          | B1                   | S-M           |
| A1  | app          | Consume `/v1/content/home?channel=app`, batch resolve rails, fallbacks                 | B2                   | M-L           |
| W1  | new web repo | Website content consumption and product cards                                          | B2, web design       | L             |
| T1  | all          | Cross-system acceptance suite on staging                                               | all above            | M             |

Estimates are relative (S/M/L), not calendar commitments; they exclude product/design decisions and the storage provider.

## 14. Decisions (approved in independent review; implementation PRs still need separate authorization)

| #   | Decision                        | Outcome                                                                                                                   | Clarification / consequence                                                                                                                                                                                                                                                                             |
| --- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Legacy content default          | **BOTH.** Preserves the existing public API behavior.                                                                     | Interpret "field absent" as BOTH at read time; do not rewrite stored documents. With no `channel` parameter the public API returns BOTH-audience blocks plus legacy blocks (which are BOTH), so every currently shipped client sees exactly what it sees today. Record the default in code and OpenAPI. |
| D2  | Channel identification          | **Query parameter `channel=app\|web`**, with authoritative backend filtering.                                             | Distinct URLs keep `public` cache keys apart without `Vary`. Unknown values return 400 (closed grammar, like other public params). Channel-specific blocks are never returned without an explicit channel. Not a security boundary: it targets content; it does not authenticate.                       |
| D3  | FAQs, legal, shared config      | **Global initially.** Existing Android/iOS version fields stay platform-specific.                                         | No `audience` on FAQs or legal links in the first release; the block mechanism can add it later without a contract break. `minAndroid/latestAndroid/minIos/latestIos` unchanged; web has no min-version concept. `storeOpen`/maintenance apply to both channels.                                        |
| D4  | Banner variants                 | **Three variants: app, mobile web, desktop web.** Backward compatible; website dimensions finalized after website design. | Keep legacy `imageAssetKey` as the fallback so existing content and old clients are unchanged. Store width/height/alt per variant so no web dimension is fixed in the contract now. App variant can ship first.                                                                                         |
| D5  | Publication delay               | **Accept the documented 60 s cache delay** for the initial release.                                                       | The CMS must disclose it at publish time and state plainly that **emergency unpublish/archive can also take up to 60 s** to disappear from clients or caches honouring `max-age=60`. No purge or shorter TTL is promised.                                                                               |
| D6  | Media provider / CDN            | **External dependency.** Do not simulate successful uploads.                                                              | Real upload verification stays BLOCKED_BY_EXTERNAL_PROVIDER. The CMS may build and test the UI/BFF against the documented 503 `MEDIA_STORAGE_NOT_CONFIGURED`, labelled as such; metadata-only PUT of unverified keys must be shown as unverified, never as a successful upload.                         |
| D7  | Offers, discounts, coupons      | **Separate backend gap/specification.** Banners are not a promotional engine.                                             | See `CMS_PROMOTIONS_BACKEND_GAP.md`. No campaign, coupon or discount UI is built on banners; today's pricing (selling price + MRP) is unchanged.                                                                                                                                                        |
| D8  | Website layouts and breakpoints | **Handled in the customer-website workstream.**                                                                           | No web image sizes or crop rules are fixed here.                                                                                                                                                                                                                                                        |
| D9  | Website rate-limit identity     | **Needs backend security review before implementation.**                                                                  | The public content endpoints charge admission by client identity (`X-Forwarded-For`, `X-Tazzzo-Installation-Id`). A web equivalent must not be invented in the CMS or website; it is gated on that review and on the website workstream.                                                                |

## 15. Impact on the current CMS plan

- Slices CMS-01 (dashboard, PR #6), CMS-02 (products; local WIP, unpushed), CMS-03..11 and CMS-13 (app config, FAQ) are
  unaffected: shared-global data.
- CMS-12 (home content) is re-scoped as above and is **blocked by backend change B1/B2** and decisions D1, D2, D4. A
  channel-less version of the module is possible, but it would have to be reworked, so it is deferred.
- CMS-07 (media) is expanded by B3 and blocked by D6 for real uploads.

## 16. External dependencies

Media storage provider and CDN (D6); web design and the web repo (D8); infrastructure CDN purge capability if chosen;
backend release process (security gate PR #91 still open at audit time); staging environment and test accounts for the
real-environment acceptance run.

TAZZZO UNIFIED CMS MULTI-CHANNEL SCOPE: READY FOR REVIEW
