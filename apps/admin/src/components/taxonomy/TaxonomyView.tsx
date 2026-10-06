import Link from 'next/link'
import { RefreshButton } from '@/components/RefreshButton'
import { BackendFailure } from '@/components/ui/BackendFailure'
import { EmptyState, PageHeader, StatusBadge } from '@/components/ui/primitives'
import type { BackendReadResult } from '@/lib/backend-result'
import { NODE_TYPE_LABEL, STATUS_TONE, type NodeListQuery, type TaxonomyNode } from '@/lib/taxonomy'
import { NodeActions } from './NodeActions'

type Ok<T> = Exclude<BackendReadResult<T>, { kind: 'unauthenticated' }>
export interface TaxonomyData {
  list: Ok<{ items: TaxonomyNode[]; nextCursor?: string | null }>
  node?: Ok<TaxonomyNode>
  path?: Ok<{ path?: string | null; nodes: { id: string; name: string }[] }>
}

const href = (parent?: string, cursor?: string) => {
  const p = new URLSearchParams()
  if (parent) p.set('parent', parent)
  if (cursor) p.set('cursor', cursor)
  const q = p.toString()
  return `/catalogue/taxonomy${q ? `?${q}` : ''}`
}

/**
 * Hierarchy browser: Super category > Category > Subcategory > Vertical. Server-rendered and bookmarkable
 * (`?parent=<id>`); the backend's cursor is the only paging. Writer controls appear for the viewed node.
 */
export function TaxonomyView({
  data,
  query,
  canWrite,
}: {
  data: TaxonomyData
  query: NodeListQuery
  canWrite: boolean
}) {
  const header = (
    <PageHeader
      title="Taxonomy"
      description="Super category → Category → Subcategory → Vertical. Changes need an open release."
      actions={
        <Link href="/catalogue/taxonomy/releases" className="btn">
          Releases
        </Link>
      }
    />
  )
  if (data.list.kind !== 'ok') {
    return (
      <>
        {header}
        <BackendFailure
          result={data.list}
          title="Taxonomy"
          subject="Taxonomy"
          forbiddenMessage="Your roles cannot read the taxonomy. The backend allows it for reader and cms-writer."
          refresh={<RefreshButton />}
        />
      </>
    )
  }
  const { items, nextCursor } = data.list.data
  const node = data.node?.kind === 'ok' ? data.node.data : undefined
  const trail = data.path?.kind === 'ok' ? data.path.data.nodes : []
  return (
    <>
      {header}
      <nav aria-label="Taxonomy path" className="trail">
        <Link href="/catalogue/taxonomy">All super categories</Link>
        {trail.map((n) => (
          <span key={n.id}>
            {' › '}
            {n.id === query.parentId ? (
              <strong>{n.name}</strong>
            ) : (
              <Link href={href(n.id)}>{n.name}</Link>
            )}
          </span>
        ))}
        {query.parentId && trail.length === 0 ? <span> › {query.parentId}</span> : null}
      </nav>
      {query.parentId && data.node && data.node.kind !== 'ok' ? (
        <p className="notice" role="alert">
          {data.node.kind === 'not_found'
            ? 'That node does not exist.'
            : 'The node could not be loaded.'}
        </p>
      ) : null}
      {node ? (
        <section className="panel" aria-labelledby="node-h">
          <h2 id="node-h">{node.name}</h2>
          <dl className="kv">
            <dt>Level</dt>
            <dd>{NODE_TYPE_LABEL[node.nodeType] ?? node.nodeType}</dd>
            <dt>Status</dt>
            <dd>
              <StatusBadge tone={STATUS_TONE[node.status] ?? 'neutral'}>{node.status}</StatusBadge>
            </dd>
            <dt>Id</dt>
            <dd>
              <code>{node.id}</code>
            </dd>
            <dt>Attribute schema</dt>
            <dd>{node.attributeSchemaId ?? '—'}</dd>
            <dt>Version</dt>
            <dd>{node.version}</dd>
          </dl>
          {node.nodeType === 'vertical' ? (
            <p>
              <Link href={`/catalogue/products?verticalId=${encodeURIComponent(node.id)}`}>
                View products in this vertical
              </Link>
            </p>
          ) : null}
        </section>
      ) : null}
      {node && canWrite ? <NodeActions key={`${node.id}:${node.version}`} node={node} /> : null}
      {node && !canWrite ? (
        <p className="notice" role="note">
          Read-only: changing the taxonomy needs the cms-writer role.
        </p>
      ) : null}

      <h2 className="section-title">{query.parentId ? 'Children' : 'Super categories'}</h2>
      {items.length === 0 ? (
        <EmptyState
          title={query.parentId ? 'No children' : 'No super categories'}
          message={
            query.parentId
              ? 'This node has no children (or is a vertical).'
              : 'The backend reports an empty taxonomy.'
          }
        />
      ) : (
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Taxonomy nodes">
          <table className="data-table">
            <caption className="sr-only">{items.length} nodes</caption>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Level</th>
                <th scope="col">Status</th>
                <th scope="col">Id</th>
                <th scope="col" className="num">
                  Version
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((n) => (
                <tr key={n.id}>
                  <th scope="row">
                    <Link href={href(n.id)}>{n.name}</Link>
                  </th>
                  <td>{NODE_TYPE_LABEL[n.nodeType] ?? n.nodeType}</td>
                  <td>
                    <StatusBadge tone={STATUS_TONE[n.status] ?? 'neutral'}>{n.status}</StatusBadge>
                  </td>
                  <td>
                    <code>{n.id}</code>
                  </td>
                  <td className="num">{n.version}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <nav className="pager" aria-label="Pagination">
        {query.cursor ? (
          <Link href={href(query.parentId)} className="btn">
            First page
          </Link>
        ) : null}
        {nextCursor ? (
          <Link href={href(query.parentId, nextCursor)} className="btn" rel="next">
            Next page
          </Link>
        ) : null}
      </nav>
    </>
  )
}
