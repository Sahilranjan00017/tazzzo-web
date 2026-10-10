import type { Metadata } from 'next'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { LogoutButton } from '@/components/LogoutButton'
import { getProfile } from '@/server/backend/customer'
import { readSession } from '@/server/session/cookies'
import { accessTokenUsable } from '@/server/session/service'

export const metadata: Metadata = { title: 'Your account', robots: { index: false, follow: false } }

const REFRESH = '/api/auth/refresh?next=/account'

/**
 * The signed-in customer's account (`GET /v1/customer/profile`). A page cannot set cookies, so an expired or refused
 * access token is handed to `/api/auth/refresh`, which rotates the tokens and comes back here.
 */
export default async function AccountPage() {
  const session = await readSession()
  if (session === null) redirect('/login?next=/account')
  if (!accessTokenUsable(session)) redirect(REFRESH)
  const profile = await getProfile(session.accessToken)
  if (!profile.ok && profile.kind === 'unauthenticated') redirect(`${REFRESH}&rejected=1`)
  return (
    <section className="auth" aria-labelledby="account-title">
      <div className="auth-card">
        <h1 id="account-title">Your account</h1>
        {profile.ok ? (
          <dl className="account-details">
            <dt>Name</dt>
            <dd>{profile.data.displayName ?? 'Not set yet'}</dd>
            <dt>Email</dt>
            <dd>{profile.data.email ?? 'Not set yet'}</dd>
          </dl>
        ) : (
          <p role="alert">
            We could not load your details right now. <Link href="/account">Try again</Link>
          </p>
        )}
        <LogoutButton csrfToken={session.csrf} />
      </div>
    </section>
  )
}
