import 'server-only'

const SAFE_PATH = /^\/(?![/\\])[^\\\u0000-\u001f\u007f]*$/
const PROBE_ORIGIN = 'https://return-to.invalid'
const CONTROL_OR_BACKSLASH = /[\\\u0000-\u001f\u007f]/
const MAX_DECODE_ROUNDS = 5

/** Why a path is unsafe at one decoding stage: another origin, a dot segment or an encoded separator. */
function pathIsUnsafe(path: string): boolean {
  if (!SAFE_PATH.test(path)) return true
  if (/%2f|%5c/i.test(path)) return true // an encoded slash or backslash survives some decoders
  return path.split('/').some((segment) => segment === '.' || segment === '..')
}

/**
 * Post-login destination. Only a same-origin, single-leading-slash path is accepted: no backslash or control
 * character, no `.`/`..` segment and no encoded slash or backslash, checked on the path as given and after every round
 * of percent-decoding up to a fixpoint (so `/.//evil`, `/%2e//evil`, `/x/..//evil` and `%252f` are refused BEFORE the
 * URL parser could collapse them into `//evil`). The result is then rebuilt by the URL parser and must still be the
 * same single-slash path on the probe origin. Never an API route. Anything else is `/`.
 */
export function safeReturnTo(raw: string | null | undefined): string {
  if (!raw || raw.length > 512 || CONTROL_OR_BACKSLASH.test(raw)) return '/'
  // Also refuse a control character or backslash the query or fragment only reveals once percent-decoded.
  try {
    if (CONTROL_OR_BACKSLASH.test(decodeURIComponent(raw))) return '/'
  } catch {
    return '/'
  }
  const path = raw.split(/[?#]/, 1)[0] ?? ''
  let stage = path
  for (let round = 0; ; round++) {
    if (pathIsUnsafe(stage)) return '/'
    let decoded: string
    try {
      decoded = decodeURIComponent(stage)
    } catch {
      return '/'
    }
    if (decoded === stage) break
    if (round >= MAX_DECODE_ROUNDS) return '/'
    stage = decoded
  }
  const url = new URL(raw, PROBE_ORIGIN)
  const result = `${url.pathname}${url.search}${url.hash}`
  if (url.origin !== PROBE_ORIGIN || !/^\/(?![/\\])/.test(result) || url.pathname !== path) {
    return '/'
  }
  if (url.pathname.startsWith('/api/')) return '/'
  return result
}
