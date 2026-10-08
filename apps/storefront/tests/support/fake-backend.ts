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
 * - `GET /v1/products/{id}`, `/v1/categories`, `/v1/categories/{id}/children`, `/v1/categories/{id}/products`,
 *   `/v1/search` with the documented shapes; unknown ids are a flat 404.
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
}

type Audience = 'APP_ONLY' | 'WEB_ONLY' | 'BOTH'

export class FakeBackend {
  url = ''
  mediaUrl = ''
  mediaDown = false
  readonly requests: RecordedRequest[] = []
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
        ids: ['TZS-000001', 'TZC-000002', 'TZG-000003'],
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

  private nodes: Record<string, { name: string; children: string[] }> = {
    'TZS-000001': { name: 'Staples', children: ['TZC-000002'] },
    'TZS-000002': { name: 'Fruits', children: [] },
    'TZC-000002': { name: 'Rice', children: [] },
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
    })
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

    const product = /^\/v1\/products\/([^/]+)$/.exec(url.pathname)
    if (product) {
      const p = this.products()[decodeURIComponent(product[1] ?? '')]
      if (!p) return error(404, 'NOT_FOUND')
      return send(
        200,
        { ...p, resolvedReleaseId: 'R1', requestId: 'req_pdp' },
        { 'cache-control': 'private, no-store' },
      )
    }

    if (url.pathname === '/v1/categories') {
      const items = ['TZS-000001', 'TZS-000002'].map((id) => ({ id, name: this.nodes[id]!.name }))
      return send(200, { resolvedReleaseId: 'R1', items, requestId: 'req_cat' })
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
      const items = Object.values(this.products())
      return send(200, { resolvedReleaseId: 'R1', items, hasMore: false, requestId: 'req_list' })
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
      return send(200, { resolvedReleaseId: 'R1', items, hasMore: false, requestId: 'req_search' })
    }
    return error(404, 'NOT_FOUND')
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
