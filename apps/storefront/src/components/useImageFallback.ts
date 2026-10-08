'use client'

import { useCallback, useState } from 'react'

/**
 * Tracks whether the image for `src` failed. Two paths, because a server-rendered `<img>` can fail BEFORE React
 * hydrates and attaches `onError` (a CDN that refuses connections fails fast):
 * - `onError` for failures after hydration;
 * - the ref callback for failures that already happened: `complete` with no decoded pixels means broken.
 * A lazy image that has not started loading is not `complete`, so it is never misreported.
 */
export function useImageFallback(src: string) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const onError = useCallback(() => setFailedSrc(src), [src])
  const ref = useCallback(
    (img: HTMLImageElement | null) => {
      if (img && img.complete && img.naturalWidth === 0) setFailedSrc(src)
    },
    [src],
  )
  return { failed: failedSrc === src, onError, ref }
}
