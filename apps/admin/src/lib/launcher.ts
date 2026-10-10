import type { Tone } from '@/components/ui/primitives'
import type { DashboardSummary } from './dashboard'
import { canSee, NAV, type BackendRole, type NavSection } from './nav'

/** One line on what each module is for, so Home can launch people to the right place. Keyed by nav item id. */
export const MODULE_BLURB: Record<string, string> = {
  dashboard: 'Live counts: orders, stock, service areas, support and notifications.',
  products: 'Find a product, edit its title and lifecycle, and jump to its price, stock and media.',
  taxonomy: 'Browse the category tree and its classification releases.',
  imports: 'Upload products, prices or stock as a spreadsheet (cms-writer).',
  'import-jobs': 'Follow background import jobs and fix rejected rows.',
  media: 'Product and SKU images.',
  pricing: 'View and set the price of one SKU.',
  inventory: 'Stock by SKU and location, with low-stock and out-of-stock filters.',
  orders: 'Open orders and their status changes.',
  'service-areas': 'Pincodes the store delivers to.',
  slots: 'Delivery windows and their capacity.',
  support: 'Customer support cases.',
  'home-content': 'Banners, product rails and category grids on the customer Home.',
  faqs: 'Help-centre questions.',
  legal: 'Terms and Privacy shown on the website and in the app.',
  'app-config': 'Store open/closed, maintenance, app versions and support contact.',
  audit: 'Who changed what, and when.',
  notifications: 'Notification delivery status.',
  status: 'Service health.',
  account: 'Your roles and what they allow.',
}

export interface LauncherCard {
  id: string
  label: string
  href: string
  blurb: string
}
export interface LauncherSection {
  id: string
  label: string
  cards: LauncherCard[]
}

/** The built modules these roles can use, grouped as in the sidebar (Home itself excluded). Never links to a refusal. */
export function launcherFor(
  roles: readonly string[],
  nav: readonly NavSection[] = NAV,
): LauncherSection[] {
  return nav
    .map((section) => ({
      id: section.id,
      label: section.label,
      cards: section.items
        .filter((i) => i.id !== 'home' && i.state === 'available' && canSee(i, roles))
        .map((i) => ({ id: i.id, label: i.label, href: i.href, blurb: MODULE_BLURB[i.id] ?? '' })),
    }))
    .filter((s) => s.cards.length > 0)
}

/** The dashboard summary endpoint is served to these backend roles only (the backend refuses the rest). */
const DASHBOARD_ROLES: readonly BackendRole[] = ['reader', 'cms-writer']
export const canReadDashboard = (roles: readonly string[]) =>
  roles.some((r) => (DASHBOARD_ROLES as readonly string[]).includes(r))

export interface AttentionItem {
  id: string
  label: string
  value: number
  capped: boolean
  tone: Tone
  /** Absent when the viewer's roles cannot open the module that handles it. */
  href?: string
}

/**
 * What needs attention, from the existing dashboard summary and nothing else: out-of-stock and low-stock products, failed
 * notifications, and open support cases. Only non-zero figures are returned; a capped figure stays a lower bound.
 */
export function attentionItems(
  d: DashboardSummary,
  hrefFor: (moduleId: string) => string | undefined,
): AttentionItem[] {
  const items: AttentionItem[] = [
    {
      id: 'out-of-stock',
      label: 'Out-of-stock',
      ...d.inventory.out_of_stock,
      tone: 'danger',
      href: hrefFor('inventory'),
    },
    {
      id: 'low-stock',
      label: 'Low-stock',
      ...d.inventory.low_stock,
      tone: 'warning',
      href: hrefFor('inventory'),
    },
    {
      id: 'failed-notifications',
      label: 'Failed notifications',
      ...d.notifications.failed,
      tone: 'danger',
      href: hrefFor('notifications'),
    },
    {
      id: 'open-support',
      label: 'Open support cases',
      ...d.support.open,
      tone: 'info',
      href: hrefFor('support'),
    },
  ]
  return items.filter((i) => i.value > 0)
}
