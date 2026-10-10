/**
 * Placeholder while a page's data streams in. A single polite status region with a text alternative, so a screen
 * reader hears "Loading" once rather than a list of empty boxes; the blocks are decorative. Heights are fixed (CSS), so
 * the real content replacing it moves the footer, not the header.
 */
export function PageSkeleton({
  label = 'Loading',
  variant = 'grid',
  titleBar = true,
}: {
  label?: string
  variant?: 'grid' | 'list'
  /** A placeholder for the page title; off when the real heading is already on screen. */
  titleBar?: boolean
}) {
  return (
    <div className="skeleton" role="status" aria-live="polite" data-testid="page-skeleton">
      <span className="visually-hidden">{label}…</span>
      {titleBar && <div className="skeleton__bar skeleton__bar--title" aria-hidden="true" />}
      {variant === 'grid' ? (
        <div className="skeleton__grid" aria-hidden="true">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="skeleton__card" />
          ))}
        </div>
      ) : (
        <div className="skeleton__list" aria-hidden="true">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="skeleton__row" />
          ))}
        </div>
      )}
    </div>
  )
}
