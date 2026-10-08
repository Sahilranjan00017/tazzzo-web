import type { Metadata } from 'next'
import Link from 'next/link'
import { HomeBlockEditor } from '@/components/home/HomeBlockEditor'
import { BackendFailure } from '@/components/ui/BackendFailure'
import { PageHeader } from '@/components/ui/primitives'
import { BLOCK_ID } from '@/lib/content'
import { HOME_TYPES, TYPE_LABEL, type HomeType } from '@/lib/home-content'
import { canWrite } from '@/lib/roles'
import { readHomeBlock } from '@/server/backend/home-content'
import { requireAdmin } from '@/server/session/require-session'

export const metadata: Metadata = { title: 'New Home block · Tazzzo Admin' }
export const dynamic = 'force-dynamic'

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim()

/** New draft of one type, optionally duplicated from an existing block (`?from=<blockId>`). */
export default async function NewHomeBlockPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const access = await requireAdmin()
  const writer = access.view === 'ok' && canWrite(access.me.roles)
  const raw = await searchParams
  const from = one(raw.from)
  const source = from && BLOCK_ID.test(from) ? await readHomeBlock(from) : undefined
  const typeParam = one(raw.type)
  const type: HomeType | undefined =
    source?.kind === 'ok' && (HOME_TYPES as readonly string[]).includes(source.data.type)
      ? (source.data.type as HomeType)
      : (HOME_TYPES as readonly string[]).includes(typeParam ?? '')
        ? (typeParam as HomeType)
        : undefined
  const header = (
    <PageHeader
      title={
        type
          ? `${source ? 'Duplicate' : 'New'} ${TYPE_LABEL[type].toLowerCase()}`
          : 'New Home block'
      }
      description="Created as a draft; it is not public until you publish it."
    />
  )
  if (!writer)
    return (
      <>
        {header}
        <p className="notice" role="note">
          Creating content needs the cms-writer role. The backend enforces this independently.
        </p>
      </>
    )
  if (
    source?.kind === 'ok' &&
    (source.data.placement !== 'HOME' ||
      !(HOME_TYPES as readonly string[]).includes(source.data.type))
  )
    return (
      <>
        <PageHeader title="Cannot duplicate here" />
        <p className="notice" role="alert">
          {source.data.blockId} is a {source.data.type} on {source.data.placement}, not a Home
          block, so it cannot be duplicated as Home content.
        </p>
      </>
    )
  if (source && source.kind !== 'ok')
    return (
      <BackendFailure
        result={source}
        title="Duplicate"
        subject="Source block"
        forbiddenMessage="Your roles cannot read content."
      />
    )
  if (!type)
    return (
      <>
        {header}
        <ul className="stack">
          {HOME_TYPES.map((t) => (
            <li key={t}>
              <Link href={`/content/home/new?type=${t}`}>New {TYPE_LABEL[t].toLowerCase()}</Link>
            </li>
          ))}
        </ul>
      </>
    )
  return (
    <>
      {header}
      <HomeBlockEditor type={type} template={source?.kind === 'ok' ? source.data : undefined} />
    </>
  )
}
