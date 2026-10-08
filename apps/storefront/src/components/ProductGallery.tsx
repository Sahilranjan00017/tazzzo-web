'use client'

import { useRef, useState, type KeyboardEvent } from 'react'
import { ImagePlaceholder } from '@/components/ImagePlaceholder'
import { SafeImage } from '@/components/SafeImage'
import type { GalleryImage } from '@/lib/images'

/**
 * Product images in backend order (primary first, then gallery). The thumbnails are buttons: Tab reaches them,
 * Enter/Space selects, and Left/Right/Home/End move the selection and focus along the strip. Any image that fails
 * to load becomes the branded placeholder without affecting the others.
 */
export function ProductGallery({
  images,
  productName,
}: {
  images: GalleryImage[]
  productName: string
}) {
  const [selected, setSelected] = useState(0)
  const thumbs = useRef<Array<HTMLButtonElement | null>>([])
  const current = images[selected]

  if (!current) {
    return (
      <div className="gallery">
        <ImagePlaceholder label={productName} className="gallery__main" />
      </div>
    )
  }

  const select = (i: number, focus: boolean) => {
    const next = Math.max(0, Math.min(images.length - 1, i))
    setSelected(next)
    if (focus) thumbs.current[next]?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    // Move from the thumbnail that has focus (it can differ from the selected one after Tab or a click elsewhere).
    const focused = thumbs.current.indexOf(event.target as HTMLButtonElement)
    const from = focused >= 0 ? focused : selected
    const moves: Record<string, number> = {
      ArrowRight: from + 1,
      ArrowDown: from + 1,
      ArrowLeft: from - 1,
      ArrowUp: from - 1,
      Home: 0,
      End: images.length - 1,
    }
    const target = moves[event.key]
    if (target === undefined) return
    event.preventDefault()
    select(target, true)
  }

  return (
    <div className="gallery" data-testid="product-gallery">
      <div className="gallery__main" data-selected-url={current.url}>
        <SafeImage
          key={current.url}
          src={current.url}
          alt={current.alt}
          width={current.width ?? 800}
          height={current.height ?? 800}
          className="gallery__image"
          priority
        />
      </div>
      {images.length > 1 && (
        <ul className="gallery__thumbs" aria-label="Product images" onKeyDown={onKeyDown}>
          {images.map((image, i) => (
            <li key={image.url}>
              <button
                type="button"
                ref={(el) => {
                  thumbs.current[i] = el
                }}
                className="gallery__thumb"
                aria-label={`Show image ${i + 1} of ${images.length}: ${image.alt}`}
                aria-pressed={i === selected}
                onClick={() => select(i, false)}
              >
                <SafeImage src={image.url} alt="" width={80} height={80} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
