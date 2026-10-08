/** Money is int64 paise (INR only). Parsing is integer-only string work: no floating point ever touches an amount. */
export const MAX_PAISE = 1_000_000_000

const INR = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })

/** `12345` paise -> `₹123.45`. */
export function formatPaise(paise: number): string {
  return INR.format(paise / 100)
}

export type ParsedRupees = { ok: true; paise: number } | { ok: false; reason: string }

/** "129", "129.5", "129.50" -> paise. Rejects signs, exponents, separators, more than 2 decimals, and out-of-range values. */
export function parseRupees(input: string): ParsedRupees {
  const text = input.trim()
  if (text === '') return { ok: false, reason: 'Enter an amount.' }
  const match = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(text)
  if (!match) return { ok: false, reason: 'Use digits with at most two decimals, e.g. 129.50.' }
  const paise = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0') || '0')
  if (paise > MAX_PAISE)
    return { ok: false, reason: 'That is above the maximum the backend accepts.' }
  return { ok: true, paise }
}

/** paise -> editable rupee string with exactly two decimals (no float math). */
export function paiseToInput(paise: number): string {
  const whole = Math.trunc(paise / 100)
  const frac = String(paise % 100).padStart(2, '0')
  return `${whole}.${frac}`
}
