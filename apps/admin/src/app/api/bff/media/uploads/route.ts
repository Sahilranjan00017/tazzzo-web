import type { NextRequest } from 'next/server'
import { requestUploadMutation } from '@/server/bff/media-actions'
import { runBffMutation } from '@/server/bff/mutation'

export async function POST(request: NextRequest) {
  return runBffMutation(requestUploadMutation, request)
}
