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
