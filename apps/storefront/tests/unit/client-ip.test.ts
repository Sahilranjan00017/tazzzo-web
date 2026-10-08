import { describe, expect, it } from 'vitest'
import { clientKey, ipKey, UNRESOLVED_CLIENT } from '@/lib/security/client-ip'

const xff = (value?: string) => new Headers(value === undefined ? {} : { 'x-forwarded-for': value })
const trusted = { trustProxy: true, trustedHops: 1 }

describe('clientKey', () => {
  it('ignores X-Forwarded-For entirely unless the proxy is trusted (no key at all)', () => {
    for (const value of ['203.0.113.9', '203.0.113.9, 198.51.100.1', undefined]) {
      expect(clientKey(xff(value), { trustProxy: false, trustedHops: 1 })).toBeNull()
    }
  })

  it('trusted: takes the entry our proxy appended (rightmost), never the client-written left ones', () => {
    expect(clientKey(xff('203.0.113.9'), trusted)).toBe('203.0.113.9')
    expect(clientKey(xff('6.6.6.6, 1.1.1.1, 203.0.113.9'), trusted)).toBe('203.0.113.9')
  })

  it('trusted with two hops (CDN -> ALB): the second entry from the right', () => {
    const twoHops = { trustProxy: true, trustedHops: 2 }
    expect(clientKey(xff('6.6.6.6, 203.0.113.9, 10.0.0.5'), twoHops)).toBe('203.0.113.9')
    // A chain shorter than the configured hops did not come through the proxies: fail closed, shared key.
    expect(clientKey(xff('203.0.113.9'), twoHops)).toBe(UNRESOLVED_CLIENT)
  })

  it('trusted: a missing or non-IP entry is the shared unresolved key, not a client-chosen one', () => {
    expect(clientKey(xff(), trusted)).toBe(UNRESOLVED_CLIENT)
    expect(clientKey(xff(''), trusted)).toBe(UNRESOLVED_CLIENT)
    expect(clientKey(xff('203.0.113.9, evil.example'), trusted)).toBe(UNRESOLVED_CLIENT)
    expect(clientKey(xff('203.0.113.9, 1.2.3.4:5678'), trusted)).toBe(UNRESOLVED_CLIENT)
  })
})

describe('ipKey', () => {
  it.each([
    ['203.0.113.9', '203.0.113.9'],
    ['0.0.0.0', '0.0.0.0'],
    ['::ffff:203.0.113.9', '203.0.113.9'],
    ['::FFFF:cb00:7109', '203.0.113.9'],
    ['::1', '0:0:0:0::/64'],
    ['[::1]', '0:0:0:0::/64'],
    ['2001:db8:85a3:12::8a2e:370:7334', '2001:db8:85a3:12::/64'],
    ['2001:DB8:85A3:0012:1111:2222:3333:4444', '2001:db8:85a3:12::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['64:ff9b::192.0.2.33', '64:ff9b:0:0::/64'],
  ])('%s -> %s', (input, key) => {
    expect(ipKey(input)).toBe(key)
  })

  it('one IPv6 /64 is one visitor: rotating the interface id gives the same key', () => {
    expect(ipKey('2001:db8:1:2::1')).toBe(ipKey('2001:db8:1:2:ffff:ffff:ffff:fffe'))
    expect(ipKey('2001:db8:1:2::1')).not.toBe(ipKey('2001:db8:1:3::1'))
  })

  it.each([
    '',
    'localhost',
    '256.1.1.1',
    '1.2.3',
    '01.2.3.4',
    '1.2.3.4.5',
    '1.2.3.4:80',
    '::1::2',
    '1:2:3:4:5:6:7:8:9',
    '1:2:3:4:5:6:7',
    '1:2:3:4::5:6:7:8',
    '12345::1',
    'g::1',
    '::ffff:999.1.1.1',
  ])('rejects %j', (input) => {
    expect(ipKey(input)).toBeNull()
  })
})
