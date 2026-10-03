import type { NextConfig } from 'next'
import { STATIC_SECURITY_HEADERS } from './src/lib/security/headers'

/**
 * Tazzzo Admin (internal CMS). `standalone` output is the container artifact for the ratified AWS ECS/Fargate host.
 * Static security headers apply to every response here; the per-request nonce CSP is set by `src/proxy.ts`.
 * HSTS is deliberately NOT set by the app: it belongs to the TLS-terminating edge (ALB) in production, and setting it
 * on plain-http local development would be misleading.
 */
const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
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
