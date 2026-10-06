'use client'

import './globals.css'

/** Last-resort boundary (root layout failure, e.g. invalid server configuration). Deliberately minimal and generic. */
export default function GlobalError({
  retry,
}: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  return (
    <html lang="en">
      <body className="fatal">
        <h1>Tazzzo Admin is unavailable</h1>
        <p>Something went wrong starting the application. Try again shortly.</p>
        <button type="button" onClick={() => retry()}>
          Try again
        </button>
      </body>
    </html>
  )
}
