import { canSee, NAV } from './nav'

/**
 * "Go to" resolution for the top-bar box. The backend has NO text search for products, orders, support cases or content,
 * so this is deliberately not a search: it recognises an exact identifier format and links to that record's page. It
 * makes no backend call (nothing is enumerated or revealed), and only offers modules the viewer's roles can use; the
 * destination page and the backend still authorize everything.
 */
export interface GotoTarget {
  href: string
  label: string
}
export type GotoResult = { ok: true; target: GotoTarget } | { ok: false; reason: string }

const RULES: {
  test: RegExp
  module: string
  build: (id: string) => GotoTarget
  upper?: boolean
}[] = [
  {
    test: /^TZP-[A-Z0-9][A-Z0-9-]{0,39}$/,
    module: 'products',
    upper: true,
    build: (id) => ({
      href: `/catalogue/products/${encodeURIComponent(id)}`,
      label: `Product ${id}`,
    }),
  },
  {
    test: /^ORD_[A-Za-z0-9_-]{6,64}$/,
    module: 'orders',
    build: (id) => ({ href: `/orders/${encodeURIComponent(id)}`, label: `Order ${id}` }),
  },
  {
    test: /^SUP_[A-Za-z0-9_-]{20,40}$/,
    module: 'support',
    build: (id) => ({ href: `/support/${encodeURIComponent(id)}`, label: `Support case ${id}` }),
  },
  {
    test: /^CB_[A-Za-z0-9_-]{16,40}$/,
    module: 'faqs',
    build: (id) => ({
      href: `/content/faqs/${encodeURIComponent(id)}`,
      label: `Content entry ${id}`,
    }),
  },
  {
    test: /^TZ[SCGV]-[0-9]{6}$/,
    module: 'taxonomy',
    upper: true,
    build: (id) => ({
      href: `/catalogue/taxonomy?parent=${encodeURIComponent(id)}`,
      label: `Taxonomy node ${id}`,
    }),
  },
  {
    test: /^[1-9][0-9]{5}$/,
    module: 'service-areas',
    build: (id) => ({ href: `/delivery/service-areas/${id}`, label: `Pincode ${id}` }),
  },
  {
    test: /^req_[0-9a-f]{20}$/,
    module: 'audit',
    build: (id) => ({
      href: `/system/audit?requestId=${encodeURIComponent(id)}`,
      label: `Audit events for ${id}`,
    }),
  },
]

export const GOTO_HELP =
  'Enter an exact id: product TZP-…, order ORD_…, support case SUP_…, content CB_…, taxonomy node TZS-/TZC-/TZB-/TZV-…, a 6-digit pincode, or an audit request id req_….'

export function resolveGoto(input: string, roles: readonly string[]): GotoResult {
  const text = input.trim()
  if (!text) return { ok: false, reason: 'Type an id to go to.' }
  const item = (id: string) => NAV.flatMap((s) => s.items).find((i) => i.id === id)
  for (const rule of RULES) {
    const candidate = rule.upper ? text.toUpperCase() : text
    if (!rule.test.test(candidate)) continue
    const mod = item(rule.module)
    if (!mod || mod.state !== 'available' || !canSee(mod, roles))
      return { ok: false, reason: `Your roles cannot open ${mod?.label ?? 'that module'}.` }
    return { ok: true, target: rule.build(candidate) }
  }
  return { ok: false, reason: `That is not a recognised id. ${GOTO_HELP}` }
}
