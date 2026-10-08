import Link from 'next/link'

export default function NotFound() {
  return (
    <section className="listing">
      <h1>Page not found</h1>
      <p>
        This page doesn&apos;t exist or is no longer available.{' '}
        <Link href="/">Go to the home page</Link>.
      </p>
    </section>
  )
}
