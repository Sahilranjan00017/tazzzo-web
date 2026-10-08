import { NextResponse, type NextRequest } from 'next/server'
import { runBffMutation } from '@/server/bff/mutation'
import { NODE_ACTIONS, nodeActionMutation, type NodeAction } from '@/server/bff/taxonomy-actions'

/** POST only; the action is checked against the three-entry allowlist before a spec is chosen. */
export async function POST(
  request: NextRequest,
  context: RouteContext<'/api/bff/catalog/taxonomy/nodes/[nodeId]/[action]'>,
) {
  const { nodeId, action } = await context.params
  if (!(NODE_ACTIONS as readonly string[]).includes(action)) {
    return NextResponse.json(
      { error: 'not_found' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    )
  }
  return runBffMutation(nodeActionMutation(action as NodeAction), request, { nodeId })
}
