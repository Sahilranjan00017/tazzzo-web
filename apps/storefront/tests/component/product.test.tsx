import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ProductGallery } from '@/components/ProductGallery'
import { ProductRail } from '@/components/ProductRail'
import { SafeImage } from '@/components/SafeImage'
import type { ProductSummary } from '@/lib/products'

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

const product = (id: string, over: Partial<ProductSummary> = {}): ProductSummary => ({
  productId: id,
  name: `Product ${id}`,
  brandName: null,
  packSize: null,
  sellingPricePaise: 15950,
  mrpPaise: 19900,
  image: { url: `https://cdn.test/${id}.jpg`, alt: `Product ${id}`, width: null, height: null },
  ...over,
})

describe('SafeImage', () => {
  it('renders the image with explicit dimensions, then the placeholder (with the alt text) on error', () => {
    render(<SafeImage src="https://cdn.test/a.jpg" alt="Front of pack" width={320} height={320} />)
    const img = screen.getByAltText('Front of pack')
    expect(img).toHaveAttribute('width', '320')
    expect(img).toHaveAttribute('loading', 'lazy')
    fireEvent.error(img)
    expect(screen.getByRole('img', { name: 'Front of pack' })).toHaveAttribute(
      'data-testid',
      'image-fallback',
    )
  })

  it('a decorative image falls back to a placeholder hidden from assistive technology', () => {
    render(<SafeImage src="https://cdn.test/a.jpg" alt="" width={80} height={80} />)
    fireEvent.error(document.querySelector('img')!)
    const fallback = screen.getByTestId('image-fallback')
    expect(fallback).toHaveAttribute('aria-hidden', 'true')
    expect(fallback).not.toHaveAttribute('role')
  })
})

describe('ProductRail', () => {
  it('renders the given products in order with name, image and price', () => {
    render(
      <ProductRail
        blockId="R1"
        title="Bestsellers"
        products={[product('TZP-2'), product('TZP-1')]}
      />,
    )
    const rail = screen.getByRole('region', { name: 'Bestsellers' })
    const cards = within(rail).getAllByRole('article')
    expect(cards.map((c) => c.dataset.productId)).toEqual(['TZP-2', 'TZP-1'])
    expect(within(cards[0]!).getByRole('heading', { name: 'Product TZP-2' })).toBeInTheDocument()
    expect(within(cards[0]!).getByRole('link')).toHaveAttribute('href', '/p/TZP-2')
    expect(cards[0]).toHaveTextContent('₹159.50')
    expect(cards[0]).toHaveTextContent('MRP ₹199')
  })

  it('a product without an image shows the placeholder; without a price shows no price', () => {
    render(
      <ProductRail
        blockId="R1"
        title="Rail"
        products={[product('TZP-1', { image: null, sellingPricePaise: null })]}
      />,
    )
    expect(screen.getByRole('img', { name: 'Product TZP-1' })).toHaveAttribute(
      'data-testid',
      'image-fallback',
    )
    expect(screen.queryByText(/₹/)).toBeNull()
  })

  it('renders nothing when no product resolved (no empty heading)', () => {
    const { container } = render(<ProductRail blockId="R1" title="Empty" products={[]} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('ProductGallery', () => {
  const images = [
    { url: 'https://cdn.test/a.jpg', alt: 'Front', width: 800, height: 800 },
    { url: 'https://cdn.test/b.jpg', alt: 'Dal', width: null, height: null },
    { url: 'https://cdn.test/c.jpg', alt: 'Back', width: null, height: null },
  ]
  const main = () => screen.getByTestId('product-gallery').querySelector('.gallery__main')!

  it('shows the first (primary) image and labelled thumbnails in order', () => {
    render(<ProductGallery images={images} productName="Dal" />)
    expect(within(main() as HTMLElement).getByRole('img')).toHaveAttribute('alt', 'Front')
    const thumbs = within(screen.getByRole('list', { name: 'Product images' })).getAllByRole(
      'button',
    )
    expect(thumbs.map((t) => t.getAttribute('aria-label'))).toEqual([
      'Show image 1 of 3: Front',
      'Show image 2 of 3: Dal',
      'Show image 3 of 3: Back',
    ])
    expect(thumbs[0]).toHaveAttribute('aria-pressed', 'true')
  })

  it('thumbnails work by click and by keyboard (arrows, Home, End move selection and focus)', async () => {
    const user = userEvent.setup()
    render(<ProductGallery images={images} productName="Dal" />)
    const thumbs = within(screen.getByRole('list', { name: 'Product images' })).getAllByRole(
      'button',
    )
    await user.click(thumbs[2]!)
    expect(within(main() as HTMLElement).getByRole('img')).toHaveAttribute('alt', 'Back')
    thumbs[0]!.focus()
    await user.keyboard('{ArrowRight}')
    expect(thumbs[1]).toHaveFocus()
    expect(thumbs[1]).toHaveAttribute('aria-pressed', 'true')
    expect(within(main() as HTMLElement).getByRole('img')).toHaveAttribute(
      'src',
      'https://cdn.test/b.jpg',
    )
    await user.keyboard('{End}')
    expect(thumbs[2]).toHaveFocus()
    await user.keyboard('{Home}')
    expect(thumbs[0]).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(thumbs[0]).toHaveFocus() // clamps at the start
  })

  it('a failing main image becomes the placeholder; other images still work', async () => {
    const user = userEvent.setup()
    render(<ProductGallery images={images} productName="Dal" />)
    fireEvent.error(within(main() as HTMLElement).getByRole('img'))
    expect(within(main() as HTMLElement).getByRole('img')).toHaveAttribute(
      'data-testid',
      'image-fallback',
    )
    await user.click(screen.getByRole('button', { name: 'Show image 3 of 3: Back' }))
    expect(within(main() as HTMLElement).getByRole('img')).toHaveAttribute(
      'src',
      'https://cdn.test/c.jpg',
    )
  })

  it('no images: a single placeholder labelled with the product name, no thumbnails', () => {
    render(<ProductGallery images={[]} productName="Dal" />)
    expect(screen.getByRole('img', { name: 'Dal' })).toHaveAttribute(
      'data-testid',
      'image-fallback',
    )
    expect(screen.queryByRole('button')).toBeNull()
  })
})
