'use client'

import { useEffect } from 'react'

/** Marks the page as hydrated (`<body data-hydrated>`), so a test (or a script) knows the buttons are live. */
export function Hydrated() {
  useEffect(() => {
    document.body.dataset.hydrated = 'true'
  }, [])
  return null
}
