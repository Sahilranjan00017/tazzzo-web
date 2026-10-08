import type { NextRequest } from 'next/server'
import { reorderHomeMutation } from '@/server/bff/home-content-actions'
import { runBffMutation } from '@/server/bff/mutation'

export async function POST(request: NextRequest) {
  return runBffMutation(reorderHomeMutation, request)
}
