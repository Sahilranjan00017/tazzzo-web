/** GTIN-8/12/13/14 check-digit validation (GS1 mod-10). The backend does not check GTIN format, so the CMS must. */
export function isValidGtin(value: string): boolean {
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(value)) return false
  const digits = [...value].map(Number)
  const check = digits.pop()!
  let sum = 0
  digits.reverse().forEach((d, i) => {
    sum += d * (i % 2 === 0 ? 3 : 1)
  })
  return (10 - (sum % 10)) % 10 === check
}
