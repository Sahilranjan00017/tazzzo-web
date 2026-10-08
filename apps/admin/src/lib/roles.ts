import type { BackendRole } from './nav'

/** What each backend role grants, mirrored from the backend's admin roles doc. Display only: the backend decides. */
export const ROLE_DESCRIPTIONS: Record<BackendRole, { title: string; grants: string }> = {
  reader: {
    title: 'Reader',
    grants: 'Read the catalogue, pricing, stock, media, delivery and content surface.',
  },
  'cms-writer': {
    title: 'CMS writer',
    grants: 'Read and write the catalogue, pricing, stock, media, delivery and content surface.',
  },
  'audit-reader': { title: 'Audit reader', grants: 'Read the admin audit log. Nothing else.' },
  'order-ops': {
    title: 'Order operations',
    grants:
      'Read and operate orders (includes customer personal data). Read-only on support cases.',
  },
  'support-agent': {
    title: 'Support agent',
    grants: 'Read and work support cases. Read-only on orders (includes customer personal data).',
  },
}

export interface RoleView {
  role: string
  title: string
  grants: string
  known: boolean
}

export function describeRoles(roles: readonly string[]): RoleView[] {
  return roles.map((role) => {
    const known = ROLE_DESCRIPTIONS[role as BackendRole]
    return known
      ? { role, ...known, known: true }
      : {
          role,
          title: role,
          grants: 'Unrecognised role. The backend decides what it allows.',
          known: false,
        }
  })
}

export function canWrite(roles: readonly string[]): boolean {
  return roles.includes('cms-writer')
}

/** Staff order transitions are order-ops only on the backend; support-agent can read orders. UX gate, never security. */
export function canOperateOrders(roles: readonly string[]): boolean {
  return roles.includes('order-ops')
}

/** Support replies/status/assignment are support-agent only on the backend; order-ops can read cases. */
export function canWorkSupport(roles: readonly string[]): boolean {
  return roles.includes('support-agent')
}

/**
 * Backend access matrix (backend main c3306b6, `AdminAccessPolicy` / `ApiAuthFilter`), for DISPLAY only: the backend
 * authorizes every request. R = read, W = write, blank = refused. The five roles are the only ones that exist; the
 * product personas (Catalog Manager, Pricing Manager, ...) are NOT backend roles and are not modelled here.
 */
export const MATRIX_ROLES = [
  'reader',
  'cms-writer',
  'audit-reader',
  'order-ops',
  'support-agent',
] as const
export type Access = '' | 'R' | 'R W'

export interface MatrixRow {
  area: string
  access: Record<(typeof MATRIX_ROLES)[number], Access>
}

const row = (
  area: string,
  reader: Access,
  writer: Access,
  audit: Access,
  ops: Access,
  support: Access,
): MatrixRow => ({
  area,
  access: {
    reader,
    'cms-writer': writer,
    'audit-reader': audit,
    'order-ops': ops,
    'support-agent': support,
  },
})

export const ACCESS_MATRIX: readonly MatrixRow[] = [
  row('Dashboard summary', 'R', 'R', '', '', ''),
  row('Products, taxonomy, attributes', 'R', 'R W', '', '', ''),
  row('Pricing, stock, media', 'R', 'R W', '', '', ''),
  row('Bulk imports', '', 'R W', '', '', ''),
  row('Service areas, delivery slots', 'R', 'R W', '', '', ''),
  row('Home content, FAQs, app config', 'R', 'R W', '', '', ''),
  row('Orders', '', '', '', 'R W', 'R'),
  row('Support cases', '', '', '', 'R', 'R W'),
  row('Audit log', '', '', 'R', '', ''),
]

/** Backend authorization quirks worth knowing (documented in the contract matrix, not fixed here). */
export const ACCESS_NOTES: readonly string[] = [
  'The dashboard summary is refused for audit-reader, order-ops and support-agent.',
  'audit-reader combined with order-ops or support-agent (without reader or cms-writer) is refused at the audit log.',
  'Reader and cms-writer never reach orders or support, and order-ops cannot edit products.',
  'Combining order-ops and support-agent gives read and write on both orders and support.',
]
