# CMS launch scope: what the day-1 CMS must have, and what it need not

**Status:** classification of the missing and partial CMS areas, with evidence from the backend's admin routes.
**Backend evidence base:** `tazzzo-backend` `origin/main` `5caee8e` plus branch `feature/legal-content` (adds the LEGAL content
type and `GET /v1/content/legal/{slug}`). Route list = `services/catalog-service/docs/openapi.json` (`/api/**` operations);
roles = backend `docs/ops/ADMIN_ROLES.md`; role/identity architecture = `docs/ops/ADMIN_ROLES.md` and the DB-4/PR-25 entries in
`docs/ENGINEERING_STATUS.md`.
**Nothing here was verified against a real staging backend.** Tests are mock-backed (see `CMS_RELEASE_READINESS.md`).

Labels: `REQUIRED_FOR_LAUNCH` (day 1 cannot honestly go live without it), `POST_LAUNCH` (valuable, not blocking),
`NOT_REQUIRED_BY_ARCHITECTURE` (the system is designed so the CMS does not own it).

## Summary

| Area                               | Class                         | Why (one line)                                                                             | State after this branch                                                 |
| ---------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Legal documents (Terms, Privacy)   | REQUIRED_FOR_LAUNCH           | The storefront and app need CMS-managed Terms/Privacy pages; the backend now serves them   | Built: `/content/legal` list, new, detail/edit/publish/schedule/archive |
| Offers / promotions                | POST_LAUNCH                   | No backend admin API exists for them                                                       | Not built (nothing to build against)                                    |
| Search configuration               | POST_LAUNCH                   | No backend capability to configure                                                         | Not built                                                               |
| Customers directory                | POST_LAUNCH                   | No admin customer API; PII; day-1 cases are covered by support cases and orders            | Not built                                                               |
| Staff / role management            | NOT_REQUIRED_BY_ARCHITECTURE  | Roles are backend configuration, never edited through the CMS                              | Not built, by design                                                    |
| Home (was a stub)                  | REQUIRED_FOR_LAUNCH           | First screen of every operator; a stub that says "Soon" is not acceptable                  | Built: role-aware launcher plus a "Needs attention" strip               |
| Product detail                     | REQUIRED_FOR_LAUNCH (partial) | Operators must reach price, stock and media from the product without guessing              | Built: Price, Stock, Media (and Import) links plus an honest note       |
| Taxonomy (browse and node actions) | Acceptable for launch         | Browse, create and node moves exist; the missing piece is only the release list (next row) | Unchanged                                                               |
| Taxonomy releases                  | POST_LAUNCH                   | Backend has open/get/publish, no list or "current release" endpoint                        | Unchanged (open and publish by id)                                      |
| Pricing                            | Acceptable for launch         | One-SKU editor plus bulk through Import covers day 1; no price list endpoint               | Unchanged; reachable from the product page                              |
| Notifications                      | POST_LAUNCH                   | No notification list endpoint; only two counters on the dashboard summary                  | Unchanged (counts only)                                                 |

## Evidence and reasoning

### Legal documents: REQUIRED_FOR_LAUNCH (done)

- The day-1 storefront and mobile app need Terms and Privacy pages. Both are CMS-managed (one CMS, one backend), so the
  documents must be editable without a deploy.
- Backend (branch `feature/legal-content`): content block type `LEGAL` on placement `HELP`; public
  `GET /v1/content/legal/{slug}` for `terms` and `privacy`; at most one live document per slug; admin writes use the
  existing generic blocks endpoints.
- CMS: `/content/legal` (list with the document that is live now, per slug), `/content/legal/new`,
  `/content/legal/[blockId]` (edit, publish, schedule through the publication window, unpublish, archive). Readers see the
  text read-only; `cms-writer` writes. The body is plain text with a live character count; the page says it is shown as plain
  paragraphs. The effective date is an optional field.
- The App config legal URL fields stay (not removed), with a note that Terms and Privacy are now managed under Legal and the
  URLs are optional external overrides. The refund policy URL has no managed document and stays the only place for that link.
- Not covered, deliberately: the customer-facing pages themselves (storefront and app work), and the legal text (a business
  and legal owner task; the CMS holds text, it does not approve it).

### Offers / promotions: POST_LAUNCH

- No admin route exists. The `/api/**` operations are: app-config, audit-events, content, dashboard, delivery-slots, imports,
  inventory, me, media, orders, prices, service-areas, support, products, taxonomy, attributes, attribute-schemas, evidence.
  There is nothing about offers, promotions or coupons.
- The nearest backend concepts are not CMS-editable: Benefits rules (`benefits/BenefitRule`, an order-level percentage
  discount keyed to a membership plan snapshot) and Membership plans are code/configuration, and `offers_current` is the raw
  multi-source price input behind the price resolver, not a promotion model.
- Home banners, product rails and category grids (already in the CMS) cover day-1 merchandising and "promotional copy"
  (ADR-012 puts promotional copy in the CMS content boundary).
- Re-evaluate once the backend owns a promotion model. A CMS screen without an API would be a fake screen.

### Search configuration: POST_LAUNCH

- `GET /v1/search` is a public read with no admin counterpart: no synonyms, boosts, pins or stop-word routes in the admin
  surface. There is no backend capability to configure, so there is nothing for the CMS to drive.

### Customers directory: POST_LAUNCH

- No admin customer list or lookup exists (the backend contract matrix records "no list endpoints for ... customers").
- Customer data is personal data; the architecture keeps it behind the staff namespaces (`order-ops` and `support-agent`
  reach orders and support cases only; `cms-writer` and `reader` do not).
- Day-1 customer questions arrive as support cases and orders, which the CMS already shows to the staff roles that may see
  them. A directory is a privacy-sensitive feature that should be designed with data-protection review, after launch.

### Staff / role management: NOT_REQUIRED_BY_ARCHITECTURE

- Roles come from the backend allowlist (`tazzzo.admin.users[i].roles`), never from token claims. The five roles are fixed
  strings; unknown role names fail backend startup. Granting or revoking a role is a configuration change
  (`docs/ops/ADMIN_ROLES.md`: "Granting a staff role: add it to the person's `roles` in the allowlist ... Revoking: remove it
  or set `enabled=false`").
- There is no admin route to manage staff or roles, and by design the CMS should not be able to grant itself access. The CMS
  already shows each person their own roles and what they allow (Profile & access, `/api/v1/admin/me`).

### Home (stub): REQUIRED_FOR_LAUNCH (done)

- The old Home said that modules marked "Soon" were not built and showed nothing else. Every sidebar module is now built.
- New Home: cards grouped as in the sidebar, only for modules the signed-in roles can use (same role source as the sidebar,
  so a card never leads to a refusal page). For `reader` and `cms-writer` (the roles the backend serves the dashboard summary
  to) a "Needs attention" strip reuses the existing `GET /api/v1/admin/dashboard/summary`: out-of-stock, low-stock, failed
  notifications and open support cases, non-zero figures only, capped counts kept as lower bounds. If the summary fails the
  launcher still works and says the summary is unavailable. Other roles get cards only. No new backend capability is used.

### Product detail: REQUIRED_FOR_LAUNCH (done)

- `GET /api/v1/products/{id}` returns no price, stock or media, and `PATCH` edits the title only. The page used to say so
  in one muted line.
- Now: "Price", "Stock" and "Media" links open `/pricing?sku=`, `/inventory?sku=` and `/catalogue/media?type=product&id=` for
  that product, an "Import" link for `cms-writer`, and a note on what can and cannot be edited here. Stock is held per
  location, so `/inventory?sku=` now asks for the location instead of showing an input error.

### Taxonomy and taxonomy releases

- Taxonomy: nodes can be listed, read, created and changed (rename, move, deprecate, merge, split, revive). That is enough
  for launch; the catalogue is seeded and imported.
- Releases: the backend offers `POST /api/v1/taxonomy/releases`, `GET .../releases/{id}` and `.../publish`, and **no list or
  "current release" endpoint** (backend contract matrix, section on releases). The CMS can open and publish a release when
  given its id, and cannot list them. POST_LAUNCH, and it needs a backend list endpoint first.

### Pricing

- Backend: `GET`/`PUT /api/v1/admin/prices/{skuId}` and `POST /api/v1/admin/imports/prices`. No price list endpoint exists.
- Acceptable for launch: the single-SKU editor for corrections and Import (prices) for bulk. Operators reach the editor from
  the product page. Documented limitation: there is no "all prices" screen, because the backend cannot list them.

### Notifications

- The backend writes to a transactional outbox (`docs/ops/NOTIFICATIONS.md`) and exposes only two gauges on the dashboard
  summary (pending, failed). There is no list route. The CMS Notifications page shows those counts, which is all the backend
  can say. POST_LAUNCH: a list needs a backend endpoint (and a delivery provider, which does not ship yet).

## What to watch after launch

1. Legal: confirm the storefront and app read `GET /v1/content/legal/{slug}`; public changes take up to 60 seconds (cache).
2. Replacing a live legal document: end the old one's window when the new one starts, or unpublish then publish. The backend
   refuses a second overlapping document for the same slug (409).
3. Re-run this classification when the backend adds promotions, search tuning, a customer lookup or release/notification
   list endpoints.

## Test evidence for the work in this branch

Mock-backed only (the fake backend implements the frozen legal contract, including the one-live rule); never a real backend.

- Unit: legal body, date and payload rules, the live-document pick per slug, the BFF specs (placement and type fixed in code).
- Component: list ("Live now" per slug, duplicate-live warning), detail (inert text for readers), editor (live character
  count, plain-text note, validation without a request, a refused save keeps the typed text), status actions, the App config
  note, the launcher cards per role, "Needs attention", product detail links, inventory without a location.
- Integration: Home now reads the dashboard summary after `/me` (`runtime-flow`).
- Browser: create, publish, refused second document, replace, edit, unpublish; reader read-only; go-to redirect for a legal
  id; Home launcher and its summary-failure state; product detail deep links; responsive sweep includes the three legal pages.
- Mutation checks (each made the named tests fail, then reverted): body markup check removed; legacy "latest updated" pick
  reversed; "Needs attention" listing zero rows; launcher ignoring roles; create posting to the FAQ route; Import link shown to
  readers; bidirectional-control check removed.
