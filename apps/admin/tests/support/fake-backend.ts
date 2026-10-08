import { randomBytes, randomUUID } from 'node:crypto'
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
export const AUDIT_SUB = '110000000000000000005'

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
  /** Health mock: readiness status and component state (set via /__control/ready). */
  readyDown = false
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
  readonly cases = new Map<
    string,
    {
      caseId: string
      status: string
      version: number
      assignedTo: string | null
      messages: { id: string; author: string; staffId?: string; text: string; at: string }[]
    }
  >()
  readonly areas = new Map<
    string,
    {
      pincode: string
      serviceAreaId: string
      active: boolean
      version: number
      routes: { fulfillmentLocationId: string; priority: number; active: boolean }[]
    }
  >()
  readonly windows = new Map<
    string,
    {
      serviceAreaId: string
      windowId: string
      label: string
      startMinute: number
      endMinute: number
      cutoffMinutes: number
      capacity: number
      days: number[]
      active: boolean
      version: number
    }
  >()
  readonly media = new Map<string, { version: number; assets: Record<string, unknown>[] }>()
  readonly blocks = new Map<
    string,
    Record<string, unknown> & { blockId: string; status: string; version: number }
  >()
  appConfig: Record<string, unknown> & { version: number } = {
    storeOpen: true,
    maintenance: false,
    maintenanceMessage: null,
    minAndroid: '1.0.0',
    latestAndroid: '1.2.0',
    minIos: null,
    latestIos: null,
    supportPhone: null,
    supportEmail: null,
    termsUrl: null,
    privacyUrl: null,
    refundPolicyUrl: null,
    version: 0,
  }
  readonly requests: RecordedRequest[] = []
  /**
   * Object-storage stand-in (S3 presigned PUT semantics): a target is issued for one key, bound to Content-Type,
   * Content-Length and If-None-Match: * (anything else is 403), write-once (a second PUT is 412), CORS for the browser.
   * `enabled` false mimics the default backend (503 MEDIA_STORAGE_NOT_CONFIGURED); `outage` makes verification 503.
   */
  storage: {
    enabled: boolean
    outage: boolean
    publicBase: boolean
    failNext?: { status: number; count: number }
  } = { enabled: true, outage: false, publicBase: true }
  readonly objects = new Map<string, { bytes: Buffer; contentType: string }>()
  readonly issued = new Map<string, { contentType: string; size: number }>()
  readonly storageRequests: {
    method: string
    path: string
    headers: Record<string, string | string[] | undefined>
    bytes: number
  }[] = []
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
    this.storage = { enabled: true, outage: false, publicBase: true }
    this.objects.clear()
    this.issued.clear()
    this.storageRequests.length = 0
    for (const key of ['p/product/tzp-ref-1/a.jpg', 'p/product/tzp-ref-1/b.png'])
      this.objects.set(key, { bytes: TINY_PNG, contentType: 'image/png' })
    this.mutationOverride = undefined
    this.readyDown = false
    this.dashboardOverride = undefined
    this.requests.length = 0
    this.openRelease = undefined
    this.releases.clear()
    this.nodes.clear()
    this.prices.clear()
    this.orders.clear()
    this.cases.clear()
    this.areas.clear()
    this.media.clear()
    this.blocks.clear()
    this.blocks.set('CB_faqseed000000001', {
      blockId: 'CB_faqseed000000001',
      placement: 'HELP',
      type: 'FAQ',
      title: 'Delivery times',
      sort: 1,
      status: 'PUBLISHED',
      version: 2,
      payload: {
        faqCategory: 'DELIVERY',
        question: 'When do you deliver?',
        answer: 'Evenings.\nSeven days a week.',
      },
    })
    this.appConfig = {
      storeOpen: true,
      maintenance: false,
      maintenanceMessage: null,
      minAndroid: '1.0.0',
      latestAndroid: '1.2.0',
      minIos: null,
      latestIos: null,
      supportPhone: null,
      supportEmail: null,
      termsUrl: null,
      privacyUrl: null,
      refundPolicyUrl: null,
      version: 0,
    }
    this.media.set('product|TZP-REF-1', {
      version: 3,
      assets: [
        {
          assetId: 'A1',
          assetKey: 'p/product/tzp-ref-1/a.jpg',
          role: 'PRIMARY',
          sortOrder: 0,
          altText: 'Front',
          width: 800,
          height: 800,
          contentType: 'image/jpeg',
        },
        { assetId: 'A2', assetKey: 'p/product/tzp-ref-1/b.png', role: 'GALLERY', sortOrder: 1 },
      ],
    })
    this.windows.clear()
    this.areas.set('560047', {
      pincode: '560047',
      serviceAreaId: 'Ejipura',
      active: true,
      version: 2,
      routes: [{ fulfillmentLocationId: 'LOC-1', priority: 1, active: true }],
    })
    this.windows.set('Ejipura|evening', {
      serviceAreaId: 'Ejipura',
      windowId: 'evening',
      label: 'Evening',
      startMinute: 1080,
      endMinute: 1200,
      cutoffMinutes: 60,
      capacity: 20,
      days: [1, 2, 3, 4, 5],
      active: true,
      version: 1,
    })
    this.cases.clear()
    this.cases.set('SUP_1', {
      caseId: 'SUP_1',
      status: 'OPEN',
      version: 2,
      assignedTo: null,
      messages: [
        {
          id: 'm1',
          author: 'CUSTOMER',
          text: '<b>where</b> is my order',
          at: '2026-10-06T03:30:00Z',
        },
      ],
    })
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

  /** A presigned-style target for one key (the URL points at this fake's storage endpoint). */
  issue(key: string, contentType: string, size: number) {
    this.issued.set(key, { contentType, size })
    return {
      assetKey: key,
      method: 'PUT',
      url: `${this.url}/__storage/${key}?X-Amz-Signature=fake${randomBytes(4).toString('hex')}`,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(size),
        'If-None-Match': '*',
      },
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
      maxBytes: 5 * 1024 * 1024,
    }
  }

  publicUrl(key: string): string | undefined {
    return this.storage.publicBase ? `${this.url}/__storage/${key}` : undefined
  }

  /** Mirrors `MediaIngestVerifier`: exists, size, magic bytes match the declared type. Undefined = ok. */
  verifyStored(key: string, declared?: string): { status: number; code: string } | undefined {
    if (this.storage.outage) return { status: 503, code: 'MEDIA_STORAGE_UNAVAILABLE' }
    const o = this.objects.get(key)
    if (!o || o.bytes.length < 1 || o.bytes.length > 5 * 1024 * 1024)
      return { status: 422, code: 'INVALID_MEDIA' }
    const sniffed = sniff(o.bytes)
    if (!sniffed || (declared && declared !== sniffed) || o.contentType !== sniffed)
      return { status: 422, code: 'INVALID_MEDIA' }
    return undefined
  }

  private storageRequest(
    req: IncomingMessage,
    res: import('node:http').ServerResponse,
    url: URL,
    raw: Buffer,
  ) {
    const key = decodeURIComponent(url.pathname.slice('/__storage/'.length))
    this.storageRequests.push({
      method: req.method ?? '',
      path: url.pathname,
      headers: { ...req.headers },
      bytes: raw.length,
    })
    const cors = {
      'access-control-allow-origin': String(req.headers.origin ?? '*'),
      vary: 'Origin',
    }
    const end = (status: number, headers: Record<string, string> = {}, bytes?: Buffer) => {
      res.writeHead(status, { ...cors, ...headers })
      res.end(bytes)
    }
    if (req.method === 'OPTIONS')
      return end(204, {
        'access-control-allow-methods': 'PUT',
        'access-control-allow-headers': 'content-type, if-none-match',
        'access-control-max-age': '60',
      })
    if (req.method === 'GET') {
      const o = this.objects.get(key)
      return o ? end(200, { 'content-type': o.contentType }, o.bytes) : end(404)
    }
    if (req.method !== 'PUT') return end(405)
    const fail = this.storage.failNext
    if (fail && fail.count > 0) {
      fail.count -= 1
      return end(fail.status)
    }
    const signed = this.issued.get(key)
    if (
      !signed ||
      req.headers['content-type'] !== signed.contentType ||
      Number(req.headers['content-length']) !== signed.size ||
      req.headers['if-none-match'] !== '*' ||
      raw.length !== signed.size
    )
      return end(403)
    if (this.objects.has(key)) return end(412)
    this.objects.set(key, { bytes: raw, contentType: signed.contentType })
    return end(200)
  }

  private async handle(req: IncomingMessage, res: import('node:http').ServerResponse) {
    const raw = await readBody(req)
    const body = raw.toString('utf8')
    const url = new URL(req.url ?? '/', this.url)
    if (url.pathname.startsWith('/__storage/')) return this.storageRequest(req, res, url, raw)
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

    if (url.pathname === '/health/live' || url.pathname === '/health/ready') {
      this.requests.push({
        method: req.method ?? '',
        path: req.url ?? '',
        authorization: req.headers.authorization,
        headers: { ...req.headers },
        body,
      })
      if (url.pathname === '/health/live')
        return json(200, { status: 'UP', components: { datastore: 'OPEN', mongo: 'SKIPPED' } })
      return this.readyDown
        ? json(503, { status: 'DOWN', components: { mongo: 'DOWN', rate_limiter: 'UP' } })
        : json(200, { status: 'UP', components: { mongo: 'UP', rate_limiter: 'UP' } })
    }
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
            : claims?.sub === AUDIT_SUB
              ? ['audit-reader']
              : ['cms-writer', 'reader']
    const staffRole = roles.some((r) => r === 'order-ops' || r === 'support-agent')
    // Mirrors the backend access matrix: staff roles reach only /me and the staff namespaces; general roles never reach them.
    const staffPath = /^\/api\/v1\/admin\/(orders|support)\b/.test(url.pathname)
    const auditPath = url.pathname === '/api/v1/admin/audit-events'
    const auditRole = roles.includes('audit-reader')
    if (this.verify && url.pathname !== '/api/v1/admin/me') {
      // audit-reader reaches only /me and the audit trail; other roles never read the audit trail.
      if (auditPath ? !auditRole : auditRole) return json(403, { error: { code: 'FORBIDDEN' } })
      if (!auditPath && staffRole !== staffPath) return json(403, { error: { code: 'FORBIDDEN' } })
    }
    if (auditPath && req.method === 'GET') {
      const all = [
        {
          id: 'AE-3',
          occurredAt: '2026-10-06T03:30:00Z',
          action: 'PRICE_SET',
          targetType: 'sku',
          targetId: 'TZP-REF-1',
          actorType: 'HUMAN_ADMIN',
          actorId: 'google:110000000000000000001',
          credentialId: null,
          requestId: 'req_0123456789abcdef0123',
        },
        {
          id: 'AE-2',
          occurredAt: '2026-10-06T03:00:00Z',
          action: 'CONTENT_BLOCK_CREATED',
          targetType: 'content_block',
          targetId: 'CB_x',
          actorType: 'HUMAN_ADMIN',
          actorId: 'google:110000000000000000001',
          credentialId: null,
          requestId: null,
        },
        {
          id: 'AE-1',
          occurredAt: '2026-10-06T02:00:00Z',
          action: 'PRICE_SET',
          targetType: 'sku',
          targetId: 'TZP-REF-2',
          actorType: 'SERVICE_ACCOUNT',
          actorId: 'service:cms-writer',
          credentialId: 'cred-1',
          requestId: null,
        },
      ]
      const act = url.searchParams.get('action')
      const items = all.filter((e) => !act || e.action === act)
      return json(200, { items, nextCursor: null })
    }

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
    if (url.pathname === '/api/v1/admin/service-areas' && req.method === 'GET')
      return json(200, { items: [...this.areas.values()] })
    if (url.pathname === '/api/v1/admin/media/uploads' && req.method === 'POST') {
      if (!roles.includes('cms-writer')) return json(403, { error: { code: 'FORBIDDEN' } })
      const b = JSON.parse(body) as {
        ownerType: string
        ownerId: string
        contentType: string
        sizeBytes: number
      }
      const ext = EXTENSIONS[b.contentType]
      if (!ext || !(b.sizeBytes >= 1 && b.sizeBytes <= 5 * 1024 * 1024))
        return json(422, { error: { code: 'INVALID_MEDIA', message: 'unsupported' } })
      if (!this.products.has(b.ownerId)) return json(404, { error: { code: 'NOT_FOUND' } })
      if (!this.storage.enabled)
        return json(503, {
          error: { code: 'MEDIA_STORAGE_NOT_CONFIGURED', message: 'internal detail: bucket none' },
        })
      const key = `p/${b.ownerType}/${b.ownerId.replace(/[^A-Za-z0-9_-]/g, '-')}/${randomUUID()}.${ext}`
      return json(201, this.issue(key, b.contentType, b.sizeBytes))
    }
    if (url.pathname === '/api/v1/admin/app-config') {
      if (req.method === 'GET') return json(200, this.appConfig)
      if (req.method === 'PUT') {
        if (!roles.includes('cms-writer')) return json(403, { error: { code: 'FORBIDDEN' } })
        const b = JSON.parse(body) as Record<string, unknown> & {
          expectedVersion: number
          maintenance: boolean
          maintenanceMessage: string | null
        }
        if (b.expectedVersion !== this.appConfig.version)
          return json(409, { error: { code: 'STALE_VERSION' } })
        if (Object.values(b).some((v) => v === ''))
          return json(422, {
            error: { code: 'INVALID_CONTENT', message: 'empty string not allowed' },
          })
        const { expectedVersion, ...rest } = b
        this.appConfig = { ...this.appConfig, ...rest, version: expectedVersion + 1 }
        return json(200, this.appConfig)
      }
    }
    if (url.pathname === '/api/v1/admin/content/blocks' && req.method === 'GET') {
      const placement = url.searchParams.get('placement') ?? 'HOME'
      const st = url.searchParams.get('status')
      return json(200, {
        items: [...this.blocks.values()].filter(
          (x) => x.placement === placement && (!st || x.status === st),
        ),
      })
    }
    if (url.pathname === '/api/v1/admin/content/blocks' && req.method === 'POST') {
      if (!roles.includes('cms-writer')) return json(403, { error: { code: 'FORBIDDEN' } })
      const b = JSON.parse(body) as Record<string, unknown>
      const id = `CB_new${String(this.blocks.size).padStart(13, '0')}`
      const created = { ...b, blockId: id, status: 'DRAFT', version: 1 }
      this.blocks.set(id, created as never)
      return json(201, created)
    }
    const blk = url.pathname.match(
      /^\/api\/v1\/admin\/content\/blocks\/(CB_[A-Za-z0-9_-]+)(\/status)?$/,
    )
    if (blk) {
      const cur = this.blocks.get(blk[1]!)
      if (!cur) return json(404, { error: { code: 'NOT_FOUND' } })
      if (req.method === 'GET') return json(200, cur)
      if (!roles.includes('cms-writer')) return json(403, { error: { code: 'FORBIDDEN' } })
      const b = JSON.parse(body) as Record<string, unknown> & {
        expectedVersion: number
        to?: string
      }
      if (b.expectedVersion !== cur.version) return json(409, { error: { code: 'STALE_VERSION' } })
      if (cur.status === 'ARCHIVED') return json(409, { error: { code: 'STATE_CONFLICT' } })
      if (req.method === 'POST' && blk[2]) {
        if (b.to === cur.status) return json(409, { error: { code: 'STATE_CONFLICT' } })
        const next = { ...cur, status: String(b.to), version: cur.version + 1 }
        this.blocks.set(cur.blockId, next)
        return json(200, next)
      }
      if (req.method === 'PUT') {
        const { expectedVersion, ...rest } = b
        const next = {
          blockId: cur.blockId,
          placement: cur.placement,
          type: cur.type,
          status: cur.status,
          ...rest,
          version: expectedVersion + 1,
        }
        this.blocks.set(cur.blockId, next as never)
        return json(200, next)
      }
    }
    const mediaM = url.pathname.match(/^\/api\/v1\/admin\/media\/(product|sku)\/([^/]+)$/)
    if (mediaM) {
      const key = `${mediaM[1]}|${decodeURIComponent(mediaM[2]!)}`
      const m = this.media.get(key)
      if (req.method === 'GET')
        return m
          ? json(200, {
              ownerType: mediaM[1],
              ownerId: decodeURIComponent(mediaM[2]!),
              version: m.version,
              active: true,
              assets: m.assets.map((a) => ({ ...a, url: this.publicUrl(String(a.assetKey)) })),
            })
          : json(404, { error: { code: 'NOT_FOUND' } })
      if (req.method === 'PUT') {
        if (!roles.includes('cms-writer')) return json(403, { error: { code: 'FORBIDDEN' } })
        const b = JSON.parse(body) as {
          assets: Record<string, unknown>[]
          expectedVersion?: number
        }
        if (b.expectedVersion === undefined ? m !== undefined : m?.version !== b.expectedVersion)
          return json(409, { error: { code: 'STALE_VERSION' } })
        if (this.storage.enabled) {
          const existing = new Set((m?.assets ?? []).map((a) => String(a.assetKey)))
          const prefix = `p/${mediaM[1]}/${decodeURIComponent(mediaM[2]!).replace(/[^A-Za-z0-9_-]/g, '-')}/`
          for (const a of b.assets) {
            const key = String(a.assetKey)
            if (existing.has(key)) continue
            if (!key.startsWith(prefix))
              return json(422, { error: { code: 'INVALID_MEDIA', message: 'other owner' } })
            const bad = this.verifyStored(key, a.contentType as string | undefined)
            if (bad) return json(bad.status, { error: { code: bad.code, message: 'detail' } })
          }
        }
        const next = { version: (m?.version ?? 0) + 1, assets: b.assets }
        this.media.set(key, next)
        return json(m ? 200 : 201, {
          ownerType: mediaM[1],
          ownerId: decodeURIComponent(mediaM[2]!),
          version: next.version,
        })
      }
    }
    const areaM = url.pathname.match(
      /^\/api\/v1\/admin\/service-areas\/(\d{6})(\/activate|\/deactivate)?$/,
    )
    if (areaM) {
      const pin = areaM[1]!
      const a = this.areas.get(pin)
      if (req.method === 'GET')
        return a ? json(200, a) : json(404, { error: { code: 'NOT_FOUND' } })
      if (!roles.includes('cms-writer')) return json(403, { error: { code: 'FORBIDDEN' } })
      const b = JSON.parse(body || '{}') as {
        serviceAreaId?: string
        routes?: { fulfillmentLocationId: string; priority: number; active: boolean }[]
        expectedVersion?: number
      }
      if (req.method === 'PUT') {
        if (b.expectedVersion === undefined ? a !== undefined : a?.version !== b.expectedVersion)
          return json(a ? 409 : 404, { error: { code: a ? 'STALE_VERSION' : 'NOT_FOUND' } })
        const next = {
          pincode: pin,
          serviceAreaId: String(b.serviceAreaId),
          active: a?.active ?? true,
          version: (a?.version ?? 0) + 1,
          routes: b.routes ?? [],
        }
        this.areas.set(pin, next)
        return json(a ? 200 : 201, next)
      }
      if (req.method === 'POST' && a && areaM[2]) {
        if (b.expectedVersion !== a.version) return json(409, { error: { code: 'STALE_VERSION' } })
        const next = { ...a, active: areaM[2] === '/activate', version: a.version + 1 }
        this.areas.set(pin, next)
        return json(200, next)
      }
    }
    const winL = url.pathname.match(/^\/api\/v1\/admin\/delivery-slots\/([^/]+)$/)
    if (winL && req.method === 'GET') {
      const area = decodeURIComponent(winL[1]!)
      return json(200, {
        items: [...this.windows.values()].filter((w) => w.serviceAreaId === area),
      })
    }
    const winM = url.pathname.match(
      /^\/api\/v1\/admin\/delivery-slots\/([^/]+)\/([^/]+)(\/activate|\/deactivate)?$/,
    )
    if (winM) {
      const area = decodeURIComponent(winM[1]!)
      const key = `${area}|${winM[2]}`
      const w = this.windows.get(key)
      if (!roles.includes('cms-writer') && req.method !== 'GET')
        return json(403, { error: { code: 'FORBIDDEN' } })
      const b = JSON.parse(body || '{}') as Record<string, number | string | number[]>
      if (req.method === 'PUT') {
        if (b.expectedVersion === undefined ? w !== undefined : w?.version !== b.expectedVersion)
          return json(409, { error: { code: 'STALE_VERSION' } })
        const next = {
          serviceAreaId: area,
          windowId: winM[2]!,
          label: String(b.label),
          startMinute: Number(b.startMinute),
          endMinute: Number(b.endMinute),
          cutoffMinutes: Number(b.cutoffMinutes),
          capacity: Number(b.capacity),
          days: b.days as number[],
          active: w?.active ?? true,
          version: (w?.version ?? 0) + 1,
        }
        this.windows.set(key, next)
        return json(w ? 200 : 201, next)
      }
      if (req.method === 'POST' && w && winM[3]) {
        if (b.expectedVersion !== w.version) return json(409, { error: { code: 'STALE_VERSION' } })
        const next = { ...w, active: winM[3] === '/activate', version: w.version + 1 }
        this.windows.set(key, next)
        return json(200, next)
      }
    }
    const caseView = (c: NonNullable<ReturnType<typeof this.cases.get>>) => ({
      ...c,
      customerId: 'C-1',
      category: 'ORDER_ISSUE',
      orderId: 'O-100',
      subject: 'Late order',
      createdAt: '2026-10-06T03:30:00Z',
      updatedAt: '2026-10-06T03:30:00Z',
    })
    if (url.pathname === '/api/v1/admin/support/cases' && req.method === 'GET') {
      const st = url.searchParams.get('status')
      return json(200, {
        items: [...this.cases.values()]
          .filter((c) => !st || c.status === st)
          .map((c) => ({ ...caseView(c), messageCount: c.messages.length, messages: undefined })),
      })
    }
    const sup = url.pathname.match(
      /^\/api\/v1\/admin\/support\/cases\/([^/]+)(\/messages|\/assign|\/status)?$/,
    )
    if (sup) {
      const c = this.cases.get(decodeURIComponent(sup[1]!))
      if (!c) return json(404, { error: { code: 'NOT_FOUND' } })
      if (req.method === 'GET' && !sup[2]) return json(200, caseView(c))
      if (req.method === 'POST' && sup[2]) {
        if (!roles.includes('support-agent')) return json(403, { error: { code: 'FORBIDDEN' } })
        const b = JSON.parse(body) as { message?: string; to?: string; expectedVersion?: number }
        if (sup[2] === '/messages') {
          if (c.status === 'CLOSED') return json(409, { error: { code: 'STATE_CONFLICT' } })
          const next = {
            ...c,
            status: c.status === 'OPEN' ? 'IN_PROGRESS' : c.status,
            version: c.version + 1,
            messages: [
              ...c.messages,
              {
                id: `m${c.messages.length + 1}`,
                author: 'STAFF',
                staffId: `google:${claims?.sub}`,
                text: b.message ?? '',
                at: '2026-10-06T04:00:00Z',
              },
            ],
          }
          this.cases.set(c.caseId, next)
          return json(200, caseView(next))
        }
        if (b.expectedVersion !== c.version) return json(409, { error: { code: 'STALE_VERSION' } })
        if (sup[2] === '/assign') {
          const next = {
            ...c,
            assignedTo: `google:${claims?.sub}`,
            status: c.status === 'OPEN' ? 'IN_PROGRESS' : c.status,
            version: c.version + 1,
          }
          this.cases.set(c.caseId, next)
          return json(200, caseView(next))
        }
        if (c.status === 'CLOSED' || b.to === c.status)
          return json(409, { error: { code: 'STATE_CONFLICT' } })
        const next = { ...c, status: String(b.to), version: c.version + 1 }
        this.cases.set(c.caseId, next)
        return json(200, caseView(next))
      }
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
    if (url.pathname === '/__control/storage-requests') return json(200, this.storageRequests)
    if (url.pathname === '/__control/storage' && method === 'POST') {
      this.storage = {
        ...this.storage,
        ...(JSON.parse(body || '{}') as Partial<FakeBackend['storage']>),
      }
      return json(200, { ok: true })
    }
    if (url.pathname === '/__control/bump-media' && method === 'POST') {
      const { key } = JSON.parse(body) as { key: string }
      const m = this.media.get(key)
      if (m) this.media.set(key, { ...m, version: m.version + 1 })
      return json(200, { ok: true })
    }
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

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}

/** Same closed-world sniff as the backend's `MediaSniffer`. */
function sniff(b: Buffer): string | undefined {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (
    b.length >= 8 &&
    b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]))
  )
    return 'image/png'
  if (
    b.length >= 12 &&
    b.toString('latin1', 0, 4) === 'RIFF' &&
    b.toString('latin1', 8, 12) === 'WEBP'
  )
    return 'image/webp'
  return undefined
}

/** A valid 1x1 PNG, served for the seeded media keys so thumbnails render. */
export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)
