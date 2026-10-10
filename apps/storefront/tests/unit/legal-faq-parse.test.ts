import { describe, expect, it } from 'vitest'
import { groupFaqs, parseFaqs } from '@/lib/content/faqs'
import {
  formatEffectiveDate,
  isLegalSlug,
  parseEffectiveDate,
  parseLegal,
  toParagraphs,
} from '@/lib/content/legal'

describe('legal slugs', () => {
  it('only terms and privacy are routable', () => {
    expect(isLegalSlug('terms')).toBe(true)
    expect(isLegalSlug('privacy')).toBe(true)
    for (const v of ['refund', 'Terms', 'terms/', '../terms', 'terms?x=1', '', null, 1]) {
      expect(isLegalSlug(v)).toBe(false)
    }
  })
})

describe('toParagraphs', () => {
  it('splits on blank lines, trims, drops empties, keeps single line breaks', () => {
    expect(toParagraphs('One.\n\nTwo\nstill two.\r\n\r\n   \n\n  Three.  ')).toEqual([
      'One.',
      'Two\nstill two.',
      'Three.',
    ])
  })

  it('leaves markup as literal text (it is rendered escaped, never parsed)', () => {
    expect(toParagraphs('<b>x</b>\n\n<script>1</script>')).toEqual([
      '<b>x</b>',
      '<script>1</script>',
    ])
  })
})

describe('parseLegal', () => {
  const ok = {
    slug: 'terms',
    title: ' Terms ',
    body: 'A.\n\nB.',
    effectiveDate: '2026-03-01',
    requestId: 'r',
  }

  it('accepts the frozen shape', () => {
    expect(parseLegal(ok, 'terms')).toEqual({
      slug: 'terms',
      title: 'Terms',
      paragraphs: ['A.', 'B.'],
      effectiveDate: '2026-03-01',
    })
    expect(parseLegal({ ...ok, effectiveDate: null }, 'terms')?.effectiveDate).toBeNull()
  })

  it('refuses a document for another slug, or without a title or text body', () => {
    expect(parseLegal(ok, 'privacy')).toBeNull()
    expect(parseLegal({ ...ok, title: '' }, 'terms')).toBeNull()
    expect(parseLegal({ ...ok, body: 5 }, 'terms')).toBeNull()
    expect(parseLegal({ ...ok, body: ' \n\n ' }, 'terms')).toBeNull()
    expect(parseLegal(null, 'terms')).toBeNull()
    expect(parseLegal('x', 'terms')).toBeNull()
  })

  it('shows no date when it is not a real calendar date', () => {
    expect(parseEffectiveDate('2026-02-30')).toBeNull()
    expect(parseEffectiveDate('March 1')).toBeNull()
    expect(parseEffectiveDate(20260301)).toBeNull()
    expect(parseEffectiveDate('2026-03-01T00:00:00Z')).toBe('2026-03-01')
    expect(formatEffectiveDate('2026-03-01')).toBe('1 March 2026')
  })
})

describe('faqs', () => {
  const raw = {
    faqs: [
      { faqId: 'A', category: 'PAYMENT', question: 'Pay?', answer: 'COD.' },
      { faqId: 'B', category: 'DELIVERY', question: 'When?', answer: 'Soon.\nReally.' },
      { faqId: 'C', faqCategory: 'DELIVERY', question: 'Where?', answer: 'Here.' },
      { faqId: 'D', category: 'NOPE', question: 'x', answer: 'y' },
      { faqId: 'E', category: 'CLUB', question: '', answer: 'y' },
      { faqId: 'F', category: 'CLUB', question: 'q', answer: '  ' },
      'junk',
    ],
    requestId: 'r',
  }

  it('keeps well-formed entries (either category field) and drops the rest', () => {
    expect(parseFaqs(raw)?.map((f) => f.id)).toEqual(['A', 'B', 'C'])
    expect(parseFaqs(raw)?.[1]?.paragraphs).toEqual(['Soon.', 'Really.'])
  })

  it('groups in the fixed category order, keeping the given order inside, dropping empty groups', () => {
    const groups = groupFaqs(parseFaqs(raw)!)
    expect(groups.map((g) => [g.category, g.faqs.map((f) => f.id)])).toEqual([
      ['DELIVERY', ['B', 'C']],
      ['PAYMENT', ['A']],
    ])
  })

  it('is null for a body that is not a faqs envelope; an empty list is an empty array', () => {
    expect(parseFaqs(null)).toBeNull()
    expect(parseFaqs({})).toBeNull()
    expect(parseFaqs({ faqs: [] })).toEqual([])
  })
})
