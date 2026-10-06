'use client'

import { useRouter } from 'next/navigation'
import { useState, type FormEvent } from 'react'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { useBffAction } from '@/components/useBffAction'
import {
  CHILD_TYPE,
  NODE_TYPE_LABEL,
  nodeName,
  taxonomyErrorMessage,
  type TaxonomyNode,
} from '@/lib/taxonomy'

/**
 * Writer actions for the node being viewed: add a child one level down, rename, deprecate or revive. Each call needs
 * an open release (the backend answers 409 NO_OPEN_RELEASE otherwise and the message says what to do). The backend
 * enforces cms-writer; these controls are only hidden for readers.
 */
export function NodeActions({ node }: { node: TaxonomyNode }) {
  const router = useRouter()
  const { run, busy } = useBffAction(taxonomyErrorMessage)
  const [name, setName] = useState(node.name)
  const [childName, setChildName] = useState('')
  const [schemaId, setSchemaId] = useState('')
  const [error, setError] = useState<string>()
  const [confirm, setConfirm] = useState<'deprecate' | 'revive'>()
  const childType = CHILD_TYPE[node.nodeType]
  const childLabel = childType ? (NODE_TYPE_LABEL[childType] ?? childType) : ''
  const base = `/api/bff/catalog/taxonomy/nodes/${encodeURIComponent(node.id)}`

  async function rename(e: FormEvent) {
    e.preventDefault()
    const parsed = nodeName.safeParse(name)
    if (!parsed.success) return setError('Enter a name of 1 to 120 characters.')
    setError(undefined)
    await run(
      `${base}/rename`,
      'POST',
      { name: parsed.data, expectedVersion: node.version },
      'Renamed.',
    )
  }

  async function addChild(e: FormEvent) {
    e.preventDefault()
    if (!childType) return
    const parsed = nodeName.safeParse(childName)
    if (!parsed.success) return setError('Enter a child name of 1 to 120 characters.')
    if (childType === 'vertical' && !schemaId.trim())
      return setError('A vertical needs an attribute schema id.')
    setError(undefined)
    const result = await run<{ id: string }>(
      '/api/bff/catalog/taxonomy/nodes',
      'POST',
      {
        nodeType: childType,
        name: parsed.data,
        parentId: node.id,
        ...(childType === 'vertical' ? { attributeSchemaId: schemaId.trim() } : {}),
      },
      `${childLabel} created.`,
    )
    if (result.ok) {
      setChildName('')
      router.refresh()
    }
  }

  return (
    <section className="panel" aria-labelledby="node-actions-h">
      <h2 id="node-actions-h">Change “{node.name}”</h2>
      <p className="muted">
        Changes need an open taxonomy release and are visible to customers only after it is
        published.
      </p>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="detail-grid">
        <form className="stack" onSubmit={rename} aria-label="Rename node">
          <label>
            Name
            <input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
          </label>
          <button type="submit" className="btn" disabled={busy || name.trim() === node.name}>
            Rename
          </button>
        </form>
        {childType ? (
          <form className="stack" onSubmit={addChild} aria-label="Add child node">
            <label>
              New {childLabel.toLowerCase()} name
              <input
                value={childName}
                maxLength={120}
                onChange={(e) => setChildName(e.target.value)}
              />
            </label>
            {childType === 'vertical' ? (
              <label>
                Attribute schema id
                <input value={schemaId} onChange={(e) => setSchemaId(e.target.value)} />
              </label>
            ) : null}
            <button type="submit" className="btn btn-primary" disabled={busy || !childName.trim()}>
              Add {childLabel.toLowerCase()}
            </button>
          </form>
        ) : (
          <p className="muted">A vertical is a leaf; it cannot have children.</p>
        )}
      </div>
      <div className="row">
        {node.status === 'active' ? (
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy}
            onClick={() => setConfirm('deprecate')}
          >
            Deprecate
          </button>
        ) : null}
        {node.status === 'deprecated' ? (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => setConfirm('revive')}
          >
            Revive
          </button>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirm !== undefined}
        title={confirm === 'deprecate' ? `Deprecate “${node.name}”?` : `Revive “${node.name}”?`}
        description={
          confirm === 'deprecate'
            ? 'It is hidden from consumers once the release is published. The backend refuses if it still has active children.'
            : 'Only a deprecated node can be revived; its parent must be active.'
        }
        confirmLabel={confirm === 'deprecate' ? 'Deprecate' : 'Revive'}
        destructive={confirm === 'deprecate'}
        busy={busy}
        onCancel={() => setConfirm(undefined)}
        onConfirm={() => {
          const action = confirm
          if (!action) return
          void run(
            `${base}/${action}`,
            'POST',
            { expectedVersion: node.version },
            action === 'deprecate' ? 'Deprecated.' : 'Revived.',
          ).then(() => setConfirm(undefined))
        }}
      />
    </section>
  )
}
