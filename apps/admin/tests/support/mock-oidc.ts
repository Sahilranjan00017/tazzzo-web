import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose'

/**
 * Deterministic local OpenID provider for integration tests (never Google). Real discovery, token and JWKS endpoints
 * so openid-client runs its normal flow: the token endpoint checks client authentication, redirect_uri and the PKCE
 * verifier; ID tokens are RS256-signed by a locally generated key. Tests "authorize" by calling `issueCode`.
 */
export interface CodeGrant {
  codeChallenge: string
  redirectUri: string
  claims: Record<string, unknown>
  signWithForeignKey?: boolean
}

export class MockOidcProvider {
  issuer = ''
  readonly clientId = 'cms-test-client.apps.example'
  readonly clientSecret = 'test-only-client-secret'
  private server?: Server
  private readonly codes = new Map<string, CodeGrant>()
  private key!: CryptoKey
  private foreignKey!: CryptoKey
  private jwk!: JWK
  tokenRequests = 0
  /** Identity used by the browser-facing /authorize endpoint (auto-consent; E2E only). */
  identity: Record<string, unknown> = { sub: '110000000000000000001', email: 'writer@tazzzo.test' }

  async start(): Promise<void> {
    const pair = await generateKeyPair('RS256', { extractable: true })
    this.key = pair.privateKey
    this.jwk = { ...(await exportJWK(pair.publicKey)), kid: 'mock-1', alg: 'RS256', use: 'sig' }
    this.foreignKey = (await generateKeyPair('RS256')).privateKey
    this.server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    const address = this.server.address()
    if (address === null || typeof address === 'string') throw new Error('no address')
    this.issuer = `http://127.0.0.1:${address.port}`
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
  }

  issueCode(grant: CodeGrant): string {
    const code = randomBytes(16).toString('base64url')
    this.codes.set(code, grant)
    return code
  }

  private async handle(req: IncomingMessage, res: import('node:http').ServerResponse) {
    const url = new URL(req.url ?? '/', this.issuer)
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
      })
    }
    if (url.pathname === '/jwks') return json(200, { keys: [this.jwk] })
    if (url.pathname === '/__control/identity' && req.method === 'POST') {
      this.identity = JSON.parse(await readBody(req)) as Record<string, unknown>
      return json(200, { ok: true })
    }
    if (url.pathname === '/authorize') {
      // Auto-consent for browser tests: bind a code to the request's PKCE challenge, redirect URI and nonce.
      const p = url.searchParams
      const code = this.issueCode({
        codeChallenge: p.get('code_challenge') ?? '',
        redirectUri: p.get('redirect_uri') ?? '',
        claims: {
          email_verified: true,
          hd: 'tazzzo.test',
          ...this.identity,
          nonce: p.get('nonce'),
        },
      })
      const back = new URL(p.get('redirect_uri') ?? 'about:blank')
      back.searchParams.set('code', code)
      back.searchParams.set('state', p.get('state') ?? '')
      res.writeHead(302, { location: back.toString() })
      return res.end()
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      this.tokenRequests += 1
      const body = new URLSearchParams(await readBody(req))
      const basic = req.headers.authorization?.startsWith('Basic ')
        ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString().split(':')
        : undefined
      const clientId =
        body.get('client_id') ?? (basic ? decodeURIComponent(basic[0] ?? '') : undefined)
      const secret =
        body.get('client_secret') ?? (basic ? decodeURIComponent(basic[1] ?? '') : undefined)
      if (clientId !== this.clientId || secret !== this.clientSecret)
        return json(401, { error: 'invalid_client' })
      const code = body.get('code') ?? ''
      const grant = this.codes.get(code)
      this.codes.delete(code)
      const verifier = body.get('code_verifier') ?? ''
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      if (
        !grant ||
        grant.redirectUri !== body.get('redirect_uri') ||
        grant.codeChallenge !== challenge
      ) {
        return json(400, { error: 'invalid_grant' })
      }
      const now = Math.floor(Date.now() / 1000)
      const idToken = await new SignJWT({
        iss: this.issuer,
        aud: this.clientId,
        azp: this.clientId,
        iat: now,
        exp: now + 3600,
        ...grant.claims,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'mock-1', typ: 'JWT' })
        .sign(grant.signWithForeignKey ? this.foreignKey : this.key)
      return json(200, {
        access_token: `at-${randomBytes(8).toString('hex')}`,
        token_type: 'Bearer',
        expires_in: 3600,
        id_token: idToken,
        scope: 'openid email',
      })
    }
    return json(404, { error: 'not_found' })
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
  })
}
