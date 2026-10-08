const WHOLE = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
})
const FRACTIONAL = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
})

/** Integer paise (the backend's money unit) as rupees; whole rupees without decimals. Null for a non-amount. */
export function formatPaise(paise: unknown): string | null {
  if (typeof paise !== 'number' || !Number.isSafeInteger(paise) || paise < 0) return null
  return paise % 100 === 0 ? WHOLE.format(paise / 100) : FRACTIONAL.format(paise / 100)
}
