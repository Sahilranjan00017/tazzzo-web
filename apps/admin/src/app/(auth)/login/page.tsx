import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { LoginView } from '@/components/LoginView'
import { safeReturnTo } from '@/server/auth/return-to'
import { hasValidSession } from '@/server/session/require-session'

export const metadata: Metadata = { title: 'Sign in · Tazzzo Admin' }

export default async function LoginPage({ searchParams }: PageProps<'/login'>) {
  const params = await searchParams
  const returnTo = safeReturnTo(typeof params.returnTo === 'string' ? params.returnTo : undefined)
  if (await hasValidSession()) redirect(returnTo)
  const startHref =
    returnTo === '/'
      ? '/api/auth/google/start'
      : `/api/auth/google/start?returnTo=${encodeURIComponent(returnTo)}`
  return (
    <LoginView
      startHref={startHref}
      error={typeof params.error === 'string' ? params.error : undefined}
    />
  )
}
