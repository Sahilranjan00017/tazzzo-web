import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BannerCarousel, DESKTOP_MEDIA, type BannerSlide } from '@/components/BannerCarousel'

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

const slide = (n: number, over: Partial<BannerSlide> = {}): BannerSlide => ({
  blockId: `CB_${n}`,
  title: `Offer ${n}`,
  subtitle: null,
  altText: `Alt ${n}`,
  imageUrl: `https://cdn.test/m/${n}.jpg`,
  href: `/p/TZP-${n}`,
  ...over,
})

afterEach(() => vi.useRealTimers())

function slides(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('[aria-roledescription="slide"]')]
}

describe('BannerCarousel', () => {
  it('a single banner is a static hero: <picture> with the desktop source, alt text, eager, no controls', () => {
    const { container } = render(
      <BannerCarousel
        slides={[
          slide(1, { desktopImageUrl: 'https://cdn.test/m/1w.jpg', subtitle: 'Today only' }),
        ]}
        priority
      />,
    )
    const picture = container.querySelector('picture')!
    const source = picture.querySelector('source')!
    expect(source).toHaveAttribute('media', DESKTOP_MEDIA)
    expect(source).toHaveAttribute('srcset', 'https://cdn.test/m/1w.jpg')
    const img = within(picture).getByRole('img')
    expect(img).toHaveAttribute('src', 'https://cdn.test/m/1.jpg')
    expect(img).toHaveAttribute('alt', 'Alt 1')
    expect(img).toHaveAttribute('loading', 'eager')
    expect(img).toHaveAttribute('width')
    expect(img).toHaveAttribute('height')
    expect(screen.getByText('Today only')).toBeInTheDocument()
    expect(screen.getByRole('link')).toHaveAttribute('href', '/p/TZP-1')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('without a desktop image there is no <source>: imageUrl is used at every width', () => {
    const { container } = render(<BannerCarousel slides={[slide(1)]} priority={false} />)
    expect(container.querySelector('source')).toBeNull()
    expect(container.querySelector('img')).toHaveAttribute('loading', 'lazy')
  })

  it('a banner without a valid link is not clickable', () => {
    render(<BannerCarousel slides={[slide(1, { href: null })]} priority />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByAltText('Alt 1')).toBeInTheDocument()
  })

  it('renders slides in the given order; only the first is visible and only the first loads eagerly', () => {
    const { container } = render(
      <BannerCarousel slides={[slide(1), slide(2), slide(3)]} priority />,
    )
    const all = slides(container)
    expect(all.map((s) => s.dataset.blockId)).toEqual(['CB_1', 'CB_2', 'CB_3'])
    expect(all.map((s) => s.hidden)).toEqual([false, true, true])
    expect([...container.querySelectorAll('img')].map((i) => i.getAttribute('loading'))).toEqual([
      'eager',
      'lazy',
      'lazy',
    ])
    expect(all[1]).toHaveAttribute('aria-label', '2 of 3: Offer 2')
  })

  it('shows the branded placeholder with the alt text when the image fails to load', () => {
    render(<BannerCarousel slides={[slide(1)]} priority />)
    fireEvent.error(screen.getByAltText('Alt 1'))
    expect(screen.queryByAltText('Alt 1')).toBeNull()
    const fallback = screen.getByTestId('image-fallback')
    expect(fallback).toHaveAttribute('role', 'img')
    expect(fallback).toHaveAttribute('aria-label', 'Alt 1')
    // The banner itself (title, link) survives.
    expect(screen.getByRole('link')).toHaveTextContent('Offer 1')
  })

  it('next/previous buttons, dots and arrow keys change the slide; dots expose the current one', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <BannerCarousel slides={[slide(1), slide(2), slide(3)]} priority />,
    )
    const visible = () => slides(container).findIndex((s) => !s.hidden)
    await user.click(screen.getByRole('button', { name: 'Next slide' }))
    expect(visible()).toBe(1)
    await user.click(screen.getByRole('button', { name: 'Previous slide' }))
    await user.click(screen.getByRole('button', { name: 'Previous slide' }))
    expect(visible()).toBe(2) // wraps
    await user.click(screen.getByRole('button', { name: 'Show slide 1: Offer 1' }))
    expect(visible()).toBe(0)
    expect(screen.getByRole('button', { name: 'Show slide 1: Offer 1' })).toHaveAttribute(
      'aria-current',
      'true',
    )
    screen.getByRole('button', { name: 'Next slide' }).focus()
    await user.keyboard('{ArrowRight}')
    expect(visible()).toBe(1)
    await user.keyboard('{ArrowLeft}{ArrowLeft}')
    expect(visible()).toBe(2)
  })

  it('autoplays, and the pause button stops it', () => {
    vi.useFakeTimers()
    const { container } = render(<BannerCarousel slides={[slide(1), slide(2)]} priority />)
    const visible = () => slides(container).findIndex((s) => !s.hidden)
    act(() => vi.advanceTimersByTime(6_000))
    expect(visible()).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: 'Pause slideshow' }))
    act(() => vi.advanceTimersByTime(30_000))
    expect(visible()).toBe(1)
    expect(screen.getByRole('button', { name: 'Play slideshow' })).toBeInTheDocument()
  })

  it('an explicit pause survives the pointer and focus leaving; only Play resumes', () => {
    vi.useFakeTimers()
    const { container } = render(<BannerCarousel slides={[slide(1), slide(2)]} priority />)
    const region = screen.getByTestId('banner-carousel')
    const visible = () => slides(container).findIndex((s) => !s.hidden)
    fireEvent.mouseEnter(region)
    fireEvent.click(screen.getByRole('button', { name: 'Pause slideshow' }))
    fireEvent.mouseLeave(region)
    fireEvent.focus(screen.getByRole('button', { name: 'Next slide' }))
    fireEvent.blur(screen.getByRole('button', { name: 'Next slide' }), {
      relatedTarget: document.body,
    })
    act(() => vi.advanceTimersByTime(30_000))
    expect(visible()).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Play slideshow' }))
    act(() => vi.advanceTimersByTime(6_000))
    expect(visible()).toBe(1)
  })

  it('hover only holds autoplay temporarily when the shopper did not pause', () => {
    vi.useFakeTimers()
    const { container } = render(<BannerCarousel slides={[slide(1), slide(2)]} priority />)
    const region = screen.getByTestId('banner-carousel')
    const visible = () => slides(container).findIndex((s) => !s.hidden)
    fireEvent.mouseEnter(region)
    act(() => vi.advanceTimersByTime(30_000))
    expect(visible()).toBe(0)
    fireEvent.mouseLeave(region)
    act(() => vi.advanceTimersByTime(6_000))
    expect(visible()).toBe(1)
  })

  it('a banner whose image cannot be shown renders the placeholder and keeps its link', () => {
    render(<BannerCarousel slides={[slide(1, { imageUrl: null })]} priority />)
    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByRole('img', { name: 'Alt 1' })).toHaveAttribute(
      'data-testid',
      'image-fallback',
    )
    expect(screen.getByRole('link')).toHaveAttribute('href', '/p/TZP-1')
  })

  it('does not autoplay under prefers-reduced-motion', () => {
    vi.useFakeTimers()
    const original = window.matchMedia
    window.matchMedia = ((q: string) => ({
      ...original(q),
      matches: q.includes('reduce'),
    })) as typeof window.matchMedia
    try {
      const { container } = render(<BannerCarousel slides={[slide(1), slide(2)]} priority />)
      act(() => vi.advanceTimersByTime(30_000))
      expect(slides(container).findIndex((s) => !s.hidden)).toBe(0)
      // Nothing rotates, so there is nothing to pause: no misleading (disabled) "Play" control.
      expect(screen.queryByRole('button', { name: /slideshow/ })).toBeNull()
      expect(screen.getByRole('button', { name: 'Next slide' })).toBeEnabled()
    } finally {
      window.matchMedia = original
    }
  })
})
