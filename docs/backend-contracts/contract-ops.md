# Tazzzo catalog-service — Ops/Admin HTTP contract (pricing, inventory, service areas, delivery slots, dashboard, me, audit, health)

Source: `tazzzo-backend-int2/services/catalog-service/src/main/java/com/tazzzo/` (paths below are relative to it unless prefixed `docs/`).
Read-only extraction, 2026-10-06. `UNKNOWN` = not determinable from code.

---

## 0. Cross-cutting rules (apply to every `/api/**` endpoint below)

### 0.1 Surface, auth, roles

- `/api/**` is surface `INTERNAL` (`catalog/api/SurfaceClassifier.java:88-89`). Every request passes `ApiAuthFilter`.
- Header: `Authorization: Bearer <token>` — exact, case-sensitive prefix `"Bearer "` (`admin/auth/AdminBearerCredential.java:24-30`). Token = shared service token (→ `SERVICE_ACCOUNT`, `actorId` `service:<role>`, `credentialId` `shared-token:<role>`) or Google OIDC ID token (→ `HUMAN_ADMIN`, `actorId` `google:<sub>`) (`admin/auth/AdminPrincipal.java:52-54`).
- Authorization (`admin/auth/AdminAccessPolicy.java:30-52`), for every endpoint in this doc (none is in the staff namespaces `/orders`, `/support`):
  - non-GET (PUT/POST) requires role `cms-writer`, else `403 FORBIDDEN "role may not perform writes here"`.
  - GET requires `reader` or `cms-writer`, else `403 FORBIDDEN "role may not read this resource"` — except exact URIs `/api/v1/admin/me` and `/api/v1/admin/audit-events`, which any authenticated principal may GET (`catalog/api/ApiAuthFilter.java:46-50`). Staff-only principals (`order-ops`/`support-agent` without catalog roles) may only GET `/me`.
  - Raw URI containing `;` or `%` → 403 (policy) — and in fact earlier `404 NO_SUCH_ENDPOINT` since `SurfaceClassifier.isNormalised` rejects `%`, `;`, `\`, `.`/`..` segments (`SurfaceClassifier.java:125-138`, `ApiAuthFilter.java:91-94`). **Consequence: every path id (skuId, locationId, serviceAreaId, windowId, pincode) must be usable un-percent-encoded.** An id that needs `%XX` (space, `|`, non-ASCII, `/`) is unreachable.
- 401 body (missing/invalid/expired token, domain mismatch, unverified email): `{"error":{"code":"UNAUTHENTICATED","message":"missing or unknown bearer token","request_id":"req_…"}}`. Allowlist refusal (`NOT_ALLOWLISTED`/`DISABLED`): `403 {"error":{"code":"FORBIDDEN","message":"admin access not granted",…}}` (`ApiAuthFilter.java:136-163`). Note filter-written bodies use `Map.of` → key order inside `error` is NOT guaranteed.
- No endpoint here uses `If-Match`, `ETag`, `Idempotency-Key`, `Location`. Concurrency is **body field `expectedVersion`** (CAS). Retries of a create are mutation-safe (duplicate → 409) but not result-idempotent.

### 0.2 Common response headers

- `X-Request-Id: req_<20 hex>` always (server-minted) (`catalog/api/RequestIdFilter.java:40,49`).
- `X-Correlation-Id` echoed only if the inbound one matches `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$` (`RequestIdFilter.java:35,47`).
- Security headers on all responses: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, CSP, HSTS, `Cross-Origin-Resource-Policy: same-site`, `Permissions-Policy` (`catalog/api/SecurityHeadersFilter.java:30-36`).
- `Cache-Control: no-store` only on dashboard + health (explicit). Others: none set explicitly.
- CORS off by default; BFF use assumed (`docs/ops/HTTP_PLATFORM_BASELINE.md` §5).
- Body limit 65536 bytes default → `413 PAYLOAD_TOO_LARGE` (nested envelope on `/api/**`) (`HTTP_PLATFORM_BASELINE.md` §2).

### 0.3 Error envelope (INTERNAL surface)

```ts
type AdminError = {
  error: { code: string; message: string; request_id: string; correlation_id?: string }
}
```

- Per-controller advices (pricing, inventory, service-area, delivery) emit `{code, message, request_id}` only — **never `correlation_id`** (e.g. `pricing/admin/PriceAdminExceptionHandler.java:44-50`).
- Anything those advices don't catch falls through to the global `catalog/api/ApiExceptionHandler.java`, which adds `correlation_id` when a valid one was supplied (`:240-241`). Global mappings relevant here:

| Cause                                                                                   | Status | code                                                                       |
| --------------------------------------------------------------------------------------- | ------ | -------------------------------------------------------------------------- |
| Missing/unparseable JSON body (incl. **no body at all**, wrong JSON type, int overflow) | 400    | `MALFORMED_REQUEST` ("request body is malformed or unreadable") `:163-172` |
| Path/query param type mismatch (e.g. `limit=abc`)                                       | 400    | `MALFORMED_REQUEST` ("parameter 'limit' has an invalid value") `:130-136`  |
| Uncaught `IllegalArgumentException` (incl. all audit-query rejections)                  | 400    | `MALFORMED_REQUEST` `:153-156`                                             |
| Wrong method                                                                            | 405    | `METHOD_NOT_ALLOWED`                                                       |
| Missing/wrong `Content-Type` on PUT/POST                                                | 415    | `UNSUPPORTED_MEDIA_TYPE`                                                   |
| Unmapped route under `/api`                                                             | 404    | `NO_SUCH_ENDPOINT`                                                         |
| `IllegalStateException`                                                                 | 409    | `STATE_CONFLICT`                                                           |
| `ProductNotFoundException` (if not caught locally)                                      | 404    | `NOT_FOUND`                                                                |
| Mongo dup key (uncaught)                                                                | 409    | `DUPLICATE_KEY`                                                            |
| Anything else                                                                           | 500    | `INTERNAL` ("internal error")                                              |

- Because a missing body is a Jackson error, the controllers' `body == null` → 422 branches are effectively unreachable; **an empty PUT/POST body = 400 `MALFORMED_REQUEST`, not 422**.
- No Jackson customisation exists (no `spring.jackson` keys, no custom ObjectMapper) → Spring Boot defaults: unknown JSON fields are **ignored**; float→long truncation and `"123"`→number coercion are Jackson defaults (likely accepted; UNVERIFIED by test).
- Error `message` strings are internal-grade and sometimes echo ids/values (e.g. `"stale update for SKU1 expectedVersion=3"`). Branch on `code` + status, not message.

### 0.4 Actor attribution (all writes)

`AdminActors.require(request)` → `Actor{type, id, credentialId, requestId}` from the authenticated principal + server `X-Request-Id` (`catalog/api/AdminActors.java:19-25`, `common/audit/Actor.java:18`). Nothing in body/headers can set it. Persisted as the `actor` subdocument of the audit event in the same transaction as the state change. Which ledger each domain writes to (matters for `/audit-events` filtering):

| Domain                                      | Ledger                                                                                     | targetType             | targetId                                 | action(s)                                                                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Price PUT                                   | `product_events` (via `WritePath.auxWrite`, `catalog/repo/WritePath.java:115-119,152-155`) | `product`              | skuId                                    | `PRICE_UPDATED` (`pricing/PricingService.java:133`)                                                                                           |
| Inventory PUT / activate / deactivate       | `product_events`                                                                           | `product`              | skuId (location only in hidden `detail`) | `INVENTORY_SET`, `INVENTORY_ACTIVATED`, `INVENTORY_DEACTIVATED` (`inventory/InventoryService.java:107,197`)                                   |
| Service area PUT / activate / deactivate    | `domain_events`                                                                            | `serviceability_pin`   | pincode                                  | `SERVICE_AREA_UPDATED`, `SERVICE_AREA_ACTIVATED`, `SERVICE_AREA_DEACTIVATED` (`serviceability/ServiceabilityService.java:69,162-163,260-261`) |
| Delivery window PUT / activate / deactivate | `domain_events`                                                                            | `delivery_slot_window` | `"<serviceAreaId>                        | <windowId>"`                                                                                                                                  | `DELIVERY_WINDOW_UPDATED`, `DELIVERY_WINDOW_ACTIVATED`, `DELIVERY_WINDOW_DEACTIVATED` (`delivery/DeliverySlotService.java:56,116,174-175,388-390`) |

(Price writes also append a row to `price_events` with the actor, but `price_events` is NOT an audit-read source — `admin/audit/AuditSource.java:8-10`.)

### 0.5 Identifier vocabulary

- **skuId == product `_id`** (`PricingService.java:364-366`; `ProductQueryService.requireProduct` looks up `products._id` — `catalog/tx/ProductQueryService.java:29-33`). Both price and inventory endpoints 404 unless the product document exists (any lifecycle; no lifecycle check).
- **locationId == `fulfillmentLocationId`**: free-form string, 1–128 chars, trimmed, no control chars (`inventory/InventoryKey.java:16-25`, same rule `serviceability/ServiceabilityRoute.java:17-24`). There is **no location registry / no location collection / no list endpoint**. The only place location ids appear is `routes[].fulfillmentLocationId` of service areas. Inventory PUT does **not** check that the location is referenced by any route — any well-formed string creates a row.
- **pincode**: `^[1-9][0-9]{5}$` (`commerce/contract/Pincode.java:13`).
- **serviceAreaId**: 1–128 chars, trimmed, no control chars (`serviceability/ServiceArea.java:46-51`); NOT unique across pincodes (a grouping label). Delivery-slot API additionally forbids `|` (`DeliverySlotService.java:396-401`).
- **windowId**: `[a-z0-9][a-z0-9-]{0,31}` (`delivery/SlotWindow.java:16`).

---

## 1. Pricing — `PriceAdminController` (`pricing/admin/PriceAdminController.java`)

Base: `/api/v1/admin/prices/{skuId}`. Money = integer paise (int64). Currency INR only. **There is NO list endpoint for prices** (only per-SKU GET/PUT; confirmed by `services/catalog-service/docs/openapi.json` path list). No DELETE, no deactivate.

```ts
type PriceResponse = {
  skuId: string
  currency: 'INR'
  sellingPricePaise: number // int64
  mrpPaise: number // int64, >= sellingPricePaise
  version: number // int64, >= 1
  active: boolean // always true for rows written via this API
  status: 'ACTIVE' | 'INACTIVE' | 'NOT_YET_EFFECTIVE' | 'EXPIRED' // never "MISSING" (that is a 404)
}
type PriceRequest = {
  sellingPricePaise: number // REQUIRED, 0..1_000_000_000
  mrpPaise: number // REQUIRED, 0..1_000_000_000, >= sellingPricePaise
  currency?: 'INR' | null // default INR; any other string -> 422 "unsupported currency" (case-sensitive)
  expectedVersion?: number | null // absent/null = CREATE; >=1 = CAS update
}
```

(`PriceAdminController.java:34-37`; bounds `PricingService.java:57,317-345`; `Price.java:28-42`.)

### GET `/api/v1/admin/prices/{skuId}`

- 200 `PriceResponse`. `status` computed vs server clock (`PricingService.java:205-219`, `Price.java:55-61`).
- 404 `NOT_FOUND` "no such product" (product missing) / 404 `NOT_FOUND` "no price set for this product" (product exists, no `price_current` row) — **same code; distinguish only by message** (`PriceAdminExceptionHandler.java:24-32`).
- Reads INR row only.

### PUT `/api/v1/admin/prices/{skuId}`

- Body `PriceRequest`. Order: required-field check → product exists → currency parse → `upsertPrice` (`PriceAdminController.java:59-75`).
- **201** (when `expectedVersion` absent) / **200** (when present), body = fresh `PriceResponse` (re-read via GET).
- CAS: create inserts version 1; update requires stored `version == expectedVersion`, writes `expectedVersion+1` (`PricingService.java:125,144-166`). Update always forces `active=true`, `effective_from/to=null`, `source="admin-api"`.
- 409 `STALE_VERSION`: stale/absent-row update ("stale update for … expectedVersion=N" — an update against a SKU with no price row is also 409, not 404), or create when a row exists ("price already exists for X; use expectedVersion to update") (`PricingService.java:162-183`).
- 422 `INVALID_PRICE`: missing sellingPricePaise/mrpPaise; unsupported currency; expectedVersion < 1; amount > 1e9 paise; negative amount; mrp < selling.
- 404 `NOT_FOUND` "no such product".
- Effective windows (`effectiveFrom`/`effectiveTo`) are NOT accepted by the API (always null) (`PriceAdminController.java:72`).
- Side effects: ledger row in `price_events`, `PRICE_UPDATED` in `product_events` with actor, product-card rebuild enqueue — all one transaction.
- Bulk alternative exists: `POST /api/v1/admin/imports/prices` (out of scope here).

---

## 2. Inventory — `InventoryAdminController` (`inventory/admin/InventoryAdminController.java`)

Base: `/api/v1/admin/inventory/{skuId}/{locationId}`. **There is NO list endpoint** (not per SKU, not per location, not global). To enumerate you must already know (skuId, locationId) pairs: skuIds from `GET /api/v1/products` (cursor list, `catalog/api/ProductController.java:83-101`), locationIds from service-area routes.

```ts
type StockResponse = {
  skuId: string
  fulfillmentLocationId: string
  onHand: number // int64 >= 0
  reserved: number // int64, owned by reservation flow, never set by admin
  available: number // onHand - reserved (derived)
  lowStockThreshold: number // int64 >= 0
  maxPurchasable: number // int64 >= 0 (static per-row cap; no upper bound)
  version: number // int64 >= 1
  active: boolean // GET returns inactive rows too
}
type StockRequest = {
  onHand: number // REQUIRED, 0..1_000_000
  lowStockThreshold: number // REQUIRED, >= 0 (no upper bound)
  maxPurchasable: number // REQUIRED, >= 0 (no upper bound)
  expectedVersion?: number | null // absent = CREATE (reserved=0, active=true); >=1 = CAS update
}
type VersionRequest = { expectedVersion: number } // REQUIRED, >= 1
```

(`InventoryAdminController.java:35-40`; bounds `inventory/InventoryService.java:66,426-450`.) No `stockState` field in the admin response (derivation exists in `InventoryRecord.stockState()`: available==0 → OUT_OF_STOCK; ≤threshold → LOW_STOCK; else IN_STOCK — `inventory/InventoryRecord.java:64-69`).

### GET `/api/v1/admin/inventory/{skuId}/{locationId}`

- 200 `StockResponse`. 404 `NOT_FOUND` "no such product" | "no inventory row for this sku and location". 422 `INVALID_INVENTORY` if locationId/skuId violates `InventoryKey` (IAE mapped by local handler, `InventoryAdminExceptionHandler.java:40-43`).

### PUT `/api/v1/admin/inventory/{skuId}/{locationId}` — ABSOLUTE set (never delta)

- 201 (create) / 200 (update), body = fresh `StockResponse`.
- Update CAS filter: key AND `version == expectedVersion` AND `reserved <= onHand` (`InventoryService.java:124-135`). Never touches `reserved` or `active`.
- Failure disambiguation inside the tx (`InventoryService.java:138-151`): row missing → 404 `NOT_FOUND`; version matches but `onHand < reserved` → **422** `INVALID_INVENTORY` "onHand X would fall below live reserved Y"; else 409 `STALE_VERSION`. Create on existing row → 409 `STALE_VERSION` "inventory already exists for sku@loc; use expectedVersion to update".
- 422 `INVALID_INVENTORY`: missing fields; negative; onHand > 1,000,000; expectedVersion < 1 or overflow; bad key.

### POST `/api/v1/admin/inventory/{skuId}/{locationId}/activate` and `/deactivate`

- Body `VersionRequest` (required). 200 `StockResponse` (fresh GET). Not 201.
- CAS on version → version+1 even if already in requested state (no no-op short-circuit) (`InventoryService.java:184-212`). Counters kept, so relist restores stock.
- 404 row/product missing; 409 `STALE_VERSION`; 422 missing/invalid expectedVersion.

---

## 3. Service areas — `ServiceAreaAdminController` (`serviceability/admin/`)

Base: `/api/v1/admin/service-areas`. One document per **pincode**; `serviceAreaId` is a non-unique grouping label.

```ts
type RouteDto = { fulfillmentLocationId: string; priority: number; active: boolean }
type AreaResponse = {
  pincode: string // ^[1-9][0-9]{5}$
  serviceAreaId: string
  active: boolean // area-level; set true on create, only changed by activate/deactivate
  version: number // int64
  routes: RouteDto[] // stored order (as submitted); may be []
}
type PageResponse = { items: AreaResponse[]; nextCursor?: string } // nextCursor OMITTED (not null) on last page (@JsonInclude NON_NULL)
type UpsertRequest = {
  serviceAreaId: string // REQUIRED: 1..128, trimmed, no control chars
  routes: Array<{
    // REQUIRED (may be empty = configured but unroutable); max 20
    fulfillmentLocationId: string // 1..128, trimmed, no control chars; unique within area
    priority: number // int32 >= 0; unique within area across ALL routes (active or not)
    active: boolean // REQUIRED
  }>
  expectedVersion?: number | null
}
type VersionRequest = { expectedVersion: number }
```

(`ServiceAreaAdminDtos.java:12-22`; invariants `ServiceArea.java:41-76`, `ServiceabilityRoute.java:13-28`.)
Routing: lowest-`priority` ACTIVE route wins (`ServiceArea.java:79-82`). Delivery ETA metadata intentionally absent.

### GET `/api/v1/admin/service-areas?limit=&after=`

- `limit`: int, 1..**199**, default 50 (`ServiceAreaAdminController.java:41-42,51-56`). Out of range → 422 `INVALID_SERVICE_AREA`; non-integer → 400 `MALFORMED_REQUEST`.
- `after`: keyset cursor = **the last pincode of the previous page** (request param is `after`, response field is `nextCursor`). Must be a valid pincode else 422 "invalid cursor" (`ServiceabilityService.java:231-233`).
- Sorted by pincode ascending. Unknown query params are silently ignored (this endpoint does not use `AdminListParams`). No filters (no search by serviceAreaId / active).
- 200 `PageResponse`.

### GET `/api/v1/admin/service-areas/{pincode}`

- 200 `AreaResponse`; 404 `NOT_FOUND` "no such service area"; 422 `INVALID_SERVICE_AREA` "invalid pincode".

### PUT `/api/v1/admin/service-areas/{pincode}` — whole-config replace

- 201 (create, version 1, active=true) / 200 (CAS update: replaces `service_area_id` + `routes`; area `active` untouched) (`ServiceabilityService.java:153-215`).
- 404 `NOT_FOUND` on update of non-existent pin; 409 `STALE_VERSION` on stale version or duplicate create ("service area already exists for pin; use expectedVersion to update"); 422 `INVALID_SERVICE_AREA` for any invariant (missing `routes`, null priority/active, dup location, dup priority, >20 routes, bad id, expectedVersion<1).
- Re-labelling a pin to a different `serviceAreaId` is allowed; delivery windows are keyed by `serviceAreaId`, so a relabel silently detaches the pin from its old windows (inference from `DeliverySlotService` keying; no code links them).

### POST `/api/v1/admin/service-areas/{pincode}/activate` | `/deactivate`

- Body `VersionRequest`. 200 `AreaResponse`. CAS, version+1 always. Deactivated area keeps routes, resolves not-serviceable (`ServiceabilityService.java:249-277`).

### Geo provider / config status

- Port `location/GeoPincodeResolver` (`enabled()`, `resolve(GeoPoint)`); default bean `DisabledGeoPincodeResolver` (`enabled()=false`) unless a provider module supplies one (`location/GeoConfig.java:11-15`). No concrete provider ships (`docs/ops/GEO_PROVIDER.md`).
- Used only by the PUBLIC consumer reads (`commerce/api/CommerceReadController`, `CommerceLocationParser`): `lat/lng` → 400 when disabled; 503 `UNAVAILABLE` on outage.
- **There is NO admin endpoint exposing geo provider status/config** — `/me`, dashboard and service-area APIs do not mention it. A CMS cannot discover whether geo is enabled except by probing the public `/v1/serviceability?lat=&lng=` (400 ⇒ disabled). UNKNOWN beyond that.

---

## 4. Delivery slots — `DeliverySlotAdminController` (`delivery/`)

Base: `/api/v1/admin/delivery-slots/{serviceAreaId}`. Windows are **recurring weekly definitions per serviceAreaId** (not per pincode, not per date).

```ts
type WindowResponse = {
  serviceAreaId: string
  windowId: string // [a-z0-9][a-z0-9-]{0,31}; client-chosen, immutable key
  label: string
  startMinute: number // minutes after local midnight, 0..1439
  endMinute: number // 1..1440, > startMinute (no overnight windows)
  cutoffMinutes: number // 0..10080: booking closes this many minutes before the start
  capacity: number // 1..100000 deliveries PER OCCURRENCE (window x date)
  days: number[] // ISO weekdays 1=Mon..7=Sun, sorted asc, unique, non-empty
  active: boolean
  version: number // int64
}
type ListResponse = { items: WindowResponse[] } // no cursor, unbounded
type WindowRequest = {
  label: string // REQUIRED: 1..60, trimmed, no control chars
  startMinute: number // REQUIRED int32
  endMinute: number // REQUIRED int32
  cutoffMinutes: number // REQUIRED int32
  capacity: number // REQUIRED int32
  days: number[] // REQUIRED, JSON array (dups collapse; null element -> 422)
  expectedVersion?: number | null
}
type VersionRequest = { expectedVersion: number }
```

(`DeliverySlotAdminController.java:27-35`; invariants `SlotWindow.java:16-41`.)

Time model:

- Times are **minute-of-day integers**, not `HH:mm` strings. Interpreted in the configured delivery zone `tazzzo.delivery.zone` (default `Asia/Kolkata`), never the server zone (`delivery/DeliveryConfig.java:20-23`). **The zone is NOT returned by any admin endpoint** (only the customer `GET /v1/customer/delivery/slots` returns `timezone`, `DeliverySlotController.java:31,66`).
- No date-specific rules (no holidays/exceptions/blackouts); only weekday sets. Bookable horizon `tazzzo.delivery.horizon-days` default 3 (allowed 1..14) — also not exposed to admin.
- Occurrence id seen by customers/orders: `slotId = "<windowId>~<yyyy-MM-dd>"` (`SlotOffer.java:12-14`).

### GET `/api/v1/admin/delivery-slots/{serviceAreaId}`

- 200 `ListResponse`, all windows (active + inactive) sorted by `startMinute`, then `windowId` (`DeliverySlotService.java:189-197`). **Unknown serviceAreaId → 200 `{items:[]}`, not 404** (no existence check on read). 422 `INVALID_DELIVERY_WINDOW` "serviceAreaId invalid" if malformed / contains `|`.
- This is the list endpoint per service area; there is no cross-area list. Service-area ids must be discovered from `GET /api/v1/admin/service-areas` (de-duplicate `serviceAreaId` across pincodes).

### GET `/api/v1/admin/delivery-slots/{serviceAreaId}/{windowId}`

- 200 `WindowResponse`; 404 `NOT_FOUND` "no such window"; 422 bad ids.

### PUT `/api/v1/admin/delivery-slots/{serviceAreaId}/{windowId}`

- 201 (create, active=true, version 1) / 200 (CAS update replaces label, minutes, cutoff, capacity, days).
- Requires that ≥1 pincode document carries that `serviceAreaId` (active or not) else **404 `NOT_FOUND` "no such service area"** — checked for create AND update (`DeliverySlotService.java:104-106`, `ServiceabilityService.java:348-351`).
- 404 "no such window" on update of missing window; 409 `STALE_VERSION` ("stale update expectedVersion=N" / "window already exists; use expectedVersion to update"); 422 `INVALID_DELIVERY_WINDOW` for any `SlotWindow` invariant, missing fields, expectedVersion<1.
- Note: the controller's required-field check omits `label`; a null label still fails in `SlotWindow` → 422.

### POST `/api/v1/admin/delivery-slots/{serviceAreaId}/{windowId}/activate` | `/deactivate`

- Body `VersionRequest`. 200 `WindowResponse`. CAS, version+1 always. No service-area existence check here. Deactivation stops new reservations; existing holds untouched (`DeliverySlotService.java:161-187`).

### Capacity / hold semantics (no admin endpoint exposes these)

- Usage counter per occurrence in `delivery_slot_usage`, `_id = "<area>|<window>|<yyyy-MM-dd>"`, fields `used`, `holds[]` (order ids), TTL `expire_at` = day after slot + 7 days (`DeliverySlotService.java:54-58,276-291`).
- Reserve = conditional `$inc used` where `used < capacity` and hold not present → never oversells; idempotent per hold id; release idempotent (`:261-300,344-354`).
- Bookable iff date in [today, today+horizon-1] (zone-local), weekday in `days`, and `now < start - cutoffMinutes` (`:358-368`). Customer status: `CLOSED` if past cutoff, else `FULL` if remaining==0, else `AVAILABLE`.
- **Lowering `capacity` below current `used` is allowed** (no check); remaining clamps to 0, existing holds stay. Changing `days`/times does not move or cancel existing holds. **There is no admin read of used/remaining capacity per occurrence**, and no DELETE of windows.

---

## 5. Dashboard — `GET /api/v1/admin/dashboard/summary` (`dashboard/DashboardController.java`, `dashboard/DashboardSummaryService.java`)

- Roles: `reader` or `cms-writer` (audit-reader-only or staff-only → 403). No query params (any are ignored). Response header `Cache-Control: no-store`.

```ts
type Count = { value: number; capped: boolean }
type DashboardSummary = {
  orders: {
    open_confirmed: Count
    open_out_for_delivery: Count
    last24h_confirmed: Count
    last24h_out_for_delivery: Count
    last24h_delivered: Count
    last24h_cancelled: Count
  }
  inventory: { out_of_stock: Count; low_stock: Count }
  catalog: { products_total: Count; active: Count; draft: Count }
  serviceability: { service_areas_total: Count; active: Count }
  support: { open: Count; in_progress: Count }
  notifications: { pending: Count; failed: Count }
  generatedAt: string // Instant.toString(), UTC ISO-8601, e.g. "2026-10-06T10:00:00.123456Z" (precision varies)
  bounds: { cap: number; maxTimeMs: number; recentWindowHours: number } // 10000, 2000, 24 — key order NOT stable (Map.of)
}
```

- **Capped semantics exactly** (`DashboardSummaryService.java:52-56`): `countDocuments(filter, limit=cap(10000), maxTime=2000ms)`; `capped = value >= cap`. So `value` is at most 10000; `capped:true` ⇔ `value == 10000` ⇔ "at least 10,000" (an exact count of 10,000 is also reported capped). Every count (indexed or not) is capped.
- "last24h_*" = orders with `status==S` AND `createdAt >= now-24h` (by status _now_, created in window — not "transitioned in last 24h") (`:66-69`).
- `inventory.out_of_stock` = active rows with `on_hand <= 0`; `low_stock` = active, `on_hand > 0` AND `on_hand <= low_stock_threshold` (`:73-75`). **Uses `on_hand`, ignoring `reserved`** — differs from the per-row `available`-based stockState.
- `catalog.active/draft` = `lifecycle == "active" | "draft"`. `serviceability.active` = area-level `active==true` (not "has active route").
- Any `MongoException` (incl. a count hitting the 2 s maxTime) → **503** `{"error":{"code":"SERVICE_UNAVAILABLE","message":"dashboard unavailable","request_id":…}}` with `Cache-Control: no-store`; never partial (`DashboardController.java:34-41`).
- Recent activity is intentionally not included: use `/audit-events` (`docs/ops/ADMIN_DASHBOARD.md`).

---

## 6. `GET /api/v1/admin/me` (`catalog/api/AdminMeController.java`)

Any authenticated principal (incl. audit-reader-only and staff-only). No params, no writes.

```ts
type AdminMeResponse = {
  actorType: 'HUMAN_ADMIN' | 'SERVICE_ACCOUNT' // SYSTEM never authenticates over HTTP
  actorId: string // "google:<sub>" | "service:<role>"
  email?: string // allowlist display label; KEY ABSENT (not null) for service accounts or if no label configured
  roles: string[] // sorted asc; subset of "audit-reader","cms-writer","order-ops","reader","support-agent"
}
```

Exact JSON examples:
`{"actorType":"SERVICE_ACCOUNT","actorId":"service:cms-writer","roles":["cms-writer"]}`
`{"actorType":"HUMAN_ADMIN","actorId":"google:1043…","email":"ops@tazzzo.example","roles":["audit-reader","cms-writer"]}`
(`ApiDtos.java:24-25` with `@JsonInclude(NON_NULL)` on `email`; `AdminMeController.java:29-33`; label source `admin/auth/AdminProfiles.java:24-30`.) No credentialId, no token claims. Field order as shown (record order).
Derived capabilities the CMS should compute: write = has `cms-writer`; catalog read = `reader`||`cms-writer`; audit read = `actorType==="HUMAN_ADMIN"` && has `audit-reader` (`AdminPrincipal.java:61-78`).

---

## 7. `GET /api/v1/admin/audit-events` (`catalog/api/AdminAuditEventsController.java`, `admin/audit/*`)

Authorization: passes the filter for anyone authenticated, then the controller requires **HUMAN_ADMIN + `audit-reader`**, checked BEFORE params are parsed → else `403 {"error":{"code":"FORBIDDEN","message":"audit read not granted",…}}` (`AdminAuditEventsController.java:46-52`; `ApiExceptionHandler.java:105-108`). Service accounts can never read audit.

Query params — closed allowlist; every param at most once, non-empty; unknown/repeated/empty/malformed → **400 `MALFORMED_REQUEST`** with fixed message (`admin/audit/AuditEventQuery.java:25-124`). Raw query string is also syntax-checked first (no `&&`, no empty names, valid `%XX`, valid UTF-8, no raw non-ASCII) → 400 "query string is malformed" (`admin/audit/RawQuerySyntax.java`).

| Param        | Format                                                                                  | Semantics                                                                                              |
| ------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `actorType`  | `HUMAN_ADMIN`\|`SERVICE_ACCOUNT`\|`SYSTEM`                                              | equality                                                                                               |
| `actorId`    | `^(google:[A-Za-z0-9_-]{1,255}\|service:[a-z0-9-]{1,32}\|system:[A-Za-z0-9_.-]{1,64})$` | equality                                                                                               |
| `action`     | `^[A-Za-z][A-Za-z0-9_]{0,63}$`                                                          | equality on ledger event type (e.g. `PRICE_UPDATED`)                                                   |
| `targetType` | `^[a-z][a-z0-9_]{0,63}$`                                                                | `product` / `taxonomy_node` select their ledgers; anything else filters `domain_events.aggregate_type` |
| `targetId`   | `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`; **requires `targetType`**                        | equality                                                                                               |
| `requestId`  | `^req_[0-9a-f]{20}$`                                                                    | equality on actor.request_id                                                                           |
| `from`, `to` | `^YYYY-MM-DDTHH:mm:ss(.SSS)?Z$` (UTC 'Z' only, ≤ ms)                                    | inclusive `at >= from`, `at <= to`; `from > to` → 400                                                  |
| `limit`      | `^[0-9]{1,3}$`, 1..**100**, default 50                                                  | page size                                                                                              |
| `cursor`     | `^[A-Za-z0-9_-]{1,128}$` opaque                                                         | must be replayed with IDENTICAL filters, else 400 "cursor does not belong to these filters"            |

```ts
type AuditEventDto = {
  id: string // "<pe|ne|de>_<24-hex ObjectId>"  (pe=product_events, ne=node_events, de=domain_events)
  occurredAt: string // UTC ISO-8601 instant (Instant.toString)
  action: string
  targetType: string // "product" | "taxonomy_node" | domain aggregate_type (e.g. "serviceability_pin","delivery_slot_window","content_block","app_config","bulk_import","order","support_case","customer")
  targetId: string
  actorType: 'HUMAN_ADMIN' | 'SERVICE_ACCOUNT' | 'SYSTEM'
  actorId: string
  credentialId: string | null // non-secret label or null
  requestId: string | null // null only for SYSTEM
}
type AuditEventsResponse = { items: AuditEventDto[]; nextCursor: string | null } // nextCursor PRESENT as null on last page
```

(`ApiDtos.java:32-36`; projection `AuditEventReader.java:117-143`.)

- Order: newest first — `at DESC, source rank ASC (pe<ne<de), _id DESC`; keyset paging; new events never shift later pages (`AuditEventReader.java:21-30,42-44`).
- Only **attributed** events (with an `actor` subdocument) are returned; unattributed legacy/seed events are invisible (`AuditEventReader.java:101-103`).
- **Metadata NOT exposed:** the event `detail` map (so no before/after values, no price amounts, no inventory locationId, no window capacity), no email, no IP, no token. To show "what changed" the CMS must re-read current state.
- Gotcha: delivery-window targetIds are `"<serviceAreaId>|<windowId>"` — `|` is outside the `targetId` grammar, so **you cannot filter by a delivery window's targetId** (400); filter by `targetType=delivery_slot_window` (+ action/actor/time) and match client-side. Same for any skuId/pincode containing chars outside the grammar.
- Inventory events have `targetId = skuId` only — events for different locations of the same SKU are indistinguishable in this API.
- Reads are not themselves audited; counted by metric `admin_audit_read{outcome}`.
- A corrupt ledger row → 500 `INTERNAL` (`AuditRecordCorrupt`).

---

## 8. Health — `catalog/health/HealthController.java`

| Method/path         | Status                           | Body                                                                                                                                      |
| ------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health/live`  | always 200                       | `{"status":"UP","components":{"datastore":"OPEN"\|"STARTING"\|"REFUSED"\|"JOB","mongo":"SKIPPED","rate_limiter":"SKIPPED"}}`              |
| `GET /health/ready` | 200 if up, else 503 (same shape) | `{"status":"UP"\|"DOWN","components":{"datastore":…,"mongo":"UP"\|"DOWN"\|"SKIPPED","rate_limiter":"UP"\|"DOWN"\|"DISABLED"\|"SKIPPED"}}` |

- Surface `HEALTH`: exact paths only; `/health`, `/health/`, `/healthz`, `/actuator/**` → 404 `NO_SUCH_ENDPOINT` (`SurfaceClassifier.java:67-69,93-95`). Unauthenticated (`ApiAuthFilter.java:77-82`), no rate limit, `Cache-Control: no-store`. Readiness cached 1 s, each probe bounded 2 s (`HealthService.java:50-51`). Errors on this surface use the flat public envelope `{code, message, request_id}` with collapsed codes (`ApiExceptionHandler.java:230-233,250-271`).
- Ready = datastore gate `OPEN` AND (mongo ping UP or `TAZZZO_HEALTH_REQUIRE_MONGO=false`) AND (limiter UP or not required/DISABLED) (`HealthService.java:112-130`).
- **Externally reachable? UNKNOWN.** The service answers them to any caller with no credential; whether the ALB/edge forwards `/health/*` publicly is infrastructure not in this repo (docs only say ALB routes `/catalog/v1/**` and target-group checks hit `/health/ready`, `HTTP_PLATFORM_BASELINE.md` §1; `SurfaceClassifier.java:28-31`). Equally UNKNOWN whether `/api/**` itself is exposed publicly vs. private network only. A CMS "system status" panel should call them server-side from the BFF.

---

## 9. Gap summary for the CMS

1. No price list, no inventory list (by SKU, by location, or low-stock list). Only point reads keyed by ids you already know. Dashboard gives counts only, not which SKUs.
2. No location registry: `locationId` is a free string; discover via service-area `routes[]`. Inventory accepts any well-formed locationId (typo ⇒ orphan row, no delete endpoint).
3. No DELETE for prices, inventory rows, service areas or delivery windows; only deactivate (prices cannot even be deactivated).
4. Pagination param names are inconsistent: service-areas `?after=` + `nextCursor` omitted at end (limit ≤199, out-of-range = 422); products/audit `?cursor=` + `nextCursor:null` at end (audit limit ≤100; products ≤200, 400).
5. Same `NOT_FOUND` code for "no product" vs "no price/stock row" — message-only distinction.
6. Inventory `onHand < reserved` returns 422 `INVALID_INVENTORY` (not 409); stale = 409 `STALE_VERSION`.
7. Delivery: minute-of-day ints, weekday sets, no overnight, no date exceptions; zone + horizon not exposed to admin; no capacity-usage read; capacity can be lowered under live holds; unknown area list = 200 empty.
8. Audit: no `detail`; delivery-window `targetId` unfilterable; inventory events lose location; service accounts can't read audit at all.
9. Geo provider status not exposed anywhere on the admin surface.
10. Ids needing percent-encoding in paths are unreachable (404) — enforce URL-safe id grammars in CMS forms.
