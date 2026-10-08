import type { NextRequest } from 'next/server'
import { runBffMutation } from '@/server/bff/mutation'
import { createProductMutation } from '@/server/bff/product-actions'

/** POST only: create a single-SKU draft product. */
export async function POST(request: NextRequest) {
  return runBffMutation(createProductMutation, request)
}
