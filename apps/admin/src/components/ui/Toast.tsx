'use client'

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

export type ToastKind = 'success' | 'error' | 'info'
interface ToastItem {
  id: number
  kind: ToastKind
  message: string
}

interface ToastApi {
  toast: (kind: ToastKind, message: string) => void
}

const ToastContext = createContext<ToastApi | null>(null)
const AUTO_DISMISS_MS = 6_000

/** Toast host. Success/info auto-dismiss; errors stay until dismissed. Messages are plain text, never HTML. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => setItems((cur) => cur.filter((t) => t.id !== id)), [])
  const toast = useCallback(
    (kind: ToastKind, message: string) => {
      const id = nextId.current++
      setItems((cur) => [...cur.slice(-4), { id, kind, message }])
      if (kind !== 'error') setTimeout(() => dismiss(id), AUTO_DISMISS_MS)
    },
    [dismiss],
  )
  const api = useMemo(() => ({ toast }), [toast])

  return (
    <ToastContext value={api}>
      {children}
      <div className="toast-region" aria-label="Notifications">
        {items.map((t) => (
          <div
            key={t.id}
            className={`toast toast-${t.kind}`}
            role={t.kind === 'error' ? 'alert' : 'status'}
          >
            <span>{t.message}</span>
            <button
              type="button"
              className="toast-close"
              aria-label="Dismiss notification"
              onClick={() => dismiss(t.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext>
  )
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside ToastProvider')
  return ctx
}
