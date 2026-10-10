import Link from 'next/link'
import { Unavailable } from '@/components/Unavailable'
import { formatEffectiveDate, type LegalSlug } from '@/lib/content/legal'
import { getLegal } from '@/server/backend/content'

const FALLBACK_TITLE: Record<LegalSlug, string> = {
  terms: 'Terms of service',
  privacy: 'Privacy policy',
}

export async function legalMetadata(slug: LegalSlug) {
  const result = await getLegal(slug)
  return {
    title: result.ok ? result.document.title : FALLBACK_TITLE[slug],
    alternates: { canonical: `/${slug}` },
    // A page that says "not published" must not be indexed as the policy.
    robots: result.ok ? undefined : { index: false, follow: true },
  }
}

/**
 * A legal document (`GET /v1/content/legal/{slug}`). The body is plain text: each blank-line separated paragraph is
 * one `<p>` with the text escaped by React; it is never parsed as HTML or Markdown.
 *
 * Not published (the backend's flat 404) is a real page, HTTP 200, with a friendly message and a way to reach us: the
 * route exists, only its content does not yet, so a 404 status would misreport the site's structure and strand a
 * customer who followed a link from the sign-in page. It is `noindex` and left out of the sitemap while unpublished.
 * Backend trouble (429, 5xx, timeout) is the usual "can't load right now" notice.
 */
export async function LegalPage({ slug }: { slug: LegalSlug }) {
  const result = await getLegal(slug)
  const titleId = `${slug}-title`
  if (result.ok) {
    const { document } = result
    return (
      <article className="prose legal" aria-labelledby={titleId} data-legal={slug}>
        <h1 id={titleId}>{document.title}</h1>
        {document.effectiveDate && (
          <p className="legal__date">
            Effective{' '}
            <time dateTime={document.effectiveDate}>
              {formatEffectiveDate(document.effectiveDate)}
            </time>
          </p>
        )}
        {document.paragraphs.map((p, i) => (
          <p key={i} className="legal__p">
            {p}
          </p>
        ))}
      </article>
    )
  }
  return (
    <section className="prose legal" aria-labelledby={titleId} data-legal={slug}>
      <h1 id={titleId}>{FALLBACK_TITLE[slug]}</h1>
      {result.reason === 'unpublished' ? (
        <div className="notice" role="status" data-testid="legal-unpublished">
          <p>This document hasn&apos;t been published yet.</p>
          <p>
            If you have a question in the meantime, <Link href="/contact">contact us</Link>.
          </p>
        </div>
      ) : (
        <Unavailable what="this document" />
      )}
    </section>
  )
}
