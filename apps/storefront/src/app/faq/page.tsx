import type { Metadata } from 'next'
import Link from 'next/link'
import { Unavailable } from '@/components/Unavailable'
import { groupFaqs } from '@/lib/content/faqs'
import { getFaqs } from '@/server/backend/content'

export const metadata: Metadata = {
  title: 'Help and FAQ',
  description:
    'Answers to common questions about delivery, payment, refunds and your Tazzzo account.',
  alternates: { canonical: '/faq' },
}

/**
 * Help centre (`GET /v1/content/faqs`, the backend's live FAQ in its own order), grouped by category. Each question is
 * a native `<details>`/`<summary>`: keyboard and screen-reader accessible and it needs no client JavaScript. Question
 * and answer are plain text rendered escaped. Cached like every read (60 s).
 */
export default async function FaqPage() {
  const result = await getFaqs()
  const groups = result.ok ? groupFaqs(result.faqs) : []
  return (
    <section className="prose faq" aria-labelledby="faq-title">
      <h1 id="faq-title">Help and FAQ</h1>
      {!result.ok && <Unavailable what="the help articles" />}
      {result.ok && groups.length === 0 && (
        <div className="notice" role="status" data-testid="faq-empty">
          <p>
            There are no help articles yet. If you need a hand,{' '}
            <Link href="/contact">contact us</Link>.
          </p>
        </div>
      )}
      {groups.map((group) => (
        <section
          key={group.category}
          aria-labelledby={`faq-${group.category}`}
          className="faq__group"
        >
          <h2 id={`faq-${group.category}`}>{group.label}</h2>
          {group.faqs.map((faq) => (
            <details key={faq.id} className="faq__item">
              <summary>{faq.question}</summary>
              <div className="faq__answer">
                {faq.paragraphs.map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
              </div>
            </details>
          ))}
        </section>
      ))}
      <p className="prose__foot">
        Can&apos;t find what you need? <Link href="/contact">Contact us</Link>.
      </p>
    </section>
  )
}
