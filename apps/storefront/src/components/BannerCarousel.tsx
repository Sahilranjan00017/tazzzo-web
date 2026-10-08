'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { ImagePlaceholder } from '@/components/ImagePlaceholder'
import { useImageFallback } from '@/components/useImageFallback'
import { bannerSources } from '@/lib/images'

export interface BannerSlide {
  blockId: string
  title: string
  subtitle: string | null
  altText: string
  /** Null when the image cannot be shown: the branded placeholder stands in. */
  imageUrl: string | null
  desktopImageUrl?: string
  href: string | null
}

/** Viewport width from which a banner's wide desktop image is used. */
export const DESKTOP_MEDIA = '(min-width: 768px)'
const AUTOPLAY_MS = 6_000

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'
function subscribeReducedMotion(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function BannerPicture({ slide, priority }: { slide: BannerSlide; priority: boolean }) {
  if (slide.imageUrl === null) {
    return <ImagePlaceholder label={slide.altText} className="banner__media" />
  }
  return (
    <BannerImage
      slide={slide}
      imageUrl={slide.imageUrl}
      desktopImageUrl={slide.desktopImageUrl}
      priority={priority}
    />
  )
}

function BannerImage({
  slide,
  imageUrl,
  desktopImageUrl,
  priority,
}: {
  slide: BannerSlide
  imageUrl: string
  desktopImageUrl: string | undefined
  priority: boolean
}) {
  const { narrow, wide } = bannerSources(imageUrl, desktopImageUrl)
  const { failed, onError, ref } = useImageFallback(narrow)
  if (failed) return <ImagePlaceholder label={slide.altText} className="banner__media" />
  return (
    <picture className="banner__media">
      {wide && <source media={DESKTOP_MEDIA} srcSet={wide} />}
      <img
        ref={ref}
        src={narrow}
        alt={slide.altText}
        width={1600}
        height={900}
        loading={priority ? 'eager' : 'lazy'}
        fetchPriority={priority ? 'high' : 'auto'}
        decoding="async"
        onError={onError}
      />
    </picture>
  )
}

function SlideBody({ slide, priority }: { slide: BannerSlide; priority: boolean }) {
  const content = (
    <>
      <BannerPicture slide={slide} priority={priority} />
      <span className="banner__caption">
        <span className="banner__title">{slide.title}</span>
        {slide.subtitle && <span className="banner__subtitle">{slide.subtitle}</span>}
      </span>
    </>
  )
  return slide.href ? (
    <Link href={slide.href} className="banner__link">
      {content}
    </Link>
  ) : (
    <div className="banner__static">{content}</div>
  )
}

/**
 * Home banners in backend order. One banner is a static hero; several form a carousel (WAI-ARIA APG pattern):
 * previous/next and per-slide buttons, Left/Right arrow keys, and autoplay that stops while the pointer or focus is
 * inside. The pause/play button records the shopper's choice: once paused, nothing (pointer leaving, focus leaving)
 * restarts it except pressing Play. Under `prefers-reduced-motion` there is no autoplay at all, so no pause/play
 * button either. Without JavaScript (and before hydration) the first slide shows and nothing rotates.
 * Only the very first banner on the page loads eagerly (`priority`); every other banner image is lazy.
 */
export function BannerCarousel({ slides, priority }: { slides: BannerSlide[]; priority: boolean }) {
  const [index, setIndex] = useState(0)
  /** The shopper's explicit choice; only the pause/play button changes it. */
  const [userPaused, setUserPaused] = useState(false)
  /** Temporary hold while the pointer or focus is inside the carousel. */
  const [interacting, setInteracting] = useState(false)
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => true,
  )
  const count = slides.length
  const go = useCallback((next: number) => setIndex(((next % count) + count) % count), [count])
  const autoplay = count > 1 && !userPaused && !interacting && !reducedMotion

  useEffect(() => {
    if (!autoplay) return
    const timer = setInterval(() => setIndex((i) => (i + 1) % count), AUTOPLAY_MS)
    return () => clearInterval(timer)
  }, [autoplay, count])

  // All slides share one aspect ratio, so switching slides never shifts the layout: wide (3:1) on desktop only when
  // every slide has a desktop image, otherwise 16:9 everywhere.
  const wide = slides.every((s) => s.desktopImageUrl !== undefined)
  const frameClass = `banner-frame${wide ? ' banner-frame--wide' : ''}`

  if (count === 1) {
    const only = slides[0]!
    return (
      <section className="banners" aria-label={only.title} data-testid="banner-hero">
        <div className={frameClass}>
          <div className="banner" data-block-id={only.blockId}>
            <SlideBody slide={only} priority={priority} />
          </div>
        </div>
      </section>
    )
  }

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      go(index + 1)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      go(index - 1)
    }
  }

  return (
    <section
      className="banners"
      aria-roledescription="carousel"
      aria-label="Featured offers"
      data-testid="banner-carousel"
      onKeyDown={onKeyDown}
      onMouseEnter={() => setInteracting(true)}
      onMouseLeave={() => setInteracting(false)}
      onFocus={() => setInteracting(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setInteracting(false)
      }}
    >
      <div className="banners__controls">
        {!reducedMotion && (
          <button
            type="button"
            className="banners__toggle"
            onClick={() => setUserPaused((p) => !p)}
            aria-label={userPaused ? 'Play slideshow' : 'Pause slideshow'}
          >
            {userPaused ? 'Play' : 'Pause'}
          </button>
        )}
        <button type="button" onClick={() => go(index - 1)} aria-label="Previous slide">
          ‹
        </button>
        <button type="button" onClick={() => go(index + 1)} aria-label="Next slide">
          ›
        </button>
      </div>
      <div className={frameClass} aria-live={autoplay ? 'off' : 'polite'}>
        {slides.map((slide, i) => (
          <div
            key={slide.blockId}
            className="banner"
            role="group"
            aria-roledescription="slide"
            aria-label={`${i + 1} of ${count}: ${slide.title}`}
            data-block-id={slide.blockId}
            hidden={i !== index}
          >
            <SlideBody slide={slide} priority={priority && i === 0} />
          </div>
        ))}
      </div>
      <div className="banners__dots">
        {slides.map((slide, i) => (
          <button
            key={slide.blockId}
            type="button"
            className="banners__dot"
            aria-label={`Show slide ${i + 1}: ${slide.title}`}
            aria-current={i === index ? 'true' : undefined}
            onClick={() => go(i)}
          />
        ))}
      </div>
    </section>
  )
}
