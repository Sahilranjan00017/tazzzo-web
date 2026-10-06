import Link from 'next/link'
import type { Crumb } from '@/lib/nav'

export function Breadcrumbs({ crumbs }: { crumbs: readonly Crumb[] }) {
  if (crumbs.length <= 1) return null
  return (
    <nav aria-label="Breadcrumb" className="crumbs">
      <ol>
        {crumbs.map((crumb, index) => (
          <li key={`${index}-${crumb.label}`} aria-current={crumb.href ? undefined : 'page'}>
            {crumb.href ? <Link href={crumb.href}>{crumb.label}</Link> : <span>{crumb.label}</span>}
          </li>
        ))}
      </ol>
    </nav>
  )
}
