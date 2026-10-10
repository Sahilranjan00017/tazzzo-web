import { describe, expect, it } from 'vitest'
import {
  E164_PHONE,
  mailtoHref,
  parseSupport,
  telHref,
  validEmail,
  validPhone,
} from '@/lib/support'

describe('support phone: strict E.164 before any tel: link', () => {
  it.each(['+918012345678', '+14155550123', '+442071838750', '+12345678'])('accepts %s', (v) => {
    expect(validPhone(v)).toBe(v)
    expect(telHref(v)).toBe(`tel:${v}`)
  })

  // Mutation note: loosening E164_PHONE (e.g. to /^\+?[0-9 ()-]+$/ or dropping the anchors) makes every row here fail.
  it.each([
    '08012345678',
    '918012345678',
    '+0123456789',
    '+91 80123 45678',
    '+91-8012345678',
    '+9180123',
    '+9180123456789012',
    '+918012345678;ext=1',
    '+918012345678?body=x',
    'tel:+918012345678',
    'javascript:alert(1)',
    ' +918012345678',
    '+918012345678\n',
    '',
    '+',
  ])('rejects %j: never becomes a tel: link', (v) => {
    expect(validPhone(v)).toBeNull()
    expect(parseSupport({ support: { phone: v } }).phone).toBeNull()
  })

  it.each([null, undefined, 918012345678, {}, [], true])('rejects non-string %j', (v) => {
    expect(validPhone(v)).toBeNull()
  })

  it('the pattern is anchored (a valid number inside other text does not match)', () => {
    expect(E164_PHONE.test('call +918012345678 now')).toBe(false)
  })
})

describe('support email: one plain address before any mailto: link', () => {
  it.each(['help@tazzzo.example', 'a.b+c_d@sub.example.co.in', 'x@y.io'])('accepts %s', (v) => {
    expect(validEmail(v)).toBe(v)
    expect(mailtoHref(v)).toBe(`mailto:${v}`)
  })

  it.each([
    'help@tazzzo',
    'help tazzzo@x.io',
    'a@b.io,c@d.io',
    'a@b.io?cc=evil@x.io',
    'a@b.io&bcc=x@y.io',
    'a@b.io\r\nBcc: x@y.io',
    '<a@b.io>',
    '"a b"@x.io',
    'javascript:alert(1)//@x.io',
    '@x.io',
    'a@@x.io',
    'a@-x.io',
    `${'a'.repeat(65)}@x.io`,
    '',
  ])('rejects %j', (v) => {
    expect(validEmail(v)).toBeNull()
  })
})

describe('parseSupport', () => {
  it('reads the public contract (support.phone / support.email)', () => {
    expect(
      parseSupport({ support: { phone: '+918012345678', email: 'help@tazzzo.example' } }),
    ).toEqual({ phone: '+918012345678', email: 'help@tazzzo.example' })
  })

  it('also accepts the flat CMS names, nested ones first', () => {
    expect(parseSupport({ supportPhone: '+918012345678', supportEmail: 'a@b.io' })).toEqual({
      phone: '+918012345678',
      email: 'a@b.io',
    })
    expect(
      parseSupport({ support: { phone: '+14155550123' }, supportPhone: '+918012345678' }).phone,
    ).toBe('+14155550123')
  })

  it('keeps the valid half when the other is invalid', () => {
    expect(parseSupport({ support: { phone: 'call us', email: 'help@tazzzo.example' } })).toEqual({
      phone: null,
      email: 'help@tazzzo.example',
    })
  })

  it.each([null, undefined, 'x', 5, [], {}, { support: null }, { support: [] }])(
    'yields nothing for %j',
    (raw) => {
      expect(parseSupport(raw)).toEqual({ phone: null, email: null })
    },
  )
})
