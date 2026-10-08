/**
 * The media (CDN) base every image URL must live under: the same value the backend joins asset keys with
 * (`MediaUrlResolver`: absolute https, a host, optional port and path prefix, no userinfo/query/fragment).
 *
 * Plain http is accepted ONLY for a loopback host outside production, so local runs and tests can serve images
 * without TLS; production is https only. Pure and secret-free: used by the server env and by `proxy.ts` (CSP).
 */
export interface MediaBase {
  /** Normalised base without a trailing slash, e.g. `https://media.example.com/assets`. */
  base: string
  /** Origin for the CSP `img-src` source list. */
  origin: string
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

/** True for a URL hostname that can only mean this machine. */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK.has(hostname)
}

export function parseMediaBase(
  value: string | undefined,
  nodeEnv: string | undefined,
): MediaBase | null {
  if (value === undefined || value.trim() === '') return null
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  const loopbackHttp =
    url.protocol === 'http:' && LOOPBACK.has(url.hostname) && nodeEnv !== 'production'
  if (url.protocol !== 'https:' && !loopbackHttp) return null
  if (url.username || url.password || url.search || url.hash) return null
  const path = url.pathname.replace(/\/+$/, '')
  if (path.includes('..') || path.includes('//') || path.includes('%')) return null
  return { base: `${url.origin}${path}`, origin: url.origin }
}
