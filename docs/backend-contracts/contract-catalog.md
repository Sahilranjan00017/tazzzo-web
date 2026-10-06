# Catalog-service admin HTTP contract (CMS reference)

Source: `tazzzo-backend-int2/services/catalog-service/src/main/java/com/tazzzo/`. Paths below are relative to that root unless they start with `docs/`.
Scope: products, taxonomy, attributes/schemas, evidence, bulk import, media admin. Everything here is on the **INTERNAL** surface (`/api/**`).

---

## 0. Cross-cutting rules (apply to every endpoint below)

### Auth / authorization

- `Authorization: Bearer <token>` is required on every `/api/**` call. The token is either the shared service token or a per-person Google OIDC ID token, checked against the backend allowlist (`catalog/api/ApiAuthFilter.java:96-112`).
- Roles (`docs/ops/ADMIN_ROLES.md`):
  - `reader`: GET only.
  - `cms-writer`: GET plus every write (catalogue, taxonomy, pricing, stock, media).
  - `audit-reader`: only `/api/v1/admin/me` and `/api/v1/admin/audit-events`.
  - Staff roles (`order-ops`, `support-agent`) get **nothing** on the catalogue.
- Error bodies from the auth filter use the nested envelope with **no** `correlation_id` (`ApiAuthFilter.java:155-163`):
  - 401 `UNAUTHENTICATED`: missing, invalid or expired token. All of these return the same body.
  - 403 `FORBIDDEN`: "role may not perform writes here", "role may not read this resource", or "admin access not granted".
  - 404 `NO_SUCH_ENDPOINT`: the path is outside every known surface.
- `GET /api/v1/admin/me` returns `{actorType: string, actorId: string, email?: string /*absent for service accounts*/, roles: string[] /*sorted*/}` (`catalog/api/ApiDtos.java:24-25`). This is the CMS bootstrap call.

### Error envelope (admin surface)

```ts
type AdminError = {
  error: { code: string; message: string; request_id: string; correlation_id?: string }
}
// Bulk import 422 only:
type ImportRejected = {
  error: { code: 'INVALID_IMPORT'; message: string; request_id: string }
  rowErrors: RowError[]
}
```

- `ApiExceptionHandler.envelope` builds this shape (`catalog/api/ApiExceptionHandler.java:226-243`).
- `correlation_id` is added only when the client sent a well-formed `X-Correlation-Id`.
- The media and bulk handlers build their own envelope without `correlation_id`:
  - `media/admin/MediaAdminExceptionHandler.java:50-56`
  - `bulkimport/BulkImportExceptionHandler.java:24-30`

### Global code → status map (`ApiExceptionHandler.java`)

| Status      | Code                                                                                                  | Trigger                                                                                                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 409         | `STALE_VERSION`                                                                                       | `CasConflictException`: the version in If-Match or `expectedVersion` ≠ the stored version (L51-54). The message is `"<collection>/<id> expectedVersion=N"`. **The current version is NOT returned**, so refetch with GET. |
| 409         | `IDENTITY_COLLISION`                                                                                  | `internalKey`, GTIN registry or canonical key already minted (L56-59)                                                                                                                                                     |
| 409         | `STATE_CONFLICT`                                                                                      | Illegal lifecycle transition, edit of a merged/merging/archived product, or merge of non-active products (L118-121)                                                                                                       |
| 409         | `DUPLICATE_KEY`                                                                                       | Mongo 11000, e.g. a duplicate product `_id` (L195-199)                                                                                                                                                                    |
| 409         | `EVIDENCE_IMMUTABLE`                                                                                  | Evidence id replayed with different content (L88-91)                                                                                                                                                                      |
| 422         | `ATTRIBUTE_VIOLATION`, `EVIDENCE_GATE`, `BUNDLE_COMPONENT`, `IMMUTABLE_FIELD`, `VARIANT_PACK_INVALID` | Domain rules (L61-86)                                                                                                                                                                                                     |
| 422         | `DOCUMENT_VALIDATION`                                                                                 | The Mongo `$jsonSchema` validator rejected the write (L200-201). This is the only check for many product-field rules.                                                                                                     |
| 422         | `PAYLOAD_NOT_ACCEPTED`, `INVALID_VALIDITY_TRANSITION`                                                 | `EvidenceContractException.code` (L93-97)                                                                                                                                                                                 |
| 404/409/422 | taxonomy codes                                                                                        | `TaxonomyChangeException`. See §2.4 for the status split (L34-49).                                                                                                                                                        |
| 404         | `NOT_FOUND`                                                                                           | Missing product, evidence, node, release, attribute or schema (L110-114)                                                                                                                                                  |
| 400         | `MALFORMED_REQUEST`                                                                                   | `IllegalArgumentException`, unreadable JSON, bad parameter type (e.g. a non-integer If-Match), missing parameter, bad `observedAt` (L99-103, L130-136, L153-186)                                                          |
| 400         | `MISSING_HEADER`                                                                                      | Missing `If-Match` (L125-128)                                                                                                                                                                                             |
| 403         | `FORBIDDEN`                                                                                           | Audit read without the role (L105-108)                                                                                                                                                                                    |
| 405         | `METHOD_NOT_ALLOWED`                                                                                  |                                                                                                                                                                                                                           |
| 415         | `UNSUPPORTED_MEDIA_TYPE`                                                                              | Non-JSON `Content-Type`                                                                                                                                                                                                   |
| 406         | `NOT_ACCEPTABLE`                                                                                      |                                                                                                                                                                                                                           |
| 413         | `PAYLOAD_TOO_LARGE`                                                                                   | Body over the limit. Sent with `Connection: close` (`catalog/api/RequestBodyLimitFilter.java:110-120`).                                                                                                                   |
| 500         | `INTERNAL`                                                                                            | Anything else (L204-208)                                                                                                                                                                                                  |

### Headers, bodies, concurrency

- **Content-Type** is `application/json` on every endpoint. There is no CSV and no multipart anywhere in this scope.
- **Unknown JSON fields** are ignored: Spring Boot's default Jackson has `FAIL_ON_UNKNOWN_PROPERTIES=false` and no override was found. Missing fields bind as `null`.
- **Nulls are serialized** (`"x": null`) unless a DTO is annotated `NON_NULL`. Only these have the annotation:
  - `NodeListResponse` and `ProductListResponse` (`ApiDtos.java:113,119`), so `nextCursor` is **absent** on the last page.
  - `AdminMeResponse.email`.
- **Response headers:** every response carries `X-Request-Id`, and `X-Correlation-Id` is echoed when accepted (`catalog/api/RequestIdFilter.java:32,49`).
- **No `ETag` header** is emitted on any admin route. The only ETag in the codebase is on consumer `/v1/categories` (`commerce/api/TaxonomyETag.java`).
- **No `Idempotency-Key`** support anywhere (`catalog/api/ProductController.java:60-62`).
- **Body size limits:**
  - 65,536 B by default (`TAZZZO_HTTP_MAX_BODY_BYTES`).
  - 2 MiB on `/api/v1/admin/imports/` (`TAZZZO_HTTP_BULK_IMPORT_MAX_BODY_BYTES`) (`application.yml:191-193`, `catalog/api/HttpPlatformProperties.java:24-27`).
- **Optimistic concurrency** comes in three different styles:
  1. Products (PATCH, activate, retire, revive, archive): `If-Match: <int>`. It is bound as a Java `int`, so send a **bare integer such as `If-Match: 3`, not a quoted ETag**. A quoted value gives 400 `MALFORMED_REQUEST` "parameter 'If-Match' has an invalid value" (`ProductController.java:116`).
  2. Taxonomy node ops: `expectedVersion` in the JSON body. It is required; a missing value is 400 `MALFORMED_REQUEST` (`catalog/api/TaxonomyController.java:144-147`).
  3. Media sets and bulk price/stock rows: `expectedVersion` in the body. Omit it (or send null) to **create**; send it to **update**.
  4. Classify, publish-claim, bind-GTIN and merge take **no version at all**. The server reads the current version and CASes on that, which makes them last-writer-wins from the client's view (`catalog/tx/ClassifyService.java:50`, `PublishService.java:55`, `GtinBindService.java:48`).

### Admin list grammar (products and taxonomy nodes) (`catalog/api/AdminListParams.java`)

- Query names allowed: the endpoint's own filters plus `limit` and `cursor`.
- Anything else is 400 "unsupported query parameter". A repeated parameter is also 400.
- Every value must match `[A-Za-z0-9_.:-]{1,64}`. An empty value is 400 (L19, L40).
- `limit` is 1..200, default 50 (L17-18, L48).
- Order is ascending `_id`. Pagination is keyset: `cursor` = the last `id` of the previous page (`nextCursor`), and the next page is `_id > cursor`.
- There are no sort options and no total count.

---

## 1. Products: `/api/v1/products` (`catalog/api/ProductController.java`)

### 1.1 Domain facts

- **The client supplies the product id.** The `products` validator requires `_id` to match `^TZP-` (`catalog/schema/SchemaBootstrap.java:446+`). There is no server-side minting.
  - Consumer cart accepts only `^TZP-[0-9]{1,18}$` (`customer/cart/CartController.java:38`). **Use numeric ids such as `TZP-100001`, or the product cannot be added to a cart.**
- `productType`: `"single" | "variant_pack" | "bundle"` (validator).
- `identityType`: `"gtin" | "internal"` (validator).
  - `internal`: `internalKey` is registered in `identity_keys`, which is unique.
  - `gtin`: each `gtins[].value` is registered in `gtin_registry`, which is unique (`catalog/tx/MintService.java:52-64`).
  - This registration happens only for `single`. Bundle and variant_pack writes do not touch the registries (`BundleService`, `VariantPackService`).
- **GTIN rules**:
  - Single create/bind: no check-digit or format validation, only `bsonType string`, at most 12 per product.
  - Bulk import enforces GS1 mod-10 over GTIN-8/12/13/14 (`bulkimport/ProductImportValidator.java:163-168`).
- **canonicalKey** is derived by the server, never sent: `brand|vertical|<sorted ratified discriminator terms>[|packof=N]` (`catalog/schema/CanonicalKeyService.java`).
  - No key is derived for holding verticals (`TZV-UNCLASSIFIED`, `TZV-SCOPE-BLOCKED`), bundles, a missing brand, or an unratified vertical. In that case an `identity_incomplete` work item is queued instead.
  - The key is **not** in the product response. It can only be used for lookup (§1.4).
- **lifecycle** (`catalog/tx/ProductLifecycleService.java:21-35`; validator enum `draft|active|merging|discontinued|archived|merged`):
  ```
  create → draft
  draft --activate--> active
  active --retire--> discontinued        (endpoint is /retire; the state is "discontinued", there is no "retired")
  discontinued --revive--> active
  discontinued --archive--> archived     (terminal)
  active+active --merge--> merging --(async finalizer)--> loser: merged (terminal, merged_into=survivor), survivor: active
  ```
  - Anything else is 409 `STATE_CONFLICT`.
  - **There is no "published" lifecycle state.** `/publish` publishes an attribute _claim_ (§1.8).
  - Shopper visibility = `lifecycle=active` AND `classification.status=confirmed` AND the vertical is not a holding vertical AND `productType ∈ {single, variant_pack}` (`catalog/consumer/ConsumerEligibility.java:20-23,43-46`).
- **Editable** (PATCH title): only `draft`, `active` or `discontinued` (`catalog/tx/ProductUpdateService.java:24`).
- **classification.status**: `"confirmed" | "provisional" | "review" | "scope_blocked"` (`ClassifyService.java:22`; validator).
- **verticalId**:
  - Must be a string for `single`/`variant_pack`, and **must be null for `bundle`** (validator `oneOf`, `SchemaBootstrap.java:495`).
  - Single create does **not** check that the vertical or release exists; bulk import does.
  - The sentinels `TZV-UNCLASSIFIED` / `TZV-SCOPE-BLOCKED` queue a `classification_review` item.
- Other validator bounds:
  - `classification.confidence` 0..1.
  - `evidence_refs` at most 20 items, each matching `^EV-`.
  - `bundle_contents` 2..100 items, `qty` ≥ 1, component `^TZP-`.
  - `pack_of.qty` ≥ 2.
  - `title` and `brand_code` are plain strings with no length limit.

### 1.2 `POST /api/v1/products`: create (L63-75)

```ts
type CreateProductRequest = {
  id: string // "^TZP-" (validator); client-chosen
  productType: 'single' | 'variant_pack' | 'bundle'
  identityType: 'gtin' | 'internal'
  internalKey?: string | null // required in practice when identityType = "internal"
  gtins?: { value: string; market: string }[] | null // ≤12
  brandCode: string
  title: string
  verticalId: string | null // null only for a bundle
  releaseId: string
  classificationStatus: 'confirmed' | 'provisional' | 'review' | 'scope_blocked'
  attributes?: Record<string, string | number | boolean> | null // governed by the vertical's active schema
  evidenceRefs?: string[] | null // "^EV-"; required if any attribute is claim-tier
  bundleContents?:
    { componentProductId: string; qty: number; verticalIdSnapshot?: string | null }[] | null // bundle only
  packOf?: { componentProductId: string; qty: number /* >=2 */ } | null // variant_pack only
}
```

- Dispatch on `productType` (L66-73):
  - `bundle` → `BundleService`. Components must be `active` and not bundles, else 422 `BUNDLE_COMPONENT`.
  - `variant_pack` → `VariantPackService`. The component must be an active `single`, else 422 `VARIANT_PACK_INVALID`.
  - Anything else → `MintService`.
- Attribute governance (`catalog/schema/AttributeGovernanceService.java`), when the vertical has an active schema:
  - An unknown key → 422 `ATTRIBUTE_VIOLATION`.
  - A missing required key → 422.
  - A type mismatch → 422. `number` must be a JSON number; `boolean` must be a JSON boolean; `string`/`enum_open` accept a string, number or boolean.
  - A claim-tier attribute without `evidenceRefs` → 422.
  - When the vertical has no schema, the check is lenient and queues a `validation_gap` item.
  - An unknown enum value is accepted and queues a work item.
- Response: **201** with `ProductResponse` (§1.3). There is no Location header.
- Retry semantics:
  - A replay → 409 `IDENTITY_COLLISION` (identity registry hit first).
  - The same id with a different identity → 409 `DUPLICATE_KEY`.

### 1.3 `ProductResponse` (`ApiDtos.java:105-107`; mapping at `ProductController.java:212-224`)

```ts
type ProductResponse = {
  id: string
  productType: string
  lifecycle: 'draft' | 'active' | 'merging' | 'discontinued' | 'archived' | 'merged'
  brandCode: string
  title: string
  classification: {} | { verticalId: string; releaseId: string; status: string } // values are String.valueOf(...): a null vertical becomes the STRING "null" (bundles)
  attributes: Record<string, unknown> // raw stored map, including "<key>_published": true flags written by claim-publish
  version: number // int; send it back as If-Match
  taxonomyPath: string | null // "Staples > Rice & Grains > Basmati Rice > Basmati Rice"; null when there is no vertical
}
```

**Not exposed** in any product read: `gtins`, `identity` (type, internalKey, canonicalKey), `bundleContents`, `packOf`, `evidenceRefs`, `confidence`, `formulation_version`, `merged_into`, timestamps.

### 1.4 `GET /api/v1/products`: list, or canonical-key lookup

- With `canonicalKey=<string>` (any other parameters are ignored): returns one `ProductResponse`, or 404 `NOT_FOUND` (L103-106). URL-encode the `|` characters.
- Otherwise it is the list (L83-100). Filters: `verticalId`, `lifecycle`, `status` (the classification status).
  - `lifecycle` and `status` **require** `verticalId`, else 400 (L86-88).
  - Values are not enum-checked; an unknown value simply matches nothing.

```ts
type ProductListResponse = {
  items: ProductSummary[]
  nextCursor?: string /* absent on the last page */
}
type ProductSummary = {
  id: string
  productType: string
  lifecycle: string
  brandCode: string
  title: string
  verticalId: string | null
  classificationStatus: string | null
  version: number
}
```

- There is no text search and no brand filter.

### 1.5 `GET /api/v1/products/{id}` → `ProductResponse`, or 404 `NOT_FOUND`

### 1.6 `PATCH /api/v1/products/{id}`: edit title only (L114-121)

- Header: `If-Match: <int version>` (required).
- Body: `{ title: string /* non-blank, else 400 */ }`.
- Response: 200 `ProductResponse` (version +1).
- Errors:
  - 409 `STALE_VERSION`.
  - 409 `STATE_CONFLICT` when the product is not editable.
  - 404 `NOT_FOUND`.
  - 400 `MISSING_HEADER` / `MALFORMED_REQUEST`.
- **Title is the only editable field.** No other product field, attribute or brand can be edited after create.

### 1.7 Lifecycle: `POST /api/v1/products/{id}/{activate|retire|revive|archive}` (L147-179)

- Header: `If-Match: <int>` (required).
- Bodies:
  - `activate`, `archive`: no body.
  - `retire`: optional `{ reason?: string }` (stored in the event).
  - `revive`: optional `{ formulationVersion?: number }`. If it differs from the stored `formulation_version`, the result is 409 `STATE_CONFLICT` "mint a NEW product with supersedes" (`ProductLifecycleService.java:58-75`).
- Response: 200 `ProductResponse`.
- The legality check runs before the CAS, so an illegal transition returns `STATE_CONFLICT` even when the version is also stale.

### 1.8 `POST /api/v1/products/{id}/publish`: publish an attribute claim, NOT a product (L132-138; `catalog/tx/PublishService.java`)

- Body: `{ attributeKey: string; evidenceRefs: string[] /* ≥1 */ }`.
- Effects:
  - Sets `attributes["<attributeKey>_published"] = true`.
  - Links the evidence.
  - Bumps the version.
- The evidence must be `validity=active` and `payload_state=readable`, else 422 `EVIDENCE_GATE`. An empty `evidenceRefs` is also 422 `EVIDENCE_GATE`.
- `attributeKey` is not checked against the schema.
- No If-Match. Response: 200 `ProductResponse`.

### 1.9 `POST /api/v1/products/{id}/classify` (L123-130; `ClassifyService.java`)

- Body: `{ verticalId: string; releaseId: string; status: "confirmed"|"provisional"|"review"|"scope_blocked"; confidence?: number /* default 1.0, 0..1 */; evidenceRefs?: string[] }`.
- Taxonomy is bound by writing `classification.vertical_id` / `release_id` / `status` / `confidence`, plus a `classification_history` row.
- **Neither the vertical nor the release is validated.**
- An invalid `status` → 400 `MALFORMED_REQUEST`.
- A bundle given a vertical → 422 `DOCUMENT_VALIDATION`.
- No If-Match. Response: 200 `ProductResponse`.

### 1.10 `POST /api/v1/products/{id}/gtins`: bind a GTIN (L140-145; `GtinBindService.java`)

- Body: `{ gtin: string; market: string }`. There is no format or check-digit validation.
- It **closes any open binding of that GTIN in that market, even when another product holds it**, and rebinds the GTIN to this product. This is a re-assignment, not a collision: the old product's own `gtins` array is not cleaned.
- Pushes onto `gtins`. A 13th GTIN → 422 `DOCUMENT_VALIDATION`.
- No If-Match. Response: 200 `ProductResponse`.

### 1.11 `POST /api/v1/products/{id}/merge/{survivorId}` (L182-189; `catalog/tx/MergeService.java`)

- No body and no If-Match. Both products must be `active`, else 409 `STATE_CONFLICT`. A missing product → 404.
- Response: **202** `{ status: "merging"; detail: "outbox committed; finalizer completes repointing asynchronously" }`.
- Both products go to `merging`. The finalizer later sets the loser to `merged` and the survivor back to `active`.

---

## 2. Taxonomy: `/api/v1/taxonomy` (`catalog/api/TaxonomyController.java`; `catalog/tx/TaxonomyChangeService.java`)

### 2.1 Model

- Node kinds and ids (`TaxonomyChangeService.java:411-433`, `nextId` L608):

  | nodeType         | id prefix    | parent                       | `attributeSchemaId` |
  | ---------------- | ------------ | ---------------------------- | ------------------- |
  | `super_category` | `TZS-NNNNNN` | none (root, `parentId` null) | forbidden           |
  | `category`       | `TZC-`       | `super_category`             | forbidden           |
  | `sub_category`   | `TZG-`       | `category`                   | optional            |
  | `vertical`       | `TZV-`       | `sub_category`               | **required**        |
  - New ids come from a per-prefix counter starting at 100001. Seed ids are like `TZV-000001`.

- Hierarchy is expressed only through `parentId`. There is no children or tree endpoint: list with `?parentId=`, or walk `/path`.
- Node `status`: `active | deprecated | merged`. Seed nodes start at `version: 1`.
- Name rules on create: non-blank, trimmed, no control characters, ≤120 characters (L439). Must be unique among **active** siblings.
  - **Rename does not validate the name at all**; it only checks sibling uniqueness.
- Holding verticals `TZV-UNCLASSIFIED` and `TZV-SCOPE-BLOCKED` are real nodes with no schema.
- **Release model**:
  - Every change operation (create, rename, move, merge, split, deprecate, revive) **and** every attribute definition/schema authoring call requires exactly one **open** release (`status="publishing"`), else 409 `NO_OPEN_RELEASE` (`catalog/repo/ReleaseGate.java:27-40`).
  - Changes are applied to the **live** `taxonomy_nodes` immediately. Admin reads see them at once. Consumers see them only after the release is published, which snapshots every node, flips the release to `active` and moves the `consumer_taxonomy_release` pointer.
  - Release status: `publishing` (open) → `freezing` (during publish) → `active`.
  - At most one release can be open; this is enforced by the DB.

### 2.2 Releases

- `POST /api/v1/taxonomy/releases`
  - Body: `{ releaseId: string; basedOn?: string | null }`. The id format is not validated.
  - Response: **201** `{ id: releaseId, version: null }`.
  - 409 `RELEASE_ALREADY_OPEN` when another release is open or the id exists.
- `POST /api/v1/taxonomy/releases/{id}/publish`
  - No body. Response: 200 `{ id, version: null }`.
  - Safe to retry: a release in `publishing`/`freezing` resumes.
  - A missing or already active release → 409 `RELEASE_NOT_OPEN`.
  - It runs synchronously: snapshot in batches of 200 nodes, then activate pending attribute versions, then flip status.
- `GET /api/v1/taxonomy/releases/{id}` → `{ id: string; status: "publishing"|"freezing"|"active"; basedOn: string | null }`, or 404.
- **There is NO list-releases endpoint and no "current release" endpoint.** `docs/ops/BULK_IMPORT.md` cites `GET /api/v1/taxonomy/releases`, which does not exist in code. The CMS needs to know release ids out of band. The baseline release id is UNKNOWN (only `recordBaseline(actor, id)` exists, `TaxonomyChangeService.java:199`).

### 2.3 Nodes

```ts
type NodeResponse = {
  id: string
  nodeType: 'super_category' | 'category' | 'sub_category' | 'vertical'
  name: string
  parentId: string | null
  status: 'active' | 'deprecated' | 'merged'
  attributeSchemaId: string | null
  version: number | null
}
```

- `GET /api/v1/taxonomy/nodes`
  - Filters: `parentId`, `nodeType`, `status`, plus `limit`/`cursor` (§0 grammar).
  - Response: `{ items: NodeResponse[]; nextCursor?: string }`.
  - Roots: use `nodeType=super_category`. You cannot filter on `parentId=null`.
- `GET /api/v1/taxonomy/nodes/{id}` → `NodeResponse`, or 404.
- `GET /api/v1/taxonomy/nodes/{id}/path` → `{ verticalId: string /*the requested id, any level*/; path: string /*names joined " > "*/; nodes: NodeResponse[] /*root first*/ }`.
- `POST /api/v1/taxonomy/nodes`
  - Body: `{ nodeType; name; parentId: string | null; attributeSchemaId?: string | null }`.
  - Response: **201** `NodeResponse` (the server mints the id).
  - The parent must be active and of the correct level.
  - The schema must exist in `attribute_schemas` (any status), else 404 `UNKNOWN_SCHEMA`.
- `POST /api/v1/taxonomy/nodes/{id}/rename` — body `{ name: string; expectedVersion: number }` → 200 `NodeResponse`.
- `POST /api/v1/taxonomy/nodes/{id}/move`
  - Body: `{ newParentId: string; expectedVersion: number }` → 200.
  - The parent must be active and exactly one level up. A super_category cannot move (`INVALID_PARENT_LEVEL`).
  - Stamps the products under the node for attribute revalidation.
- `POST /api/v1/taxonomy/nodes/{id}/merge`
  - Body: `{ survivorId: string; expectedVersion: number; schemaReconciliationApproved?: boolean }`.
  - Response: 200 `NodeResponse` **of the loser** (status `merged`).
  - Verticals only. Differing schemas without approval → 409 `SCHEMA_CONFLICT`.
- `POST /api/v1/taxonomy/nodes/{id}/split`
  - Body: `{ childNames: string[] /*≥2 distinct*/; expectedVersion: number }`.
  - Response: 200 **`NodeResponse[]`** (a top-level array of the new sibling verticals).
  - Verticals only. The original node becomes `deprecated`.
- `POST /api/v1/taxonomy/nodes/{id}/deprecate`
  - Body: `{ expectedVersion: number }` (the shared `RenameNodeRequest` DTO; `name` is ignored) → 200.
  - Active children → 409 `HAS_ACTIVE_CHILDREN`.
- `POST /api/v1/taxonomy/nodes/{id}/revive`
  - Body: `{ expectedVersion: number }` → 200.
  - The node must be `deprecated` (`NOT_DEPRECATED` otherwise). Merged nodes are terminal. The parent must be active.
- All node writes use node-level CAS on `expectedVersion`: a mismatch → 409 `STALE_VERSION`. A missing `expectedVersion` → 400 `MALFORMED_REQUEST`. The body is required.

### 2.4 Taxonomy/attribute error codes → status (`ApiExceptionHandler.java:34-49`)

- **404:** `NODE_NOT_FOUND`, `UNKNOWN_SCHEMA`, `UNKNOWN_DEFINITION`
- **409:** `NO_OPEN_RELEASE`, `RELEASE_ALREADY_OPEN`, `RELEASE_NOT_OPEN`, `SCHEMA_CONFLICT`, `DUPLICATE_NODE`, `DUPLICATE_DEFINITION`, `DUPLICATE_FIELD`, `DUPLICATE_SCHEMA_VERSION`, `NODE_NOT_ACTIVE`, `HAS_ACTIVE_CHILDREN`
- **422 (everything else):** `INVALID_NODE`, `INVALID_PARENT`, `INVALID_PARENT_LEVEL`, `CYCLE`, `INVALID_MERGE`, `INVALID_SPLIT`, `NOT_DEPRECATED`, `INVALID_TYPE`, `INVALID_GOVERNANCE`, `MERCHANDISING_REFUSED`, `TYPE_CHANGE_FORBIDDEN`, `ENUM_ONLY`, `REQUIRED_NEEDS_BACKFILL`

---

## 3. Attributes and schemas: `/api/v1` (`catalog/api/AttributeController.java`; `catalog/tx/AttributeAuthoringService.java`)

- `type`: `"string" | "number" | "boolean" | "enum_open"`. `governance`: `"descriptive" | "claim"`. `"merchandising"` → 422 `MERCHANDISING_REFUSED` (L35-36, L53-63).
- `POST /api/v1/attributes`
  - Body: `{ key: string; type; governance; knownValues?: string[] /*enum_open only; unioned with earlier values*/ }`.
  - Response: **201** `{ id: key, version: number }`.
  - Needs an open release.
  - Changing the type of an existing key → 422 `TYPE_CHANGE_FORBIDDEN`.
  - The new version is **`pending` until its release is published**.
- `POST /api/v1/attributes/{key}/values`
  - Body: `{ value: string }` → 200 `{ id: key, version: null }`.
  - No release is needed.
  - Only for `enum_open` (`ENUM_ONLY` 422) and only for a key with an _active_ definition (`UNKNOWN_DEFINITION` 404).
- `GET /api/v1/attributes/{key}`
  - Returns the latest **active** (or legacy, i.e. no status) version only: `{ key; version: number; type; governance; knownValues: string[] | null; status: string | null }`.
  - **A newly created definition returns 404 until its release is published.**
- `POST /api/v1/attribute-schemas/{id}/fields`
  - Body: `{ key: string; required?: boolean /*default false*/; allowBreaking?: boolean /*default false*/ }`.
  - Response: 200 `{ id: schemaId, version: number }`.
  - Needs an open release. The definition must be active or pending in the same release.
  - A required field without `allowBreaking` → 422 `REQUIRED_NEEDS_BACKFILL`.
  - Several fields added in the same release amend one pending version.
- `GET /api/v1/attribute-schemas/{id}` → `{ schemaId; version; scope: string; fields: { key: string; required: boolean }[]; status: string | null }` (latest active only).
- **Not available:** create schema, list attributes, list schemas, delete/retire anything. Seed schema ids (e.g. `rice`) come from `taxonomy_v0_9_0_seed.json`.

---

## 4. Evidence: `/api/v1/evidence` (`catalog/api/EvidenceController.java`; `catalog/tx/EvidenceService.java`)

- `POST /api/v1/evidence`
  ```ts
  type CreateEvidenceRequest = {
    id: string /* "EV-" prefix */
    evidenceType:
      'pdp' | 'ingredients' | 'lab_report' | 'supplier_doc' | 'marketplace_path' | 'human' | 'title'
    source: string /*non-blank*/
    sourceVersion?: string | null
    payloadRef?: { store: string; objectId: string; sha256?: string | null } | null
    excerpt?: string | null
    url?: string | null
    observedAt?: string /*ISO-8601 instant; default now*/
    payload?: never /* any non-null → 422 PAYLOAD_NOT_ACCEPTED */
  }
  ```
  - Response: **201** when created, **200** on an identical replay. The caller's `id` is the idempotency key.
  - A differing replay → 409 `EVIDENCE_IMMUTABLE`.
  - A validation failure → 400 `MALFORMED_REQUEST`.
- `GET /api/v1/evidence/{id}` → `{ id; evidenceType; source; sourceVersion; payloadRef: {store, objectId, sha256} | null; excerpt; url; validity: "active"|"retracted"|"superseded"; payloadState: "readable" /*other values UNKNOWN*/; observedAt: string }`.
- `POST /api/v1/evidence/{id}/retract`
  - Body (required): `{ to?: "retracted"|"superseded" /*default retracted*/; reason?: string /*accepted but IGNORED*/ }`.
  - Response: **202** `{ id; validity; cascade: "queued" }`. Retracting to the current state is a no-op.
  - Other targets → 422 `INVALID_VALIDITY_TRANSITION`.
  - There is no "un-retract".
- There is no list endpoint.

---

## 5. Bulk import: `/api/v1/admin/imports` (`bulkimport/*`; `docs/ops/BULK_IMPORT.md`)

- **JSON only** (no CSV), synchronous, 1–500 rows (`bulkimport/BulkImportService.java:43, 168-176`). Body limit 2 MiB.
- The client sets `dryRun: true` to validate without writing; missing or `false` means apply.
- Endpoints, all `POST`:
  - `/prices` → `PriceImportRequest`
  - `/inventory` → `StockImportRequest`
  - `/products` → `ProductImportRequest`

```ts
type PriceImportRequest = { dryRun?: boolean; rows: PriceRow[] }
type PriceRow = {
  skuId: string
  sellingPricePaise: number
  mrpPaise: number /* >= selling */
  currency?: 'INR' /*default; only INR*/
  expectedVersion?: number | null /* omit = create; ≥1 */
}
// amounts are non-negative integers ≤ 1_000_000_000 paise
type StockImportRequest = { dryRun?: boolean; rows: StockRow[] }
type StockRow = {
  skuId: string
  locationId: string /*trimmed, no control chars, ≤128*/
  onHand: number /*0..1_000_000*/
  lowStockThreshold: number /*≥0*/
  maxPurchasable: number /*≥0*/
  expectedVersion?: number | null
}
type ProductImportRequest = { dryRun?: boolean; rows: CreateProductRequest[] /* §1.2 shape */ }
```

- Product-row rules are stricter than a single create (`bulkimport/ProductImportValidator.java:136-178`):
  - Required: `id`, `productType`, `identityType`, `brandCode`, `title`, `verticalId`, `releaseId`, `classificationStatus`.
  - `productType` must be `"single"`.
  - `internal` needs `internalKey`; `gtin` needs a non-empty `gtins`.
  - Every GTIN must pass GS1 mod-10.
  - The release must exist.
  - `verticalId` must be a real `vertical` node or a holding sentinel.
  - Rows also get governance checks, in-file duplicates (id, internalKey, GTIN, canonical key) and conflicts with existing data, plus a validator probe.
  - An existing id with an identical create payload → `UNCHANGED`. A different payload → `CONFLICT`.

### Phase 1: whole-file validation

- Any error → **422** with `ImportRejected` (§0) and **nothing is written**:
  ```ts
  type RowError = {
    row: number /*0-based index*/
    code: 'INVALID_ROW' | 'DUPLICATE_ROW' | 'UNKNOWN_PRODUCT' | 'CONFLICT'
    message: string
  }
  ```
- Prices and stock: an unknown `skuId` → `UNKNOWN_PRODUCT`. In-file duplicates (`skuId`, or `skuId|locationId` for stock) → `DUPLICATE_ROW`.
- `rows` empty, missing, or more than 500 → 422 `INVALID_IMPORT` with `rowErrors: []`.
- A null or unreadable body → 400 `MALFORMED_REQUEST` (global handler).

### Phase 2: report (200)

```ts
type ImportReport = {
  importId: string /*"IMP-<objectid>"*/
  kind: 'prices' | 'inventory' | 'products'
  dryRun: boolean
  rows: number
  applied: number
  failed: number
  notAttempted: number
  results: RowResult[]
  unchanged: number
}
type RowResult = {
  row: number
  key: string /* skuId | "skuId|locationId" | productId */
  outcome: 'VALID' | 'APPLIED' | 'FAILED' | 'NOT_ATTEMPTED' | 'UNCHANGED'
  version: number | null // new version on APPLIED; products always report the placeholder 1 (BulkImportService.java:154-157)
  code: 'STALE_VERSION' | 'NOT_FOUND' | 'CONFLICT' | 'INVALID_ROW' | 'UNAVAILABLE' | null
  message: string | null
}
```

- Null fields are serialized, not omitted.
- Per-row `code` is derived from the exception's class name (`BulkImportService.java:265-269`):
  - `*Conflict*` → `STALE_VERSION`
  - `*NotFound*` → `NOT_FOUND`
  - `*Collision*` → `CONFLICT`
  - otherwise `INVALID_ROW`
- `UNAVAILABLE` means the datastore failed. The run stops and later rows are `NOT_ATTEMPTED`. Re-submitting the file is safe.
- **A dry run does not check CAS.** A price/stock row without `expectedVersion` for an existing record reports `VALID`, then fails with `STALE_VERSION` on apply (duplicate create).
- The `expectedVersion` values come from the single-row admin APIs: `GET /api/v1/admin/prices/{skuId}` and `GET /api/v1/admin/inventory/{skuId}/{locationId}` (`pricing/admin/PriceAdminController.java`, `inventory/admin/InventoryAdminController.java`). Those are not covered in detail here.
- Each applied (non-dry) run writes one `domain_events` `BULK_IMPORT_APPLIED` summary row.

---

## 6. Media admin: `/api/v1/admin/media` (`media/admin/MediaAdminController.java`)

### Upload flow

1. `POST /uploads` returns a presigned-style direct-to-storage target.
2. The client uploads the bytes **directly to storage**. The platform never proxies bytes, and there is no multipart.
3. `PUT /{ownerType}/{ownerId}` replaces the **whole** ordered set, referencing the `assetKey`.

### Storage status

- **No storage provider ships.** The only `MediaStorage` bean is `DisabledMediaStorage` (`media/MediaStorageConfig.java:12-16`; `media/MediaStorage.java:10-12`; `docs/ENGINEERING_STATUS.md:1486-1491`).
- As a result, `/uploads` always returns **503 `MEDIA_STORAGE_NOT_CONFIGURED`** today.
- Set writes are accepted **without verification**: any safe key is accepted.
- There is no public URL in any admin response. Consumer URLs are `tazzzo.media.public-base-url + "/" + assetKey` (`media/MediaUrlResolver.java`), and that base is unprovisioned.
- Config: `tazzzo.media.max-upload-bytes`, default 5,242,880, bounds 1..52,428,800 (`media/MediaUploadPolicy.java:13,19-23`).

### Owner types

- `ownerType` path segment: `product | sku`, case-insensitive. Anything else → 422 `INVALID_MEDIA` (L132-138).
- **For both owner types, `ownerId` must be an existing product id.** A missing product → 404 `NOT_FOUND` "no such product".

### `POST /api/v1/admin/media/uploads` (L76-91)

- Body: `{ ownerType: "product"|"sku"; ownerId: string; contentType: "image/jpeg"|"image/png"|"image/webp"; sizeBytes: number /*1..maxBytes*/ }`.
- Check order:
  1. Missing fields → 422.
  2. Bad `ownerType` → 422.
  3. Unsupported type or size → 422 `INVALID_MEDIA`.
  4. Unknown product → 404.
  5. Storage disabled → 503 `MEDIA_STORAGE_NOT_CONFIGURED`.
- Response: **201** `{ assetKey: string /*"p/<product|sku>/<ownerId sanitized>/<uuid>.<jpg|png|webp>"*/; method: string; url: string; headers: Record<string,string>; expiresAt: string /*ISO instant*/; maxBytes: number }`.
- The actual `method` and `headers` values are provider-defined and UNKNOWN, since no provider exists.

### `GET /api/v1/admin/media/{ownerType}/{ownerId}` (L93-103)

- Returns `SetResponse`, or 404 `NOT_FOUND` "no media set for this owner". A 404 means "create with `expectedVersion` omitted".
- Inactive sets are returned with `active: false`.

```ts
type SetResponse = {
  ownerType: 'product' | 'sku'
  ownerId: string
  version: number
  active: boolean
  assets: AssetDto[] /* stored order, not sorted */
}
type AssetDto = {
  assetId: string
  assetKey: string
  role: 'PRIMARY' | 'GALLERY'
  sortOrder: number
  altText: string | null
  width: number | null
  height: number | null
  contentType: string | null
}
```

### `PUT /api/v1/admin/media/{ownerType}/{ownerId}` (L105-130)

- Body: `{ assets: AssetDto[] /*required; [] clears*/; expectedVersion?: number | null }`.
- Response:
  - **201** when `expectedVersion` is omitted (create, version 1).
  - **200** on update (version = expected+1).
  - The body is `SetResponse` in both cases.
- Errors:
  - Create when a set already exists → 409 `STALE_VERSION` "use expectedVersion to update".
  - A stale version → 409 `STALE_VERSION`.
  - An update with no existing set → 404 `NOT_FOUND`.
  - `expectedVersion` < 1 → 422.
- Asset rules → 422 `INVALID_MEDIA` (`media/MediaAsset.java:40-113`, `media/MediaSet.java:36-97`):
  - `assetId`: non-blank, trimmed, no control characters, ≤128. Unique in the set.
  - `assetKey`: ≤512, matches `^[A-Za-z0-9][A-Za-z0-9/_.-]*$`, no `..` or `//`, no trailing `/`, no dot-only segments. Unique in the set.
  - `role`: exactly `"PRIMARY"` or `"GALLERY"` (**case-sensitive**). `role` and `sortOrder` are required.
  - `sortOrder`: ≥0, unique. At most one PRIMARY, and the PRIMARY must have `sortOrder` 0.
  - `altText`: trimmed, ≤300, no `<`, `>` or control characters. An empty value becomes null.
  - `width`/`height`: both present or both absent, each 1..20000.
  - `contentType`: null or one of the 3 allowed image types.
  - At most 50 assets.
- When storage is enabled, every **newly referenced** key must exist in storage, have size 1..max, and have magic bytes that match the declared `contentType`, else 422 (`media/MediaIngestVerifier.java:29-43`).
- There is no Idempotency-Key, no delete endpoint, and no activate/deactivate endpoint.

### Media error envelope (`media/admin/MediaAdminExceptionHandler.java`)

- 404 `NOT_FOUND`
- 409 `STALE_VERSION`
- 422 `INVALID_MEDIA`
- 503 `MEDIA_STORAGE_NOT_CONFIGURED`
- Everything else (unreadable body, etc.) falls back to the global handler (§0).

---

## 7. Not present / UNKNOWN (do not build against)

- Endpoints that do not exist:
  - Product delete, product attribute edit, brand edit, product text search.
  - Release list or "current release".
  - Attribute/schema list, schema create.
  - Evidence list.
  - Bulk media.
  - Media delete or deactivate.
  - CSV import.
- Behaviours that are absent:
  - No ETag headers.
  - No Idempotency-Key.
  - No server-minted product ids.
- UNKNOWN:
  - The baseline/seed release id value.
  - The non-`readable` values of evidence `payloadState`.
  - The provider-specific `UploadTarget.method`/`headers`.
  - Whether price PUT with `expectedVersion` against a missing row reports `STALE_VERSION` or `NOT_FOUND` (inventory reports `NOT_FOUND`; the pricing path was not traced).
