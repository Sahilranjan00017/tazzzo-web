import Link from 'next/link'

/** Placeholder home. Shows no admin data and claims no identity. */
export default function HomePage() {
  return (
    <section aria-labelledby="home-title">
      <h1 id="home-title">CMS foundation</h1>
      <p className="notice" role="status">
        Authentication integration pending. No session exists, no one is signed in and no admin data
        or actions are available yet.
      </p>
      <p>
        <Link href="/login">Go to sign-in</Link>
      </p>
    </section>
  )
}
