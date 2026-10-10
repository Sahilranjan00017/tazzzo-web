import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { LoginForm } from '@/components/LoginForm'
import { REASON_NOTICE } from '@/lib/auth/messages'
import { safeNext } from '@/lib/auth/validation'
import { readChallenge, readSession } from '@/server/session/cookies'

export const metadata: Metadata = { title: 'Sign in', robots: { index: false, follow: false } }

function first(value: string | string[] | undefined): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * Sign in with a mobile number and a texted code (`/api/auth/otp/*`). `next` is the page to return to: a same-origin
 * path only (`safeNext`), so this page can never send a customer to another site. A customer who is already signed
 * in is sent straight on.
 */
export default async function LoginPage({ searchParams }: PageProps<'/login'>) {
  const params = await searchParams
  const next = safeNext(first(params.next))
  if ((await readSession()) !== null) redirect(next)
  const challenge = await readChallenge()
  const reason = first(params.reason)
  return (
    <section className="auth" aria-label="Sign in">
      <LoginForm
        next={next}
        pending={challenge ? { maskedPhone: challenge.maskedPhone } : null}
        notice={reason ? (REASON_NOTICE[reason] ?? null) : null}
      />
    </section>
  )
}
