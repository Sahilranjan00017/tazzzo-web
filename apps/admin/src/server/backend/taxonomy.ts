import 'server-only'
import {
  NODE_ID,
  RELEASE_ID,
  nodeListPath,
  nodeListSchema,
  nodePathSchema,
  nodeSchema,
  releaseSchema,
  type NodeListQuery,
} from '@/lib/taxonomy'
import { readAsAdmin } from './session-read'

export const readNodes = (q: NodeListQuery) => readAsAdmin(nodeListPath(q), nodeListSchema)

function checked(id: string, pattern: RegExp): string {
  if (!pattern.test(id)) throw new Error('invalid identifier')
  return encodeURIComponent(id)
}
export const readNode = (id: string) =>
  readAsAdmin(`/api/v1/taxonomy/nodes/${checked(id, NODE_ID)}`, nodeSchema)
export const readNodePath = (id: string) =>
  readAsAdmin(`/api/v1/taxonomy/nodes/${checked(id, NODE_ID)}/path`, nodePathSchema)
export const readRelease = (id: string) =>
  readAsAdmin(`/api/v1/taxonomy/releases/${checked(id, RELEASE_ID)}`, releaseSchema)
