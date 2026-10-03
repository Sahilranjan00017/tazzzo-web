import 'server-only'

const SAFE_PATH = /^\/(?![/\\])[^\\\u0000-\u001f\u007f]*$/
const PROBE_ORIGIN = 'https://return-to.invalid'

/**
 * Post-login destination. Only a same-origin, single-leading-slash path is accepted (also after percent-decoding),
 * never an absolute or protocol-relative URL, a backslash, a control character or an API route. Anything else is `/`.
 */
export function safeReturnTo(raw: string | null | undefined): string {
  if (!raw || raw.length > 512 || !SAFE_PATH.test(raw)) return '/'
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return '/'
  }
  if (!SAFE_PATH.test(decoded)) return '/'
  const url = new URL(raw, PROBE_ORIGIN)
  if (url.origin !== PROBE_ORIGIN || url.pathname.startsWith('/api/')) return '/'
  return `${url.pathname}${url.search}${url.hash}`
}
