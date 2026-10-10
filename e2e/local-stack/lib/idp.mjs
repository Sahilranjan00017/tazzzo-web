#!/usr/bin/env node
// LOCAL JWKS stand-in for the backend's human-admin OIDC trust. The backend verifies per-person admin ID tokens against a JWKS
// (tazzzo.admin.oidc.jwks-uri; documented override, http only for a loopback host) and requires iss=https://accounts.google.com,
// audience, hd and an allowlisted `sub`. Locally there is no Google, so this serves the public half of a throwaway RSA key
// (run/certs/idp.key, git-ignored) and tests mint RS256 tokens with the private half (tests/support.ts adminToken()).
// This is configuration of the trust root, not a code bypass: the backend still runs its full verification and allowlist/role check.
import http from 'node:http'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { generateKeyPairSync, createPublicKey, createHash } from 'node:crypto'
import { join } from 'node:path'

const port = Number(new URL(process.env.E2E_IDP_URL).port)
const keyFile = join(process.env.E2E_CERT_DIR, 'idp.key')
if (!existsSync(keyFile)) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
}
const pub = createPublicKey(readFileSync(keyFile))
const jwk = pub.export({ format: 'jwk' })
jwk.kid = createHash('sha256').update(JSON.stringify(jwk)).digest('hex').slice(0, 16)
jwk.use = 'sig'
jwk.alg = 'RS256'
writeFileSync(join(process.env.E2E_CERT_DIR, 'idp.kid'), jwk.kid)

http
  .createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/jwks') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ keys: [jwk] }))
    } else res.writeHead(404).end()
  })
  .listen(port, '127.0.0.1', () => process.stdout.write(`jwks stand-in on 127.0.0.1:${port}\n`))
