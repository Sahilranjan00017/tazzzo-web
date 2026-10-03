import { randomBytes } from 'node:crypto'
import { GenericContainer, type StartedTestContainer } from 'testcontainers'
import { FakeBackend } from './fake-backend'
import { MockOidcProvider } from './mock-oidc'

/** Pinned by the multi-arch OCI index digest (linux/amd64 + linux/arm64 included), verified from Docker Hub. */
export const VALKEY_IMAGE =
  'valkey/valkey:9.1.2-alpine@sha256:48332870af354a799964c0012ae1194a0bf2bf894eb508f945810596dc2d8d11'
export const CMS_BASE_URL = 'https://cms.test'
export const SESSION_COOKIE = '__Host-tz_cms_session'
export const TX_COOKIE = '__Host-tz_cms_tx'

export interface Harness {
  valkey?: StartedTestContainer
  redisUrl: string
  provider: MockOidcProvider
  backend: FakeBackend
}

/**
 * Starts the test-only world (no Google, no production services) and configures the server environment BEFORE any
 * app module is imported, so the app's cached env/config/store are built against it.
 */
export async function startHarness(
  options: { redisUrl?: string; verifyTokens?: boolean } = {},
): Promise<Harness> {
  const provider = new MockOidcProvider()
  await provider.start()
  // Verifying fake backend: a forwarded bearer must be a genuine ID token from the mock provider.
  const backend = options.verifyTokens
    ? new FakeBackend({ issuer: provider.issuer, audience: provider.clientId })
    : new FakeBackend()
  await backend.start()
  backend.reset()
  let valkey: StartedTestContainer | undefined
  let redisUrl = options.redisUrl
  if (!redisUrl) {
    valkey = await new GenericContainer(VALKEY_IMAGE).withExposedPorts(6379).start()
    redisUrl = `redis://${valkey.getHost()}:${valkey.getMappedPort(6379)}`
  }
  Object.assign(process.env, {
    CMS_BASE_URL,
    GOOGLE_CLIENT_ID: provider.clientId,
    GOOGLE_CLIENT_SECRET: provider.clientSecret,
    GOOGLE_HOSTED_DOMAIN: 'tazzzo.test',
    GOOGLE_ISSUER: provider.issuer,
    TAZZZO_BACKEND_URL: backend.url,
    SESSION_STORE_URL: redisUrl,
    SESSION_ENCRYPTION_KEY: randomBytes(32).toString('base64url'),
  })
  return { valkey, redisUrl, provider, backend }
}

/** Convenience for tests: the fake backend's product table. */
export type { FakeBackend }

export async function stopHarness(h: Harness | undefined): Promise<void> {
  if (!h) return
  await Promise.all([h.provider.stop(), h.backend.stop()])
  await h.valkey?.stop()
}
