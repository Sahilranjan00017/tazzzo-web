# Tazzzo storefront (`apps/storefront`)

The customer website: home merchandising, product detail, category browse and search, rendered by Next.js from the
**public** Tazzzo API (`/v1/**`, tazzzo-backend `docs/api/v1/openapi.yaml`), plus customer sign-in with a phone OTP and a
server-side session (`/login`, `/account`), the customer cart (`/cart`, Add to cart on `/p/[id]`), the delivery location, saved addresses and
delivery slots (`/location`, `/account/addresses`, `/checkout/delivery`), and checkout: the order review, Cash on Delivery placement, the
confirmation and the customer's orders (`/checkout`, `/orders`, `/orders/[id]`). COD is the only payment method the backend has.

## Routes

| Route                          | Backend reads (all from the Next server, never the browser)                                                                      |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `/`                            | `GET /v1/content/home?channel=web`; rails: ONE `GET /v1/products:batch?ids=` per rail; grids: `GET /v1/categories/{id}` per tile |
| `/p/[id]`                      | `GET /v1/products/{id}` (gallery, price, description)                                                                            |
| `/c/[node]`                    | `GET /v1/categories/{id}` (title), `/children`, `/products` (cursor paged)                                                       |
| `/search?q=`                   | `GET /v1/search` (never cached)                                                                                                  |
| `/login`                       | none (the page); the form calls `/api/auth/otp/*`, which call `/v1/auth/otp/*` and `/v1/auth/session`                            |
| `/account`                     | `GET /v1/customer/profile` (bearer); `/api/auth/refresh` and `/api/auth/logout` call `/v1/auth/refresh`, `/logout`               |
| `/location`                    | `GET /v1/serviceability?pin=` (via `POST /api/location`); signed in: `GET /v1/customer/addresses`                                |
| `/account/addresses[/new,/id]` | `GET /v1/customer/addresses[/{id}]`; mutations via `/api/addresses/*`                                                            |
| `/checkout/delivery`           | `GET /v1/customer/addresses`, `GET /v1/customer/delivery/slots?pin=`                                                             |
| `/cart`                        | `GET /v1/customer/cart` (bearer); the page calls `/api/cart/*`, which call `PUT`/`DELETE /v1/customer/cart[/items/{id}]`         |
| `/checkout`                    | `GET` cart, address, slots, then `POST /v1/customer/checkout/quote`; the page calls `/api/orders`, `/api/checkout/refresh`       |
| `/orders`                      | `GET /v1/customer/orders?page_size=&cursor=` (bearer; cursor paged)                                                              |
| `/orders/[id]`                 | `GET /v1/customer/orders/{id}` (`?placed=1` = the confirmation); `/api/orders/cancel` calls `POST .../{id}/cancel`               |
| `/faq`                         | `GET /v1/content/faqs` (grouped by category; `<details>` accordion, no JS needed)                                                |
| `/terms`, `/privacy`           | `GET /v1/content/legal/{terms,privacy}` (plain text body -> escaped `<p>`; unpublished = friendly 200 page, `noindex`)           |
| `/contact`                     | `GET /v1/app-config` (`support.phone` / `support.email`; `tel:`/`mailto:` only for E.164 / plain addresses)                      |
| `/robots.txt`                  | none                                                                                                                             |
| `/sitemap.xml`                 | `GET /v1/categories` (home + super-categories), plus `/faq`, `/contact` and the published legal pages                            |

Launch scope (the help pages, loading states, deliberate non-pages such as `/offers`): `docs/storefront/LAUNCH_SCOPE.md`.

### Home content contract

The backend decides **which** blocks are live for the web (channel `WEB_ONLY`/`BOTH`, publication state, schedule)
and their order; the website renders exactly that, in order, and never filters by audience, status or time, and has
no hardcoded banners. `channel=web` is the only query parameter sent (anything else is a backend 400).

- `BANNER`: `<picture>` with `desktopImageUrl` for viewports `>= 768px` and `imageUrl` otherwise (absent desktop image
  = `imageUrl` everywhere); `altText`; optional `subtitle`. Consecutive banners form one carousel (pause/play, prev/next,
  per-slide buttons, Left/Right keys, autoplay off under `prefers-reduced-motion` and while hovered/focused). Only the
  first banner on the page loads eagerly. The `link` uses the backend's closed grammar and maps to
  `product:<id> -> /p/<id>`, `category:<node> -> /c/<node>`, `search:<text> -> /search?q=<encoded>`; anything else is
  not clickable. A banner whose image is not under the media base (or with no media base configured) is kept with
  the branded placeholder, like every other image that cannot be shown.
- `PRODUCT_RAIL`: the whole rail (at most 20 ids) is ONE `GET /v1/products:batch?ids=TZP-1,TZP-2,...[&pin=]`
  (`getProductsBatch` in `src/server/backend/catalog.ts`; admission cost `1 + distinct ids`, not 20 calls). Cards come back in the
  rail's order; a repeated id shows once, at its first position; ids the backend lists as `missing` (unknown, draft, archived,
  ineligible, **merged**: the batch does not follow a merge to its survivor, unlike `/p/[id]`) are skipped silently, exactly as a failed
  single read was. Batch cards have no gallery, so a product without a thumbnail shows the placeholder (the old single read fell back
  to the first gallery image). Only a card for an id that was asked for, once, and not also reported missing is ever shown.
  - **Ids** are checked against `^TZP-[A-Za-z0-9-]{1,40}$` (exact case, never folded or trimmed) BEFORE the call: an invalid id is
    dropped and never sent (the backend refuses a whole batch for one bad id). Ids are deduped, and chunked at the backend cap of 50
    (a rail never needs more than one chunk; a larger caller gets one call per 50, in parallel, all-or-nothing).
  - **Failure** (429, 5xx, timeout, network, a 400 that validated ids should never get, a malformed body): the rail is empty and
    renders nothing, the same as a rail whose every product failed before. It is **never retried as N single reads**: that would
    cost 20 admission units against the batch's `1 + 20` and defeat the rate-limit model. The failure is logged as one
    `storefront_backend_error` / `_unreachable` / `_malformed` line (route and status only, no ids).
  - **Cache and PIN:** same 60 s data cache as every read, keyed by the full URL (the ids list and, only for a serviceable PIN,
    `&pin=`); a non-canonical PIN is dropped. Trusted-caller headers, 5 s timeout and no redirects as for every read.
- `CATEGORY_GRID`: tiles link to `/c/<node>`; each tile is named by `GET /v1/categories/{id}` (any depth, cached like
  every read). A node that is not visible (404) or whose read fails is skipped; the rest keep grid order.
- Unknown block types and malformed blocks are skipped; the rest of the page still renders.
- Anything skipped or degraded is logged server-side as one counts-only line (no ids, titles or URLs), at most once a
  minute unless the counts change: `storefront_home_blocks_degraded unknown_type=.. malformed=.. invalid_ids=..
invalid_links=.. images_not_allowed=.. media_base=configured|unset`.

## Caching, rate limits and propagation

The backend admits every public read through a token bucket keyed by **client IP** (`ConsumerAdmissionGate`,
`ClientIpResolver`); to the backend, every visitor of this site is this server. So:

- All reads are server-side, through `src/server/backend/client.ts`, with `next: { revalidate: 60 }` (Next data cache,
  per server instance): about one backend call per URL per minute per instance, regardless of traffic.
- Only 200s are cached by Next, so the client also remembers a **404** on a cacheable read for 60 s (bounded) and,
  after a **429**, holds back uncached reads (search, paged lists) until `Retry-After` (max 60 s).
- Search and cursor pages are not cached (`no-store`, as the backend marks them); everything else is.
- No client IP is forwarded (the backend ignores `X-Forwarded-For` from untrusted peers) and no installation id is
  sent (it would add a second shared bucket).
- 5 s timeout, no redirects followed, no retries. 404 -> page 404; 429/5xx/timeout -> a "can't load right now" notice
  (or the last cached copy, which Next keeps serving when a revalidation fails).
- **Trusted caller (optional):** with `TAZZZO_CALLER_NAME` and `TAZZZO_CALLER_SECRET` set, every backend read carries
  `X-Tazzzo-Caller` / `X-Tazzzo-Caller-Secret` so the backend can admit this site through its own bucket (backend
  `TrustedCallerResolver`, merged in tazzzo-backend #108; same header names and name/secret grammar). Server-only: never sent to the browser, never
  logged, only to `TAZZZO_API_BASE_URL` (no redirects followed). CI fails if either name appears in the client bundle.

### Per-visitor rate limit (`src/proxy.ts`, `src/lib/security/rate-limit.ts`)

> **Production MUST set `STOREFRONT_TRUST_PROXY=true`, behind the ALB, with the app unreachable except through it**
> (security group: ALB only). Without the setting the per-visitor limit is off; with it but a reachable app, anyone
> can choose their own `X-Forwarded-For` and so their own bucket. **Fail closed:** in production, setting
> `TAZZZO_CALLER_*` without `STOREFRONT_TRUST_PROXY=true` is a configuration error (every page 500s, the log names only
> `STOREFRONT_TRUST_PROXY`), so unlimited visitor traffic can never be relayed into the backend's caller bucket.

A token bucket per visitor on every request the proxy sees (pages, RSC navigations, robots/sitemap; build assets
never reach it): **60/min, burst 20** by default, plus a stricter **12/min, burst 6** for the uncached paths that always
cost a backend call (`/search`, `/c/<node>?cursor=...`, the sign-in code, PIN, delivery-choice, and `POST /api/orders{,/cancel}` routes). A refused request gets `429` with `Retry-After`, a one-line
`text/plain` body and the usual security headers; it is not rendered and never reaches the backend. Settings:
`STOREFRONT_RATE_LIMIT_*` (see `.env.example`; `0` per minute switches a bucket off; an invalid value fails every
request with a 500 and logs only the variable name). Logs are counts only, at most once a minute:
`storefront_rate_limited page=.. expensive=.. unresolved_client=..`.

- **Per instance, in memory.** No shared store: N instances admit up to N times the rate per visitor, and a restart
  forgets every bucket. At most `STOREFRONT_RATE_LIMIT_MAX_CLIENTS` (10 000) visitors are remembered; the least
  recently seen go first, and a visitor idle long enough to have a full bucket again is dropped.
- **The visitor address.** Next.js does not give `proxy.ts` the socket address: before the proxy runs it sets
  `x-forwarded-for` to the socket address only when the client sent none, so a client-sent value replaces it. Hence:
  - `STOREFRONT_TRUST_PROXY` unset/`false` (default): `X-Forwarded-For` is never read and the per-visitor limit is
    **inactive** (one `storefront_rate_limit_inactive` warning per process).
  - `STOREFRONT_TRUST_PROXY=true` (production, behind the ALB): the entry `STOREFRONT_TRUSTED_PROXY_HOPS` (default 1)
    from the right of `X-Forwarded-For` is the visitor, as the ALB appends what it saw; anything the client wrote to
    the left is ignored. A chain too short or an entry that is not a literal IP falls into one shared, limited bucket.
    IPv6 visitors are keyed by their /64. Only safe if the app is reachable through those proxies alone.
- **Prefetches.** The proxy (and so the limit and the CSP) is skipped only for a genuine Next router prefetch on a PAGE path (never `/api/*`, `/robots.txt` or `/sitemap.xml`: route and metadata handlers ignore those headers and always run in full, so they are always limited and get the security headers, whatever method or headers they carry):
  `rsc: 1` **and** `next-router-prefetch: 1`, the Next server's own rule. Next answers those with a small prefetch
  payload without rendering the page body (measured: replayed `/search` and `/c/<node>?cursor=` prefetches with fresh
  queries made no backend call), and charging them would spend a visitor's tokens on `<Link>`s merely scrolled past
  (a home view sends ~10). They cannot be given their own bucket: Next strips these headers before the proxy runs,
  so inside it a prefetch looks like a navigation. Anything else carrying a prefetch-like header (`next-router-prefetch`
  alone, `purpose: prefetch`, `sec-purpose`) is rendered in full by Next and is limited and given the CSP like any
  page; previously all of those skipped the proxy. The exemption is safe only while no route has a `loading.*`
  boundary and neither PPR nor `cacheComponents` is enabled (Next then renders no components for a prefetch; the skeletons are
  therefore `<Suspense>` inside a page, never a `loading.tsx`);
  `tests/unit/prefetch-exemption-policy.test.ts` fails if that changes.

**Propagation of a CMS change to the website:** the backend reads HOME content live; the storefront caches it for
60 s and then serves the stale copy once more while it revalidates in the background. Expect **up to ~60 s plus the
time until the next visit**, i.e. typically about a minute and at most ~2 minutes under steady traffic. If an HTTP cache
honouring the backend's `Cache-Control: public, max-age=60` is placed between this server and the API, add up to
another 60 s.

## Customer sign-in and session (`src/server/session/*`, `src/app/api/auth/*`)

A backend-for-frontend: the browser never talks to the backend and never holds a backend token.

**Flow.** `/login` takes an Indian mobile number (`+91` / ten digits / leading `0`, the backend `Phone` grammar), then the
6-digit code. `POST /api/auth/otp/request` -> `POST /v1/auth/otp/request`; the challenge id stays in a sealed cookie
(so it is bound to that browser) and the page only learns the masked number. `POST /api/auth/otp/verify` -> `/v1/auth/otp/verify`
(grant) -> `/v1/auth/session` (access + refresh token) -> the session cookie. `/account` reads `GET /v1/customer/profile`.
`POST /api/auth/logout` -> `POST /v1/auth/logout` (revokes the backend session), then clears the cookie; if the backend cannot be
reached the cookie is still cleared and the session simply ages out there.

**Cookies.** `__Host-tz_session` and `__Host-tz_otp` (`tz_session_dev` / `tz_otp_dev` without `Secure` only when
`TAZZZO_SITE_URL` is plain http, i.e. local development). Attributes: `HttpOnly; Secure; SameSite=Lax; Path=/`, no `Domain`,
`Max-Age` = remaining lifetime. Values are sealed with AES-256-GCM (key derived by HKDF from `STOREFRONT_SESSION_SECRET`, random IV,
the cookie's purpose bound in as additional data, expiry inside the sealed payload), so a tampered, expired, re-purposed or
wrong-key value is simply "signed out". The session payload is the access token, refresh token, a per-session CSRF token and
timestamps (sealing refuses anything above 3.8 KB, under the 4 KB cookie limit). Absolute lifetime 30 days (the backend default; it may end a session sooner).
`SameSite=Strict` is not used: it would drop the session on every link in from outside the site.

**Refresh.** The access token (15 min) is treated as expired 30 s early. A page cannot set cookies, so `/account` sends the browser
to `GET /api/auth/refresh?next=...`, which rotates the tokens (`/v1/auth/refresh`; the old refresh token dies), rewrites the cookie
and redirects. Concurrent requests with the same token in one process share one backend call. Backend 401 on refresh ends the session
(`/login?reason=expired`); an outage keeps it and says so. Two instances refreshing one cookie at the same instant can race and the loser signs in again (known limit, gap 11). Tokens refused right after being issued end the session instead of looping.

**CSRF.** Every state-changing route is `POST` + JSON only (body streamed with a hard 2 KiB cap, 413 beyond it) and requires: header `X-Tazzzo-CSRF` (the literal `1`
before sign-in, the per-session token for logout), `Sec-Fetch-Site: same-origin` when sent, and an `Origin` whose host equals the request's
`Host` (the load balancer preserves it). The cookie is `SameSite=Lax` as a second layer. The refresh `GET` serves only same-origin or
direct navigations and redirects only to a same-origin path.

**`next`.** `safeNext` accepts only a path with one leading slash, no backslash or control character, no `.`/`..` segment and no encoded
slash/backslash (checked as given and after each round of percent-decoding, before URL parsing), a result that still resolves on the same
origin, and not `/api/*` or `/login`; anything else becomes `/account`.

**Errors and limits.** The server sends the browser a closed set of codes (`invalid_phone`, `invalid_code`, `expired`, `rate_limited`,
`unavailable`); backend text, ids and tokens never reach the page or logs (only path, status and the backend request id are logged).
Backend 429 is shown as "Too many attempts. Please wait N seconds" from `Retry-After`. The code routes also pass the per-visitor limiter in
the stricter `expensive` bucket (`/api/auth/otp/*`).

**Visitor address.** None is forwarded. The backend takes a client address only from `X-Forwarded-For` of its own trusted proxy and ignores
it from this server (`ClientIpResolver`), and the trusted-caller credential carries nothing about the visitor, so the OTP per-IP buckets see
this server's egress address; the per-phone and per-challenge buckets and the storefront's own per-visitor limit still apply.

## Cart (`src/server/backend/cart.ts`, `src/server/cart/*`, `src/app/api/cart/*`, `/cart`)

The customer cart is the backend's (`CartController`); the site stores nothing. Same BFF rules as sign-in: the browser never sees a
backend token, every call is made by the Next server with the sealed session's bearer token through `sendJson`.

**Contract facts the UI is built on.**

- A line's key is the **product id** (`skuId`, the canonical `^TZP-[A-Za-z0-9-]{1,40}$` grammar, never case-changed: `tzp-1` is refused,
  `TZP-Mix-7` is kept). `PUT /items/{id}` **sets** an exact quantity (1..20; max 50 distinct lines); there is no "add" call.
- Every mutation **requires `If-Match: "cart-<version>"`** (428 without, 412 when stale). Every answer is the full cart, enriched with
  current price, stock and a closed list of `issues` (`PRODUCT_UNAVAILABLE`, `PRICE_UNAVAILABLE`, `LOCATION_REQUIRED`, `UNSERVICEABLE`,
  `OUT_OF_STOCK`, `INSUFFICIENT_STOCK`, `STOCK_UNKNOWN`, `ENRICHMENT_UNAVAILABLE`, `PRICE_CHANGED`), `buyable`, `freshness`
  (`REVALIDATE` after 24 h; carts expire after 7 days and read as empty) and `subtotalPaise` = sum of **priced** lines at **current**
  prices (not a payable total: no delivery, fees, tax). Nothing is reserved or price-locked. There is no merge/guest cart and no
  idempotency key; the version is the only concurrency control.
- **The cart is located by a saved address only** (`?addressId=` on every cart call, see Delivery location below). Without a chosen address the
  backend answers `LOCATION_REQUIRED` and stock `UNKNOWN` for every line, `buyable: false`; the site shows that as information ("Stock and
  delivery are confirmed once a delivery address is chosen", with a link to `/location`), **not** as a blocking problem, and shows every other
  issue exactly as reported. A chosen address the backend no longer knows (404) is retried without it. A known `OUT_OF_STOCK` on the product page
  disables Add to cart up front, otherwise the backend's own answer to the add is what the product page reports.

**Routes** (all `POST` + JSON, body capped at 2 KiB, **exactly** the listed fields, `no-store` JSON out; `GET /api/cart` is read-only):

| Route                   | Body                             | Backend call                                                                                  |
| ----------------------- | -------------------------------- | --------------------------------------------------------------------------------------------- |
| `GET /api/cart`         | none                             | `GET /v1/customer/cart`                                                                       |
| `POST /api/cart/add`    | `{productId, quantity}`          | `GET` the cart, then `PUT` existing + quantity under its version; one retry after a lost race |
| `POST /api/cart/update` | `{productId, quantity, version}` | `PUT /items/{id}` with `If-Match` from the version the screen showed                          |
| `POST /api/cart/remove` | `{productId, version}`           | `DELETE /items/{id}` (a line already gone is success)                                         |
| `POST /api/cart/clear`  | `{version}`                      | `DELETE /v1/customer/cart`                                                                    |

Order of checks: the S1 CSRF rule first (`X-Tazzzo-CSRF` = the session's token, `Sec-Fetch-Site` same-origin, `Origin` host = `Host`;
403), then a session (401), then the body (400: not JSON, too big, extra/missing field, id outside the canonical grammar, quantity not an
integer in 1..20, version not 0..10^15-1), and only then the backend. An expired access token is rotated first (route handlers can set
the cookie); a token the backend refuses is rotated once and the call repeated; a session the backend will not refresh is cleared.

**Errors** are a closed set (`unauthenticated`, `forbidden`, `bad_request`, `conflict`, `not_found`, `item_limit`, `quantity_limit`,
`rate_limited`, `unavailable`) chosen from the backend's public error `code`/status; backend text, ids and tokens never reach the page or
the logs. A **stale version answers 409 with the fresh cart**, which replaces the screen ("Your cart changed in another tab or window");
the change is never applied on top of a cart the customer has not seen. Adding is commutative, so `add` reads the cart itself and
retries once; asking for more than 20 of one item is refused (`quantity_limit`), never silently clamped.

**UI.** `/cart` is rendered from the backend cart on the server (signed out: `/login?next=/cart`; expired token: through
`/api/auth/refresh`; backend down: an alert with "Try again"). Each line: image (media allowlist, else the placeholder), title link,
unit price and struck-through MRP, quantity stepper (capped at a _known_ stock limit), line total, Remove; a note per backend issue
(blocking ones in red, `PRICE_CHANGED` / `LOCATION_REQUIRED` as information), a "needs your attention" count, a stale-cart note
(`REVALIDATE`), a subtotal that says when unpriced lines are left out, and a confirmed "Clear cart". Updates are **pessimistic** (the screen
shows only what the server answered, so a failed change can never leave a wrong cart on screen; controls ignore presses while one is in
flight but stay focusable via `aria-disabled`). Results go to a polite live region, failures to an alert; after Remove/Clear focus moves to
the cart heading; the stepper buttons are 44 px. The header **Cart** link shows the item count: one best-effort cart read per page view for
signed-in visitors (time-boxed to 1.5 s, shared with the `/cart` page render by React `cache`), nothing when it fails.

**Limits / not done.** No checkout, no guest cart or merge, no client-side persistence. `/api/cart/*` passes through the per-visitor limiter (page bucket) like every other request. The
`MAX_QUANTITY_PER_ITEM`/`MAX_DISTINCT_ITEMS` constants (20/50) are the backend's defaults (`tazzzo.customer-cart.*`); if the backend is
configured lower it answers 400 and the customer sees the quantity message.

## Delivery location, addresses and slots (`src/server/location/*`, `src/server/address/*`, `src/server/delivery/*`)

Built only on what the backend serves (controllers read at tazzzo-backend `origin/main` b3ee656): `CommerceReadController`, `AddressController`,
`DeliverySlotController`, `CartLocationResolver`, `CheckoutController`/`OrderController`.

**How a location reaches the backend (there are two forms, not one).**

- Public reads (`/v1/products/{id}`, `/v1/search`, `/v1/categories/{id}/products`, and `/v1/serviceability`) take **`?pin=`**, a six-digit PIN
  `^[1-9][0-9]{5}$` (after trimming). `lat`/`lng` are refused by the backend unless an operator enabled a geo provider, so they are never sent. Without a
  PIN the backend answers anonymously (stock `UNKNOWN`). The site sends the PIN only when `GET /v1/serviceability` said it is serviceable, so the 60 s data
  cache holds one copy per real service-area PIN, never per string a visitor typed. Cached stock can therefore be up to ~60 s old.
- The customer cart takes **only `?addressId=`** of a saved address (looked up scoped to the caller; foreign, unknown and malformed ids are the same
  404). There is no PIN form on the cart. So a signed-in customer who wants real cart stock picks a saved address.
- A list/search **cursor is bound to the location it started under**: after a PIN change the backend refuses the old cursor (400). The pages treat that
  as "start again" and redirect to the first page.

**The location cookie** (`__Host-tz_loc`, `tz_loc_dev` on plain http): sealed (S1 helper, purpose `location`), `HttpOnly; Secure; SameSite=Lax; Path=/`, 90 days.
It holds the PIN, the backend's serviceable answer (true/false/null), and, for a saved address, its id plus the customer id it belongs to; the address
id is honoured only for that customer's session (another customer in the same browser, or signed out, ignores it) and is forgotten on sign-out and
when the address is deleted. No name, phone or street. Signed-out visitors can set a PIN. An unserviceable PIN is remembered as "Not delivering to ..."
(chip, product page) and is not sent to product reads.

**Routes** (all `POST` + JSON, CSRF as the cart: `X-Tazzzo-CSRF` = session token or `1` signed out, `Sec-Fetch-Site`, `Origin` = `Host`; exact fields):

| Route                         | Body                                   | Backend                                                           |
| ----------------------------- | -------------------------------------- | ----------------------------------------------------------------- |
| `POST /api/location`          | `{pin}` or `{addressId}` (signed in)   | `GET /v1/serviceability?pin=` / `GET /v1/customer/addresses/{id}` |
| `POST /api/location/clear`    | `{}`                                   | none                                                              |
| `POST /api/addresses`         | nine address fields + `idempotencyKey` | `POST /v1/customer/addresses` + `Idempotency-Key`                 |
| `POST /api/addresses/update`  | nine fields + `addressId` + `version`  | `PATCH` + `If-Match: "address-<version>"`                         |
| `POST /api/addresses/delete`  | `{addressId, version}`                 | `DELETE` + `If-Match`                                             |
| `POST /api/addresses/default` | `{addressId}`                          | `PUT .../default`                                                 |
| `POST /api/checkout/delivery` | `{addressId, slotId}`                  | `GET` address, `GET /v1/customer/delivery/slots?pin=`             |

A customer id (or any unlisted field) in a body is a 400: the backend takes the customer from the bearer token and scopes every address id to it, so
an id of another customer is a 404 and the BFF adds no user id of its own. Address bodies may be 8 KiB (free text up to ~680 characters); the others 2 KiB.
Validation mirrors `AddressService`: label HOME/WORK/OTHER; name <= 80, lines <= 160, landmark <= 120, city/state <= 80 code points, trimmed, no control
characters; PIN grammar; Indian mobile (sent as `+91...`). Edit and delete present the version the page saw (`409 conflict` when stale, and the page
refreshes); the first address becomes the default; at most 10 (409 `limit_reached`). Create sends an `Idempotency-Key` that the form reuses only while its
contents are unchanged, so a retry after a lost reply never creates a second address. Error codes are a closed set; backend text, ids and PII never reach
the page or the logs (address ids are masked in log labels).

**Slots.** `GET /v1/customer/delivery/slots?pin=` returns `{serviceable, timezone, slots[{slotId, date, startsAt, endsAt, label, status}]}` for the default
horizon (3 days); status is AVAILABLE / FULL / CLOSED (no capacity numbers, computed fresh, nothing reserved by reading). `SlotPicker` is a reusable,
controlled radio group (dates, windows in the delivery zone, "Fully booked"/"Booking closed", unserviceable/empty states). **The backend ties a slot to
the ORDER only** (`deliverySlotId` on placing the order, reserved in its transaction; the checkout quote takes just `addressId` + the cart version), so
`/checkout/delivery` validates the choice with the backend (the address is the caller's and serviceable, the slot is offered for its PIN and AVAILABLE) and
keeps `{customer, addressId, slotId}` in a sealed 30-minute cookie (`__Host-tz_checkout`) for the order step, which must re-check it. It places no order.

**The browser PIN outlives the account on purpose.** The location cookie's PIN and serviceable flag are not cleared when a session expires or a
different customer signs in on the same browser: a PIN is a browser-level shopping choice, not personal data, and a visitor has one before signing in.
What belongs to a customer (the saved-address id, bound to the customer id) is ignored for anyone else and dropped on sign-out, deletion or a new PIN.

**Limits / not done.** The shared 60 s cache holds `lowStockRemaining` (and stock) per serviceable PIN, so a low-stock count can be up to ~60 s old and is
shared by every visitor of that PIN. Client-side checks use JS `trim()`, the backend Java `strip()`/`trim()`: they differ for exotic whitespace (the server and
the backend validate again, so the worst case is a refused save). Payment methods other than Cash on Delivery do not exist in the backend. The cart uses a saved address only if one was chosen (no automatic "use the default address" yet). No
map or lat/lng. Slot horizon is the backend default; `days` is not sent. A PIN's serviceability is checked when it is set (not re-checked per page).

## Checkout, Cash on Delivery orders and Orders (`src/server/checkout/*`, `src/server/orders/*`, `src/server/backend/{checkout,orders}.ts`)

Built only on what the backend serves (controllers read at tazzzo-backend `origin/main` bc0e655: `CheckoutController`, `CheckoutService`, `OrderController`,
`OrderService`, `OrderLifecycleService`, `CustomerOrderDto`, and their exception handlers). The OpenAPI file types these bodies as `JsonNode`, so the
controllers are the source of truth.

**The review (`/checkout`).** Rendered on the server on every request from backend answers only: the cart (located by the chosen address), the saved
address, the slot, and a **checkout quote** (`POST /v1/customer/checkout/quote`, body `{addressId}`, `If-Match: "cart-<version>"` = the cart version just read,
`Idempotency-Key`). The quote carries lines (quantity, unit and line paise), the subtotal, an advisory `benefitPreview` and `moneyPreview`
(`payable = subtotal - discount`); titles, images and MRP come from the cart read. **The backend adds no delivery fee, tax or tip**, so none is shown;
the screen says "Cash on delivery" and the amount to pay. Nothing on the page comes from the browser. A cart the backend will not quote is shown as it is:
`CHECKOUT_ITEM_UNAVAILABLE` (the lines and their closed reasons: out of stock, not enough stock, no longer available, no price...) blocks placement and offers
the cart; `CHECKOUT_UNSERVICEABLE`, a deleted address or a slot that is no longer `AVAILABLE` go back to `/checkout/delivery` with a notice; an empty cart goes to
`/cart`; no session goes to `/login?next=/checkout`; no delivery choice goes to the delivery step. A quote that expired (410) offers "Refresh my review".

**Placing (`POST /api/orders`).** Body, exactly: `{quoteId, cartVersion, addressId, slotId}` (the quote the page showed, and the cart version, address and slot of
that review). No price, total, quantity, payment method or customer id is accepted. Order of checks: CSRF (as the cart), session, bounded strict body, then
the **server-held choice** in the sealed checkout cookie must equal the reviewed address and slot (else `choice_changed`, nothing sent), then the cart's current
version must equal the reviewed one (else `cart_changed`, nothing sent), then `POST /v1/customer/orders` `{quoteId, paymentMethod:"COD", deliverySlotId}`
with the slot from the cookie. The answer is `{ok:true,data:{orderId}}` or a closed error code; the client then does a full navigation to
`/orders/{id}?placed=1`. On success the backend has emptied the cart (only if it is still the purchased version) and the checkout cookie is cleared.

**Idempotency (how a double click, refresh or retry can never make a second order).** The backend has **no `Idempotency-Key` on order placement**:
`(customer, quoteId)` is unique, so placing the same quote again returns the same `CONFIRMED` order (200), and a _different_ quote of an already-ordered cart
is 409 `CART_VERSION_ALREADY_PURCHASED`. The attempt's identity is therefore the **quote**, whose creation is keyed by `Idempotency-Key`:

- The sealed checkout cookie holds a random 32-byte seed (`quoteKey`), minted when the delivery choice is saved. The key sent with the quote is
  `base64url(HMAC-SHA256(seed, "checkout-quote|v1|<cartVersion>|<addressId>"))` (43 characters; `server/checkout/key.ts`). It is derived, not stored, because a
  page render cannot set cookies. The backend fingerprints a quote by cart version + address, so: the same attempt (refresh, second tab, double click) sends the
  same key and gets the **same quote and `quoteId`** back; a changed cart or address changes the key by itself (the old key would be a 409 conflict).
- The seed is **replaced only when the current quote ended definitively**: `QUOTE_EXPIRED` / unknown quote, `PRICE_CHANGED`, or stock / product unavailable at
  placement (the route rotates it before answering, so the re-rendered review gets a new quote), or when the customer presses "Refresh my review", or saves the
  delivery choice again. It is **never** changed by an unknown outcome, a 5xx, a timeout, a rate limit or a slot/address problem.
- **Unknown outcome** (any 5xx including the internal-defect 500, a timeout, a network failure, a 200 that is not a valid order): the screen says the order may
  exist, links to Orders, and "Place order" stays enabled; pressing it sends the SAME `quoteId`, which can only return the order that exists or place the one that
  does not. The cookie also remembers that quote as pending (`placing`): a retry of exactly that quote skips the
  "cart still as reviewed" check (an order that went through has already emptied the cart, which would otherwise read as "cart changed") and asks the backend; any
  other quote is still refused if the cart moved. The marker is dropped by any definite outcome. The client also ignores presses while a request is in flight and after a success.
- Two simultaneous requests for one quote are serialised by the backend (duplicate-key recovery returns the winner), so both get the same order.

**Closed error vocabulary** (`src/lib/checkout/messages.ts`; the backend's text, ids and detail never reach the page or the logs): `unauthenticated` (sign in),
`forbidden`, `bad_request`, `choice_changed`, `cart_changed`, `quote_expired`, `price_changed` (the review shows the old and new total and the button reads "Confirm
<new total> and place order": the customer must press again; the old quote is never placed), `items_unavailable` (the re-rendered review lists the lines),
`slot_unavailable` / `address_changed` / `unserviceable` (back to the delivery step, nothing to press), `already_ordered` (see Orders),
`hold_expired` (retry), `rate_limited` (with `Retry-After`), `unavailable` (nothing was placed: the cart pre-check failed), `unknown` (above).

**Orders.** `/orders` lists the caller's orders newest first, 10 per page, following the backend cursor (`nextCursor`, strict base64url, at most 128 characters; a
cursor outside that shape is dropped and the first page shown). `/orders/[id]` shows one order entirely from the order's own stored snapshot: status
(CONFIRMED / OUT_FOR_DELIVERY / DELIVERED / CANCELLED; a newer status reads "In progress"), items, the money it settled on (`money`: subtotal, discount, payable;
an order without `money` shows no payable, never zero), the address snapshot, the delivery slot, the milestone times (shown in Asia/Kolkata). The order id must match
the backend grammar `^ORD_[A-Za-z0-9_-]{6,64}$` before it is used in a path (otherwise a 404 page with no backend call); the customer is only ever the bearer token,
so another customer's order is the backend's 404 and is shown exactly like an unknown id. All these pages and APIs are `Cache-Control: no-store`.

**Cancel.** `POST /api/orders/cancel` `{orderId, reason}` (reason: `CHANGED_MIND` / `ORDERED_BY_MISTAKE` / `OTHER`) calls `POST /v1/customer/orders/{id}/cancel`. The backend
allows customer cancellation only inside `tazzzo.orders.customer-cancel-window-seconds` after confirmation and **defaults to 0 = closed** (409
`CANCELLATION_WINDOW_CLOSED`), and does not publish that setting. So the Cancel control is offered only when this deployment mirrors the window in
`STOREFRONT_ORDER_CANCEL_WINDOW_SECONDS` (unset or 0 = no control) and the order is CONFIRMED and inside it; the backend still decides every request, and a refusal is
shown as "Cancelling is not available for this order" (not an error code).

**Unknown outcomes and the lost response.** Only a closed error code from this site's own route is a definite answer. A browser-to-Next failure, a proxy's HTML
error page, a truncated or unrecognised body or a 5xx is **status unknown** ("check your orders"), never "no order was placed". Defences, in layers: (1) the route marks the
attempt `placing` in the sealed cookie BEFORE it calls the backend (kept on unknown, cleared on any definite answer); (2) the browser keeps its own mark in this tab's
`sessionStorage` (`PendingOrderNotice` in the layout shows "An order you just tried to place may have gone through" on every page until `/orders` has been visited or the
customer says they checked), because a lost response also loses the server's Set-Cookie; (3) while a mark exists, a "cart changed" / "choice changed" answer (an order
that went through has emptied the cart) is shown as unknown and points to Orders instead of refreshing into an empty cart. Re-placing the same quote can only return that
one order.

**Known limits (reviewed).** (a) The backend re-evaluates Benefits at placement and keeps the result even when it differs from the quote's advisory preview (it does not
answer `PRICE_CHANGED` for it) and offers no pre-commit check, so a total that moves because of a benefit cannot be refused. The review says benefits are re-checked; the
placing screen compares the order's payable with the reviewed one and the confirmation shows "Your total changed from X to Y" (the reviewed amount travels in `?was=`,
display only). (b) A retry after an unknown outcome places the quote the customer saw, even if the cart changed since (the pre-check is skipped for exactly that quote).
(c) `?placed=1` says "your order is placed" only for a CONFIRMED order confirmed in the last 10 minutes.

**Not built (not in the brief's contract).** Support cases (`/v1/customer/support/*` exist; no screen yet), account deletion, reorder, invoices, payment methods other than COD.

## Images

Plain `<img>`/`<picture>` straight from the media CDN (no Next image optimizer, so no image-proxy endpoint). An image is
rendered only when its URL is under `TAZZZO_MEDIA_BASE_URL` (https; plain http only for a loopback host outside
production); the CSP `img-src` admits `'self'` and that origin only. Every image has explicit dimensions or a CSS aspect
ratio. Any image that fails (including before hydration, e.g. the CDN refusing connections) becomes a neutral branded
placeholder that keeps the box and the alt text. PDP gallery: `PRIMARY` first, then `GALLERY` by `order`, alt text from
media metadata or the product name; thumbnails are buttons (Tab, Enter/Space, arrows, Home/End).

## Security

Nonce-based CSP per request (`src/proxy.ts`; no `'unsafe-inline'`/`'unsafe-eval'` in production), static headers in
`next.config.ts` (`nosniff`, `X-Frame-Options: DENY`, `frame-ancestors 'none'`, COOP, Permissions-Policy). Backend text
is always rendered as React text (`react/no-danger` is an error). The public API takes no credential; the optional
trusted-caller secret (`TAZZZO_CALLER_SECRET`) and the session sealing key (`STOREFRONT_SESSION_SECRET`) live only in the server
environment. `src/server/*` is server-only
(ESLint import ban + `server-only`).

## Configuration

See [`.env.example`](.env.example): `TAZZZO_API_BASE_URL` (https in production; plain http only for a loopback host),
`TAZZZO_SITE_URL` (canonical/OG origin; https in production), `TAZZZO_MEDIA_BASE_URL` (the backend's media public base
URL; unset = every image is the placeholder), `STOREFRONT_SESSION_SECRET` (base64/base64url of 32+ random bytes, e.g. `openssl rand -base64 32`; **required in production**, unset elsewhere
switches sign-in off with 503; `STOREFRONT_SESSION_SECRET_PREVIOUS` is the key being rotated out and only opens cookies), optionally
`TAZZZO_CALLER_NAME`/`TAZZZO_CALLER_SECRET`, `STOREFRONT_ORDER_CANCEL_WINDOW_SECONDS` (mirror of the backend's customer cancellation window, 0..604800, default 0 = no Cancel control), and the rate
limit settings `STOREFRONT_RATE_LIMIT_*`, `STOREFRONT_TRUST_PROXY`, `STOREFRONT_TRUSTED_PROXY_HOPS`. In production, `STOREFRONT_SESSION_SECRET` also requires `STOREFRONT_TRUST_PROXY=true` (the per-visitor limit is what bounds sign-in code
requests, since the backend cannot tell visitors apart). Invalid
configuration fails the first render (500) and logs only the field name.

## Commands (from the repository root)

```sh
pnpm dev:storefront                     # http://localhost:3000 (set the env vars first)
pnpm --filter storefront lint
pnpm --filter storefront typecheck
pnpm --filter storefront test           # Vitest unit + component
pnpm test:e2e:storefront                # Playwright on `next dev` vs a fake public API + fake media host
pnpm test:e2e:storefront:prod           # `next build` + `next start`: the PRODUCTION CSP in a real browser
pnpm --filter storefront build          # standalone output
```

## Backend gaps (found while building against the contract)

1. ~~No batch product read~~: resolved by `GET /v1/products:batch` (operationId `getProductsBatch`); a rail is one call.
   **Known N+1 left: `GET /v1/categories/{id}`.** A category grid names each tile with one `GET /v1/categories/{id}` (at most
   12 per grid, `resolveCategoryNames`), because the backend has no batch/ids read for categories. Cached 60 s per URL, so the
   steady-state cost is small; a batch category read would remove it.
2. ~~No category node read by id~~: resolved by `GET /v1/categories/{id}` (tazzzo-backend #109); grid tiles and
   `/c/[node]` titles now use it at any depth.
3. **No category imagery** in the public `Node` (`id`, `name` only): grid tiles are text.
4. **Rate-limit identity (decided; deployment gate open).** Without `TAZZZO_CALLER_*` the storefront server's egress IP
   shares one bucket. The storefront caches (60 s), remembers 404s, backs off after a 429 and limits each visitor
   (above, per instance); with the trusted-caller credential (backend #108) it is admitted on its own bucket. Still
   open: sizing that bucket by load test (every bucket must hold at least 51 units for a full product batch). `GET /v1/categories` (sitemap only) costs
   `1 + sum(scope sizes)` units per call.
5. ~~Product id shape mismatch~~: resolved by tazzzo-backend #110; OpenAPI, cart and content all use
   `TZP-[A-Za-z0-9-]{1,40}`, as this site does.
6. **Banner search grammar vs search:** `search:[\p{L}\p{M}\p{N} ]{2,64}` (combining marks since backend db3623c, so
   Devanagari search banners work) still allows texts `/v1/search` rejects (more than 5 words, 1-letter words only).
   The site shows a hint on a 400.
7. **No banner dimension contract.** The site assumes 16:9 (and 3:1 on desktop when every banner in a carousel has a
   desktop image), `object-fit: cover`.
8. **PDP / category products are `private, no-store`.** The site caches them 60 s server-side (one copy per serviceable PIN, keyed by URL),
   so price/stock shown can be up to ~60 s old.
9. **Cart location is address-only.** `GET/PUT/DELETE /v1/customer/cart*` accept `addressId` but no PIN, so a customer must save an address to see real cart
   stock. **OpenAPI is thin for these endpoints** (`docs/openapi.json` lists no response codes, `isDefault`, the 201 on create, 204 on delete, or the
   `IDEMPOTENCY_CONFLICT`/`ADDRESS_LIMIT_REACHED` codes); the controllers are the source of truth used here.
10. **No product enumeration** for the sitemap.
11. **Visitor IP for OTP buckets.** `/v1/auth/otp/*` rate-limits by client IP, which the backend derives only from a trusted proxy's
    `X-Forwarded-For`; the storefront server is not such a proxy and the trusted-caller credential does not carry the visitor, so all
    sign-ins share this server's IP bucket until the backend offers a trusted way to pass the visitor address (or exempts the caller).
    The per-phone/per-challenge buckets and this site's per-visitor limiter bound abuse meanwhile.
12. **Refresh-token rotation across instances.** The cookie holds the only copy of the refresh token; two instances refreshing the same
    cookie at the same instant can lose the race (the loser signs in again). Single-flight per process removes the common case.
13. **Order placement has no `Idempotency-Key`** and the OpenAPI types the quote and order bodies as `JsonNode` with no error codes; idempotency is the quote id (see Checkout).
    A client cannot tell a lost answer from a failed placement except by retrying the same quote or reading Orders.
14. **The customer cancellation window is not discoverable.** The backend answers 409 `CANCELLATION_WINDOW_CLOSED` (its default) but publishes neither the window nor a per-order
    "cancellable until"; the site mirrors it in configuration.
15. **No delivery fee, tax or tip in the quote or order** (V1 money is `subtotal - discount`), so the review shows none; a future fee would need a contract change and a UI row.
16. **A quote is a snapshot, not a read of the live cart:** `GET /v1/customer/checkout/quotes/{id}` returns the stored quote (or 410), so "current prices" are obtained by
    creating a quote; the review therefore creates one per cart version per attempt.
