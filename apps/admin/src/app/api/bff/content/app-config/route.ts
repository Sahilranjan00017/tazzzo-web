import type { NextRequest } from 'next/server'
import { putAppConfigMutation } from '@/server/bff/content-actions'
import { runBffMutation } from '@/server/bff/mutation'

export async function PUT(request: NextRequest) {
  return runBffMutation(putAppConfigMutation, request)
}
