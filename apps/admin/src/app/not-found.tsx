import Link from 'next/link'

export default function NotFound() {
  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="nf-title">
        <h1 id="nf-title">Page not found</h1>
        <p>
          <Link href="/">Back to Tazzzo Admin</Link>
        </p>
      </section>
    </main>
  )
}
