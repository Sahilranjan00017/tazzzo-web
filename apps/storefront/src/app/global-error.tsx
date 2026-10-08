'use client'

/** Last-resort boundary (root layout failure, e.g. invalid server configuration). Deliberately minimal and generic. */
export default function GlobalError() {
  return (
    <html lang="en">
      <body>
        <main>
          <h1>Tazzzo is temporarily unavailable</h1>
          <p>Please try again in a few minutes.</p>
        </main>
      </body>
    </html>
  )
}
