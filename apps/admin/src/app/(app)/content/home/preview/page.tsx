import type { Metadata } from 'next'
import { HomePreviewView } from '@/components/home/HomePreviewView'
import { parsePreviewQuery } from '@/lib/home-content'
import { readHomeBlocks, readHomePreview } from '@/server/backend/home-content'
import { requireAdmin } from '@/server/session/require-session'

export const metadata: Metadata = { title: 'Home preview · Tazzzo Admin' }
export const dynamic = 'force-dynamic'

export default async function HomePreviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requireAdmin()
  const q = parsePreviewQuery(await searchParams)
  const [result, list] = await Promise.all([readHomePreview(q), readHomeBlocks()])
  return (
    <HomePreviewView
      q={q}
      result={result}
      blocks={list.kind === 'ok' ? list.data.items : undefined}
    />
  )
}
