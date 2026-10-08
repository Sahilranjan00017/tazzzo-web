/**
 * Neutral branded tile shown wherever an image is missing, not allowed, or failed to load (CDN down). It keeps the
 * image's box and exposes the image's alt text, so the page layout and its meaning survive without the picture.
 */
export function ImagePlaceholder({ label, className }: { label: string; className?: string }) {
  // An empty label means a decorative image (e.g. a labelled thumbnail button): hidden from assistive technology.
  const a11y = label === '' ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label }
  return (
    <div
      {...a11y}
      className={['img-fallback', className].filter(Boolean).join(' ')}
      data-testid="image-fallback"
    >
      <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false" className="img-fallback__mark">
        <circle cx="24" cy="24" r="22" />
        <path d="M15 17h18v4h-7v14h-4V21h-7z" />
      </svg>
    </div>
  )
}
