/**
 * Which visitor a request belongs to, for the per-visitor rate limit in `src/proxy.ts`. Pure; no secrets.
 *
 * Next.js gives `proxy.ts` no socket address. Before the proxy runs, the Next server does
 * `x-forwarded-for ??= socket.remoteAddress` (next/dist/server/base-server.js): when the client sends its own
 * `X-Forwarded-For`, that value is all the proxy sees and the real peer address is gone. So:
 *
 * - `trustProxy: false` (the default): `X-Forwarded-For` is ignored entirely and there is NO trustworthy visitor
 *   address; the caller gets `null` and must not key a limit on anything the client wrote.
 * - `trustProxy: true`: the site runs behind proxies that APPEND the address they saw (an AWS ALB in its default
 *   `append` mode does). Entries are read right to left, `trustedHops` from the end, like the backend's
 *   `ClientIpResolver`: the leftmost entries are the client's own invention, the rightmost ones our infrastructure
 *   wrote. A chain shorter than `trustedHops` or an entry that is not a literal IP yields the shared key
 *   `UNRESOLVED_CLIENT` (fail closed: never fall back to a client-written entry).
 *
 * IPv6 addresses are keyed by their /64, so one subscriber cannot rotate through its prefix for fresh buckets;
 * IPv4-mapped IPv6 (`::ffff:a.b.c.d`) is the IPv4 address.
 */
export const UNRESOLVED_CLIENT = 'unresolved'

export interface ClientIpOptions {
  trustProxy: boolean
  /** How many proxies append to `X-Forwarded-For` in front of this server (1 = the ALB only). */
  trustedHops: number
}

export function clientKey(headers: Headers, options: ClientIpOptions): string | null {
  if (!options.trustProxy) return null
  const chain = (headers.get('x-forwarded-for') ?? '').split(',').map((entry) => entry.trim())
  if (chain.length < options.trustedHops) return UNRESOLVED_CLIENT
  const entry = chain[chain.length - options.trustedHops] ?? ''
  return ipKey(entry) ?? UNRESOLVED_CLIENT
}

/** Canonical rate-limit key of a literal IP address (no hostnames, no ports), or null if it is not one. */
export function ipKey(value: string): string | null {
  let text = value
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1)
  const zone = text.indexOf('%')
  if (zone > 0) text = text.slice(0, zone)
  const v4 = parseIpv4(text)
  if (v4) return v4.join('.')
  const v6 = parseIpv6(text)
  if (!v6) return null
  const mapped = v6.slice(0, 5).every((g) => g === 0) && v6[5] === 0xffff
  if (mapped) {
    const hi = v6[6] ?? 0
    const lo = v6[7] ?? 0
    return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.')
  }
  return `${v6
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(':')}::/64`
}

function parseIpv4(text: string): number[] | null {
  const parts = text.split('.')
  if (parts.length !== 4) return null
  const octets: number[] = []
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null
    const n = Number(part)
    if (n > 255) return null
    octets.push(n)
  }
  return octets
}

/** Eight 16-bit groups, or null. Accepts `::` compression and a dotted IPv4 tail. */
function parseIpv6(text: string): number[] | null {
  if (!/^[0-9A-Fa-f:.]{2,45}$/.test(text)) return null
  const halves = text.split('::')
  if (halves.length > 2) return null
  const parseSide = (side: string): number[] | null => {
    if (side === '') return []
    const groups: number[] = []
    const pieces = side.split(':')
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i] ?? ''
      if (i === pieces.length - 1 && piece.includes('.')) {
        const v4 = parseIpv4(piece)
        if (!v4) return null
        groups.push(((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0))
      } else {
        if (!/^[0-9A-Fa-f]{1,4}$/.test(piece)) return null
        groups.push(parseInt(piece, 16))
      }
    }
    return groups
  }
  const head = parseSide(halves[0] ?? '')
  const tail = halves.length === 2 ? parseSide(halves[1] ?? '') : []
  if (!head || !tail) return null
  if (halves.length === 1) return head.length === 8 ? head : null
  const missing = 8 - head.length - tail.length
  if (missing < 1) return null
  return [...head, ...new Array<number>(missing).fill(0), ...tail]
}
