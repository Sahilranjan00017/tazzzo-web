import type { NextRequest } from 'next/server'
import { runBffMutation } from '@/server/bff/mutation'
import { openReleaseMutation } from '@/server/bff/taxonomy-actions'

export async function POST(request: NextRequest) {
  return runBffMutation(openReleaseMutation, request)
}
