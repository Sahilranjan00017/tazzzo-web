# Engineering status

| Area                                                | State       | Record                                                                                                                                                                                                                                             |
| --------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1 CMS foundation scaffold (`apps/admin`)           | COMPLETE    | PR #1, squash `ddcec0ac3be4a806f66bb8c61e849c8164015c01`, merged-main CI 37102719951, 28/28                                                                                                                                                        |
| W2 Google OIDC + server-side CMS session + `/me`    | COMPLETE    | PR #2, squash `85b1cfc664a622b1eb2cb08649fd526321badbd5`, merged-main CI 37111882071, 67 + 30 = 97                                                                                                                                                 |
| W3 narrow BFF mutation layer + auth/audit hardening | COMPLETE    | PR #3, merged 2026-10-03, squash `e1a105619b09b431bd4c47c29ec16b6042412bb6`, merged-main CI 37114859716                                                                                                                                            |
| W4 CMS shell (nav, roles, toasts, dialogs, states)  | IN REVIEW   | Profile & access page is BACKEND_CONNECTED (`/me`); every other module is NOT STARTED                                                                                                                                                              |
| C1 CMS inventory list + asynchronous import jobs    | IN REVIEW   | Stock list (`GET /api/v1/admin/inventory`, keyset Load more) and import jobs (`/api/v1/admin/imports/jobs`, 11 operations) in `apps/admin`; details below                                                                                          |
| CMS business modules                                | NOT STARTED |                                                                                                                                                                                                                                                    |
| Scheduler / cron                                    | NOT STARTED | Architecture note below                                                                                                                                                                                                                            |
| Customer website (`apps/storefront`)                | IN REVIEW   | Home, PDP, category, search on the public `/v1` API; customer OTP sign-in + sealed server session; customer cart (S2); delivery location, addresses and slots (S3); checkout review, COD order placement, confirmation and Orders (S4); see README |

**CMS C1 (inventory list + import jobs, branch `feature/cms-inventory-list-import-jobs`, on main `37d7d12`):** built exactly on what the backend contract supports (backend `origin/main` `06798ca`, read from source and `docs/ops/BULK_IMPORT.md`, not only the thin OpenAPI).

- **Stock list** (`/inventory`): `listStock` with its CLOSED grammar (`location`, `state` = IN_STOCK|LOW_STOCK|OUT_OF_STOCK|INACTIVE, `limit` <= 200, opaque `cursor`; a typo is a 422, never ignored). First page is server-rendered from the URL filters; "Load more" reads the next page through a new narrow BFF read route (`GET /api/bff/inventory/stock`, `src/server/bff/read.ts`: CSRF header, session, closed query parse, `backendRead`, `no-store`). **A page can be short or empty and still carry a cursor** (corrupt rows are dropped after the page is read): an empty answer is followed automatically (at most 10 hops per click) and the end is only ever a null cursor. 503 `LIST_TIMEOUT` is a retry state that keeps the rows already shown and is never retried automatically. Each row links to the existing per-SKU editor; a reader gets "View" plus a read-only note, a writer "Edit". There is still no product search and no location registry.
- **Import jobs** (`/catalogue/imports/jobs`, `/catalogue/imports/jobs/[jobId]`; module `src/components/imports/jobs`): list with status filter and keyset paging (the backend's `next` always points on, so one extra item is requested to know whether an older page exists), create (only kind `products`), upload, detail with counts and live status, per-row verdict viewer (`from`/`limit`, 100 per page, jump-to-row), row correction, validate, **approve and apply**, resume, cancel, `errors.csv`. BFF: `POST /api/bff/imports/jobs`, `GET /api/bff/imports/jobs/{id}` (poll), `POST .../rows`, `PUT .../rows/{row}`, `POST .../{validate|apply|resume|cancel}`, `GET .../errors.csv` (streamed).
- **Upload:** the file is parsed in the browser with the quick-import wizard's parser, aliases and row validation (shared product-id grammar `^TZP-[A-Za-z0-9-]{1,40}$`, never case-changed), then sent as JSON in requests of <= 200 rows / ~1 MB (the backend and BFF cap a request at 2 MiB; the text/csv upload route is hidden in OpenAPI and would need a non-JSON BFF path). **Each request is atomic on the backend, the whole file is not**: on a failed request the earlier ones stay in the job, the screen says how many rows are stored, and an explicit "Retry from request n" re-sends only the failed one (safe: it stored nothing). Client limits for a file: 20 MiB / 50,000 rows (a job holds up to 250,000; add files one after another).
- **Concurrency:** `version` is sent in the BODY of validate/apply/resume/cancel; a stale or impossible transition is **409 `IMPORT_JOB_STATE`** (there is no If-Match and no 412 on this API); appending rows and correcting a row also bump the version. **Approval:** `apply` is the explicit approval and the backend records the caller from the bearer token as `approvedBy`; the browser never sends an approver (strict schema refuses any extra field; repo-policy test forbids `approvedBy` in client code); the confirmation names the signed-in approver and the counts.
- **Polling:** only the worker-owned states (VALIDATING, APPLYING) are polled: first wait 3 s, x1.5 per unchanged answer up to 15 s, doubled after a failure, never two requests at once, paused while the tab is hidden, stopped on the first non-working status, on 401/403/404, after 5 failures in a row, and on unmount. A changed cursor/version/status triggers one page re-read.
- **errors.csv:** the BFF streams the backend CSV untouched (`text/csv; charset=utf-8`, attachment with a code-built filename, `no-store`, `nosniff`); cells are not re-interpreted. The wait is bounded only until the response headers (an overall timeout would silently cut a long file). The backend can end a very long export early without an error status, so the UI compares the lines received with the job's own negative-row count and warns on a mismatch.
- **Access:** nav "Import jobs" for reader and cms-writer (read-only for readers; "Imports" stays cms-writer), go-to box accepts `IMPJ-<24 hex>`, access matrix row "Import jobs (background, any size)" (reader R, cms-writer R W). The BFF also now answers a backend 413 as 413 instead of a generic 502.
- **Mock backend (`apps/admin/tests/support/fake-jobs.ts`) vs the real one:** same routes, query grammar, status codes, error envelope (`{error:{code,message,request_id}}`), state machine, version compare-and-swap in the body, `approvedBy` from the token, atomic appends, `next` pointers, DUPLICATE ingestion verdicts, errors.csv with formula neutralisation, and the "short or empty page still has a cursor" list contract. Different: the worker is driven by a test control call (`/__control/jobs/tick`, optional `step`/`pause`), with no lease, append lock or tick budget (an "upload in progress" 409 and every other refusal is injected with `/__control/force`); validation checks only the id grammar (no release/vertical existence, GTIN check digits, attribute governance, canonical identity or datastore conflicts), and an applied row only adds a draft product to the fake product table; counter movements between `valid` and `unchanged` at apply, the text/csv upload route, errors.csv paging/`maxTime` truncation, rate limits and the exact `version` increments of each internal step are not modelled; stock rows sort by JavaScript string order (the real list sorts in Mongo binary order) and a corrupt row is a test seed.
- **Known limits:** a row listing returns only the product id and verdicts, so a correction replaces the whole row (every field is re-entered); `line` in the backend's JSON-append path is per request, so the UI shows the job's own 0-based row number (as `errors.csv` does); `attr.*` columns (server CSV extension) are not sent; kind `prices`/`inventory` jobs do not exist on the backend; errors.csv is buffered as a Blob in the browser; no purge/retention of old jobs exists on the backend.

**Storefront cart (S2, stacked on S1 = PR #29):** the customer cart on the existing backend (`/v1/customer/cart*`): typed client
(`server/backend/cart.ts`), BFF routes `/api/cart/{add,update,remove,clear}` + `GET /api/cart` (S1 CSRF guard, strict bodies, canonical
`TZP-` ids never case-changed, quantity 1..20, `If-Match` cart versions with a fresh-cart answer on conflict, closed error codes), `/cart`
page, header count, Add to cart on `/p/[id]`. Backend reports `LOCATION_REQUIRED`/stock `UNKNOWN` until a delivery address is sent (no
address UI yet): shown as information. Not done: checkout, addresses, guest cart/merge. Details: `apps/storefront/README.md` (Cart).

**Storefront delivery (S3, stacked on S2):** delivery location, saved addresses and delivery slots on the existing backend. Location:
`/location` + header chip, `POST /api/location` (`{pin}` -> `GET /v1/serviceability`, or `{addressId}` for a signed-in customer), kept in a
sealed HttpOnly cookie (PIN, serviceable flag, and for a saved address its id bound to the customer id; no name/phone/street). The PIN goes to
product, rail, list and search reads as `?pin=` (only when serviceable); the cart is located by `?addressId=` (the only location it accepts), so
stock/`LOCATION_REQUIRED` become real. Addresses: `/account/addresses*` and `POST /api/addresses{,/update,/delete,/default}` (strict bodies that
mirror `AddressService`, `Idempotency-Key` on create, `If-Match: "address-<n>"` on edit/delete, CSRF, closed error codes, no customer id ever
accepted). Slots: reusable `SlotPicker` + `/checkout/delivery`; the backend takes a slot only when the ORDER is placed (`deliverySlotId`), so the
validated address + slot are kept in a sealed 30-minute cookie for S4 and nothing is reserved. Not done: payment/order placement (S4), default-address
auto-selection, lat/lng. Details: `apps/storefront/README.md` (Delivery location, addresses and slots).

**Storefront checkout and orders (S4, stacked on S3):** the order step on the existing backend. `/checkout` renders the backend's checkout QUOTE
(`POST /v1/customer/checkout/quote`: `{addressId}`, `If-Match: "cart-<n>"`, `Idempotency-Key`) on every request, with the cart, address and slot re-read;
`POST /api/orders` `{quoteId, cartVersion, addressId, slotId}` places the Cash on Delivery order (`POST /v1/customer/orders`, slot from the sealed choice, nothing
priced by the browser); `/orders/[id]?placed=1` is the confirmation; `/orders` and `/orders/[id]` read the caller's orders (cursor paged, ids checked against the backend
grammar, ownership by the bearer token only, no-store). **The backend has no `Idempotency-Key` on placement** (`(customer, quoteId)` is unique): the attempt identity is the
quote, whose creation key is derived from a seed in the sealed checkout cookie + cart version + address and replaced only when a quote ends definitively (expired, price or
stock changed), never on an unknown outcome; a retry after "status unknown" re-places the same quote and can only return the same order. Closed error vocabulary (stock, price
-> re-confirmation, slot full, unserviceable, cart changed, rate limit, 5xx -> "check Orders"); Cancel is offered only where `STOREFRONT_ORDER_CANCEL_WINDOW_SECONDS` mirrors a
backend window (default 0 = closed) and refusals read gracefully. The backend adds no delivery fee/tax/tip, so none is shown. Not done: support cases UI
(`/v1/customer/support/*` exists), payment methods other than COD (none exist), reorder. Details: `apps/storefront/README.md` (Checkout, Cash on Delivery orders and Orders).

**W3 (merged, PR #3):** a narrow BFF mutation layer (`src/server/bff/mutation.ts`). There is no generic proxy: every route
declares its one backend path, method, strict request schema, response schema and header allowlist. Each mutation
checks the CSRF rule (exact Origin + `X-Tazzzo-CSRF: 1`), requires `application/json`, bounds the body at 16 KiB, needs
a valid server-side session, and makes one backend call with only the human's Google ID token (no cookies, no
forwarded headers, no redirects followed, 5 s timeout, never retried). Backend 401 ends the session; 403 keeps it.
Responses are normalized `no-store` JSON with a BFF correlation id and the backend's own `X-Request-Id`. Reference
route: `PATCH /api/bff/catalog/products/{id}/title` -> backend `PATCH /api/v1/products/{id}` (If-Match). Playwright E2E
(Chromium) drives the real runtime with a mock OIDC provider, a token-verifying fake backend and Valkey.

**Deferred:** a cross-repo run against the real backend. The backend accepts only Google's issuer and the web mock
issuer cannot impersonate it without weakening production validation. HUMAN_ADMIN attribution of product mutations
is proven on the backend side (`HumanAdminOidcIT`); cross-repo human audit verification through the CMS moves to the
first real admin mutation slice.

**Not yet:** production deployment, humans moved off the shared `cms-writer` token, audit-read API, fine-grained
permissions, the six backend deployment gates, Pricing LOW-1 (before Pricing Admin). Sensitive admin modules are not
ready. Payment is deferred and comes last.

**Backend contracts:** `docs/backend-contracts/` holds the endpoint references extracted from the backend PRs
(#54-#81, read from an integration checkout, not from `main`). Most of those endpoints are not on backend `main` yet,
so every module built against them is UI-only until it is verified on staging. Notable: concurrency uses
`expectedVersion` in the body (products use `If-Match: <int>`), there is no notification-outbox admin API, no price or
inventory list API, and media uploads return 503 until a storage provider exists.

## Scheduler / cron (architecture note, not implemented)

Production scheduled work will not run inside the CMS. Planned model: AWS EventBridge Scheduler (or a scheduled ECS
task) -> backend internal job/service -> database/queue; the CMS only displays and manages it. A later dedicated CMS
"Scheduler" page would show job name, schedule, enabled state, last/next run, status, duration, retry count, a manual
"Run now" (through a narrow BFF mutation) and execution history.
