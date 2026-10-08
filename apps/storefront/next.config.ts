import type { NextConfig } from 'next'
import { STATIC_SECURITY_HEADERS } from './src/lib/security/headers'

/**
 * Tazzzo storefront (customer website). `standalone` output is the container artifact, like apps/admin. Static
 * security headers apply to every response; the per-request nonce CSP is set by `src/proxy.ts`. Images are plain
 * `<img>`/`<picture>` straight from the media CDN (no Next image optimizer, so no remote-fetching endpoint exists).
 * HSTS belongs to the TLS-terminating edge, not the app.
 */
const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  images: { unoptimized: true },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: Object.entries(STATIC_SECURITY_HEADERS).map(([key, value]) => ({ key, value })),
      },
    ]
  },
}

export default nextConfig
