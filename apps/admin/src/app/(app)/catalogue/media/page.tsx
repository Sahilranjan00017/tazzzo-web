import type { Metadata } from 'next'
import { MediaView } from '@/components/media/MediaView'
import { OWNER_TYPES, type OwnerType } from '@/lib/media'
import { PRODUCT_ID } from '@/lib/products'
import { canWrite } from '@/lib/roles'
import { readMediaSet } from '@/server/backend/media'
import { requireAdmin } from '@/server/session/require-session'

export const metadata: Metadata = { title: 'Media · Tazzzo Admin' }
export const dynamic = 'force-dynamic'

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim()

export default async function MediaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const access = await requireAdmin()
  const roles = access.view === 'ok' ? access.me.roles : []
  const raw = await searchParams
  const id = one(raw.id)?.toUpperCase()
  const type = (one(raw.type) ?? 'product') as OwnerType
  if (!id) return <MediaView canWrite={canWrite(roles)} />
  if (!PRODUCT_ID.test(id) || !OWNER_TYPES.includes(type))
    return <MediaView canWrite={canWrite(roles)} invalidInput />
  return (
    <MediaView
      owner={{ type, id }}
      result={await readMediaSet(type, id)}
      canWrite={canWrite(roles)}
    />
  )
}
