import { ProductTitleForm } from '@/components/ProductTitleForm'

/**
 * W3 BFF reference page (internal): proves browser -> CMS BFF -> backend for one existing, reversible, audited
 * catalog command. Not a CMS module; the protected layout has already required a valid session and backend identity.
 */
export default function ProductTitleReferencePage() {
  return (
    <section aria-labelledby="ref-title">
      <h1 id="ref-title">BFF reference: rename a product</h1>
      <p className="muted">
        Internal reference control. The backend authorizes the change (cms-writer only).
      </p>
      <ProductTitleForm />
    </section>
  )
}
