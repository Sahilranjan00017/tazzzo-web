import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'

/**
 * Local stand-in for the Tazzzo backend (never production). When given the mock provider, it verifies every bearer
 * as a genuine ID token (signature via the provider JWKS, issuer, audience): the same trust decision the real backend
 * makes, so a missing or replaced human token fails here too. Roles come from the token `sub`, like the backend
 * allowlist. Implements `GET /api/v1/admin/me` and the W3 reference `PATCH /api/v1/products/{id}` (If-Match version,
 * STALE_VERSION conflicts, server-generated X-Request-Id). Records every request it receives.
 */
export interface RecordedRequest {
  method: string
  path: string
  authorization: string | undefined
  headers: Record<string, string | string[] | undefined>
  body: string
  /** Verified token subject, when the bearer was a valid ID token. */
  sub?: string
}

export const WRITER_SUB = '110000000000000000001'
export const READER_SUB = '110000000000000000002'
export const OPS_SUB = '110000000000000000003'
export const SUPPORT_SUB = '110000000000000000004'

export class FakeBackend {
  url = ''
  /** W2 compatibility: a non-200 value forces this status for /me. */
  status = 200
  body: unknown = {
    actorType: 'HUMAN_ADMIN',
    actorId: 'google:111',
    email: 'ops@tazzzo.test',
    roles: ['cms-writer', 'reader'],
  }
  /** Forces this status (and optional headers) for mutations, e.g. 401, 429, 500, 302. */
  mutationOverride?: {
    status: number
    headers?: Record<string, string>
    body?: unknown
    delayMs?: number
  }
  /** Forces a status (and optional body) for the dashboard summary, e.g. 503 to mimic a Mongo outage. */
  dashboardOverride?: { status: number; body?: unknown }
  /** Taxonomy mock: id of the open release (writes need one), release statuses and nodes. */
  openRelease?: string
  readonly releases = new Map<string, string>()
  readonly nodes = new Map<
    string,
    {
      id: string
      nodeType: string
      name: string
      parentId: string | null
      status: string
      version: number
    }
  >()
  readonly prices = new Map<
    string,
    { sellingPricePaise: number; mrpPaise: number; version: number }
  >()
  readonly stock = new Map<
    string,
    {
      onHand: number
      reserved: number
      lowStockThreshold: number
      maxPurchasable: number
      version: number
      active: boolean
    }
  >()
  readonly orders = new Map<
    string,
    {
      orderId: string
      status: string
      version: number
      cancelReason?: string
      cancelledBy?: string
    }
  >()
  readonly requests: RecordedRequest[] = []
  readonly products = new Map<
    string,
    { id: string; title: string; version: number; lifecycle: string }
  >()
  private server?: Server
  private jwks?: ReturnType<typeof createRemoteJWKSet>

  constructor(private readonly verify?: { issuer: string; audience: string }) {}

  async start(): Promise<void> {
    if (this.verify) this.jwks = createRemoteJWKSet(new URL(`${this.verify.issuer}/jwks`))
    this.server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('no address')
    this.url = `http://127.0.0.1:${address.port}`
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
  }

  reset(): void {
    this.status = 200
    this.mutationOverride = undefined
    this.dashboardOverride = undefined
    this.requests.length = 0
    this.openRelease = undefined
    this.releases.clear()
    this.nodes.clear()
    this.prices.clear()
    this.orders.clear()
    this.orders.set('O-100', { orderId: 'O-100', status: 'CONFIRMED', version: 2 })
    this.orders.set('O-101', { orderId: 'O-101', status: 'OUT_FOR_DELIVERY', version: 3 })
    this.stock.clear()
    this.prices.set('TZP-REF-1', { sellingPricePaise: 12900, mrpPaise: 14900, version: 2 })
    this.stock.set('TZP-REF-1|LOC-1', {
      onHand: 20,
      reserved: 8,
      lowStockThreshold: 5,
      maxPurchasable: 10,
      version: 2,
      active: true,
    })
    this.nodes.set('TZS-000001', {
      id: 'TZS-000001',
      nodeType: 'super_category',
      name: 'Staples',
      parentId: null,
      status: 'active',
      version: 1,
    })
    this.nodes.set('TZC-000001', {
      id: 'TZC-000001',
      nodeType: 'category',
      name: 'Rice',
      parentId: 'TZS-000001',
      status: 'active',
      version: 2,
    })
    this.products.clear()
    this.products.set('TZP-REF-1', {
      id: 'TZP-REF-1',
      title: 'Basmati 5 kg',
      version: 3,
      lifecycle: 'draft',
    })
  }

  private async identify(authorization: string | undefined): Promise<JWTPayload | undefined> {
    if (!this.verify || !this.jwks || !authorization?.startsWith('Bearer ')) return undefined
    try {
      const { payload } = await jwtVerify(authorization.slice(7), this.jwks, {
        issuer: this.verify.issuer,
        audience: this.verify.audience,
      })
      return payload
    } catch {
      return undefined
    }
  }

  private async handle(req: IncomingMessage, res: import('node:http').ServerResponse) {
    const body = await readBody(req)
    const url = new URL(req.url ?? '/', this.url)
    const json = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        'x-request-id': `req_${randomBytes(10).toString('hex')}`,
        ...headers,
      })
      res.end(JSON.stringify(payload))
    }
    if (url.pathname.startsWith('/__control/'))
      return this.control(url, req.method ?? '', body, json)

    const claims = await this.identify(req.headers.authorization)
    this.requests.push({
      method: req.method ?? '',
      path: req.url ?? '',
      authorization: req.headers.authorization,
      headers: { ...req.headers },
      body,
      sub: claims?.sub,
    })
    if (this.verify && !claims) return json(401, { error: { code: 'UNAUTHENTICATED' } })
    const roles =
      claims?.sub === READER_SUB
        ? ['reader']
        : claims?.sub === OPS_SUB
          ? ['order-ops']
          : claims?.sub === SUPPORT_SUB
            ? ['support-agent']
            : ['cms-writer', 'reader']
    const staffRole = roles.some((r) => r === 'order-ops' || r === 'support-agent')
    // Mirrors the backend access matrix: staff roles reach only /me and the staff namespaces; general roles never reach them.
    const staffPath = /^\/api\/v1\/admin\/(orders|support)\b/.test(url.pathname)
    if (this.verify && url.pathname !== '/api/v1/admin/me' && staffRole !== staffPath)
      return json(403, { error: { code: 'FORBIDDEN' } })

    if (url.pathname === '/api/v1/admin/me') {
      if (this.status !== 200) return json(this.status, { error: { code: 'X' } })
      if (!this.verify) return json(200, this.body)
      return json(200, {
        actorType: 'HUMAN_ADMIN',
        actorId: `google:${claims!.sub}`,
        email: String(claims!.email ?? ''),
        roles,
      })
    }

    if (url.pathname === '/api/v1/admin/dashboard/summary' && req.method === 'GET') {
      const o = this.dashboardOverride
      if (o) return json(o.status, o.body ?? { error: { code: 'SERVICE_UNAVAILABLE' } })
      const c = (value: number, capped = false) => ({ value, capped })
      return json(200, {
        orders: {
          open_confirmed: c(7),
          open_out_for_delivery: c(2),
          last24h_confirmed: c(3),
          last24h_out_for_delivery: c(1),
          last24h_delivered: c(9),
          last24h_cancelled: c(0),
        },
        inventory: { out_of_stock: c(4), low_stock: c(10000, true) },
        catalog: { products_total: c(120), active: c(100), draft: c(20) },
        serviceability: { service_areas_total: c(1), active: c(1) },
        support: { open: c(5), in_progress: c(1) },
        notifications: { pending: c(0), failed: c(2) },
        generatedAt: '2026-10-06T03:30:00Z',
        bounds: { cap: 10000, maxTimeMs: 2000, recentWindowHours: 24 },
      })
    }

    if (url.pathname.startsWith('/api/v1/taxonomy/')) {
      const t = url.pathname.slice('/api/v1/taxonomy/'.length)
      const nodeOut = (n: { id: string }) => ({ ...n, attributeSchemaId: null })
      if (req.method === 'GET' && t === 'nodes') {
        const parent = url.searchParams.get('parentId')
        const type = url.searchParams.get('nodeType')
        const items = [...this.nodes.values()].filter((n) =>
          parent ? n.parentId === parent : n.nodeType === type,
        )
        return json(200, { items: items.map(nodeOut) })
      }
      const one = t.match(/^nodes\/([^/]+)(\/path|\/rename)?$/)
      if (one) {
        const n = this.nodes.get(decodeURIComponent(one[1]!))
        if (!n) return json(404, { error: { code: 'NODE_NOT_FOUND' } })
        if (req.method === 'GET' && !one[2]) return json(200, nodeOut(n))
        if (req.method === 'GET' && one[2] === '/path')
          return json(200, {
            verticalId: n.id,
            path: n.name,
            nodes: [{ id: n.id, name: n.name, nodeType: n.nodeType }],
          })
        if (req.method === 'POST' && one[2] === '/rename') {
          if (!roles.includes('cms-writer')) return json(403, { error: { code: 'FORBIDDEN' } })
          if (!this.openRelease) return json(409, { error: { code: 'NO_OPEN_RELEASE' } })
          const b = JSON.parse(body) as { name: string; expectedVersion: number }
          if (b.expectedVersion !== n.version)
            return json(409, { error: { code: 'STALE_VERSION' } })
          const next = { ...n, name: b.name, version: n.version + 1 }
          this.nodes.set(n.id, next)
          return json(200, nodeOut(next))
        }
      }
      if (req.method === 'POST' && t === 'releases') {
        if (!roles.includes('cms-writer')) return json(403, { error: { code: 'FORBIDDEN' } })
        if (this.openRelease) return json(409, { error: { code: 'RELEASE_ALREADY_OPEN' } })
        const b = JSON.parse(body) as { releaseId: string }
        this.openRelease = b.releaseId
        this.releases.set(b.releaseId, 'publishing')
        return json(201, { id: b.releaseId, version: null })
      }
      const rel = t.match(/^releases\/([^/]+)(\/publish)?$/)
      if (rel) {
        const id = decodeURIComponent(rel[1]!)
        const status = this.releases.get(id)
        if (req.method === 'GET')
          return status
            ? json(200, { id, status, basedOn: null })
            : json(404, { error: { code: 'NOT_FOUND' } })
        if (req.method === 'POST' && rel[2]) {
          if (status !== 'publishing') return json(409, { error: { code: 'RELEASE_NOT_OPEN' } })
          this.releases.set(id, 'active')
          this.openRelease = undefined
          return json(200, { id, version: null })
        }
      }
      return json(404, { error: { code: 'NO_SUCH_ENDPOINT' } })
    }
    const orderView = (o: {
      orderId: string
      status: string
      version: number
      cancelReason?: string
      cancelledBy?: string
    }) => ({
      ...o,
      customerId: 'C-1',
      paymentMethod: 'COD',
      lines: [
        {
          skuId: 'TZP-REF-1',
          title: 'Basmati 5 kg',
          quantity: 2,
          unitPricePaise: 12900,
          lineTotalPaise: 25800,
        },
      ],
      itemCount: 2,
      subtotalPaise: 25800,
      payablePaise: 25800,
      deliveryAddress: {
        recipientName: 'A Customer',
        recipientPhone: '+919900000000',
        addressLine1: '12 Main Rd',
        city: 'Bengaluru',
        state: 'KA',
        postalCode: '560047',
        latitude: 12.9,
        longitude: 77.6,
      },
      deliverySlot: { label: 'Today 6-8 pm' },
      createdAt: '2026-10-06T03:30:00Z',
    })
    if (url.pathname === '/api/v1/admin/orders' && req.method === 'GET') {
      const st = url.searchParams.get('status')
      return json(200, {
        items: [...this.orders.values()].filter((o) => !st || o.status === st).map(orderView),
      })
    }
    const ord = url.pathname.match(/^\/api\/v1\/admin\/orders\/([^/]+)(\/transition)?$/)
    if (ord) {
      const o = this.orders.get(decodeURIComponent(ord[1]!))
      if (!o) return json(404, { error: { code: 'ORDER_NOT_FOUND' } })
      if (req.method === 'GET' && !ord[2]) return json(200, orderView(o))
      if (req.method === 'POST' && ord[2]) {
        if (!roles.includes('order-ops')) return json(403, { error: { code: 'FORBIDDEN' } })
        const b = JSON.parse(body) as { to: string; expectedVersion: number; reason?: string }
        if (b.expectedVersion !== o.version) return json(409, { error: { code: 'STALE_VERSION' } })
        const legal: Record<string, string[]> = {
          CONFIRMED: ['OUT_FOR_DELIVERY', 'CANCELLED'],
          OUT_FOR_DELIVERY: ['DELIVERED', 'CANCELLED'],
        }
        if (!legal[o.status]?.includes(b.to))
          return json(409, { error: { code: 'INVALID_TRANSITION' } })
        if ((b.to === 'CANCELLED') !== (b.reason !== undefined))
          return json(400, { error: { code: 'INVALID_REQUEST' } })
        const next = {
          ...o,
          status: b.to,
          version: b.expectedVersion + 1,
          ...(b.reason ? { cancelReason: b.reason, cancelledBy: 'STAFF' } : {}),
        }
        this.orders.set(o.orderId, next)
        return json(200, orderView(next))
      }
    }
    const imp = url.pathname.match(/^\/api\/v1\/admin\/imports\/(prices|inventory|products)$/)
    if (imp && req.method === 'POST') {
      if (!roles.includes('cms-writer')) return json(403, { error: { code: 'FORBIDDEN' } })
      const kind = imp[1]!
      const b = JSON.parse(body) as { dryRun: boolean; rows: Record<string, unknown>[] }
      const key = (r: Record<string, unknown>) => String(r.skuId ?? r.id)
      const rowErrors = b.rows.flatMap((r, row) =>
        this.products.has(key(r)) || kind === 'products'
          ? []
          : [{ row, code: 'UNKNOWN_PRODUCT', message: `no product ${key(r)}` }],
      )
      if (rowErrors.length)
        return json(422, { error: { code: 'INVALID_IMPORT', message: 'rejected' }, rowErrors })
      const results = b.rows.map((r, row) => {
        if (b.dryRun)
          return { row, key: key(r), outcome: 'VALID', version: null, code: null, message: null }
        if (kind === 'prices') {
          const existing = this.prices.get(key(r))
          if (existing && r.expectedVersion !== existing.version)
            return {
              row,
              key: key(r),
              outcome: 'FAILED',
              version: null,
              code: 'STALE_VERSION',
              message: 'version mismatch',
            }
          this.prices.set(key(r), {
            sellingPricePaise: Number(r.sellingPricePaise),
            mrpPaise: Number(r.mrpPaise),
            version: (existing?.version ?? 0) + 1,
          })
        }
        return { row, key: key(r), outcome: 'APPLIED', version: 1, code: null, message: null }
      })
      const count = (o: string) => results.filter((r) => r.outcome === o).length
      return json(200, {
        importId: 'IMP-abc123',
        kind,
        dryRun: b.dryRun,
        rows: b.rows.length,
        applied: count('APPLIED'),
        failed: count('FAILED'),
        notAttempted: 0,
        unchanged: 0,
        results,
      })
    }
    const priceMatch = url.pathname.match(/^\/api\/v1\/admin\/prices\/([^/]+)$/)
    if (priceMatch) {
      const sku = decodeURIComponent(priceMatch[1]!)
      if (!this.products.has(sku)) return json(404, { error: { code: 'NOT_FOUND' } })
      const row = this.prices.get(sku)
      const view = (r: { sellingPricePaise: number; mrpPaise: number; version: number }) => ({
        skuId: sku,
        currency: 'INR',
        ...r,
        active: true,
        status: 'ACTIVE',
      })
      if (req.method === 'GET')
        return row ? json(200, view(row)) : json(404, { error: { code: 'NOT_FOUND' } })
      if (req.method === 'PUT') {
        if (!roles.includes('cms-writer')) return json(403, { error: { code: 'FORBIDDEN' } })
        const b = JSON.parse(body) as {
          sellingPricePaise: number
          mrpPaise: number
          currency?: string
          expectedVersion?: number
        }
        if (b.mrpPaise < b.sellingPricePaise) return json(422, { error: { code: 'INVALID_PRICE' } })
        if (
          b.expectedVersion === undefined ? row !== undefined : row?.version !== b.expectedVersion
        )
          return json(409, { error: { code: 'STALE_VERSION' } })
        const next = {
          sellingPricePaise: b.sellingPricePaise,
          mrpPaise: b.mrpPaise,
          version: (row?.version ?? 0) + 1,
        }
        this.prices.set(sku, next)
        return json(row ? 200 : 201, view(next))
      }
    }
    const invMatch = url.pathname.match(
      /^\/api\/v1\/admin\/inventory\/([^/]+)\/([^/]+)(\/activate|\/deactivate)?$/,
    )
    if (invMatch) {
      const sku = decodeURIComponent(invMatch[1]!)
      const loc = decodeURIComponent(invMatch[2]!)
      const key = `${sku}|${loc}`
      if (!this.products.has(sku)) return json(404, { error: { code: 'NOT_FOUND' } })
      const row = this.stock.get(key)
      const view = (r: NonNullable<typeof row>) => ({
        skuId: sku,
        fulfillmentLocationId: loc,
        ...r,
        available: r.onHand - r.reserved,
      })
      if (req.method === 'GET')
        return row ? json(200, view(row)) : json(404, { error: { code: 'NOT_FOUND' } })
      if (!roles.includes('cms-writer')) return json(403, { error: { code: 'FORBIDDEN' } })
      const b = JSON.parse(body || '{}') as {
        onHand?: number
        lowStockThreshold?: number
        maxPurchasable?: number
        expectedVersion?: number
      }
      if (req.method === 'PUT') {
        if (
          b.expectedVersion === undefined ? row !== undefined : row?.version !== b.expectedVersion
        )
          return json(409, { error: { code: 'STALE_VERSION' } })
        if (row && (b.onHand ?? 0) < row.reserved)
          return json(422, { error: { code: 'INVALID_INVENTORY' } })
        const next = {
          onHand: b.onHand ?? 0,
          reserved: row?.reserved ?? 0,
          lowStockThreshold: b.lowStockThreshold ?? 0,
          maxPurchasable: b.maxPurchasable ?? 0,
          version: (row?.version ?? 0) + 1,
          active: row?.active ?? true,
        }
        this.stock.set(key, next)
        return json(row ? 200 : 201, view(next))
      }
      if (req.method === 'POST' && invMatch[3] && row) {
        if (b.expectedVersion !== row.version)
          return json(409, { error: { code: 'STALE_VERSION' } })
        const next = { ...row, active: invMatch[3] === '/activate', version: row.version + 1 }
        this.stock.set(key, next)
        return json(200, view(next))
      }
    }
    const full = (p: { id: string; title: string; version: number; lifecycle: string }) => ({
      ...p,
      productType: 'single',
      brandCode: 'BR',
      classification: { verticalId: 'VT-1', releaseId: 'REL-1', status: 'confirmed' },
      attributes: { net_weight: '5 kg' },
      taxonomyPath: 'Staples > Rice',
    })
    if (url.pathname === '/api/v1/products' && req.method === 'GET') {
      const items = [...this.products.values()].map((p) => ({
        id: p.id,
        productType: 'single',
        lifecycle: p.lifecycle,
        brandCode: 'BR',
        title: p.title,
        verticalId: 'VT-1',
        classificationStatus: 'confirmed',
        version: p.version,
      }))
      return json(200, { items })
    }
    if (url.pathname === '/api/v1/products' && req.method === 'POST') {
      if (!roles.includes('cms-writer')) return json(403, { error: { code: 'FORBIDDEN' } })
      const input = JSON.parse(body) as { id: string; title: string }
      if (this.products.has(input.id)) return json(409, { error: { code: 'IDENTITY_COLLISION' } })
      const created = { id: input.id, title: input.title, version: 1, lifecycle: 'draft' }
      this.products.set(created.id, created)
      return json(201, full(created))
    }
    const lifecycle = url.pathname.match(
      /^\/api\/v1\/products\/([^/]+)\/(activate|retire|revive|archive)$/,
    )
    if (lifecycle && req.method === 'POST') {
      if (!roles.includes('cms-writer')) return json(403, { error: { code: 'FORBIDDEN' } })
      const current = this.products.get(decodeURIComponent(lifecycle[1]!))
      if (!current) return json(404, { error: { code: 'NOT_FOUND' } })
      if (Number(req.headers['if-match']) !== current.version)
        return json(409, { error: { code: 'STALE_VERSION' } })
      const to = {
        activate: 'active',
        retire: 'discontinued',
        revive: 'active',
        archive: 'archived',
      }[lifecycle[2] as 'activate']
      const legal: Record<string, string[]> = {
        activate: ['draft'],
        retire: ['active'],
        revive: ['discontinued'],
        archive: ['discontinued'],
      }
      if (!legal[lifecycle[2]!]!.includes(current.lifecycle))
        return json(409, { error: { code: 'STATE_CONFLICT' } })
      const next = { ...current, lifecycle: to, version: current.version + 1 }
      this.products.set(next.id, next)
      return json(200, full(next))
    }
    const getProduct = url.pathname.match(/^\/api\/v1\/products\/([^/]+)$/)
    if (getProduct && req.method === 'GET') {
      const found = this.products.get(decodeURIComponent(getProduct[1]!))
      return found ? json(200, full(found)) : json(404, { error: { code: 'NOT_FOUND' } })
    }

    const product = url.pathname.match(/^\/api\/v1\/products\/([^/]+)$/)
    if (product && req.method === 'PATCH') {
      const o = this.mutationOverride
      if (o) {
        if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs))
        return json(
          o.status,
          o.body ?? {
            error: { code: 'FORCED', message: 'internal detail: stack trace at Foo.java:42' },
          },
          o.headers,
        )
      }
      if (!roles.includes('cms-writer'))
        return json(403, { error: { code: 'FORBIDDEN', message: 'role may not perform writes' } })
      const current = this.products.get(decodeURIComponent(product[1]!))
      if (!current)
        return json(404, { error: { code: 'NOT_FOUND', message: 'no product TZP-...' } })
      const expected = Number(req.headers['if-match'])
      if (!Number.isInteger(expected))
        return json(400, { error: { code: 'MISSING_HEADER', message: 'If-Match' } })
      if (expected !== current.version)
        return json(409, {
          error: { code: 'STALE_VERSION', message: `expected ${current.version}` },
        })
      const next = {
        ...current,
        title: (JSON.parse(body) as { title: string }).title,
        version: current.version + 1,
      }
      this.products.set(next.id, next)
      return json(200, {
        ...next,
        productType: 'single',
        brandCode: 'BR',
        classification: {},
        attributes: {},
        taxonomyPath: 'x',
      })
    }
    return json(404, { error: { code: 'NO_SUCH_ENDPOINT' } })
  }

  private control(
    url: URL,
    method: string,
    body: string,
    json: (status: number, payload: unknown) => void,
  ) {
    if (url.pathname === '/__control/requests') return json(200, this.requests)
    if (url.pathname === '/__control/reset' && method === 'POST') {
      this.reset()
      return json(200, { ok: true })
    }
    if (url.pathname === '/__control/bump-product' && method === 'POST') {
      const { id } = JSON.parse(body) as { id: string }
      const p = this.products.get(id)
      if (p)
        this.products.set(id, {
          ...p,
          version: p.version + 1,
          title: `${p.title} (edited elsewhere)`,
        })
      return json(200, { ok: true })
    }
    if (url.pathname === '/__control/dashboard' && method === 'POST') {
      this.dashboardOverride = body
        ? (JSON.parse(body) as FakeBackend['dashboardOverride'])
        : undefined
      return json(200, { ok: true })
    }
    if (url.pathname === '/__control/mutation' && method === 'POST') {
      this.mutationOverride = body
        ? (JSON.parse(body) as FakeBackend['mutationOverride'])
        : undefined
      return json(200, { ok: true })
    }
    return json(404, {})
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
  })
}
