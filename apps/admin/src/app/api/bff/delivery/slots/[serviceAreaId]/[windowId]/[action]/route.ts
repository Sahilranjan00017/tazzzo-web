import { NextResponse, type NextRequest } from 'next/server'
import { TOGGLES, windowToggleMutation, type Toggle } from '@/server/bff/delivery-actions'
import { runBffMutation } from '@/server/bff/mutation'

export async function POST(
  request: NextRequest,
  context: RouteContext<'/api/bff/delivery/slots/[serviceAreaId]/[windowId]/[action]'>,
) {
  const { serviceAreaId, windowId, action } = await context.params
  if (!(TOGGLES as readonly string[]).includes(action)) {
    return NextResponse.json(
      { error: 'not_found' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    )
  }
  return runBffMutation(windowToggleMutation(action as Toggle), request, {
    serviceAreaId,
    windowId,
  })
}
