import { createServer, type Server } from 'node:http'

/** Local stand-in for the Tazzzo backend `/api/v1/admin/me` (never production). Records every Authorization header. */
export class FakeBackend {
  url = ''
  status = 200
  body: unknown = {
    actorType: 'HUMAN_ADMIN',
    actorId: 'google:111',
    email: 'ops@tazzzo.test',
    roles: ['cms-writer', 'reader'],
  }
  readonly requests: Array<{ method: string; path: string; authorization: string | undefined }> = []
  private server?: Server

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.requests.push({
        method: req.method ?? '',
        path: req.url ?? '',
        authorization: req.headers.authorization,
      })
      res.writeHead(this.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(this.status === 200 ? this.body : { error: { code: 'X' } }))
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('no address')
    this.url = `http://127.0.0.1:${address.port}`
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
  }
}
