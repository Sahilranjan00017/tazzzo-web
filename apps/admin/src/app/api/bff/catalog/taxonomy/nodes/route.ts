import type { NextRequest } from 'next/server'
import { runBffMutation } from '@/server/bff/mutation'
import { createNodeMutation } from '@/server/bff/taxonomy-actions'

export async function POST(request: NextRequest) {
  return runBffMutation(createNodeMutation, request)
}
