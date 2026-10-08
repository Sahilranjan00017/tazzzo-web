import { beforeAll, describe, expect, it } from 'vitest'
import {
  CHILD_TYPE,
  nodeListPath,
  nodeName,
  parseNodeListQuery,
  taxonomyErrorMessage,
} from '@/lib/taxonomy'

describe('taxonomy lib', () => {
  it('roots are super categories; a parent switches to parentId; bad ids are dropped', () => {
    expect(nodeListPath(parseNodeListQuery({}))).toBe(
      '/api/v1/taxonomy/nodes?nodeType=super_category&limit=100',
    )
    expect(nodeListPath(parseNodeListQuery({ parent: 'TZS-000001', cursor: 'TZC-000009' }))).toBe(
      '/api/v1/taxonomy/nodes?parentId=TZS-000001&cursor=TZC-000009&limit=100',
    )
    expect(parseNodeListQuery({ parent: 'a&b=c', cursor: '../x' })).toEqual({ limit: 100 })
  })
  it('children are exactly one level down and verticals are leaves', () => {
    expect(CHILD_TYPE.super_category).toBe('category')
    expect(CHILD_TYPE.sub_category).toBe('vertical')
    expect(CHILD_TYPE.vertical).toBeUndefined()
  })
  it('validates node names like the backend', () => {
    expect(nodeName.safeParse('  Rice  ').data).toBe('Rice')
    expect(nodeName.safeParse('   ').success).toBe(false)
    expect(nodeName.safeParse('a'.repeat(121)).success).toBe(false)
    expect(nodeName.safeParse('bad\u0007name').success).toBe(false)
  })
  it('explains NO_OPEN_RELEASE and RELEASE_ALREADY_OPEN specifically, others generically', () => {
    const f = (status: number, code?: string) => ({
      ok: false as const,
      status,
      error: 'conflict',
      code,
    })
    expect(taxonomyErrorMessage(f(409, 'NO_OPEN_RELEASE'))).toMatch(/Open a release first/)
    expect(taxonomyErrorMessage(f(409, 'RELEASE_ALREADY_OPEN'))).toMatch(/does not say which/)
    expect(taxonomyErrorMessage(f(409, 'DUPLICATE_NODE'))).toMatch(/sibling/)
    expect(taxonomyErrorMessage(f(403))).toMatch(/not permitted/)
  })
})

describe('taxonomy BFF specs', () => {
  let a: typeof import('@/server/bff/taxonomy-actions')
  beforeAll(async () => {
    a = await import('@/server/bff/taxonomy-actions')
  })
  it('enforces level/parent/schema rules on create', () => {
    const ok = { nodeType: 'category', name: 'Rice', parentId: 'TZS-000001' }
    expect(a.createNodeMutation.input.safeParse(ok).success).toBe(true)
    expect(a.createNodeMutation.input.safeParse({ ...ok, parentId: null }).success).toBe(false)
    expect(
      a.createNodeMutation.input.safeParse({
        nodeType: 'super_category',
        name: 'X',
        parentId: null,
      }).success,
    ).toBe(true)
    expect(
      a.createNodeMutation.input.safeParse({
        nodeType: 'vertical',
        name: 'V',
        parentId: 'TZG-000001',
      }).success,
    ).toBe(false)
    expect(a.createNodeMutation.input.safeParse({ ...ok, attributeSchemaId: 'S1' }).success).toBe(
      false,
    )
    expect(a.createNodeMutation.input.safeParse({ ...ok, extra: 1 }).success).toBe(false)
  })
  it('builds fixed backend calls with expectedVersion in the body', () => {
    const rename = a.nodeActionMutation('rename')
    expect(
      rename.backend(rename.input.parse({ nodeId: 'TZC-1', name: ' New ', expectedVersion: 2 })),
    ).toEqual({
      path: '/api/v1/taxonomy/nodes/TZC-1/rename',
      body: { name: 'New', expectedVersion: 2 },
    })
    const dep = a.nodeActionMutation('deprecate')
    expect(dep.backend({ nodeId: 'TZC-1', expectedVersion: 2 }).body).toEqual({
      expectedVersion: 2,
    })
    expect(dep.input.safeParse({ nodeId: 'TZC-1/../x', expectedVersion: 1 }).success).toBe(false)
  })
  it('release specs use fixed paths', () => {
    expect(a.publishReleaseMutation.backend({ releaseId: 'R-1' }).path).toBe(
      '/api/v1/taxonomy/releases/R-1/publish',
    )
    expect(a.openReleaseMutation.input.safeParse({ releaseId: 'R 1' }).success).toBe(false)
  })
})
