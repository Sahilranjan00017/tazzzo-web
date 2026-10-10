import { describe, expect, it } from 'vitest'
import {
  LIMITS,
  parseCreate,
  parseDefault,
  parseDelete,
  parseUpdate,
  validateAddress,
  addressIfMatch,
} from '@/lib/address/validation'

const valid = {
  label: 'HOME',
  recipientName: 'Asha Verma',
  recipientPhone: '98765 43210',
  addressLine1: '12 MG Road',
  addressLine2: '',
  landmark: null,
  city: 'Bengaluru',
  state: 'Karnataka',
  postalCode: '560001',
}
const KEY = 'a1b2c3d4-e5f6-4789-8abc-0123456789ab'

describe('validateAddress (mirrors AddressService / AddressTexts)', () => {
  it('normalises: trims, canonical phone, empty optionals null', () => {
    const r = validateAddress({ ...valid, recipientName: '  Asha  ', landmark: '   ' })
    expect(r).toEqual({
      ok: true,
      value: {
        label: 'HOME',
        recipientName: 'Asha',
        recipientPhone: '+919876543210',
        addressLine1: '12 MG Road',
        addressLine2: null,
        landmark: null,
        city: 'Bengaluru',
        state: 'Karnataka',
        postalCode: '560001',
      },
    })
  })
  it('accepts the three backend phone shapes and rejects the rest', () => {
    for (const p of ['+919876543210', '9876543210', '09876543210']) {
      expect(validateAddress({ ...valid, recipientPhone: p }).ok, p).toBe(true)
    }
    for (const p of [
      '',
      '5876543210',
      '+449876543210',
      '98765432',
      '98765432101',
      'abcdefghij',
      null,
      9876543210,
    ]) {
      const r = validateAddress({ ...valid, recipientPhone: p })
      expect(r.ok, String(p)).toBe(false)
    }
  })
  it('enforces the label vocabulary', () => {
    for (const l of ['HOME', 'WORK', 'OTHER'])
      expect(validateAddress({ ...valid, label: l }).ok).toBe(true)
    for (const l of ['home', 'Office', '', null, 1])
      expect(validateAddress({ ...valid, label: l }).ok, String(l)).toBe(false)
  })
  it('enforces required fields, max code points and control characters', () => {
    for (const f of ['recipientName', 'addressLine1', 'city', 'state'] as const) {
      expect(validateAddress({ ...valid, [f]: '  ' }).ok, f).toBe(false)
      expect(validateAddress({ ...valid, [f]: undefined }).ok, f).toBe(false)
      expect(validateAddress({ ...valid, [f]: 'x'.repeat(LIMITS[f]) }).ok, f).toBe(true)
      expect(validateAddress({ ...valid, [f]: 'x'.repeat(LIMITS[f] + 1) }).ok, f).toBe(false)
      expect(validateAddress({ ...valid, [f]: 'bad\u0007char' }).ok, f).toBe(false)
      expect(validateAddress({ ...valid, [f]: 'two\nlines' }).ok, f).toBe(false)
      expect(validateAddress({ ...valid, [f]: 'c1\u0085' }).ok, f).toBe(false)
    }
    expect(validateAddress({ ...valid, addressLine2: 'y'.repeat(161) }).ok).toBe(false)
    expect(validateAddress({ ...valid, landmark: 'y'.repeat(121) }).ok).toBe(false)
    expect(validateAddress({ ...valid, landmark: 'y'.repeat(120) }).ok).toBe(true)
  })
  it('counts code points, not UTF-16 units (emoji, Devanagari)', () => {
    expect(validateAddress({ ...valid, recipientName: '😀'.repeat(80) }).ok).toBe(true)
    expect(validateAddress({ ...valid, recipientName: '😀'.repeat(81) }).ok).toBe(false)
    expect(validateAddress({ ...valid, city: 'नई दिल्ली' }).ok).toBe(true)
  })
  it('validates the PIN', () => {
    for (const p of ['056001', '56001', '5600011', '56 0001', 'abcdef', null]) {
      const r = validateAddress({ ...valid, postalCode: p })
      expect(r.ok, String(p)).toBe(false)
    }
    expect(validateAddress({ ...valid, postalCode: ' 560001 ' }).ok).toBe(true)
  })
  it('reports every bad field at once', () => {
    const r = validateAddress({ label: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok)
      expect(Object.keys(r.errors).sort()).toEqual([
        'addressLine1',
        'city',
        'label',
        'postalCode',
        'recipientName',
        'recipientPhone',
        'state',
      ])
  })
  it('rejects non-string text values', () => {
    expect(validateAddress({ ...valid, city: 5 }).ok).toBe(false)
    expect(validateAddress({ ...valid, addressLine2: {} }).ok).toBe(false)
  })
})

describe('BFF body parsers accept EXACTLY the listed fields', () => {
  it('create', () => {
    expect(parseCreate({ ...valid, idempotencyKey: KEY })?.idempotencyKey).toBe(KEY)
    expect(parseCreate({ ...valid })).toBeNull() // no key
    expect(parseCreate({ ...valid, idempotencyKey: 'short' })).toBeNull()
    for (const extra of [
      'customerId',
      'userId',
      'addressId',
      'version',
      'latitude',
      'isDefault',
      'fulfillmentLocationId',
    ]) {
      expect(parseCreate({ ...valid, idempotencyKey: KEY, [extra]: 'CUS_other' }), extra).toBeNull()
    }
    const { city: _c, ...missing } = valid
    void _c
    expect(parseCreate({ ...missing, idempotencyKey: KEY })).toBeNull()
  })
  it('update', () => {
    const ok = parseUpdate({ ...valid, addressId: 'ADDR_abcdef1', version: 3 })
    expect(ok).toMatchObject({ addressId: 'ADDR_abcdef1', version: 3 })
    expect(parseUpdate({ ...valid, addressId: 'ADDR_abcdef1' })).toBeNull()
    expect(parseUpdate({ ...valid, addressId: 'nope', version: 1 })).toBeNull()
    expect(parseUpdate({ ...valid, addressId: 'ADDR_abcdef1', version: -1 })).toBeNull()
    expect(parseUpdate({ ...valid, addressId: 'ADDR_abcdef1', version: 1.5 })).toBeNull()
    expect(parseUpdate({ ...valid, addressId: 'ADDR_abcdef1', version: 10 ** 15 })).toBeNull()
    expect(
      parseUpdate({ ...valid, addressId: 'ADDR_abcdef1', version: 1, customerId: 'CUS_x' }),
    ).toBeNull()
  })
  it('delete and default', () => {
    expect(parseDelete({ addressId: 'ADDR_abcdef1', version: 0 })).toEqual({
      addressId: 'ADDR_abcdef1',
      version: 0,
    })
    expect(parseDelete({ addressId: 'ADDR_abcdef1' })).toBeNull()
    expect(parseDelete({ addressId: 'ADDR_abcdef1', version: 1, customerId: 'CUS_x' })).toBeNull()
    expect(parseDefault({ addressId: 'ADDR_abcdef1' })).toEqual({ addressId: 'ADDR_abcdef1' })
    expect(parseDefault({ addressId: 'ADDR_abcdef1', userId: 'u' })).toBeNull()
    expect(parseDefault({ addressId: '../ADDR_abcdef1' })).toBeNull()
    expect(parseDefault({})).toBeNull()
  })
  it('If-Match uses the backend ETag form', () => {
    expect(addressIfMatch(7)).toBe('"address-7"')
  })
})
