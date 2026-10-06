import Link from 'next/link'
import { EmptyState } from '@/components/ui/primitives'

export default function NotFound() {
  return (
    <EmptyState
      title="Not found"
      message="That page or record does not exist, or you cannot see it."
      action={
        <Link className="btn" href="/">
          Back to Home
        </Link>
      }
    />
  )
}
