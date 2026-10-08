/**
 * CMS navigation model (pure, client-safe). Role gating here is UX ONLY: it hides entries a person's backend roles
 * cannot use. The backend authorizes every request regardless of what the sidebar shows.
 *
 * Roles are the backend allowlist roles (`GET /api/v1/admin/me` -> `roles`), not product job titles.
 */
export type BackendRole = 'reader' | 'cms-writer' | 'audit-reader' | 'order-ops' | 'support-agent'

/** The general INTERNAL surface (catalogue, pricing, stock, media, serviceability, slots, content...). */
const GENERAL: readonly BackendRole[] = ['reader', 'cms-writer']

export interface NavItem {
  id: string
  label: string
  href: string
  /** Any-of. Empty/omitted = every signed-in admin. */
  roles?: readonly BackendRole[]
  /** `planned` entries are listed but disabled: the module is not built yet (never a fake screen). */
  state: 'available' | 'planned'
}

export interface NavSection {
  id: string
  label: string
  items: readonly NavItem[]
}

export const NAV: readonly NavSection[] = [
  {
    id: 'overview',
    label: 'Overview',
    items: [
      { id: 'home', label: 'Home', href: '/', state: 'available' },
      {
        id: 'dashboard',
        label: 'Dashboard',
        href: '/dashboard',
        roles: GENERAL,
        state: 'available',
      },
    ],
  },
  {
    id: 'catalogue',
    label: 'Catalogue',
    items: [
      {
        id: 'products',
        label: 'Products',
        href: '/catalogue/products',
        roles: GENERAL,
        state: 'available',
      },
      {
        id: 'taxonomy',
        label: 'Taxonomy',
        href: '/catalogue/taxonomy',
        roles: GENERAL,
        state: 'available',
      },
      {
        id: 'imports',
        label: 'Imports',
        href: '/catalogue/imports',
        roles: GENERAL,
        state: 'planned',
      },
      { id: 'media', label: 'Media', href: '/catalogue/media', roles: GENERAL, state: 'planned' },
    ],
  },
  {
    id: 'commerce',
    label: 'Commerce',
    items: [
      { id: 'pricing', label: 'Pricing', href: '/pricing', roles: GENERAL, state: 'planned' },
      { id: 'inventory', label: 'Inventory', href: '/inventory', roles: GENERAL, state: 'planned' },
    ],
  },
  {
    id: 'operations',
    label: 'Operations',
    items: [
      {
        id: 'orders',
        label: 'Orders',
        href: '/orders',
        roles: ['order-ops', 'support-agent'],
        state: 'planned',
      },
      {
        id: 'service-areas',
        label: 'Service areas',
        href: '/delivery/service-areas',
        roles: GENERAL,
        state: 'planned',
      },
      {
        id: 'slots',
        label: 'Delivery slots',
        href: '/delivery/slots',
        roles: GENERAL,
        state: 'planned',
      },
      {
        id: 'support',
        label: 'Support',
        href: '/support',
        roles: ['support-agent', 'order-ops'],
        state: 'planned',
      },
    ],
  },
  {
    id: 'content',
    label: 'Content',
    items: [
      {
        id: 'home-content',
        label: 'Home content',
        href: '/content/home',
        roles: GENERAL,
        state: 'planned',
      },
      { id: 'faqs', label: 'FAQs', href: '/content/faqs', roles: GENERAL, state: 'planned' },
      {
        id: 'app-config',
        label: 'App config',
        href: '/content/app-config',
        roles: GENERAL,
        state: 'planned',
      },
    ],
  },
  {
    id: 'system',
    label: 'System',
    items: [
      {
        id: 'audit',
        label: 'Audit log',
        href: '/system/audit',
        roles: ['audit-reader'],
        state: 'planned',
      },
      { id: 'account', label: 'Profile & access', href: '/account', state: 'available' },
    ],
  },
]

/** Href of a module only once it is built; metrics link here so they never point at a page that does not exist. */
export function moduleHref(id: string): string | undefined {
  const item = NAV.flatMap((s) => s.items).find((i) => i.id === id)
  return item?.state === 'available' ? item.href : undefined
}

export function canSee(item: NavItem, roles: readonly string[]): boolean {
  return !item.roles || item.roles.length === 0 || item.roles.some((r) => roles.includes(r))
}

/** Sections filtered to what these roles can use; empty sections are dropped. */
export function navFor(roles: readonly string[]): NavSection[] {
  return NAV.map((section) => ({
    ...section,
    items: section.items.filter((item) => canSee(item, roles)),
  })).filter((section) => section.items.length > 0)
}

export function isActive(href: string, pathname: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`)
}

export interface Crumb {
  label: string
  href?: string
}

const SEGMENT_LABELS: Record<string, string> = {
  account: 'Profile & access',
  catalogue: 'Catalogue',
  delivery: 'Delivery',
  content: 'Content',
  system: 'System',
}

/** Breadcrumbs from the path: registered nav labels first, then humanized segments. Ids are shown verbatim. */
export function breadcrumbsFor(pathname: string): Crumb[] {
  const flat = NAV.flatMap((s) => s.items)
  const segments = pathname.split('/').filter(Boolean)
  const crumbs: Crumb[] = [{ label: 'Home', href: '/' }]
  let acc = ''
  segments.forEach((segment, index) => {
    acc += `/${segment}`
    const label =
      flat.find((i) => i.href === acc)?.label ?? SEGMENT_LABELS[segment] ?? decodeSegment(segment)
    crumbs.push(index === segments.length - 1 ? { label } : { label, href: acc })
  })
  return crumbs
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}
