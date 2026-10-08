'use client'

import { ImagePlaceholder } from '@/components/ImagePlaceholder'
import { useImageFallback } from '@/components/useImageFallback'

export interface SafeImageProps {
  src: string
  alt: string
  width: number
  height: number
  className?: string
  /** Above-the-fold image: loaded eagerly with high priority. Everything else is lazy. */
  priority?: boolean
}

/** An `<img>` with explicit dimensions (no layout shift) that degrades to the branded placeholder on failure. */
export function SafeImage({
  src,
  alt,
  width,
  height,
  className,
  priority = false,
}: SafeImageProps) {
  const { failed, onError, ref } = useImageFallback(src)
  if (failed) return <ImagePlaceholder label={alt} className={className} />
  return (
    // eslint-disable-next-line @next/next/no-img-element -- plain <img>: CDN URLs are rendered as given, no optimizer
    <img
      ref={ref}
      src={src}
      alt={alt}
      width={width}
      height={height}
      className={className}
      loading={priority ? 'eager' : 'lazy'}
      fetchPriority={priority ? 'high' : 'auto'}
      decoding="async"
      onError={onError}
    />
  )
}
