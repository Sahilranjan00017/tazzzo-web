import { describe, expect, it } from 'vitest'
import { errorMessage, waitText } from '@/lib/auth/messages'
import { isChallengeId, isOtp, maskPhone, normalisePhone, safeNext } from '@/lib/auth/validation'

describe('normalisePhone (the backend Phone grammar)', () => {
  it('accepts +91, ten bare digits and a leading zero, and returns +91XXXXXXXXXX', () => {
    expect(normalisePhone('+919876543210')).toBe('+919876543210')
    expect(normalisePhone('9876543210')).toBe('+919876543210')
    expect(normalisePhone('09876543210')).toBe('+919876543210')
    expect(normalisePhone('  98765 43210 ')).toBe('+919876543210')
    expect(normalisePhone('+91 98765-43210')).toBe('+919876543210')
  })

  it('rejects everything else', () => {
    for (const bad of [
      '',
      '5876543210', // does not start 6-9
      '987654321', // 9 digits
      '98765432100', // 11 digits
      '919876543210', // 91 without +
      '+449876543210',
      '+91987654321',
      '+9198765432101',
      '98765abcde',
      '98765\n43210',
      '+91(9876)543210',
      '٩٨٧٦٥٤٣٢١٠', // non-ASCII digits
      "9876543210'; drop",
      '9'.repeat(40),
    ]) {
      expect(normalisePhone(bad), bad).toBeNull()
    }
    for (const notText of [undefined, null, 9876543210, {}, ['9876543210']]) {
      expect(normalisePhone(notText)).toBeNull()
    }
  })

  it('masks all but the last four digits', () => {
    expect(maskPhone('+919876543210')).toBe('+91 ******3210')
  })
})

describe('code and challenge shapes', () => {
  it('accepts exactly six ASCII digits', () => {
    expect(isOtp('123456')).toBe(true)
    for (const bad of ['12345', '1234567', '12345a', ' 123456', '١٢٣٤٥٦', 123456, null]) {
      expect(isOtp(bad), String(bad)).toBe(false)
    }
  })

  it('accepts the backend challenge id grammar only', () => {
    expect(isChallengeId(`OTP_${'a'.repeat(24)}`)).toBe(true)
    for (const bad of [
      'OTP_short',
      `otp_${'a'.repeat(24)}`,
      `OTP_${'a'.repeat(24)}!`,
      `OTP_${'a'.repeat(60)}`,
    ]) {
      expect(isChallengeId(bad)).toBe(false)
    }
  })
})

describe('safeNext (no open redirect)', () => {
  it('keeps same-origin paths with their query and fragment', () => {
    expect(safeNext('/account')).toBe('/account')
    expect(safeNext('/p/TZP-1001?x=1#top')).toBe('/p/TZP-1001?x=1#top')
    expect(safeNext('/search?q=rice%20dal')).toBe('/search?q=rice%20dal')
  })

  it('falls back to /account for anything that could leave the site', () => {
    for (const bad of [
      'https://evil.example/',
      'http://evil.example',
      '//evil.example',
      '///evil.example',
      '/\\evil.example',
      '\\\\evil.example',
      '/%2Fevil.example',
      '/%5Cevil.example',
      '/%2f/evil.example',
      'javascript:alert(1)',
      'data:text/html,x',
      'evil.example',
      'account',
      '/a\nb',
      '/a%0d%0aSet-Cookie:x=1',
      '/\tevil.example',
      '/%00',
      '/%',
      '/api/auth/logout',
      '/api/auth/refresh?next=/',
      '/login',
      '/login?next=/account',
      '/' + 'a'.repeat(600),
      '',
      undefined,
      null,
      42,
      ['/a'],
    ]) {
      expect(safeNext(bad), String(bad)).toBe('/account')
    }
  })
})

describe('customer-facing messages', () => {
  it('maps every code to a plain sentence and leaks nothing else', () => {
    for (const code of [
      'invalid_phone',
      'invalid_code',
      'expired',
      'rate_limited',
      'unavailable',
      'forbidden',
      'weird',
    ]) {
      expect(errorMessage(code, 90)).toMatch(/^[A-Z][^<>{}]+[.]$/)
    }
    expect(errorMessage('rate_limited', 42)).toBe(
      'Too many attempts. Please wait 42 seconds and try again.',
    )
    expect(errorMessage('rate_limited', 300)).toContain('5 minutes')
    expect(errorMessage('rate_limited', null)).toContain('a moment')
    expect(waitText(1)).toBe('a moment')
  })
})
