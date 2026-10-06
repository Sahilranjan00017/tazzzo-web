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
  readonly requests: RecordedRequest[] = []
  readonly products = new Map<string, { id: string; title: string; version: number }>()
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
    this.products.clear()
    this.products.set('TZP-REF-1', { id: 'TZP-REF-1', title: 'Basmati 5 kg', version: 3 })
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
    const roles = claims?.sub === READER_SUB ? ['reader'] : ['cms-writer', 'reader']

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
        lifecycle: 'active',
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
