/** Sign-in screen (pure view). The Google button is a plain GET link to the server-side login start. */
const ERRORS: Record<string, string> = {
  signin_failed: 'Sign-in did not complete. Please try again.',
  expired: 'Your session has ended. Please sign in again.',
  unavailable: 'Sign-in is temporarily unavailable. Please try again shortly.',
}

export function LoginView({ startHref, error }: { startHref: string; error?: string }) {
  const message = error ? ERRORS[error] : undefined
  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="login-title">
        <h1 id="login-title">Tazzzo Admin</h1>
        <p className="muted">Internal content management. Authorized staff only.</p>
        {message ? (
          <p className="notice" role="alert">
            {message}
          </p>
        ) : null}
        <a className="button" href={startHref}>
          Sign in with Google
        </a>
      </section>
    </main>
  )
}
