'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { GOTO_HELP, resolveGoto } from '@/lib/goto'

/** Top-bar jump-to-id box. Press `/` anywhere (outside a field) to focus it. Not a search: see `lib/goto.ts`. */
export function GotoBox({ roles }: { roles: readonly string[] }) {
  const router = useRouter()
  const input = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string>()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      const typing =
        t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT' ||
          t.isContentEditable)
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        input.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  function submit(e: FormEvent) {
    e.preventDefault()
    const result = resolveGoto(input.current?.value ?? '', roles)
    if (!result.ok) return setError(result.reason)
    setError(undefined)
    if (input.current) input.current.value = ''
    router.push(result.target.href)
  }

  return (
    <form className="goto" role="search" aria-label="Go to an id" onSubmit={submit}>
      <input
        ref={input}
        type="text"
        name="goto"
        placeholder="Go to id…  ( / )"
        aria-label="Go to an id"
        aria-describedby="goto-help"
        aria-invalid={error ? true : undefined}
        autoComplete="off"
        spellCheck={false}
        maxLength={80}
        onChange={() => error && setError(undefined)}
      />
      <span id="goto-help" className="sr-only">
        {GOTO_HELP}
      </span>
      {error ? (
        <p className="goto-error" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  )
}
