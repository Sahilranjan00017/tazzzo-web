import { render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

const session = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('@/server/session/cookies', () => ({ readSession: async () => session.current }))

beforeAll(() => {
  vi.stubEnv('TAZZZO_API_BASE_URL', 'https://api.tazzzo.test')
  vi.stubEnv('TAZZZO_SITE_URL', 'https://www.tazzzo.test')
})

const { resetFailureMemory } = await import('@/server/backend/client')
const fetchMock = vi.fn<(input: string) => Promise<Response>>()
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  resetFailureMemory()
  fetchMock.mockReset()
  session.current = null
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('legal pages', () => {
  const body =
    'First paragraph.\n\n<script>window.pwned = 1</script>\n\nPrices include <b>tax</b> & fees.'

  // Mutation note: rendering `body` via dangerouslySetInnerHTML (or as markdown/HTML) creates a <script> and a <b>
  // element and the literal-text assertions below fail.
  it('renders the plain-text body as escaped paragraphs, never as HTML', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, {
        slug: 'terms',
        title: 'Terms of service',
        body,
        effectiveDate: '2026-03-01',
        requestId: 'r',
      }),
    )
    const { LegalPage } = await import('@/app/_sections/LegalPage')
    const { container } = render(await LegalPage({ slug: 'terms' }))
    expect(screen.getByRole('heading', { level: 1, name: 'Terms of service' })).toBeInTheDocument()
    const paragraphs = container.querySelectorAll('p.legal__p')
    expect(paragraphs).toHaveLength(3)
    expect(paragraphs[1]!.textContent).toBe('<script>window.pwned = 1</script>')
    expect(paragraphs[2]!.textContent).toBe('Prices include <b>tax</b> & fees.')
    expect(container.querySelector('script, b')).toBeNull()
    expect(container.innerHTML).not.toContain('<script')
    expect(screen.getByText('1 March 2026')).toHaveAttribute('datetime', '2026-03-01')
    // Landmark/heading structure: one article named by its h1.
    expect(screen.getByRole('article', { name: 'Terms of service' })).toBeInTheDocument()
  })

  it('shows no date line when the document has no effective date', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, {
        slug: 'privacy',
        title: 'Privacy policy',
        body: 'Text.',
        effectiveDate: null,
        requestId: 'r',
      }),
    )
    const { LegalPage } = await import('@/app/_sections/LegalPage')
    const { container } = render(await LegalPage({ slug: 'privacy' }))
    expect(container.querySelector('time')).toBeNull()
    expect(screen.queryByText(/Effective/)).toBeNull()
  })

  it('unpublished (flat 404): a friendly page with a link to Contact, not an error', async () => {
    fetchMock.mockResolvedValueOnce(json(404, { code: 'NOT_FOUND', message: 'm', requestId: 'r' }))
    const { LegalPage } = await import('@/app/_sections/LegalPage')
    render(await LegalPage({ slug: 'privacy' }))
    expect(screen.getByRole('heading', { level: 1, name: 'Privacy policy' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent("This document hasn't been published yet.")
    expect(screen.getByRole('link', { name: 'contact us' })).toHaveAttribute('href', '/contact')
  })

  it('backend trouble is the generic "can\'t load right now" notice, not "unpublished"', async () => {
    fetchMock.mockResolvedValueOnce(json(503, {}))
    const { LegalPage } = await import('@/app/_sections/LegalPage')
    render(await LegalPage({ slug: 'terms' }))
    expect(screen.getByRole('status')).toHaveTextContent("We can't load this document right now")
    expect(screen.queryByText(/hasn't been published/)).toBeNull()
  })

  it('metadata: noindex while unpublished, canonical always, the document title when published', async () => {
    fetchMock.mockResolvedValueOnce(json(404, {}))
    const { legalMetadata } = await import('@/app/_sections/LegalPage')
    expect(await legalMetadata('privacy')).toMatchObject({
      title: 'Privacy policy',
      alternates: { canonical: '/privacy' },
      robots: { index: false },
    })
    resetFailureMemory()
    fetchMock.mockResolvedValueOnce(
      json(200, {
        slug: 'terms',
        title: 'Our terms',
        body: 'x',
        effectiveDate: null,
        requestId: 'r',
      }),
    )
    const published = await legalMetadata('terms')
    expect(published.title).toBe('Our terms')
    expect(published.robots).toBeUndefined()
  })
})

describe('ContactDetails', () => {
  it('links a valid number and address with tel: and mailto:', async () => {
    const { ContactDetails } = await import('@/components/ContactDetails')
    render(<ContactDetails contacts={{ phone: '+918012345678', email: 'help@tazzzo.example' }} />)
    expect(screen.getByRole('link', { name: '+918012345678' })).toHaveAttribute(
      'href',
      'tel:+918012345678',
    )
    expect(screen.getByRole('link', { name: 'help@tazzzo.example' })).toHaveAttribute(
      'href',
      'mailto:help@tazzzo.example',
    )
  })

  it('nothing to show: the "not available" message and a link to the FAQ', async () => {
    const { ContactDetails } = await import('@/components/ContactDetails')
    for (const contacts of [null, { phone: null, email: null }]) {
      const { unmount } = render(<ContactDetails contacts={contacts} />)
      expect(screen.getByRole('status')).toHaveTextContent(
        "Support details aren't available right now.",
      )
      expect(screen.getByRole('link', { name: 'help articles' })).toHaveAttribute('href', '/faq')
      unmount()
    }
  })
})

describe('contact page (app-config -> validated links)', () => {
  const cfg = (support: unknown) => json(200, { storeOpen: true, support, requestId: 'r' })

  // Mutation note: passing the raw backend string to href (skipping parseSupport/E164_PHONE) makes the first two
  // assertions fail: "call 080-123" or "javascript:..." would become a tel: link.
  it('a phone that is not E.164 never becomes a tel: link, and a hostile email never a mailto:', async () => {
    fetchMock.mockResolvedValueOnce(
      cfg({ phone: 'javascript:alert(1)', email: 'a@b.io?bcc=x@y.io' }),
    )
    const Page = (await import('@/app/contact/page')).default
    const { container } = render(await Page())
    expect(
      container.querySelector('a[href^="tel:"], a[href^="mailto:"], a[href^="javascript:"]'),
    ).toBeNull()
    expect(container.textContent).not.toContain('javascript')
    expect(screen.getByRole('status')).toHaveTextContent(
      "Support details aren't available right now.",
    )
  })

  it('numbers with spaces or a national format are dropped, the valid email still links', async () => {
    fetchMock.mockResolvedValueOnce(cfg({ phone: '080 1234 5678', email: 'help@tazzzo.example' }))
    const Page = (await import('@/app/contact/page')).default
    const { container } = render(await Page())
    expect(container.querySelector('a[href^="tel:"]')).toBeNull()
    expect(screen.getByRole('link', { name: 'help@tazzzo.example' })).toBeInTheDocument()
  })

  it('links to the FAQ; Orders only when signed in', async () => {
    fetchMock.mockResolvedValue(cfg({ phone: '+918012345678' }))
    const Page = (await import('@/app/contact/page')).default
    const anon = render(await Page())
    expect(screen.getByRole('link', { name: /FAQ/ })).toHaveAttribute('href', '/faq')
    expect(screen.queryByRole('link', { name: 'Your orders' })).toBeNull()
    anon.unmount()
    session.current = { csrf: 'x' }
    render(await Page())
    expect(screen.getByRole('link', { name: 'Your orders' })).toHaveAttribute('href', '/orders')
  })

  it('app-config down: the "not available" message, page still renders', async () => {
    fetchMock.mockResolvedValueOnce(json(503, {}))
    const Page = (await import('@/app/contact/page')).default
    render(await Page())
    expect(screen.getByRole('heading', { level: 1, name: 'Contact us' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(
      "Support details aren't available right now.",
    )
  })
})

describe('FAQ page', () => {
  const faq = (faqId: string, category: string, question: string, answer: string) => ({
    faqId,
    category,
    question,
    answer,
  })

  it('groups by category under h2 headings, each question a native disclosure, text escaped', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, {
        faqs: [
          faq('1', 'DELIVERY', 'When <i>arrives</i>?', 'Soon.\nVery soon. <script>x</script>'),
          faq('2', 'PAYMENT', 'How to pay?', 'COD.'),
        ],
        requestId: 'r',
      }),
    )
    const Page = (await import('@/app/faq/page')).default
    const { container } = render(await Page())
    expect(screen.getByRole('heading', { level: 1, name: 'Help and FAQ' })).toBeInTheDocument()
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Delivery',
      'Payment',
    ])
    const items = container.querySelectorAll('details')
    expect(items).toHaveLength(2)
    expect(items[0]!.querySelector('summary')!.textContent).toBe('When <i>arrives</i>?')
    expect(within(items[0] as HTMLElement).getAllByText(/soon/i).length).toBe(2)
    expect(container.querySelector('i, script')).toBeNull()
    expect(screen.getByRole('region', { name: 'Delivery' })).toBeInTheDocument()
  })

  it('empty state when there are no articles, with a link to Contact', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { faqs: [], requestId: 'r' }))
    const Page = (await import('@/app/faq/page')).default
    const { container } = render(await Page())
    expect(screen.getByRole('status')).toHaveTextContent('There are no help articles yet.')
    expect(container.querySelector('details')).toBeNull()
    expect(screen.getAllByRole('link', { name: /contact us/i })[0]).toHaveAttribute(
      'href',
      '/contact',
    )
  })

  it('backend down: the generic notice', async () => {
    fetchMock.mockResolvedValueOnce(json(503, {}))
    const Page = (await import('@/app/faq/page')).default
    render(await Page())
    expect(screen.getByRole('status')).toHaveTextContent(
      "We can't load the help articles right now",
    )
  })
})

describe('shared pieces', () => {
  it('PageSkeleton is one polite status region with a text alternative; the blocks are hidden from assistive tech', async () => {
    const { PageSkeleton } = await import('@/components/Skeleton')
    const { container } = render(<PageSkeleton label="Searching" />)
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Searching…')
    expect(status).toHaveAttribute('aria-live', 'polite')
    for (const el of container.querySelectorAll('.skeleton__bar, .skeleton__grid')) {
      expect(el).toHaveAttribute('aria-hidden', 'true')
    }
  })

  it('HelpfulLinks: home, optional search, contact; each with a name', async () => {
    const { HelpfulLinks } = await import('@/components/StaticPageNav')
    render(<HelpfulLinks search />)
    const nav = screen.getByRole('navigation', { name: 'Where to next' })
    expect(
      within(nav)
        .getAllByRole('link')
        .map((a) => [a.textContent, a.getAttribute('href')]),
    ).toEqual([
      ['Back to home', '/'],
      ['Try a different search', '/search'],
      ['Contact us', '/contact'],
    ])
  })

  it('PopularCategories lists the super-categories, and nothing when they cannot be read', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, {
        items: [{ id: 'TZS-000001', name: 'Staples' }],
        resolvedReleaseId: 'R',
        requestId: 'r',
      }),
    )
    const { PopularCategories } = await import('@/app/_sections/PopularCategories')
    const ok = render(await PopularCategories())
    expect(screen.getByRole('link', { name: 'Staples' })).toHaveAttribute('href', '/c/TZS-000001')
    ok.unmount()
    resetFailureMemory()
    fetchMock.mockResolvedValueOnce(json(503, {}))
    const { container } = render(await PopularCategories())
    expect(container).toBeEmptyDOMElement()
  })

  it('the header chip keeps its exact text content (optional words are only hidden by CSS)', async () => {
    const { LocationChipLabel } = await import('@/components/LocationChipLabel')
    const text = (loc: Parameters<typeof LocationChipLabel>[0]['location']) => {
      const { container, unmount } = render(<LocationChipLabel location={loc} />)
      const t = container.textContent
      unmount()
      return t
    }
    expect(text(null)).toBe('Set delivery location')
    expect(text({ pin: '560001', serviceable: true, viaAddress: false })).toBe('Deliver to 560001')
    expect(text({ pin: '400001', serviceable: false, viaAddress: false })).toBe(
      'Not delivering to 400001',
    )
  })
})
