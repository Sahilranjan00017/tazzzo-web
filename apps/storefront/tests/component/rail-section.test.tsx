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
  it('skips missing products silently and keeps the rail order', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const id = url.split('/').pop()!
        if (id === 'TZP-404') return new Response('{}', { status: 404 })
        return new Response(
          JSON.stringify({
            productId: id,
            name: `Name ${id}`,
            thumbnailUrl: `https://cdn.tazzzo.test/${id}.png`,
          }),
          { status: 200 },
        )
      }),
    )
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
  })
})
