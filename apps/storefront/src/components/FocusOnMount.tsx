'use client'

import { useEffect, useRef, type ReactNode } from 'react'

/**
 * A heading that takes focus once when it appears (a result page the customer was just sent to, so a screen reader
 * announces it and a keyboard user starts there). The server renders it; this only moves focus.
 */
export function FocusOnMount({
  id,
  className,
  children,
}: {
  id?: string
  className?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [])
  return (
    <h1 id={id} className={className} tabIndex={-1} ref={ref}>
      {children}
    </h1>
  )
}
