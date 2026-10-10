/**
 * Help-centre FAQ from `GET /v1/content/faqs`: `{ faqs: [{ faqId, category, question, answer }], requestId }`, already
 * ordered by category then display order. Answers are plain text; a line break separates paragraphs. Everything is
 * rendered as escaped text. The CMS names the category field `faqCategory`; both names are accepted.
 */
export const FAQ_CATEGORY_ORDER = [
  'DELIVERY',
  'PRODUCT',
  'CLUB',
  'PAYMENT',
  'REFUND',
  'ACCOUNT',
] as const

const FAQ_CATEGORY_LABEL: Record<string, string> = {
  DELIVERY: 'Delivery',
  PRODUCT: 'Products',
  CLUB: 'Club',
  PAYMENT: 'Payment',
  REFUND: 'Refunds',
  ACCOUNT: 'Account',
}

export interface Faq {
  id: string
  category: string
  question: string
  paragraphs: string[]
}

export interface FaqGroup {
  category: string
  label: string
  faqs: Faq[]
}

const MAX_FAQS = 200
const MAX_QUESTION = 200
const MAX_ANSWER = 2_000

export function parseFaqs(raw: unknown): Faq[] | null {
  if (typeof raw !== 'object' || raw === null) return null
  const list = (raw as { faqs?: unknown }).faqs
  if (!Array.isArray(list)) return null
  const faqs: Faq[] = []
  for (const entry of list.slice(0, MAX_FAQS) as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    const category = e.category ?? e.faqCategory
    const question = typeof e.question === 'string' ? e.question.trim() : ''
    const answer = typeof e.answer === 'string' ? e.answer : ''
    if (
      typeof category !== 'string' ||
      !(FAQ_CATEGORY_ORDER as readonly string[]).includes(category) ||
      question.length === 0 ||
      question.length > MAX_QUESTION ||
      answer.length > MAX_ANSWER
    ) {
      continue
    }
    const paragraphs = answer
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((p) => p.trim())
      .filter((p) => p.length > 0)
    if (paragraphs.length === 0) continue
    faqs.push({
      id: typeof e.faqId === 'string' ? e.faqId : `faq-${faqs.length}`,
      category,
      question,
      paragraphs,
    })
  }
  return faqs
}

/** Groups in the fixed category order (the backend's), each keeping the backend's order inside. Empty groups are dropped. */
export function groupFaqs(faqs: Faq[]): FaqGroup[] {
  return FAQ_CATEGORY_ORDER.flatMap((category) => {
    const inGroup = faqs.filter((f) => f.category === category)
    return inGroup.length > 0
      ? [{ category, label: FAQ_CATEGORY_LABEL[category] ?? category, faqs: inGroup }]
      : []
  })
}
