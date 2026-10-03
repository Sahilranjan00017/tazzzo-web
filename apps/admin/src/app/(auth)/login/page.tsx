import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Sign in · Tazzzo Admin' }

/**
 * Visual shell only. Google sign-in is implemented in W2 (authorization code + state + OIDC nonce + PKCE, server-side
 * session). Until then the button is disabled: there is no code path from here to an authenticated state.
 */
export default function LoginPage() {
  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="login-title">
        <h1 id="login-title">Tazzzo Admin</h1>
        <p className="muted">Internal content management. Authorized staff only.</p>
        <button type="button" className="button" disabled aria-describedby="signin-status">
          Sign in with Google
        </button>
        <p id="signin-status" className="notice" role="status">
          Google sign-in is not available yet. Authentication is set up in the next release.
        </p>
      </section>
    </main>
  )
}
