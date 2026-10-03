/**
 * An obviously fake, UNSIGNED, JWT-shaped string for unit tests that only need "some ID token" (never verified).
 * Built at runtime so no token-like literal sits in the public repository.
 */
export function fakeIdToken(claims: Record<string, unknown> = { sub: '111' }): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${part({ alg: 'RS256', typ: 'JWT' })}.${part(claims)}.not-a-real-signature`
}
