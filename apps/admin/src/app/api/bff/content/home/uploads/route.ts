import type { NextRequest } from 'next/server'
import { requestContentUploadMutation } from '@/server/bff/home-content-actions'
import { runBffMutation } from '@/server/bff/mutation'

export async function POST(request: NextRequest) {
  return runBffMutation(requestContentUploadMutation, request)
}
