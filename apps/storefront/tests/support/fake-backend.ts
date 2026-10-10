import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https'
import { deflateSync } from 'node:zlib'

/**
 * Local stand-in for the PUBLIC Tazzzo API (never production) plus a separate fake media (CDN) host, so the CSP
 * `img-src` and the media-base allowlist are exercised against a real second origin.
 *
 * Mirrors the served contract (tazzzo-backend docs/api/v1/openapi.yaml, PublicContentController):
 * - `GET /v1/content/home`: `channel` is the ONLY accepted parameter (app|web, once); anything else is 400. Blocks are
 *   stored with an audience and filtered here like the backend does (web: WEB_ONLY+BOTH, app: APP_ONLY+BOTH, absent:
 *   BOTH only), in stored order, with `Cache-Control: public, max-age=60`;
 * - `GET /v1/products/{id}`, `/v1/categories`, `/v1/categories/{id}`, `/v1/categories/{id}/children`,
 *   `/v1/categories/{id}/products`, `/v1/search` with the documented shapes; unknown ids are a flat 404.
 * - the customer auth contract (OtpController, SessionController, CustomerProfileController): OTP request/verify,
 *   session establish, refresh with rotation (the old refresh token dies), logout (bearer) and `GET /v1/customer/profile`,
 *   with the backend's public error codes. Test phones/codes: see `handleAuth`. Test tokens only, never real values.
 * - the customer cart contract (CartController): `GET/DELETE /v1/customer/cart`, `PUT/DELETE /v1/customer/cart/items/{sku}`,
 *   with the backend's rules: `If-Match: "cart-<version>"` required (428) and compared (412), `quantity` an integer
 *   1..20, 50 distinct lines (409 CART_ITEM_LIMIT_REACHED), unknown/invalid sku 404, every answer the full enriched cart.
 *   With no `addressId` the backend knows no location, so every line is `LOCATION_REQUIRED` with stock `UNKNOWN`;
 *   `POST /__control/cart` switches a sku to the answers a located cart gives (out of stock, price changed, ...).
 * - delivery location, addresses and slots (S3; compared with the controller sources, differences listed in the PR):
 *   `GET /v1/serviceability?pin=` (pin required, `^[1-9][0-9]{5}$`, lat/lng 400; serviceable PINs 560001, 560002, 110001; 500500
 *   is a 503), `?pin=` on product/list/search reads (stock and `serviceable` only for a serviceable PIN; lat/lng 400; list/search
 *   cursors are bound to the PIN they started under), `?addressId=` on the cart (owned address -> located by its PIN; foreign,
 *   unknown or malformed id -> 404), `/v1/customer/addresses**` (per customer; 201 create with optional `Idempotency-Key`,
 *   `If-Match: "address-<n>"` on PATCH/DELETE, 10 max, first becomes default, strict field validation) and
 *   `GET /v1/customer/delivery/slots` (AVAILABLE / FULL / CLOSED, no capacity). `+919123456780` signs in as a second customer.
 * Every API request is recorded (with any trusted-caller headers); tests read them through `GET /__control/requests`. `POST /__control/media?down=1`
 * makes the media host fail every image (CDN outage).
 */
export interface RecordedRequest {
  method: string
  path: string
  query: string
  /** The trusted-caller headers as received (test values only), or null when absent. */
  caller: string | null
  callerSecret: string | null
  /** Whether an `Authorization` header arrived (its value is a throwaway test token and is not kept). */
  bearer: boolean
  /** `X-Forwarded-For` as received: the storefront must never send one. */
  forwardedFor: string | null
  /** `If-Match` as received (the cart's version precondition), or null. */
  ifMatch: string | null
  /** `Idempotency-Key` as received (address create), or null. */
  idempotencyKey: string | null
}

interface FakeSession {
  customerId: string
  refreshToken: string
  accessTokens: Set<string>
  revoked: boolean
}

type Audience = 'APP_ONLY' | 'WEB_ONLY' | 'BOTH'

/** How the fake enriches a cart line (`/__control/cart?sku=..&mode=..`). `located` = as if a delivery address were known. */
type CartMode =
  | 'default'
  | 'located'
  | 'out_of_stock'
  | 'insufficient'
  | 'unserviceable'
  | 'unavailable'
  | 'price_changed'

interface FakeCart {
  version: number
  lines: Array<{ sku: string; quantity: number; addedAt: string; updatedAt: string }>
  freshness: 'FRESH' | 'REVALIDATE'
}

interface FakeAddress {
  addressId: string
  customerId: string
  label: string
  recipientName: string
  recipientPhone: string
  addressLine1: string
  addressLine2: string | null
  landmark: string | null
  city: string
  state: string
  postalCode: string
  version: number
}

const SERVICEABLE_PINS = new Set(['560001', '560002', '110001'])
const PIN_RE = /^[1-9][0-9]{5}$/
const ADDRESS_ID_RE = /^ADDR_[A-Za-z0-9_-]{6,64}$/

export class FakeBackend {
  url = ''
  mediaUrl = ''
  mediaDown = false
  readonly requests: RecordedRequest[] = []
  /** Access token lifetime handed out by `/v1/auth/session` and `/v1/auth/refresh` (seconds). */
  accessTtlSeconds = 900
  refreshCount = 0
  logoutCount = 0
  private readonly challenges = new Map<string, { phone: string; wrong: number }>()
  private readonly grants = new Set<string>()
  private readonly sessions = new Map<string, FakeSession>()
  private cart: FakeCart = { version: 0, lines: [], freshness: 'FRESH' }
  private readonly cartModes = new Map<string, CartMode>()
  private readonly cartPrices = new Map<string, number>()
  private cartDown = false
  private readonly grantPhones = new Map<string, string>()
  private readonly addresses = new Map<string, FakeAddress[]>()
  private readonly addressKeys = new Map<string, { hash: string; id: string }>()
  private defaultByCustomer = new Map<string, string>()
  private paged = false
  private slotsFull = false
  private addressDown = false
  private api?: Server
  private media?: Server | HttpsServer

  /** @param publicMediaBase media base used in API responses; default: this fake's own media host + `/media`. */
  private readonly publicMediaBase: string | undefined

  constructor(publicMediaBase?: string) {
    this.publicMediaBase = publicMediaBase
  }

  /** Absolute media URL for a file name, under the media base (`<mediaUrl>/media` unless overridden). */
  m(name: string): string {
    return `${this.publicMediaBase ?? `${this.mediaUrl}/media`}/${name}`
  }

  /**
   * @param options.mediaTls serve the media host over https (production runs: media must be https there) with this
   *   throwaway certificate; the browser is told to accept it. Default: plain http on loopback.
   */
  async start(options: { mediaTls?: { key: Buffer; cert: Buffer } } = {}): Promise<void> {
    this.api = createServer((req, res) => void this.handleApi(req, res))
    this.media = options.mediaTls
      ? createHttpsServer(options.mediaTls, (req, res) => this.handleMedia(req, res))
      : createServer((req, res) => this.handleMedia(req, res))
    this.url = await listen(this.api, 'http')
    this.mediaUrl = await listen(this.media, options.mediaTls ? 'https' : 'http')
  }

  async stop(): Promise<void> {
    await Promise.all([close(this.api), close(this.media)])
  }

  private blocks(): Array<Record<string, unknown> & { audience: Audience }> {
    return [
      {
        audience: 'WEB_ONLY',
        blockId: 'CB_web1',
        type: 'BANNER',
        title: 'Web only deal',
        subtitle: 'Only on the website',
        altText: 'Sacks of basmati rice',
        imageUrl: this.m('banner-web1.png'),
        desktopImageUrl: this.m('banner-web1-wide.png'),
        link: 'product:TZP-1001',
      },
      {
        audience: 'APP_ONLY',
        blockId: 'CB_app1',
        type: 'BANNER',
        title: 'App only deal',
        altText: 'App only deal',
        imageUrl: this.m('banner-app1.png'),
        link: 'search:rice',
      },
      {
        audience: 'BOTH',
        blockId: 'CB_both1',
        type: 'BANNER',
        title: 'Fresh fruit',
        altText: 'A basket of fruit',
        imageUrl: this.m('banner-both1.png'),
        link: 'category:TZC-000002',
      },
      {
        audience: 'BOTH',
        blockId: 'CB_rail1',
        type: 'PRODUCT_RAIL',
        title: 'Bestsellers',
        ids: ['TZP-1001', 'TZP-9999', 'TZP-1002'],
      },
      {
        audience: 'BOTH',
        blockId: 'CB_broken',
        type: 'BANNER',
        title: 'Broken image banner',
        altText: 'Festival offers',
        imageUrl: this.m('missing.png'),
        link: 'https://evil.example/phish',
      },
      {
        audience: 'WEB_ONLY',
        blockId: 'CB_grid1',
        type: 'CATEGORY_GRID',
        title: 'Shop by category',
        ids: ['TZS-000001', 'TZC-000002', 'TZG-000003', 'TZG-000004'],
      },
      { audience: 'BOTH', blockId: 'CB_video', type: 'VIDEO', title: 'Future block type' },
      {
        audience: 'APP_ONLY',
        blockId: 'CB_app2',
        type: 'PRODUCT_RAIL',
        title: 'App only rail',
        ids: ['TZP-1002'],
      },
      {
        audience: 'WEB_ONLY',
        blockId: 'CB_search',
        type: 'BANNER',
        title: 'Search for rice',
        altText: 'Rice bowls',
        imageUrl: this.m('banner-search.png'),
        link: 'search:basmati rice',
      },
      {
        audience: 'WEB_ONLY',
        blockId: 'CB_offhost',
        type: 'BANNER',
        title: 'Off-host image',
        altText: 'Spices',
        // Not under the media base: the site must keep the banner with a placeholder and never request this URL.
        imageUrl: 'https://images.evil.example/spices.png',
        link: 'search:चावल',
      },
    ]
  }

  private products(): Record<string, Record<string, unknown>> {
    const card = (id: string, name: string, extra: Record<string, unknown>) => ({
      skuId: id,
      productId: id,
      name,
      brandName: null,
      packSize: null,
      stockState: 'UNKNOWN',
      maxOrderQuantity: 0,
      minimumOrderQuantity: 1,
      buyable: false,
      ...extra,
    })
    return {
      'TZP-1001': card('TZP-1001', 'Basmati Rice 5 kg', {
        brandName: 'Tazzzo Farms',
        packSize: '5 kg',
        sellingPricePaise: 49900,
        mrpPaise: 59900,
        thumbnailUrl: this.m('p1-thumb.png'),
        description: 'Aged long-grain basmati.\nSorted and cleaned.',
        highlights: ['Aged 12 months'],
        gallery: [
          {
            url: this.m('p1-c.png'),
            role: 'GALLERY',
            order: 2,
            alt: 'Back of pack',
            width: 800,
            height: 800,
          },
          {
            url: this.m('p1-a.png'),
            role: 'PRIMARY',
            order: 0,
            alt: 'Front of pack',
            width: 800,
            height: 800,
          },
          {
            url: this.m('p1-b.png'),
            role: 'GALLERY',
            order: 1,
            alt: null,
            width: null,
            height: null,
          },
          { url: this.m('p1-missing.png'), role: 'GALLERY', order: 3, alt: 'Nutrition table' },
        ],
      }),
      'TZP-1002': card('TZP-1002', 'Toor Dal 1 kg', { sellingPricePaise: 15950, mrpPaise: 15950 }),
    }
  }

  /** Products reachable by id only (not in listings or search): a known out-of-stock product. */
  private catalog(): Record<string, Record<string, unknown>> {
    return {
      ...this.products(),
      'TZP-2001': {
        skuId: 'TZP-2001',
        productId: 'TZP-2001',
        name: 'Sold Out Ghee 500 ml',
        brandName: null,
        packSize: '500 ml',
        sellingPricePaise: 32000,
        mrpPaise: 35000,
        stockState: 'OUT_OF_STOCK',
        maxOrderQuantity: 0,
        minimumOrderQuantity: 1,
        buyable: false,
      },
      // Mixed case is part of the canonical grammar and must round-trip untouched.
      'TZP-Mix-7': {
        skuId: 'TZP-Mix-7',
        productId: 'TZP-Mix-7',
        name: 'Mixed Case Tea',
        brandName: null,
        packSize: null,
        sellingPricePaise: 12000,
        mrpPaise: 12000,
        stockState: 'UNKNOWN',
        maxOrderQuantity: 0,
        minimumOrderQuantity: 1,
        buyable: false,
      },
    }
  }

  private setLine(sku: string, quantity: number): void {
    const now = new Date().toISOString()
    const line = this.cart.lines.find((l) => l.sku === sku)
    if (line) {
      line.quantity = quantity
      line.updatedAt = now
    } else this.cart.lines.push({ sku, quantity, addedAt: now, updatedAt: now })
    this.cart.version += 1
  }

  /** The cart as the backend presents it (`CartResponseDto`), enriched per line by the sku's mode. */
  private presentCart(pin: string | null): Record<string, unknown> {
    const catalog = this.catalog()
    let subtotal = 0
    let itemCount = 0
    const items = this.cart.lines.map((line) => {
      const mode = this.cartModes.get(line.sku) ?? 'default'
      const card = catalog[line.sku]
      const unit = this.cartPrices.get(line.sku) ?? (card?.sellingPricePaise as number | undefined)
      itemCount += line.quantity
      const base = {
        skuId: line.sku,
        quantity: line.quantity,
        addedAt: line.addedAt,
        updatedAt: line.updatedAt,
      }
      if (mode === 'unavailable' || !card || unit === undefined) {
        return {
          ...base,
          product: null,
          price: null,
          availability: { stockState: 'UNKNOWN', maxOrderQuantity: 0, serviceable: null },
          lineTotalPaise: null,
          buyable: false,
          issues: ['PRODUCT_UNAVAILABLE'],
        }
      }
      const lineTotal = unit * line.quantity
      subtotal += lineTotal
      // Located by a saved address (its PIN) or, for the older tests, forced by the line's control mode.
      const byAddress = pin !== null
      const located = mode !== 'default' || byAddress
      const pinServed = pin === null || SERVICEABLE_PINS.has(pin)
      const stock =
        mode === 'out_of_stock' ? 'OUT_OF_STOCK' : located && pinServed ? 'IN_STOCK' : 'UNKNOWN'
      const maxOrder =
        mode === 'out_of_stock' ? 0 : mode === 'insufficient' ? 2 : located && pinServed ? 10 : 0
      const issues: string[] = []
      if (!located) issues.push('LOCATION_REQUIRED')
      if (mode === 'unserviceable' || !pinServed) issues.push('UNSERVICEABLE')
      if (mode === 'out_of_stock') issues.push('OUT_OF_STOCK')
      if (mode === 'insufficient' && line.quantity > 2) issues.push('INSUFFICIENT_STOCK')
      if (mode === 'price_changed') issues.push('PRICE_CHANGED')
      return {
        ...base,
        product: {
          title: card.name,
          brandCode: card.brandName ? 'TZB-1' : null,
          imageUrl: card.thumbnailUrl ?? null,
        },
        price: { unitPricePaise: unit, mrpPaise: card.mrpPaise ?? null, currency: 'INR' },
        availability: {
          stockState: stock,
          maxOrderQuantity: maxOrder,
          serviceable: mode === 'unserviceable' || !pinServed ? false : located ? true : null,
        },
        lineTotalPaise: lineTotal,
        buyable: issues.length === 0 || (issues.length === 1 && issues[0] === 'PRICE_CHANGED'),
        issues,
      }
    })
    return {
      version: this.cart.version,
      items,
      itemCount,
      distinctItemCount: items.length,
      subtotalPaise: subtotal,
      expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
      freshness: this.cart.lines.length === 0 ? 'FRESH' : this.cart.freshness,
      requestId: 'req_cart',
    }
  }

  /** `/v1/customer/cart**` (CartController + CartExceptionHandler): bearer required; flat `{code,message,requestId}` errors. */
  private handleCart(
    req: IncomingMessage,
    path: string,
    body: unknown,
    out: (status: number, body: unknown, headers?: Record<string, string>) => void,
    fail: (status: number, code: string) => void,
    customerId: string,
    query: URLSearchParams,
  ): void {
    if (this.cartDown) return fail(503, 'SERVICE_UNAVAILABLE')
    // CartLocationResolver: `addressId` is looked up scoped to the caller; foreign, unknown and malformed are one 404.
    let pin: string | null = null
    const addressId = query.get('addressId')
    if (addressId !== null) {
      const own = ADDRESS_ID_RE.test(addressId)
        ? (this.addresses.get(customerId) ?? []).find((a) => a.addressId === addressId)
        : undefined
      if (!own) return fail(404, 'NOT_FOUND')
      pin = own.postalCode
    }
    const reply = () => out(200, this.presentCart(pin), { etag: `"cart-${this.cart.version}"` })
    const header = req.headers['if-match']
    const mutating = req.method !== 'GET'
    let expected = -1
    if (mutating) {
      if (typeof header !== 'string' || header.trim() === '')
        return fail(428, 'PRECONDITION_REQUIRED')
      const m = /^"?cart-([0-9]{1,15})"?$/.exec(header.trim())
      if (!m) return fail(400, 'INVALID_REQUEST')
      expected = Number(m[1])
    }
    const item = /^\/v1\/customer\/cart\/items\/([^/]+)$/.exec(path)
    if (path === '/v1/customer/cart' && req.method === 'GET') return reply()
    if (path === '/v1/customer/cart' && req.method === 'DELETE') {
      if (expected !== this.cart.version) return fail(412, 'PRECONDITION_FAILED')
      this.cart.lines = []
      this.cart.version += 1
      return reply()
    }
    if (!item) return fail(404, 'NOT_FOUND')
    const sku = decodeURIComponent(item[1] ?? '')
    if (!/^TZP-[A-Za-z0-9-]{1,40}$/.test(sku) || !this.catalog()[sku]) return fail(404, 'NOT_FOUND')
    if (req.method === 'PUT') {
      const q = (body as { quantity?: unknown } | null)?.quantity
      if (typeof q !== 'number' || !Number.isInteger(q) || q < 1 || q > 20) {
        return fail(400, 'INVALID_REQUEST')
      }
      if (expected !== this.cart.version) return fail(412, 'PRECONDITION_FAILED')
      if (!this.cart.lines.some((l) => l.sku === sku) && this.cart.lines.length >= 50) {
        return fail(409, 'CART_ITEM_LIMIT_REACHED')
      }
      this.setLine(sku, q)
      return reply()
    }
    if (req.method === 'DELETE') {
      if (expected !== this.cart.version) return fail(412, 'PRECONDITION_FAILED')
      if (!this.cart.lines.some((l) => l.sku === sku)) return fail(404, 'NOT_FOUND')
      this.cart.lines = this.cart.lines.filter((l) => l.sku !== sku)
      this.cart.version += 1
      return reply()
    }
    return fail(405, 'INVALID_REQUEST')
  }

  /** Visible nodes; TZG-000004 is two levels deep (only `GET /v1/categories/{id}` can name it). */
  private nodes: Record<string, { name: string; children: string[] }> = {
    'TZS-000001': { name: 'Staples', children: ['TZC-000002'] },
    'TZS-000002': { name: 'Fruits', children: [] },
    'TZC-000002': { name: 'Rice', children: ['TZG-000004'] },
    'TZG-000004': { name: 'Basmati', children: [] },
  }

  /** The validated PIN (null when absent), or 'invalid' (malformed pin, or any lat/lng). `required`: absent -> null is "invalid" for serviceability. */
  private locationParams(url: URL, optional = false): string | null | 'invalid' {
    if (url.searchParams.has('lat') || url.searchParams.has('lng')) return 'invalid'
    const pin = url.searchParams.get('pin')
    if (pin === null || pin.trim() === '') return optional ? null : 'invalid'
    return PIN_RE.test(pin.trim()) ? pin.trim() : 'invalid'
  }

  /** A product card as the backend answers it for a location: stock and serviceability only with a serviceable PIN. */
  private located(card: Record<string, unknown>, pin: string | null): Record<string, unknown> {
    if (pin === null) return card
    if (!SERVICEABLE_PINS.has(pin))
      return { ...card, serviceable: false, stockState: 'UNKNOWN', buyable: false }
    const id = String(card.productId)
    if (card.stockState === 'OUT_OF_STOCK') return { ...card, serviceable: true }
    if (id === 'TZP-1002') {
      return {
        ...card,
        serviceable: true,
        stockState: 'LOW_STOCK',
        lowStockRemaining: 3,
        maxOrderQuantity: 3,
        buyable: true,
      }
    }
    return {
      ...card,
      serviceable: true,
      stockState: 'IN_STOCK',
      maxOrderQuantity: 10,
      buyable: true,
    }
  }

  /** A list/search page. Cursors are bound to the location they started under (a different one is 400, like the backend). */
  private page(
    all: Array<Record<string, unknown>>,
    pin: string | null,
    url: URL,
    send: (status: number, body: unknown, headers?: Record<string, string>) => void,
    error: (status: number, code: string) => void,
    requestId: string,
  ): void {
    const context = pin ?? 'anon'
    const cursor = url.searchParams.get('cursor')
    if (cursor !== null && cursor !== `cur-${context}`) return error(400, 'INVALID_CURSOR')
    const items = all.map((p) => this.located(p, pin))
    if (!this.paged) return send(200, { resolvedReleaseId: 'R1', items, hasMore: false, requestId })
    return cursor === null
      ? send(200, {
          resolvedReleaseId: 'R1',
          items: items.slice(0, 1),
          hasMore: true,
          nextCursor: `cur-${context}`,
          requestId,
        })
      : send(200, { resolvedReleaseId: 'R1', items: items.slice(1), hasMore: false, requestId })
  }

  private async handleApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.url)
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        'x-request-id': `req_${randomBytes(8).toString('hex')}`,
        ...headers,
      })
      res.end(JSON.stringify(body))
    }
    const error = (status: number, code: string) =>
      send(
        status,
        { code, message: 'error', requestId: 'req_x', retryable: false },
        { 'cache-control': 'no-store' },
      )

    if (url.pathname.startsWith('/__control/')) {
      if (url.pathname === '/__control/requests') return send(200, this.requests)
      if (url.pathname === '/__control/auth') {
        if (req.method === 'POST') {
          this.accessTtlSeconds = Number(url.searchParams.get('accessTtl') ?? '900')
          if (url.searchParams.get('revokeAll') === '1') {
            for (const session of this.sessions.values()) session.revoked = true
          }
        }
        return send(200, {
          accessTtlSeconds: this.accessTtlSeconds,
          refreshCount: this.refreshCount,
          logoutCount: this.logoutCount,
        })
      }
      if (url.pathname === '/__control/cart') {
        if (req.method === 'POST') {
          const q = url.searchParams
          if (q.get('reset') === '1') {
            this.cart = { version: 0, lines: [], freshness: 'FRESH' }
            this.cartModes.clear()
            this.cartPrices.clear()
            this.cartDown = false
          }
          const sku = q.get('sku')
          if (sku && q.get('mode')) this.cartModes.set(sku, q.get('mode') as CartMode)
          if (sku && q.get('price')) this.cartPrices.set(sku, Number(q.get('price')))
          if (q.get('freshness')) this.cart.freshness = q.get('freshness') as FakeCart['freshness']
          if (q.get('down')) this.cartDown = q.get('down') === '1'
          // Another tab changed the cart: the version moves under the caller (the next mutation is stale).
          if (q.get('bump') === '1') this.cart.version += 1
          // Another tab added a line.
          const add = q.get('addLine')
          if (add) this.setLine(add, Number(q.get('qty') ?? '1'))
        }
        return send(200, this.cart)
      }
      if (url.pathname === '/__control/delivery' && req.method === 'POST') {
        const q = url.searchParams
        if (q.get('reset') === '1') {
          this.addresses.clear()
          this.addressKeys.clear()
          this.defaultByCustomer.clear()
          this.paged = false
          this.slotsFull = false
          this.addressDown = false
        }
        if (q.get('paged')) this.paged = q.get('paged') === '1'
        if (q.get('slotsFull')) this.slotsFull = q.get('slotsFull') === '1'
        if (q.get('addressDown')) this.addressDown = q.get('addressDown') === '1'
        // Another device deleted every address of a customer.
        const wipe = q.get('wipe')
        if (wipe) this.addresses.delete(wipe)
        return send(200, { ok: true })
      }
      if (url.pathname === '/__control/media' && req.method === 'POST') {
        this.mediaDown = url.searchParams.get('down') === '1'
        return send(200, { mediaDown: this.mediaDown })
      }
      return error(404, 'NOT_FOUND')
    }
    const header = (name: string) => {
      const value = req.headers[name]
      return typeof value === 'string' ? value : null
    }
    this.requests.push({
      method: req.method ?? '',
      path: url.pathname,
      query: url.search,
      caller: header('x-tazzzo-caller'),
      callerSecret: header('x-tazzzo-caller-secret'),
      bearer: header('authorization') !== null,
      forwardedFor: header('x-forwarded-for'),
      ifMatch: header('if-match'),
      idempotencyKey: header('idempotency-key'),
    })
    if (url.pathname.startsWith('/v1/auth/') || url.pathname.startsWith('/v1/customer/')) {
      return this.handleAuth(req, res, url, send)
    }
    if (req.method !== 'GET') return error(405, 'INVALID_REQUEST')

    if (url.pathname === '/v1/content/home') {
      const keys = [...url.searchParams.keys()]
      const values = url.searchParams.getAll('channel')
      let channel: 'app' | 'web' | null = null
      if (keys.length > 0) {
        if (keys.length !== 1 || values.length !== 1) return error(400, 'INVALID_REQUEST')
        if (values[0] !== 'app' && values[0] !== 'web') return error(400, 'INVALID_REQUEST')
        channel = values[0]
      }
      const visible = (a: Audience) =>
        a === 'BOTH' ||
        (channel === 'web' && a === 'WEB_ONLY') ||
        (channel === 'app' && a === 'APP_ONLY')
      const blocks = this.blocks()
        .filter((b) => visible(b.audience))
        // The audience is storage-side only; the public response never carries it.
        .map((b) => Object.fromEntries(Object.entries(b).filter(([key]) => key !== 'audience')))
      return send(200, { blocks, requestId: 'req_home' }, { 'cache-control': 'public, max-age=60' })
    }

    if (url.pathname === '/v1/serviceability') {
      const bad = this.locationParams(url)
      if (bad === 'invalid' || bad === null) return error(400, 'INVALID_REQUEST')
      if (bad === '500500') return error(503, 'SERVICE_UNAVAILABLE')
      const serviceable = SERVICEABLE_PINS.has(bad)
      return send(
        200,
        serviceable
          ? { serviceable, serviceAreaId: 'SA_blr', serviceAreaVersion: 3, requestId: 'req_svc' }
          : { serviceable, requestId: 'req_svc' },
        { 'cache-control': 'private, no-store' },
      )
    }
    // pin / lat / lng on the reads: a malformed PIN or any lat/lng is 400; absent = anonymous.
    const where = this.locationParams(url, true)
    if (where === 'invalid') return error(400, 'INVALID_REQUEST')

    const product = /^\/v1\/products\/([^/]+)$/.exec(url.pathname)
    if (product) {
      const p = this.catalog()[decodeURIComponent(product[1] ?? '')]
      if (!p) return error(404, 'NOT_FOUND')
      return send(
        200,
        { ...this.located(p, where), resolvedReleaseId: 'R1', requestId: 'req_pdp' },
        { 'cache-control': 'private, no-store' },
      )
    }

    if (url.pathname === '/v1/categories') {
      const items = ['TZS-000001', 'TZS-000002'].map((id) => ({ id, name: this.nodes[id]!.name }))
      return send(200, { resolvedReleaseId: 'R1', items, requestId: 'req_cat' })
    }
    // GET /v1/categories/{id} (CommerceReadController.category): a malformed id is 400, an invisible node a flat 404,
    // otherwise the node unwrapped next to the envelope fields.
    const byId = /^\/v1\/categories\/([^/]+)$/.exec(url.pathname)
    if (byId) {
      const id = byId[1] ?? ''
      if (!/^TZ[SCGV]-[0-9]{6}$/.test(id)) return error(400, 'INVALID_REQUEST')
      const node = this.nodes[id]
      if (!node) return error(404, 'NOT_FOUND')
      return send(
        200,
        { id, name: node.name, resolvedReleaseId: 'R1', requestId: 'req_node' },
        { 'cache-control': 'public, max-age=300, stale-while-revalidate=60' },
      )
    }
    const children = /^\/v1\/categories\/([^/]+)\/children$/.exec(url.pathname)
    if (children) {
      const node = this.nodes[children[1] ?? '']
      if (!node) return error(404, 'NOT_FOUND')
      const items = node.children.map((id) => ({ id, name: this.nodes[id]!.name }))
      return send(200, { resolvedReleaseId: 'R1', items, requestId: 'req_children' })
    }
    const listing = /^\/v1\/categories\/([^/]+)\/products$/.exec(url.pathname)
    if (listing) {
      if (!this.nodes[listing[1] ?? '']) return error(404, 'NOT_FOUND')
      return this.page(Object.values(this.products()), where, url, send, error, 'req_list')
    }
    if (url.pathname === '/v1/search') {
      const q = url.searchParams.get('q') ?? ''
      const tokens = q
        .toLowerCase()
        .split(/[^\p{L}\p{M}\p{N}]+/u)
        .filter((t) => t.length >= 2)
      if (q.length > 64 || tokens.length === 0 || tokens.length > 5)
        return error(400, 'INVALID_REQUEST')
      const items = Object.values(this.products()).filter((p) => {
        const words = String(p.name)
          .toLowerCase()
          .split(/[^\p{L}\p{M}\p{N}]+/u)
        return tokens.every((t) => words.some((w) => w.startsWith(t)))
      })
      return this.page(items, where, url, send, error, 'req_search')
    }
    return error(404, 'NOT_FOUND')
  }

  /**
   * Customer auth, with the backend's behaviour and public error codes.
   * Phones: `+919999999999` is rate limited (429 + Retry-After 42), `+919888888888` fails delivery (503); any other
   * `+91[6-9]xxxxxxxxx` gets a challenge. Codes: `123456` is right; `654321` is expired; `999999` is rate limited;
   * anything else is wrong, and the fifth wrong code locks the challenge (still `OTP_INVALID`).
   */
  private async handleAuth(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    send: (status: number, body: unknown, headers?: Record<string, string>) => void,
  ): Promise<void> {
    const out = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      send(status, body, { 'cache-control': 'no-store', ...headers })
    const code = (status: number, value: string, headers: Record<string, string> = {}) =>
      out(status, { code: value, message: 'error', requestId: 'req_auth' }, headers)
    const rand = (n: number) => randomBytes(n).toString('base64url')
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    let body: Record<string, unknown> = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
    } catch {
      return code(400, 'INVALID_REQUEST')
    }
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
    const sessionFor = (token: string | undefined) => {
      for (const session of this.sessions.values()) {
        if (token && session.accessTokens.has(token) && !session.revoked) return session
      }
      return undefined
    }
    const issue = (session: FakeSession) => {
      const accessToken = `AT.${rand(48)}`
      session.accessTokens.add(accessToken)
      session.refreshToken = `SES_${rand(9)}.${rand(24)}`
      return {
        accessToken,
        accessTokenExpiresIn: this.accessTtlSeconds,
        refreshToken: session.refreshToken,
      }
    }
    const path = url.pathname

    if (req.method === 'POST' && path === '/v1/auth/otp/request') {
      const phone = body.phone
      if (typeof phone !== 'string' || !/^\+91[6-9][0-9]{9}$/.test(phone)) {
        return code(400, 'OTP_INVALID_REQUEST')
      }
      if (phone === '+919999999999') {
        return out(
          429,
          { code: 'OTP_RATE_LIMITED', message: 'x', requestId: 'req_auth', retryAfterSeconds: 42 },
          { 'retry-after': '42' },
        )
      }
      if (phone === '+919888888888') return code(503, 'SERVICE_UNAVAILABLE')
      const challengeId = `OTP_${rand(18)}`
      this.challenges.set(challengeId, { phone, wrong: 0 })
      return out(202, {
        challengeId,
        expiresInSeconds: 300,
        resendAfterSeconds: 2,
        requestId: 'req_auth',
      })
    }
    if (req.method === 'POST' && path === '/v1/auth/otp/verify') {
      const challenge = this.challenges.get(String(body.challengeId))
      const otp = body.otp
      if (typeof otp !== 'string' || !/^[0-9]{6}$/.test(otp))
        return code(400, 'OTP_INVALID_REQUEST')
      if (!challenge) return code(400, 'OTP_INVALID')
      if (otp === '999999') {
        return out(
          429,
          { code: 'OTP_RATE_LIMITED', message: 'x', requestId: 'req_auth', retryAfterSeconds: 120 },
          { 'retry-after': '120' },
        )
      }
      if (otp === '654321') return code(400, 'OTP_EXPIRED')
      if (otp !== '123456' || challenge.wrong >= 5) {
        challenge.wrong += 1
        return code(400, 'OTP_INVALID')
      }
      this.challenges.delete(String(body.challengeId))
      const grantId = `GRANT_${rand(18)}`
      this.grants.add(grantId)
      this.grantPhones.set(grantId, challenge.phone)
      return out(200, {
        challengeId: body.challengeId,
        verified: true,
        grantId,
        requestId: 'req_auth',
      })
    }
    if (req.method === 'POST' && path === '/v1/auth/session') {
      const grantId = String(body.grantId)
      if (!this.grants.delete(grantId)) return code(401, 'UNAUTHENTICATED')
      const session: FakeSession = {
        customerId:
          this.grantPhones.get(grantId) === '+919123456780' ? 'CUS_e2e0002' : 'CUS_e2e0001',
        refreshToken: '',
        accessTokens: new Set(),
        revoked: false,
      }
      this.sessions.set(`SES_${rand(6)}`, session)
      return out(200, { customerId: session.customerId, ...issue(session), requestId: 'req_auth' })
    }
    if (req.method === 'POST' && path === '/v1/auth/refresh') {
      const presented = String(body.refreshToken)
      const session = [...this.sessions.values()].find(
        (s) => s.refreshToken === presented && !s.revoked,
      )
      if (!session) return code(401, 'UNAUTHENTICATED')
      this.refreshCount += 1
      return out(200, { ...issue(session), requestId: 'req_auth' })
    }
    if (req.method === 'POST' && path === '/v1/auth/logout') {
      const session = sessionFor(bearer)
      if (!session) return code(401, 'UNAUTHENTICATED')
      session.revoked = true
      this.logoutCount += 1
      res.writeHead(204, { 'cache-control': 'no-store' })
      res.end()
      return
    }
    if (path === '/v1/customer/cart' || path.startsWith('/v1/customer/cart/')) {
      if (!sessionFor(bearer)) return code(401, 'UNAUTHENTICATED')
      return this.handleCart(
        req,
        path,
        body,
        out,
        code,
        sessionFor(bearer)!.customerId,
        url.searchParams,
      )
    }
    if (path === '/v1/customer/addresses' || path.startsWith('/v1/customer/addresses/')) {
      const session = sessionFor(bearer)
      if (!session) return code(401, 'UNAUTHENTICATED')
      return this.handleAddresses(req, path, body, out, code, session.customerId)
    }
    if (path === '/v1/customer/delivery/slots') {
      if (!sessionFor(bearer)) return code(401, 'UNAUTHENTICATED')
      return this.handleSlots(req, url, out, code)
    }
    if (req.method === 'GET' && path === '/v1/customer/profile') {
      const session = sessionFor(bearer)
      if (!session) return code(401, 'UNAUTHENTICATED')
      return out(200, {
        customerId: session.customerId,
        displayName: 'Asha Verma',
        email: 'asha@example.test',
        version: 3,
        requestId: 'req_auth',
      })
    }
    return code(404, 'NOT_FOUND')
  }

  private addressView(a: FakeAddress): Record<string, unknown> {
    const isDefault = this.defaultByCustomer.get(a.customerId) === a.addressId
    const { customerId: _owner, ...rest } = a
    void _owner
    return {
      ...rest,
      latitude: null,
      longitude: null,
      isDefault,
      serviceability: { serviceable: SERVICEABLE_PINS.has(a.postalCode) },
      requestId: 'req_addr',
    }
  }

  /** `/v1/customer/addresses**` (AddressController + AddressService + AddressExceptionHandler). */
  private handleAddresses(
    req: IncomingMessage,
    path: string,
    body: Record<string, unknown>,
    out: (status: number, body: unknown, headers?: Record<string, string>) => void,
    fail: (status: number, code: string) => void,
    customerId: string,
  ): void {
    if (this.addressDown) return fail(503, 'SERVICE_UNAVAILABLE')
    const mine = this.addresses.get(customerId) ?? []
    const etag = (a: FakeAddress) => ({ etag: `"address-${a.version}"` })
    const sorted = () =>
      [...mine].sort(
        (x, y) =>
          Number(this.defaultByCustomer.get(customerId) === y.addressId) -
          Number(this.defaultByCustomer.get(customerId) === x.addressId),
      )
    const text = (raw: unknown, max: number, required: boolean): string | null | undefined => {
      if (raw === undefined || raw === null) return required ? undefined : null
      if (typeof raw !== 'string') return undefined
      const t = raw.trim()
      if (t === '') return required ? undefined : null
      if ([...t].length > max || /[\u0000-\u001f\u007f-\u009f]/.test(t)) return undefined
      return t
    }
    const phone = (raw: unknown): string | undefined => {
      if (typeof raw !== 'string') return undefined
      const t = raw.trim()
      if (t.length === 0 || t.length > 16) return undefined
      if (/^\+91[6-9][0-9]{9}$/.test(t)) return t
      if (/^[6-9][0-9]{9}$/.test(t)) return `+91${t}`
      if (/^0[6-9][0-9]{9}$/.test(t)) return `+91${t.slice(1)}`
      return undefined
    }
    /** Normalises a full or partial field set; undefined = INVALID_REQUEST. */
    const fields = (
      src: Record<string, unknown>,
      partial: boolean,
    ): Partial<FakeAddress> | undefined => {
      const out: Record<string, unknown> = {}
      const spec: Array<[string, (v: unknown) => unknown]> = [
        [
          'label',
          (v) =>
            typeof v === 'string' && ['HOME', 'WORK', 'OTHER'].includes(v.trim().toUpperCase())
              ? v.trim().toUpperCase()
              : undefined,
        ],
        ['recipientName', (v) => text(v, 80, true) ?? undefined],
        ['recipientPhone', phone],
        ['addressLine1', (v) => text(v, 160, true) ?? undefined],
        ['addressLine2', (v) => text(v, 160, false)],
        ['landmark', (v) => text(v, 120, false)],
        ['city', (v) => text(v, 80, true) ?? undefined],
        ['state', (v) => text(v, 80, true) ?? undefined],
        [
          'postalCode',
          (v) => (typeof v === 'string' && PIN_RE.test(v.trim()) ? v.trim() : undefined),
        ],
      ]
      for (const [key, check] of spec) {
        if (partial && !(key in src)) continue
        const value = check(src[key])
        if (value === undefined) return undefined
        out[key] = value
      }
      return out as Partial<FakeAddress>
    }
    const ifMatch = (): number | 'missing' | 'bad' => {
      const h = req.headers['if-match']
      if (typeof h !== 'string' || h.trim() === '') return 'missing'
      const m = /^"?address-([0-9]{1,15})"?$/.exec(h.trim())
      return m ? Number(m[1]) : 'bad'
    }
    const one = /^\/v1\/customer\/addresses\/([^/]+)(\/default)?$/.exec(path)
    if (path === '/v1/customer/addresses' && req.method === 'GET') {
      return out(200, { items: sorted().map((a) => this.addressView(a)), requestId: 'req_addr' })
    }
    if (path === '/v1/customer/addresses' && req.method === 'POST') {
      const keyHeader = req.headers['idempotency-key']
      const key = typeof keyHeader === 'string' ? keyHeader : null
      if (key !== null && !/^[A-Za-z0-9_-]{8,64}$/.test(key)) return fail(400, 'INVALID_REQUEST')
      const allowed = new Set([
        'label',
        'recipientName',
        'recipientPhone',
        'addressLine1',
        'addressLine2',
        'landmark',
        'city',
        'state',
        'postalCode',
        'latitude',
        'longitude',
      ])
      void allowed // unknown properties are ignored by the backend DTO (Jackson); the BFF never sends any
      const f = fields(body, false)
      if (!f) return fail(400, 'INVALID_REQUEST')
      const hash = JSON.stringify(f)
      if (key !== null) {
        const prior = this.addressKeys.get(`${customerId}:${key}`)
        if (prior) {
          const existing = mine.find((a) => a.addressId === prior.id)
          if (prior.hash !== hash || !existing) return fail(409, 'IDEMPOTENCY_CONFLICT')
          return out(201, this.addressView(existing), etag(existing))
        }
      }
      if (mine.length >= 10) return fail(409, 'ADDRESS_LIMIT_REACHED')
      const created: FakeAddress = {
        addressId: `ADDR_${randomBytes(15).toString('base64url')}`,
        customerId,
        version: 1,
        ...(f as Omit<FakeAddress, 'addressId' | 'customerId' | 'version'>),
      }
      this.addresses.set(customerId, [...mine, created])
      if (mine.length === 0) this.defaultByCustomer.set(customerId, created.addressId)
      if (key !== null)
        this.addressKeys.set(`${customerId}:${key}`, { hash, id: created.addressId })
      return out(201, this.addressView(created), etag(created))
    }
    if (!one) return fail(404, 'NOT_FOUND')
    const id = decodeURIComponent(one[1] ?? '')
    const target = ADDRESS_ID_RE.test(id) ? mine.find((a) => a.addressId === id) : undefined
    if (one[2]) {
      if (req.method !== 'PUT') return fail(405, 'INVALID_REQUEST')
      if (!target) return fail(404, 'NOT_FOUND')
      this.defaultByCustomer.set(customerId, target.addressId)
      return out(200, this.addressView(target), etag(target))
    }
    if (req.method === 'GET') {
      return target ? out(200, this.addressView(target), etag(target)) : fail(404, 'NOT_FOUND')
    }
    if (req.method === 'PATCH' || req.method === 'DELETE') {
      const expected = ifMatch()
      if (expected === 'missing') return fail(428, 'PRECONDITION_REQUIRED')
      if (expected === 'bad') return fail(400, 'INVALID_REQUEST')
      const patch = req.method === 'PATCH' ? fields(body, true) : {}
      if (!patch) return fail(400, 'INVALID_REQUEST')
      if (!target) return fail(404, 'NOT_FOUND')
      if (target.version !== expected) return fail(412, 'PRECONDITION_FAILED')
      if (req.method === 'DELETE') {
        this.addresses.set(
          customerId,
          mine.filter((a) => a !== target),
        )
        if (this.defaultByCustomer.get(customerId) === target.addressId) {
          const next = mine.find((a) => a !== target)
          if (next) this.defaultByCustomer.set(customerId, next.addressId)
          else this.defaultByCustomer.delete(customerId)
        }
        return out(204 as number, undefined)
      }
      Object.assign(target, patch, { version: target.version + 1 })
      return out(200, this.addressView(target), etag(target))
    }
    return fail(405, 'INVALID_REQUEST')
  }

  /** `GET /v1/customer/delivery/slots` (DeliverySlotController): `pin` required, `days` 1..3 (the default horizon). */
  private handleSlots(
    req: IncomingMessage,
    url: URL,
    out: (status: number, body: unknown, headers?: Record<string, string>) => void,
    fail: (status: number, code: string) => void,
  ): void {
    if (req.method !== 'GET') return fail(405, 'INVALID_REQUEST')
    const pin = url.searchParams.get('pin')
    if (pin === null || !PIN_RE.test(pin.trim())) return fail(400, 'INVALID_REQUEST')
    const days = url.searchParams.get('days')
    if (days !== null && (!/^[1-9][0-9]?$/.test(days) || Number(days) > 3))
      return fail(400, 'INVALID_REQUEST')
    const serviceable = SERVICEABLE_PINS.has(pin.trim())
    const slots: unknown[] = []
    if (serviceable && pin.trim() !== '560002') {
      const windows = [
        { id: 'morning', label: 'Morning', from: 9, to: 11 },
        { id: 'afternoon', label: 'Afternoon', from: 13, to: 15 },
        { id: 'evening', label: 'Evening', from: 18, to: 20 },
      ]
      for (let d = 0; d < Number(days ?? 3); d++) {
        const date = new Date(Date.now() + d * 86_400_000 + 5.5 * 3_600_000)
          .toISOString()
          .slice(0, 10)
        for (const w of windows) {
          const at = (h: number) => `${date}T${String(h).padStart(2, '0')}:00:00+05:30`
          // Day 0: the afternoon is full and the evening closed; later days are open (unless `slotsFull`).
          const status = this.slotsFull
            ? 'FULL'
            : d === 0 && w.id === 'afternoon'
              ? 'FULL'
              : d === 0 && w.id === 'evening'
                ? 'CLOSED'
                : 'AVAILABLE'
          slots.push({
            slotId: `${w.id}~${date}`,
            date,
            startsAt: at(w.from),
            endsAt: at(w.to),
            label: w.label,
            status,
          })
        }
      }
    }
    return out(200, { serviceable, timezone: 'Asia/Kolkata', slots, requestId: 'req_slots' })
  }

  private handleMedia(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', this.mediaUrl)
    const name = /^\/media\/([a-z0-9-]+)\.png$/.exec(url.pathname)?.[1]
    if (this.mediaDown || !name || name.includes('missing')) {
      res.writeHead(this.mediaDown ? 503 : 404, { 'cache-control': 'no-store' })
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
    res.end(PNG)
  }
}

async function listen(server: Server | HttpsServer, scheme: 'http' | 'https'): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no address')
  return `${scheme}://127.0.0.1:${address.port}`
}

async function close(server: Server | HttpsServer | undefined): Promise<void> {
  if (!server) return
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

/** A valid 16x9 PNG (solid colour), built at load time so no binary fixture is committed. */
const PNG = (() => {
  const width = 16
  const height = 9
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf: Buffer) => {
    let c = 0xffffffff
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(crc(body))
    return Buffer.concat([len, body, sum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.writeUInt8(8, 8) // bit depth
  header.writeUInt8(2, 9) // truecolour RGB
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array(width).fill([91, 43, 224]).flat()),
  ])
  const raw = Buffer.concat(Array(height).fill(row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
})()
