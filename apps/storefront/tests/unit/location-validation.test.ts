import { describe, expect, it } from 'vitest'
import {
  isAddressId,
  isIdempotencyKey,
  isPin,
  isSlotId,
  normalisePin,
  returnPath,
} from '@/lib/location/validation'
import { locationChipText } from '@/lib/location/model'

describe('PIN grammar (backend Pincode: ^[1-9][0-9]{5}$ after trimming)', () => {
  it('accepts six digits not starting with 0, ignoring surrounding blanks only', () => {
    expect(normalisePin('560001')).toBe('560001')
    expect(normalisePin('  560001\t')).toBe('560001')
    expect(normalisePin('110001')).toBe('110001')
  })
  it.each([
    '',
    ' ',
    '56001',
    '5600011',
    '056001',
    '000000',
    '56 0001',
    '560-001',
    '56000a',
    'abcdef',
    '５６０００１',
    '560001\n560002',
    '+560001',
    '5.60001',
    '1e5000',
    '0560011',
  ])('refuses %j', (raw) => {
    expect(normalisePin(raw)).toBeNull()
  })
  it('refuses non-strings and absurd lengths', () => {
    for (const raw of [undefined, null, 560001, {}, ['560001'], 'x'.repeat(100)]) {
      expect(normalisePin(raw)).toBeNull()
    }
  })
  it('isPin is the strict canonical form', () => {
    expect(isPin('560001')).toBe(true)
    expect(isPin(' 560001')).toBe(false)
    expect(isPin(560001)).toBe(false)
  })
})

describe('ids', () => {
  it('address ids follow ADDR_[A-Za-z0-9_-]{6,64}, case preserved', () => {
    expect(isAddressId('ADDR_abcdef')).toBe(true)
    expect(isAddressId('ADDR_aB-_9xyz')).toBe(true)
    for (const bad of [
      'addr_abcdef',
      'ADDR_abc',
      `ADDR_${'a'.repeat(65)}`,
      'ADDR_ab cdef',
      'ADDR_../x',
      '',
      'ADDR_abcdef/',
      'TZP-1001',
      null,
    ]) {
      expect(isAddressId(bad), String(bad)).toBe(false)
    }
  })
  it('slot ids are <window>~<date> with the backend grammar', () => {
    expect(isSlotId('morning~2026-10-11')).toBe(true)
    expect(isSlotId('a-1~2026-10-11')).toBe(true)
    for (const bad of [
      'Morning~2026-10-11',
      'morning~2026-1-11',
      'morning',
      '~2026-10-11',
      '-x~2026-10-11',
      `${'a'.repeat(33)}~2026-10-11`,
      'morning~2026-10-11x',
      'a/b~2026-10-11',
    ]) {
      expect(isSlotId(bad), bad).toBe(false)
    }
  })
  it('idempotency keys are 8-64 of [A-Za-z0-9_-]', () => {
    expect(isIdempotencyKey('8c0a7c1e-1b5e-4f0f-9a0c-123456789abc')).toBe(true)
    for (const bad of ['short', 'has space 12345', 'a'.repeat(65), 'ünïcode-key-12', '']) {
      expect(isIdempotencyKey(bad)).toBe(false)
    }
  })
})

describe('returnPath', () => {
  it('keeps safe same-origin paths and falls back to the home page, never /account', () => {
    expect(returnPath('/cart')).toBe('/cart')
    expect(returnPath('/p/TZP-1001')).toBe('/p/TZP-1001')
    expect(returnPath('/account/addresses')).toBe('/account/addresses')
    for (const bad of [
      undefined,
      '',
      '//evil.example',
      '/\\evil',
      'https://evil.example',
      '/api/cart',
      '/login',
      '/%2f/evil',
    ]) {
      expect(returnPath(bad), String(bad)).toBe('/')
    }
  })
})

describe('chip text', () => {
  it('says what is set', () => {
    expect(locationChipText(null)).toBe('Set delivery location')
    expect(locationChipText({ pin: '560001', serviceable: true, viaAddress: false })).toBe(
      'Deliver to 560001',
    )
    expect(locationChipText({ pin: '400001', serviceable: false, viaAddress: false })).toBe(
      'Not delivering to 400001',
    )
    expect(locationChipText({ pin: '560001', serviceable: null, viaAddress: false })).toBe(
      'Deliver to 560001',
    )
  })
})
