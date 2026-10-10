import type { NextRequest } from 'next/server'
import { createLegalMutation } from '@/server/bff/content-actions'
import { runBffMutation } from '@/server/bff/mutation'

export async function POST(request: NextRequest) {
  return runBffMutation(createLegalMutation, request)
}
