import { NextResponse, type NextRequest } from 'next/server'
import { IMPORT_KINDS, type ImportKind } from '@/lib/imports'
import { importMutations } from '@/server/bff/import-actions'
import { runBffMutation } from '@/server/bff/mutation'

/** POST only. The kind picks one of three fixed specs (fixed backend path each); it is never used to build a path. */
export async function POST(request: NextRequest, context: RouteContext<'/api/bff/imports/[kind]'>) {
  const { kind } = await context.params
  if (!(IMPORT_KINDS as readonly string[]).includes(kind)) {
    return NextResponse.json(
      { error: 'not_found' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    )
  }
  return runBffMutation(importMutations[kind as ImportKind], request)
}
