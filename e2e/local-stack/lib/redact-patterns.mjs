// Redaction rules for committed evidence, shared by tests/support.ts (live, on every transcript line) and
// lib/redact-evidence.mjs (post hoc, in place). One-time ids and mobile numbers never stay in evidence.
const NB = String.raw`(?<![A-Za-z0-9_-])`
const NA = String.raw`(?![A-Za-z0-9_-])`
export const RULES = [
  // one-time OTP challenge / login grant ids (JSON fields and bare tokens)
  [/"(challengeId|grantId)":"[^"]*"/g, '"$1":"<redacted>"'],
  [/\b(OTP|GRANT)_[A-Za-z0-9_-]{16,}/g, '$1_<redacted>'],
  // Indian mobile numbers: +91 / 91 prefixed (12 digits) or bare (10 digits starting 6-9) -> +91XXXXXX1234
  [new RegExp(`${NB}\\+?91([6-9]\\d{5})(\\d{4})${NA}`, 'g'), '+91XXXXXX$2'],
  [new RegExp(`${NB}[6-9]\\d{5}(\\d{4})${NA}`, 'g'), '+91XXXXXX$1'],
]
export function redactPii(s) {
  let out = s
  for (const [re, to] of RULES) out = out.replace(re, to)
  return out
}
