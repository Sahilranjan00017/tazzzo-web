# Tazzzo storefront (`apps/storefront`)

The customer website: home merchandising, product detail, category browse and search, rendered by Next.js from the
**public** Tazzzo API (`/v1/**`, tazzzo-backend `docs/api/v1/openapi.yaml`). No sign-in, cart or checkout yet.

## Routes

| Route          | Backend reads (all from the Next server, never the browser)                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| `/`            | `GET /v1/content/home?channel=web`; rails: `GET /v1/products/{id}` per id; grids: `GET /v1/categories/{id}` per tile |
| `/p/[id]`      | `GET /v1/products/{id}` (gallery, price, description)                                                                |
| `/c/[node]`    | `GET /v1/categories/{id}` (title), `/children`, `/products` (cursor paged)                                           |
| `/search?q=`   | `GET /v1/search` (never cached)                                                                                      |
| `/robots.txt`  | none                                                                                                                 |
| `/sitemap.xml` | `GET /v1/categories` (home + super-categories)                                                                       |

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
- `PRODUCT_RAIL`: each id is read with `GET /v1/products/{id}`; missing/hidden/failing products are skipped silently.
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
cost a backend call (`/search`, `/c/<node>?cursor=...`). A refused request gets `429` with `Retry-After`, a one-line
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
- **Prefetches.** The proxy (and so the limit and the CSP) is skipped only for a genuine Next router prefetch:
  `rsc: 1` **and** `next-router-prefetch: 1`, the Next server's own rule. Next answers those with a small prefetch
  payload without rendering the page body (measured: replayed `/search` and `/c/<node>?cursor=` prefetches with fresh
  queries made no backend call), and charging them would spend a visitor's tokens on `<Link>`s merely scrolled past
  (a home view sends ~10). They cannot be given their own bucket: Next strips these headers before the proxy runs,
  so inside it a prefetch looks like a navigation. Anything else carrying a prefetch-like header (`next-router-prefetch`
  alone, `purpose: prefetch`, `sec-purpose`) is rendered in full by Next and is limited and given the CSP like any
  page; previously all of those skipped the proxy. The exemption is safe only while no route has a `loading.*`
  boundary and neither PPR nor `cacheComponents` is enabled (Next then renders no components for a prefetch);
  `tests/unit/prefetch-exemption-policy.test.ts` fails if that changes.

**Propagation of a CMS change to the website:** the backend reads HOME content live; the storefront caches it for
60 s and then serves the stale copy once more while it revalidates in the background. Expect **up to ~60 s plus the
time until the next visit**, i.e. typically about a minute and at most ~2 minutes under steady traffic. If an HTTP cache
honouring the backend's `Cache-Control: public, max-age=60` is placed between this server and the API, add up to
another 60 s.

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
trusted-caller secret (`TAZZZO_CALLER_SECRET`) lives only in the server environment. `src/server/*` is server-only
(ESLint import ban + `server-only`).

## Configuration

See [`.env.example`](.env.example): `TAZZZO_API_BASE_URL` (https in production; plain http only for a loopback host),
`TAZZZO_SITE_URL` (canonical/OG origin; https in production), `TAZZZO_MEDIA_BASE_URL` (the backend's media public base
URL; unset = every image is the placeholder), optionally `TAZZZO_CALLER_NAME`/`TAZZZO_CALLER_SECRET`, and the rate
limit settings `STOREFRONT_RATE_LIMIT_*`, `STOREFRONT_TRUST_PROXY`, `STOREFRONT_TRUSTED_PROXY_HOPS`. Invalid
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

1. **No batch product read.** Rails need one `GET /v1/products/{id}` per id (up to 20, admission cost 1 each).
2. ~~No category node read by id~~: resolved by `GET /v1/categories/{id}` (tazzzo-backend #109); grid tiles and
   `/c/[node]` titles now use it at any depth.
3. **No category imagery** in the public `Node` (`id`, `name` only): grid tiles are text.
4. **Rate-limit identity (decided; deployment gate open).** Without `TAZZZO_CALLER_*` the storefront server's egress IP
   shares one bucket. The storefront caches (60 s), remembers 404s, backs off after a 429 and limits each visitor
   (above, per instance); with the trusted-caller credential (backend #108) it is admitted on its own bucket. Still
   open: sizing that bucket by load test, and a batch product read. `GET /v1/categories` (sitemap only) costs
   `1 + sum(scope sizes)` units per call.
5. ~~Product id shape mismatch~~: resolved by tazzzo-backend #110; OpenAPI, cart and content all use
   `TZP-[A-Za-z0-9-]{1,40}`, as this site does.
6. **Banner search grammar vs search:** `search:[\p{L}\p{M}\p{N} ]{2,64}` (combining marks since backend db3623c, so
   Devanagari search banners work) still allows texts `/v1/search` rejects (more than 5 words, 1-letter words only).
   The site shows a hint on a 400.
7. **No banner dimension contract.** The site assumes 16:9 (and 3:1 on desktop when every banner in a carousel has a
   desktop image), `object-fit: cover`.
8. **PDP / category products are `private, no-store`.** The site caches them 60 s server-side because it never sends a
   location, so the answers are the same for everyone; price/stock shown can be up to ~60 s old.
9. **No product enumeration** for the sitemap.
