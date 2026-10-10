# Storefront launch scope (`apps/storefront`)

What the customer website ships on day 1, and what it deliberately does not.

## Pages added for launch

| Route      | Backend read (server side, 60 s data cache)         | Status codes                                                                                                                                                        |
| ---------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/faq`     | `GET /v1/content/faqs`                              | 200 always (empty state when there are no articles; "can't load right now" notice when the backend fails)                                                           |
| `/terms`   | `GET /v1/content/legal/terms` (frozen contract)     | 200 always: the document when published; a friendly "This document hasn't been published yet" page (`noindex`, link to Contact) on the backend's 404; notice on 5xx |
| `/privacy` | `GET /v1/content/legal/privacy` (frozen contract)   | same as `/terms`                                                                                                                                                    |
| `/contact` | `GET /v1/app-config` (support phone and email only) | 200 always ("Support details aren't available right now" when absent or unreadable)                                                                                 |

Every page also appears in the footer of every page (FAQ, Privacy, Terms, Contact), the sign-in legal sentence links to `/terms` and `/privacy`, and
`/sitemap.xml` lists `/faq`, `/contact` and each legal page **that is published** (an unpublished one is `noindex` and not listed). `robots.txt`
disallows only `/search`, `/login`, `/account` and `/api/`, so all four are crawlable.

### Decisions

- **Unpublished legal document is HTTP 200, not 404.** The route is real; only its content is missing. A 404 would misreport the site's structure
  and strand a customer who followed a link from the sign-in page. The page is `noindex` and left out of the sitemap while unpublished. (A backend
  outage is also 200 with the standard notice, like every other page.)
- **Legal body is plain text.** Paragraphs are separated by blank lines and rendered as escaped `<p>` elements (line breaks inside a paragraph are kept
  by CSS). It is never parsed as HTML or Markdown; there is no `dangerouslySetInnerHTML` anywhere (a repository policy test enforces it).
- **FAQ answers** are plain text too (`\n` separates paragraphs); grouped by category in the backend's category order, each question a native
  `<details>`/`<summary>` (keyboard and screen-reader accessible, works with JavaScript off).
- **Support links are validated, never injected.** `tel:` only for a value matching E.164 (`^\+[1-9][0-9]{7,14}$`); `mailto:` only for one plain
  address (no whitespace, quotes, commas, `?`/`&` parameters, second `@`). Anything else is treated as absent. The public contract nests the values
  (`support.phone`, `support.email`); the CMS form's flat names (`supportPhone`, `supportEmail`) are accepted too.
- **Caching:** the same rule as every other read: the shared hardened client (`src/server/backend/client.ts`: `/v1/` allow-list, no redirects,
  trusted-caller headers, 5 s timeout), `revalidate: 60` (the backend sends `Cache-Control: public, max-age=60`), a remembered 404 for 60 s. The
  allow-list did not need extending (it is the `/v1/` prefix); slugs come from a closed list (`terms`, `privacy`) before a path is built.
  The pages render per request like all pages (nonce CSP), so there is no change to the proxy matcher or the rate limit.

## Loading states

A route-level `loading.tsx` is **not** used. Two reasons, both found by reading the code:

1. `src/proxy.ts` skips the proxy (rate limit and CSP) for genuine router prefetches, which is safe only because Next renders no components for a
   prefetch while no route has a `loading.*` file (`next/dist/server/app-render/walk-tree-with-flight-router-state.js`; guarded by
   `tests/unit/prefetch-exemption-policy.test.ts`). With a loading boundary every prefetch would render the root layout (cart count, location) and the
   boundary, unlimited. The matcher semantics are to stay unchanged, so that test stays as it is.
2. An implicit boundary above the page makes `notFound()` and the session `redirect()`s that pages issue after a backend read arrive after the response
   has started: HTTP 200 instead of 404 (PDP, category, order detail), client-side instead of 302 redirects (cart, checkout, orders, account).

Instead the shared `PageSkeleton` (`src/components/Skeleton.tsx`: one polite status region with a text alternative, fixed-height blocks, shimmer
off under `prefers-reduced-motion`) is used inside a `<Suspense>` on the two routes where nothing depends on the backend answer for the status code:
**home** (blocks stream in) and **search** (heading first, results stream in). The other data routes (category, PDP, cart, checkout, orders, order
detail, account) are unchanged: they keep their exact 404/redirect behaviour. To give them skeletons the team must first choose between that
behaviour and the prefetch rule: wrap only the secondary parts in `Suspense`, or revisit the prefetch exemption (and re-run the rate-limit tests).

## Deliberate non-pages

- **`/offers`.** Offers are home-only for launch: banners and rails are CMS-managed content blocks on `GET /v1/content/home?channel=web`. A separate
  page would need its own backend read, ordering and scheduling rules and duplicate what home renders. Nothing links to `/offers`.
- **`/refund` (refund policy).** `GET /v1/app-config` exposes a `refundPolicyUrl`, but the frozen legal contract covers `terms` and `privacy` only.
  Refund answers live in the FAQ (category Refunds).
- **`/about`, `/careers`, `/blog`, `/press`:** no backend content and not in the launch scope.
- **Guest checkout, registration, password pages:** sign-in is a phone OTP only; there is no password or separate sign-up.
- **Order tracking by link / `/track`:** order detail (`/orders/[id]`) is the tracking surface for signed-in customers.
- **Wishlist, reviews, notifications settings:** the backend has no such contracts yet.
- **A `/sitemap` HTML page:** `sitemap.xml` is for crawlers; the footer links to the four help pages.

## Other launch polish in this change

- Sign-in code step: "We sent a 6-digit code to ..." was printed twice (the page hint and the live region). It is now said once (the hint), and the
  code field is described by it; a resend announces "A new code has been sent."
- Header at 480 px and below: the nav is a full-width second row, labels never wrap (`white-space: nowrap`; optional words are hidden by CSS only:
  "Set location", "Account", "Not delivering 400001"; the text content is unchanged for tests and crawlers), every link and the search field and button
  are at least 44 px tall.
- Empty search, invalid search, no results and 404 now offer Back to home, Try a different search (where it fits), Contact us and the root categories
  (one cached `GET /v1/categories`; nothing is shown when it cannot be read). The 404 status is unchanged.
- `public/favicon.ico` (16/32/48 px PNG-in-ICO, the brand purple `#5b2be0` with a white "T"; generated locally, no external assets). The proxy matcher
  already excludes `favicon.ico`, so it is served outside the limiter. **A deployment that builds the standalone output must copy `public/` next to
  `server.js`** (Next does not copy it), otherwise the icon 404s.
