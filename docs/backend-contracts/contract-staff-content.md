# Tazzzo admin HTTP contracts: staff orders, support, content, app-config, notifications, RBAC, errors

Source: `tazzzo-backend-int2` (read-only). All paths below are relative to
`services/catalog-service/src/main/java/com/tazzzo/` unless prefixed `docs/`.
Generated OpenAPI for `/api/v1/**` also exists at `services/catalog-service/docs/openapi.json` (it lists all 32 admin paths used here).

Conventions:

- JSON keys are **camelCase** in success bodies and **snake_case** in error bodies (`request_id`).
- Timestamps are `Instant.toString()` ISO-8601 UTC strings, e.g. `"2026-10-06T08:15:30.123Z"`.
- Money is integer **paise** (`long`), currency INR.
- None of these endpoints use `If-Match`, `ETag` or `Idempotency-Key`. Optimistic concurrency (CAS) is always an **`expectedVersion` field in the JSON body**. (`If-Match` is used only by the legacy `/api/v1/products` controller, `catalog/api/ProductController.java:113-116`.)
- Every response has the `X-Request-Id: req_<20 hex>` header. `X-Correlation-Id` is echoed back only when the inbound value matches `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$` (`catalog/api/RequestIdFilter.java:35,47-49`).
- Send `Content-Type: application/json` on every POST/PUT. A missing or wrong type gives `415 UNSUPPORTED_MEDIA_TYPE` from the global handler.
- Jackson is not customised (no ObjectMapper bean and no `spring.jackson` in `application.yml`), so Spring Boot defaults apply. **Unknown body fields are ignored** by the typed-record endpoints (content, app-config). Nulls are serialised unless a record has `@JsonInclude(NON_NULL)`. The staff order and support controllers parse `JsonNode` by hand and **reject** unknown fields.

---

## 0. Shared types

```ts
type Iso = string // Instant ISO-8601 UTC
type Paise = number // int64 integer paise

// INTERNAL (/api/**) error envelope - every admin error
interface AdminError {
  error: {
    code: string
    message: string // see per-controller notes: generic or domain-specific
    request_id: string // == X-Request-Id
    correlation_id?: string // ONLY from the global ApiExceptionHandler, and only when a valid X-Correlation-Id was sent
  }
}
```

---

## 1. Staff orders: `/api/v1/admin/orders`

File: `customer/order/StaffOrderController.java` (service: `StaffOrderService.java`).
RBAC: `order-ops` can read and write. `support-agent` can only read. Only `HUMAN_ADMIN` principals are allowed (see §5).

### 1.1 Response types

```ts
type OrderStatus = 'CONFIRMED' | 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'CANCELLED'
// CREATED exists internally but is never listed/returned (404) - StaffOrderService.java:94,115; OrderRepository.java:98-99

interface StaffOrderLine {
  // StaffOrderController.java:37
  skuId: string
  title: string
  quantity: number // int
  unitPricePaise: Paise
  lineTotalPaise: Paise
  // NOTE: brandCode is NOT exposed to staff (the customer DTO has it)
}

interface DeliveryAddress {
  // OrderAddressSnapshot record serialised AS-IS (no NON_NULL on it)
  label: string
  recipientName: string
  recipientPhone: string // customer PII
  addressLine1: string
  addressLine2: string | null // serialised as explicit null
  landmark: string | null
  city: string
  state: string
  postalCode: string
  latitude: number | null // !! internal coordinates ARE exposed to staff (customer DTO hides them)
  longitude: number | null // both null or both set (OrderAddressSnapshot.java:47-60)
}

interface DeliverySlot {
  // CustomerOrderDto.DeliverySlot, CustomerOrderDto.java:26
  slotId: string // `${windowId}~${yyyy-mm-dd}` (OrderDeliverySlot.java:25-27)
  label: string
  startsAt: Iso
  endsAt: Iso
  // serviceAreaId/windowId/date are NOT exposed separately
}

// @JsonInclude(NON_NULL): any null field below is OMITTED (StaffOrderController.java:39-57)
interface StaffOrder {
  orderId: string // ^ORD_[A-Za-z0-9_-]{6,64}$ (OrderId.java)
  customerId: string // opaque id; no name/phone except recipient* on the address
  status: OrderStatus
  version: number // CAS token; see 1.5
  paymentMethod: 'COD' // only constant (PaymentMethod.java)
  paymentCondition?: 'COD_DUE' // present whenever confirmed (unlike customer DTO it is NOT hidden on CANCELLED)
  lines: StaffOrderLine[]
  itemCount: number
  subtotalPaise: Paise
  payablePaise?: Paise // omitted on legacy orders w/o money snapshot (absence != 0)
  deliveryAddress: DeliveryAddress
  deliverySlot?: DeliverySlot // omitted for orders placed without a slot
  createdAt: Iso
  confirmedAt?: Iso
  outForDeliveryAt?: Iso
  deliveredAt?: Iso
  cancelledAt?: Iso
  cancelledBy?: 'CUSTOMER' | 'STAFF' | 'SYSTEM' // OrderCancellation.java:8
  cancelReason?: CustomerCancelReason | StaffCancelReason // reasonCode, closed sets below
}

interface StaffOrderPage {
  // NON_NULL
  items: StaffOrder[] // full StaffOrder per row (incl. address + lines)
  nextCursor?: string // omitted at end of list
}
```

**Not exposed to staff (gaps):**

- `currency`.
- The money breakdown: `merchandiseSubtotalPaise` and `benefitDiscountPaise` are never returned (only `payablePaise`).
- The membership/benefit snapshot (`OrderBenefitSnapshot`) is not serialised anywhere.
- `quoteId`, `reservationId`, `addressId`.
- `brandCode`.
- `updatedAt`.
- There is no status-timeline array. The timeline is only the timestamps `createdAt`, `confirmedAt`, `outForDeliveryAt`, `deliveredAt` and `cancelledAt`. The actor of each transition lives only in the audit ledger (`GET /api/v1/admin/audit-events`, which needs `audit-reader`; see §5).

### 1.2 `GET /api/v1/admin/orders` (the queue)

| Query         | Type          | Rules                                                                                                                                   |
| ------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `status`      | `OrderStatus` | optional. `CREATED` or any other value gives 400 `INVALID_REQUEST` (`StaffOrderService.java:69`). Omitted means all 4 visible statuses. |
| `page_size`   | int           | optional. Must match `[1-9][0-9]{0,2}` (controller:76), then 1..50 (`MAX_PAGE`, service:44,68). Default 20.                             |
| `cursor`      | string        | optional and opaque. At most 128 chars. base64url without padding of `v1                                                                | <epochMillis> | <orderId>`, strictly re-encoded (`OrderLifecycleService.java:123-140`). Bad value gives 400 `INVALID_REQUEST`. |
| anything else | -             | **400 `INVALID_REQUEST`**: unknown query params are refused (controller:73-75).                                                         |

- Sort: `createdAt DESC, _id DESC`. Keyset pagination (`OrderRepository.java:124-133`).
- **There are no filters for date range, service area, delivery slot/date, customer, phone or text search.** Only `status` exists.
- 200 returns `StaffOrderPage`.

### 1.3 `GET /api/v1/admin/orders/{orderId}`

- 200 returns `StaffOrder`.
- An id with a malformed shape, an unknown id, or an internal `CREATED` row all give 404 `ORDER_NOT_FOUND` (service:90-96).

### 1.4 `POST /api/v1/admin/orders/{orderId}/transition` (order-ops only)

```ts
type StaffCancelReason =
  | 'OUT_OF_STOCK'
  | 'CUSTOMER_UNREACHABLE'
  | 'DELIVERY_FAILED'
  | 'CUSTOMER_REQUEST'
  | 'ADDRESS_UNSERVICEABLE'
  | 'OTHER' // OrderCancellation.java:14-15
type CustomerCancelReason = 'CHANGED_MIND' | 'ORDERED_BY_MISTAKE' | 'OTHER' // OrderCancellation.java:11 (read-only, appears in cancelReason)

interface TransitionRequest {
  // ONLY these keys; any other key -> 400 (controller:94-96)
  to: 'OUT_FOR_DELIVERY' | 'DELIVERED' | 'CANCELLED' // must be a JSON string
  expectedVersion: number // must be a JSON integer
  reason?: StaffCancelReason // REQUIRED iff to==="CANCELLED", FORBIDDEN otherwise (service:107-108)
}
```

- 200 returns the updated `StaffOrder` (re-read inside the same transaction).
- Validation order:
  1. body shape → 400.
  2. `to` not a known `OrderStatus` → 400.
  3. `to` is `CREATED` or `CONFIRMED` → 400.
  4. `reason` present/absent mismatch, or not in the staff set → 400.
  5. bad id → 404 `ORDER_NOT_FOUND`.
  6. version ≠ current → 409 `STALE_VERSION`.
  7. illegal edge → 409 `INVALID_TRANSITION`.
  8. CAS lost → 409 `STALE_VERSION`.
  9. restock failure → 500 `INTEGRITY_FAILURE`.
  10. Mongo down → 503 `UNAVAILABLE`.
- Side effects run in one transaction:
  - audit event `ORDER_<TO>` with detail `{from, to, reason?, restocked?, slot_released?}`;
  - on cancel, restock and release the delivery slot hold;
  - enqueue notification `ORDER_OUT_FOR_DELIVERY` / `ORDER_DELIVERED` / `ORDER_CANCELLED` (`StaffOrderService.java:125-161`).

### 1.5 Order state machine and version

`version` is the state-machine position, not a write counter (`OrderStatus.java:3-19`). A staff transition sets `version = expectedVersion + 1` (`OrderRepository.java:113-121`).

| From (version)       | → OUT_FOR_DELIVERY | → DELIVERED                 | → CANCELLED                             |
| -------------------- | ------------------ | --------------------------- | --------------------------------------- |
| CONFIRMED (2)        | yes, gives v3      | no (409 INVALID_TRANSITION) | yes, gives v3 (staff reason)            |
| OUT_FOR_DELIVERY (3) | no                 | yes, gives v4               | yes, gives v4 (failed/refused delivery) |
| DELIVERED (4)        | no                 | no                          | no (returns not modelled)               |
| CANCELLED (3/4)      | no                 | no                          | no                                      |

The customer can also cancel CONFIRMED → CANCELLED (`cancelledBy: CUSTOMER`, customer reason) inside a configured window (`OrderLifecycleService`). `SYSTEM` is an enum value with no producer found: UNKNOWN.

### 1.6 Errors (controller-local advice, `StaffOrderController.java:103-130`)

Envelope: `AdminError`. The `message` is always `"request could not be completed"`, and there is no `correlation_id`. The `code` is the **raw `OrderFailure.Reason` name**:

| HTTP | code                                                                                    |
| ---- | --------------------------------------------------------------------------------------- |
| 400  | `INVALID_REQUEST` (also for an unreadable JSON body)                                    |
| 404  | `ORDER_NOT_FOUND` (note: not `NOT_FOUND`)                                               |
| 409  | `STALE_VERSION`, `INVALID_TRANSITION` (any other reason also maps to 409 via `default`) |
| 500  | `INTEGRITY_FAILURE`                                                                     |
| 503  | `UNAVAILABLE` (note: not `SERVICE_UNAVAILABLE`; no `Retry-After`)                       |

Anything else falls through to the global `ApiExceptionHandler` (§6): 405, 415, and a corrupt stored order (`IllegalArgumentException` gives 400 `MALFORMED_REQUEST`; `IllegalStateException` gives 409 `STATE_CONFLICT`). `OrderExceptionHandler.java` is for the **customer** `OrderController` only and does **not** apply here (`OrderExceptionHandler.java:26`).

---

## 2. Staff support: `/api/v1/admin/support/cases`

Files: `support/StaffSupportController.java`, `SupportService.java`, `SupportDtos.java`, `SupportCase.java`, `SupportExceptionHandlers.java`.
RBAC: `support-agent` can read and write. `order-ops` can only read. `HUMAN_ADMIN` only.

### 2.1 Types

```ts
type CaseStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED' // SupportCase.java:12
type CaseCategory = 'ORDER_ISSUE' | 'DELIVERY' | 'PRODUCT' | 'ACCOUNT' | 'OTHER' // SupportCase.java:10

interface StaffMessage {
  // SupportDtos.java:33 - no NON_NULL
  id: number // 1-based sequence within the case
  author: 'CUSTOMER' | 'STAFF'
  staffId: string | null // actor id of the staff author, e.g. "google:<sub>"; null for customer messages
  text: string // plain text, may contain \n
  at: Iso
}

interface StaffCase {
  // SupportDtos.java:35-43 - NON_NULL (orderId/assignedTo omitted when null)
  caseId: string // SUP_[A-Za-z0-9_-]{20,40}
  customerId: string // ONLY customer identity exposed: no name, phone, email
  category: CaseCategory
  orderId?: string // optional linked order (customer's own)
  subject: string // <=120
  status: CaseStatus
  assignedTo?: string // staff actor id ("google:<sub>")
  version: number // CAS token; bumped by EVERY change incl. replies (SupportCaseRepository.java:80-81,89)
  messages: StaffMessage[] // max 100
  createdAt: Iso
  updatedAt: Iso
}

interface StaffCaseSummary {
  // SupportDtos.java:45-51 - NO NON_NULL -> assignedTo: null is serialised
  caseId: string
  customerId: string
  category: CaseCategory
  subject: string
  status: CaseStatus
  assignedTo: string | null
  messageCount: number
  version: number
  updatedAt: Iso
  // no createdAt, no orderId in the summary
}

interface StaffCasePage {
  items: StaffCaseSummary[]
  nextCursor?: string
} // NON_NULL
```

There is no endpoint that resolves `staffId`/`assignedTo` (`google:<sub>`) to a display name or email. `/api/v1/admin/me` gives only the caller's own email. UNKNOWN how the CMS should display other agents' names.

### 2.2 `GET /api/v1/admin/support/cases`

| Query        | Rules                                                                      |
| ------------ | -------------------------------------------------------------------------- |
| `status`     | optional `CaseStatus`. An invalid value gives 400 `INVALID_REQUEST`.       |
| `page_size`  | `[1-9][0-9]{0,2}` and 1..50. Default 20 (`SupportService.java:46-47,229`). |
| `cursor`     | ≤128 chars. Opaque base64url of `v1                                        | <millis> | <caseId>`. |
| other params | 400 `INVALID_REQUEST`.                                                     |

- **There is no `category`, `assignedTo`/"mine", customer or text filter.**
- Sort: `updatedAt DESC, _id DESC` (`SupportCaseRepository.java:58-67`). The keyset is on `updatedAt`, which changes on every reply, so rows can move between pages. Dedupe by `caseId`.

### 2.3 `GET /api/v1/admin/support/cases/{caseId}`

200 returns `StaffCase`. A bad or unknown id gives 404 `NOT_FOUND`.

### 2.4 `POST /api/v1/admin/support/cases/{caseId}/messages` (reply)

```ts
interface ReplyRequest {
  message: string
} // EXACTLY one key (controller:51)
```

- Text is stripped, then must be 1..2000 chars, with no control chars except `\n` and no DEL (`SupportCase.java:30-38`). A violation gives 400.
- **No `expectedVersion` (no CAS)**, but the reply bumps `version`.
- Effects:
  - OPEN becomes IN_PROGRESS.
  - IN_PROGRESS and RESOLVED **keep their status**: a staff reply does not reopen a case.
  - CLOSED gives 409 `STATE_CONFLICT`.
  - At 100 messages: 409 `MESSAGE_LIMIT`.
  - Audit `SUPPORT_STAFF_REPLIED`, plus notification `SUPPORT_REPLY` (`SupportService.java:147-167`).
- 200 returns `StaffCase`.

### 2.5 `POST /api/v1/admin/support/cases/{caseId}/assign`

```ts
interface AssignRequest {
  expectedVersion: number
} // integer >= 1; body may contain AT MOST 1 key (controller:68-74)
```

- **Assigns to the caller only.** There is no body field for an assignee, no unassign, and no assigning to others. Re-assigning a case already assigned to someone else is allowed (it takes the case over).
- OPEN becomes IN_PROGRESS. Other statuses are unchanged. CLOSED gives 409 `STATE_CONFLICT`. A version mismatch gives 409 `STALE_VERSION`. Audit `SUPPORT_ASSIGNED`.

### 2.6 `POST /api/v1/admin/support/cases/{caseId}/status`

```ts
interface CaseStatusRequest {
  to: 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED'
  expectedVersion: number
} // <=2 keys
```

Legal staff transitions (`SupportService.java:181-195`, repository CAS requires `from ∈ {OPEN, IN_PROGRESS, RESOLVED}`):

| from \ to   | IN_PROGRESS                     | RESOLVED   | CLOSED |
| ----------- | ------------------------------- | ---------- | ------ |
| OPEN        | yes                             | yes        | yes    |
| IN_PROGRESS | 409 STATE_CONFLICT (same state) | yes        | yes    |
| RESOLVED    | **yes (the staff "reopen")**    | 409 (same) | yes    |
| CLOSED      | 409 (final)                     | 409        | 409    |

- `to: "OPEN"` gives **400** `INVALID_REQUEST`. Staff cannot set OPEN.
- A **customer** reply on a RESOLVED case reopens it to OPEN (`SupportService.java:111`). A customer can also close a case.
- RESOLVED enqueues `SUPPORT_CASE_RESOLVED`. Audit `SUPPORT_STATUS_CHANGED {to}`.

### 2.7 Errors (`SupportExceptionHandlers.Staff`, `SupportExceptionHandlers.java:70-90`)

Envelope: `AdminError`. The `message` is always `"request could not be completed"`. The code is the raw reason name:

| HTTP | code                                                                                  |
| ---- | ------------------------------------------------------------------------------------- |
| 400  | `INVALID_REQUEST` (also for an unreadable body)                                       |
| 404  | `NOT_FOUND`                                                                           |
| 409  | `STATE_CONFLICT`, `STALE_VERSION`, `MESSAGE_LIMIT` (`TOO_MANY_OPEN` is customer-only) |
| 503  | `UNAVAILABLE` (no Retry-After)                                                        |

Anything else falls through to the global handler.

---

## 3. Content: `/api/v1/admin/content/blocks`, `/api/v1/admin/app-config`, and public reads

Files: `content/ContentAdminController.java`, `ContentService.java`, `ContentBlock.java`, `AppConfig.java`, `PublicContentController.java`.
RBAC: legacy coarse rules. GET needs `reader` or `cms-writer`. PUT/POST need `cms-writer` (§5).

### 3.1 Block model

```ts
type Placement = 'HOME' | 'HELP'
type BlockType = 'BANNER' | 'PRODUCT_RAIL' | 'CATEGORY_GRID' | 'FAQ'
// placement is FIXED per type: BANNER/PRODUCT_RAIL/CATEGORY_GRID -> HOME, FAQ -> HELP (ContentBlock.java:21-34)
type BlockStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED'
type FaqCategory = 'DELIVERY' | 'PRODUCT' | 'CLUB' | 'PAYMENT' | 'REFUND' | 'ACCOUNT' // enum order = public display order

interface BlockPayload {
  // PayloadDto, NON_NULL; fields not belonging to the type MUST be absent/null
  imageAssetKey?: string // BANNER
  link?: string // BANNER
  ids?: string[] // PRODUCT_RAIL / CATEGORY_GRID (omitted in responses when empty)
  faqCategory?: FaqCategory // FAQ
  question?: string // FAQ
  answer?: string // FAQ
}

interface BlockResponse {
  // ContentAdminController.java:43-53, NON_NULL
  blockId: string // CB_[A-Za-z0-9_-]{16,40} (generated: CB_ + 20 chars)
  placement: Placement
  type: BlockType
  title: string
  sort: number
  status: BlockStatus
  startsAt?: Iso // omitted when no window start
  endsAt?: Iso
  payload: BlockPayload
  version: number // starts at 1, +1 on every update/status change
  createdAt: Iso
  updatedAt: Iso
}
interface BlockList {
  items: BlockResponse[]
} // no pagination, no cursor
```

Per-type payload validation (`ContentBlock.java:64-134`; the first violated rule is returned as the error `message`):

| Field / type          | Rule                                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `title` (all types)   | Required. 1..80 chars. Not blank. No leading/trailing whitespace (`title === title.strip()`). No chars < 0x20 and no DEL.                                                                                                                        |
| `sort` (all types)    | Required integer, 0..10000.                                                                                                                                                                                                                      |
| `startsAt` / `endsAt` | Optional ISO-8601 instants (`Instant.parse`; use `...Z`). If both are set, `startsAt < endsAt`. A bad format gives 422 `"times are ISO-8601 instants"`.                                                                                          |
| Any non-FAQ type      | Must not carry `faqCategory`/`question`/`answer`.                                                                                                                                                                                                |
| BANNER                | `imageAssetKey`: safe key `^[A-Za-z0-9][A-Za-z0-9/_.-]*$`, ≤512 chars, no `..`, no `//`, no trailing `/`, no all-dot segments (`media/MediaAsset.java:44,49,62-70`). `link`: required, `^(product:TZP-[A-Za-z0-9-]{1,40}                         | category:TZ[SCGV]-[0-9]{6} | search:[\p{L}\p{N} ]{2,64})$`. **No arbitrary URLs.** `ids` must be empty. |
| PRODUCT_RAIL          | `ids`: 1..20 unique values matching `TZP-[A-Za-z0-9-]{1,40}`. No `imageAssetKey` or `link`. Existence of the ids is **not checked**.                                                                                                             |
| CATEGORY_GRID         | `ids`: 1..12 unique values matching `TZ[SCGV]-[0-9]{6}`. No `imageAssetKey` or `link`. Existence is not checked.                                                                                                                                 |
| FAQ                   | Only `faqCategory`, `question` and `answer`. `faqCategory` must be in the enum. `question`: 1..200 chars, no newline. `answer`: 1..2000 chars, `\n` allowed. Neither may contain control chars, DEL, `<` or `>`, or leading/trailing whitespace. |

- Per-placement cap: 200 non-ARCHIVED blocks. Creating the 201st gives 409 `STATE_CONFLICT` `"too many blocks in this placement; archive some"` (`ContentService.java:41,73-75`).

### 3.2 Endpoints

**`GET /api/v1/admin/content/blocks?placement=HOME|HELP&status=DRAFT|PUBLISHED|ARCHIVED`**

- `placement` defaults to `HOME`. `status` is optional (absent means all, including ARCHIVED). An unknown enum value gives 422 `INVALID_CONTENT` (`"unknown Placement"` / `"unknown Status"`). Other query params are **ignored**.
- Sort: `sort ASC, _id ASC`. At most 200 rows (`ContentService.java:125-134`).
- 200 returns `BlockList`.

**`GET /api/v1/admin/content/blocks/{id}`**

- 200 returns `BlockResponse`. A bad or unknown id gives 404 `NOT_FOUND` `"no such block"`.

**`POST /api/v1/admin/content/blocks`**: creates the block as DRAFT.

```ts
interface CreateBlockRequest {
  placement?: Placement // default "HOME" (controller:81) -> FAQ creators MUST send "HELP"
  type: BlockType // required
  title: string
  sort: number // required (null -> 422 "sort and payload are required")
  startsAt?: Iso | null
  endsAt?: Iso | null
  payload: BlockPayload // required
  // expectedVersion ignored on create
}
```

- **201** returns `BlockResponse` (status `DRAFT`, version 1). There is no `Location` header.
- Errors: a type/placement mismatch gives 422 `"type FAQ belongs on placement HELP"`.

**`PUT /api/v1/admin/content/blocks/{id}`**: full replace of the editable fields.

```ts
interface UpdateBlockRequest {
  title: string
  sort: number // required
  startsAt?: Iso | null // OMITTING CLEARS the window bound (ContentService.java:99-100)
  endsAt?: Iso | null
  payload: BlockPayload // required
  expectedVersion: number // required
  type?: never // must be absent/null -> else 422 "type and placement are fixed at creation"
  placement?: never
}
```

- Allowed in DRAFT **and PUBLISHED**: editing a published block changes live content immediately. There is no draft copy.
- ARCHIVED gives 409 `STATE_CONFLICT` `"an archived block is final"`. A version mismatch gives 409 `STALE_VERSION` `"the block changed; reload it"`.
- 200 returns `BlockResponse`.

**`POST /api/v1/admin/content/blocks/{id}/status`**

```ts
interface BlockStatusRequest {
  to: BlockStatus
  expectedVersion: number /* required */
}
```

| from \ to | DRAFT                                | PUBLISHED     | ARCHIVED |
| --------- | ------------------------------------ | ------------- | -------- |
| DRAFT     | 409 STATE_CONFLICT ("already DRAFT") | yes (publish) | yes      |
| PUBLISHED | yes (unpublish)                      | 409           | yes      |
| ARCHIVED  | 409 (final)                          | 409           | 409      |

- An unknown `to` gives 422 `"unknown Status"`. A stale version gives 409 `STALE_VERSION`.
- Audit event `CONTENT_BLOCK_<TO>` with `{from}` (`ContentService.java:105-116`).
- Blocks are never deleted.

**Live rule.** A block is live when `status == PUBLISHED && (startsAt == null || now >= startsAt) && (endsAt == null || now < endsAt)`, using the server clock (`ContentBlock.java:136-138`). A PUBLISHED block outside its window is just not shown, and there is no separate "scheduled" status. The CMS must compute "Scheduled" and "Expired" itself.

### 3.3 App config

```ts
// GET /api/v1/admin/app-config -> AppConfig record serialised AS-IS (no NON_NULL: absent values are explicit null)
interface AppConfig {
  storeOpen: boolean
  maintenance: boolean
  maintenanceMessage: string | null
  minAndroid: string | null
  latestAndroid: string | null
  minIos: string | null
  latestIos: string | null
  supportPhone: string | null
  supportEmail: string | null
  termsUrl: string | null
  privacyUrl: string | null
  refundPolicyUrl: string | null
  version: number // 0 = never saved (AppConfig.DEFAULT: storeOpen=true, maintenance=false, rest null)
}

// PUT /api/v1/admin/app-config  -> 200 AppConfig (re-read; version = expectedVersion+1)
interface PutAppConfigRequest {
  // FULL REPLACE: any omitted optional field is stored as null
  storeOpen: boolean // required
  maintenance: boolean // required
  maintenanceMessage?: string | null
  minAndroid?: string | null
  latestAndroid?: string | null
  minIos?: string | null
  latestIos?: string | null
  supportPhone?: string | null
  supportEmail?: string | null
  termsUrl?: string | null
  privacyUrl?: string | null
  refundPolicyUrl?: string | null
  expectedVersion: number // required; 0 = create (first save), else CAS on current version
}
```

Validation (`AppConfig.java:25-63`). Each failure gives 422 `INVALID_CONTENT` with the quoted message:

| Field                                       | Rule                                                                                                                                                                      | Message                                                             |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| required trio                               | `storeOpen`, `maintenance` and `expectedVersion` must not be null                                                                                                         | `"storeOpen, maintenance and expectedVersion are required"`         |
| `maintenanceMessage`                        | null, or 1..200 chars, not blank, no chars < 0x20 (**no newlines**) and no DEL                                                                                            | `"maintenanceMessage must be 1..200 chars of plain text"`           |
| `maintenance=true`                          | requires `maintenanceMessage`                                                                                                                                             | `"maintenance needs a message"`                                     |
| version fields                              | `^[0-9]{1,4}(\.[0-9]{1,4}){0,3}$`                                                                                                                                         | `"versions are dotted numbers like 1.4.2"`                          |
| min ≤ latest                                | numeric, segment-wise (1.10 > 1.9)                                                                                                                                        | `"minAndroid exceeds latestAndroid"` / `"minIos exceeds latestIos"` |
| `supportPhone`                              | E.164 `^\+[1-9][0-9]{7,14}$`                                                                                                                                              | `"supportPhone must be E.164"`                                      |
| `supportEmail`                              | `^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$`                                                                                                           | `"supportEmail is not an email address"`                            |
| `termsUrl`, `privacyUrl`, `refundPolicyUrl` | null, or ≤500 chars with no chars ≤ 0x20 or DEL, parseable by `java.net.URI`, scheme exactly `https` (lowercase), non-blank host, no userinfo and no `@` in the authority | `"<field> must be an absolute https URL"`                           |

- **Send `null`, never `""`, for "not set".** An empty string fails the version, phone, email and URL rules.
- CAS: a wrong `expectedVersion` gives 409 `STALE_VERSION` `"app config changed; reload it"`. `expectedVersion: 0` when a config already exists gives 409 `STALE_VERSION` `"app config already exists; reload it"` (`ContentService.java:178-211`).
- Audit event `APP_CONFIG_UPDATED {storeOpen, maintenance, version}`.

### 3.4 Content admin errors (`ContentAdminController.Errors`, lines 130-153)

Envelope: `AdminError`. **The `message` is the domain message** (specific and safe to show next to form fields). There is no `correlation_id`.

| HTTP | code                              |
| ---- | --------------------------------- |
| 422  | `INVALID_CONTENT`                 |
| 404  | `NOT_FOUND`                       |
| 409  | `STALE_VERSION`, `STATE_CONFLICT` |

Anything not a `ContentFailure` goes to the global handler:

- Unparseable JSON, or a wrong JSON type (e.g. `"sort":"x"`): 400 `MALFORMED_REQUEST`.
- Mongo outage: **500 `INTERNAL`** (there is no 503 mapping here).

### 3.5 Public reads (for preview parity; surface `PUBLIC_CONSUMER`, no auth)

| Endpoint               | Query                                    | 200 body                                                                                                                                                                                     | Headers                             |
| ---------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `GET /v1/content/home` | none (any param gives 400)               | `{ blocks: {blockId, type, title, imageUrl?, link?, ids?}[], requestId }`                                                                                                                    | `Cache-Control: public, max-age=60` |
| `GET /v1/content/faqs` | optional single `category=<FaqCategory>` | `{ faqs: {faqId, category, question, answer}[], requestId }`, sorted by category enum order, then sort, then id                                                                              | same                                |
| `GET /v1/app-config`   | none                                     | `{ storeOpen, maintenance:{enabled, message?}, android:{minSupported?, latest?}, ios:{...}, support:{phone?, email?}, legal:{termsUrl, privacyUrl, refundPolicyUrl} (nullable), requestId }` | same                                |

- Banners are dropped from `/v1/content/home` when the media base URL is not configured (`PublicContentController.java:84-88`). `imageUrl` is resolved from `imageAssetKey`.
- Public error body: `{code, message, requestId, retryable}`. Codes: 400 `INVALID_REQUEST`, 429 `RATE_LIMITED` (with `Retry-After: <seconds>`), 503 `SERVICE_UNAVAILABLE`, 500 `INTERNAL`. Errors carry `Cache-Control: no-store`.

---

## 4. Notifications (transactional outbox)

Files: `notification/*`; doc `docs/ops/NOTIFICATIONS.md`.

- **There is no admin HTTP endpoint to list, read, retry or inspect outbox rows.** No `@*Mapping` exists in `notification/`, and none of the 32 admin paths in `openapi.json` is a notification path.
- The **only** HTTP visibility is two aggregate counts in `GET /api/v1/admin/dashboard/summary`: `notifications.pending` and `notifications.failed`, each `{value, capped}` (`dashboard/DashboardSummaryService.java:95-99`). SENDING, SENT and EXPIRED are not counted.
- Collection `notification_outbox`.
  - `_id` is `TYPE:subject` (the dedupe key).
  - Fields: `type`, `customer_id`, `subject_id`, `params`, `status`, `attempts`, `next_attempt_at`, `created_at`, `expire_at` (+7 days, removed by a TTL index), `lease_until`, `claim_token`, `completed_at` (`NotificationOutbox.java`).
- Types (`NotificationType.java`): `ORDER_CONFIRMED`, `ORDER_OUT_FOR_DELIVERY`, `ORDER_DELIVERED`, `ORDER_CANCELLED`, `SUPPORT_REPLY`, `SUPPORT_CASE_RESOLVED`.
- Statuses: `PENDING` → `SENDING` (leased) → `SENT` | `FAILED` | `EXPIRED`. A retry goes back to `PENDING` with exponential backoff.
- **No provider adapter exists.** `DisabledNotificationSender` makes enabling dispatch a startup failure, so in practice every row stays `PENDING` until the TTL removes it (`NOTIFICATIONS.md:49`).

Dashboard summary shape (for reference; `Cache-Control: no-store`):

```ts
type Count = { value: number; capped: boolean } // capped => ">= 10000"
interface DashboardSummary {
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
  generatedAt: Iso
  bounds: { cap: number; maxTimeMs: number; recentWindowHours: number }
}
// 503 {error:{code:"SERVICE_UNAVAILABLE", message:"dashboard unavailable", request_id}}
```

The dashboard is a non-staff path, so `order-ops` and `support-agent` alone **cannot** read it, even though it shows order and support counts.

---

## 5. Authorization

Files: `admin/auth/AdminAccessPolicy.java`, `admin/auth/AdminPrincipal.java`, `catalog/api/ApiAuthFilter.java`, `catalog/api/SurfaceClassifier.java`; doc `docs/ops/ADMIN_ROLES.md`.

Pipeline: `RequestIdFilter` → `RequestBodyLimitFilter` → CORS → `ApiAuthFilter` (`HTTP_PLATFORM_BASELINE.md:77`).

1. Surface classification. `/api` and `/api/**` are INTERNAL. A URI with `;`, `%`, `\`, `.` or `..` segments is UNKNOWN. Any UNKNOWN path gives **404 `NO_SUCH_ENDPOINT`** before auth (`ApiAuthFilter.java:91-94`, `SurfaceClassifier.java:125-137`).
2. Authentication: `Authorization: Bearer <token>`. A shared service token (`service:reader` / `service:cms-writer`, actor type `SERVICE_ACCOUNT`) is tried first, then a Google OIDC ID token (actor type `HUMAN_ADMIN`, id `google:<sub>`, roles taken from the backend allowlist).
   - Missing, invalid or expired token: **401 `UNAUTHENTICATED`**, message `"missing or unknown bearer token"`.
   - Not allowlisted, disabled, wrong domain, or unverified email: **403 `FORBIDDEN`**, message `"admin access not granted"` (`ApiAuthFilter.java:136-153`).
3. Policy. **"Read" means `GET` only.** Every other method, including HEAD, counts as a write (`AdminAccessPolicy.java:31`).
   - Staff namespaces `/api/v1/admin/orders[/**]` and `/api/v1/admin/support[/**]` use the staff rule.
   - Everything else uses the legacy rule: a write needs `cms-writer`; a read needs `reader` or `cms-writer`, except the narrow paths.
   - Narrow paths: `/api/v1/admin/me` and `/api/v1/admin/audit-events` for non-staff principals. For **staff** principals the set is just `/api/v1/admin/me` (`ApiAuthFilter.java:46-50,114-115`).
   - A refusal gives 403 `FORBIDDEN` with message `"role may not perform writes here"` or `"role may not read this resource"`.
4. Audit endpoint. `GET /api/v1/admin/audit-events` additionally requires `HUMAN_ADMIN` + `audit-reader` inside the controller. Otherwise: 403 `FORBIDDEN` (`AdminAuditEventsController.java:47-51`).

### 5.1 Matrix (one role per principal)

R = GET allowed, W = POST/PUT/PATCH/DELETE allowed, `-` = 403. "Human" means `HUMAN_ADMIN`. Shared tokens only ever carry `reader` or `cms-writer`.

| Namespace (all under `/api/v1/admin` unless noted)            | reader                             | cms-writer                         | audit-reader (human) | order-ops (human) | support-agent (human) |
| ------------------------------------------------------------- | ---------------------------------- | ---------------------------------- | -------------------- | ----------------- | --------------------- |
| `/me` (GET)                                                   | R                                  | R                                  | R                    | R                 | R                     |
| `/orders/**`                                                  | -                                  | -                                  | -                    | **R W**           | R only (W → 403)      |
| `/support/**`                                                 | -                                  | -                                  | -                    | R only            | **R W**               |
| `/content/**`                                                 | R                                  | R W                                | -                    | -                 | -                     |
| `/app-config`                                                 | R                                  | R W                                | -                    | -                 | -                     |
| `/dashboard/summary`                                          | R                                  | R                                  | -                    | -                 | -                     |
| `/imports/*` (POST only)                                      | - (write)                          | W                                  | -                    | -                 | -                     |
| `/media/**`                                                   | R                                  | R W                                | -                    | -                 | -                     |
| `/prices/**`                                                  | R                                  | R W                                | -                    | -                 | -                     |
| `/inventory/**`                                               | R                                  | R W                                | -                    | -                 | -                     |
| `/service-areas/**`                                           | R                                  | R W                                | -                    | -                 | -                     |
| `/delivery-slots/**`                                          | R                                  | R W                                | -                    | -                 | -                     |
| `/audit-events` (GET)                                         | filter passes → **controller 403** | filter passes → **controller 403** | **R**                | -                 | -                     |
| other `/api/v1/**` (products, taxonomy, attributes, evidence) | R                                  | R W                                | -                    | -                 | -                     |
| any `/api/**` via shared token on the staff namespaces        | -                                  | -                                  | n/a                  | n/a               | n/a                   |

Combined roles (the allowlist allows several):

- `reader`/`cms-writer` + a staff role: the legacy namespaces follow the legacy role, and the staff namespaces follow the staff role.
- **`audit-reader` + a staff role, without reader or cms-writer: `/audit-events` is refused at the filter.** Because the principal `isStaff()`, its narrow set shrinks to `/me` only (`ApiAuthFilter.java:115`). This is likely unintended.
- `order-ops` + `support-agent`: R/W on both staff namespaces.

The CMS can build its navigation from `GET /api/v1/admin/me`:

```ts
{ actorType: "HUMAN_ADMIN" | "SERVICE_ACCOUNT"; actorId: string; email?: string; roles: string[] /* sorted */ }
```

CORS: off by default. When enabled, a request with an `Origin` outside the allowlist gets a **plain 403** (the body is not the JSON envelope: UNKNOWN shape) (`HTTP_PLATFORM_BASELINE.md:57-66`). Use a server-side BFF.

---

## 6. Error envelopes and codes

**INTERNAL (`/api/**`), nested** (`catalog/api/ApiExceptionHandler.java:41,226-243`):

```json
{
  "error": {
    "code": "STALE_VERSION",
    "message": "…",
    "request_id": "req_0123456789abcdef0123",
    "correlation_id": "opt"
  }
}
```

- `correlation_id` appears **only** on errors produced by the global `ApiExceptionHandler`. The errors from `ApiAuthFilter`, the 413 filter, and the controller-local advices (staff orders, support, content, dashboard) never include it.
- The global handler's `message` may be specific (domain text). The staff order and support advices always say `"request could not be completed"`. The content advice passes the domain message through.

**Public/customer (`/v1/**`, `/catalog/v1/**`), flat.** The global handler collapses everything to `{code, message, request_id?}`: `NOT_FOUND` 404, `SERVICE_UNAVAILABLE` 503, otherwise `INVALID_REQUEST` 400 (`ApiExceptionHandler.java:250-272`). Domain advices on these surfaces use `{code, message, requestId[, retryable]}` (camelCase `requestId`). `docs/api/v1/CONTRACTS.md:27-34` documents the frozen `/v1` envelope `{code, message, requestId, retryable, retryAfterSeconds, details}`, but not every controller emits all of those fields (`PublicContentController` emits only `code`, `message`, `requestId`, `retryable`).

### 6.1 Status → code on the INTERNAL surface

| HTTP | code(s)                                                                                                                                                                                   | Source                                      |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 400  | `MALFORMED_REQUEST`: unreadable body (`"request body is malformed or unreadable"`), param type mismatch, missing param, `IllegalArgumentException`                                        | global :130-186                             |
| 400  | `MISSING_HEADER`                                                                                                                                                                          | global :125-128                             |
| 400  | `INVALID_REQUEST`                                                                                                                                                                         | staff orders, staff support (local)         |
| 401  | `UNAUTHENTICATED`                                                                                                                                                                         | ApiAuthFilter                               |
| 403  | `FORBIDDEN` (policy, allowlist, audit)                                                                                                                                                    | ApiAuthFilter; global :105-108              |
| 403  | plain 403 for a disallowed CORS Origin (not JSON)                                                                                                                                         | CORS config                                 |
| 404  | `NO_SUCH_ENDPOINT` (UNKNOWN surface or unmapped route); `NOT_FOUND` (content, support, catalog); `ORDER_NOT_FOUND` (staff orders)                                                         |                                             |
| 405  | `METHOD_NOT_ALLOWED` (message is Spring's text)                                                                                                                                           | global :138-141                             |
| 406  | `NOT_ACCEPTABLE`                                                                                                                                                                          | global :188-191                             |
| 409  | `STALE_VERSION`, `STATE_CONFLICT`, `INVALID_TRANSITION`, `MESSAGE_LIMIT`, `DUPLICATE_KEY`, `IDENTITY_COLLISION`, …                                                                        |                                             |
| 413  | `PAYLOAD_TOO_LARGE` `"request body too large"`, plus the `Connection: close` header. The default limit is 64 KiB (2 MiB for `/api/v1/admin/imports/`). It fires before auth.              | `RequestBodyLimitFilter.java:41-42,110-119` |
| 415  | `UNSUPPORTED_MEDIA_TYPE`                                                                                                                                                                  | global :143-146                             |
| 422  | `INVALID_CONTENT` (content/app-config), `DOCUMENT_VALIDATION`, `ATTRIBUTE_VIOLATION`, …                                                                                                   |                                             |
| 429  | **none on `/api/**`** (no admin rate limiter). Only public and customer surfaces send `RATE_LIMITED` + `Retry-After` (integer seconds).                                                   | `PublicContentController.java:163-167`      |
| 500  | `INTERNAL` `"internal error"`; `INTEGRITY_FAILURE` (staff orders)                                                                                                                         |                                             |
| 503  | `UNAVAILABLE` (staff orders and support); `SERVICE_UNAVAILABLE` (dashboard). **No `Retry-After` on the admin surface.** The content admin has no 503: Mongo errors become 500 `INTERNAL`. |                                             |

Response headers on the admin surface:

- `X-Request-Id` on every response.
- `X-Correlation-Id` when a valid one was sent.
- `Cache-Control: no-store` on the dashboard success response and its 503 only. **No `Cache-Control` is set on the order, support or content admin responses**, so the BFF should add `no-store` itself. `SecurityHeadersFilter` adds only `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, CSP, HSTS, CORP and `Permissions-Policy` (`catalog/api/SecurityHeadersFilter.java:30-36`).
- No `ETag` or `Location`.
