import { render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

beforeAll(() => {
  vi.stubEnv('TAZZZO_API_BASE_URL', 'https://api.tazzzo.test')
  vi.stubEnv('TAZZZO_SITE_URL', 'https://www.tazzzo.test')
  vi.stubEnv('TAZZZO_MEDIA_BASE_URL', 'https://cdn.tazzzo.test')
})

afterEach(() => vi.unstubAllGlobals())

describe('RailSection (server component: rail ids -> product reads -> cards)', () => {
  it('one batch read: skips missing products silently and keeps the rail order', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchMock = vi.fn(async (url: string) => {
      const ids = new URL(url).searchParams.get('ids')!.split(',')
      const found = ids.filter((id) => id !== 'TZP-404')
      return new Response(
        JSON.stringify({
          resolvedReleaseId: 'R1',
          items: found.map((id) => ({
            productId: id,
            name: `Name ${id}`,
            thumbnailUrl: `https://cdn.tazzzo.test/${id}.png`,
          })),
          missing: ids.filter((id) => id === 'TZP-404'),
          requestId: 'r',
        }),
        { status: 200 },
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    const { RailSection } = await import('@/app/_sections/RailSection')
    render(
      await RailSection({
        block: {
          type: 'PRODUCT_RAIL',
          blockId: 'R',
          title: 'Picks',
          ids: ['TZP-3', 'TZP-404', 'TZP-1'],
        },
      }),
    )
    const cards = within(screen.getByRole('region', { name: 'Picks' })).getAllByRole('article')
    expect(cards.map((c) => c.dataset.productId)).toEqual(['TZP-3', 'TZP-1'])
    expect(screen.queryByText(/TZP-404/)).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![0]).toContain('/v1/products:batch?ids=TZP-3,TZP-404,TZP-1')
  })

  it('renders no rail (and no heading) when the batch read fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchMock = vi.fn(async () => new Response('{}', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    const { RailSection } = await import('@/app/_sections/RailSection')
    const { container } = render(
      await RailSection({
        block: { type: 'PRODUCT_RAIL', blockId: 'R2', title: 'Down', ids: ['TZP-3', 'TZP-1'] },
      }),
    )
    expect(container).toBeEmptyDOMElement()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
