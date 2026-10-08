/** Display formatting shared by CMS modules. Pure, no I/O. */
const NUMBER = new Intl.NumberFormat('en-IN')

export interface BoundedCount {
  value: number
  capped: boolean
}

/** A capped count is a lower bound: shown as `10,000+`, never as an exact total. */
export function formatCount({ value, capped }: BoundedCount): string {
  return `${NUMBER.format(value)}${capped ? '+' : ''}`
}

/** Screen-reader wording for a bounded count. */
export function describeCount({ value, capped }: BoundedCount): string {
  return capped ? `at least ${NUMBER.format(value)}` : NUMBER.format(value)
}

/** Operations run in Bengaluru: timestamps are shown in Asia/Kolkata with the zone named, whatever the browser zone. */
export function formatDateTimeIst(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'unknown time'
  return `${new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(date)} IST`
}

/** Short IST date-time for tables, e.g. `6 Oct 2026, 3:04 pm`. */
export function formatShortIst(iso: string | null | undefined): string {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}
