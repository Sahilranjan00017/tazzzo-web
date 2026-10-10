import { NextResponse, type NextRequest } from 'next/server'
import { stockListPath, stockPageSchema, parseStockQuery } from '@/lib/stock-list'
import { runBffRead } from '@/server/bff/read'

/**
 * GET only: one page of the stock list (`listStock`) for "Load more". The query is parsed against the backend's closed
 * grammar (location, state, limit, cursor, each once); anything else is refused here and never forwarded.
 */
export function GET(request: NextRequest) {
  const query = parseStockQuery(request.nextUrl.searchParams)
  if (!query) {
    return NextResponse.json(
      { error: 'invalid_request' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    )
  }
  return runBffRead(
    {
      routeId: 'inventory.list',
      path: stockListPath(query),
      output: stockPageSchema,
      toClient: (page) => page,
    },
    request,
  )
}
