import type { Metadata } from 'next'
import Link from 'next/link'
import { ContactDetails } from '@/components/ContactDetails'
import { getSupportContacts } from '@/server/backend/content'
import { readSession } from '@/server/session/cookies'

export const metadata: Metadata = {
  title: 'Contact us',
  description: 'How to reach Tazzzo support.',
  alternates: { canonical: '/contact' },
}

/**
 * Support contacts from `GET /v1/app-config` (`support.phone`, `support.email`). Only values that match the strict
 * E.164 / plain-address grammars become `tel:` / `mailto:` links (`lib/support.ts`); anything else is treated as not
 * set. Signed-in customers also get a link to their orders.
 */
export default async function ContactPage() {
  const [contacts, session] = await Promise.all([getSupportContacts(), readSession()])
  return (
    <section className="prose contact" aria-labelledby="contact-title">
      <h1 id="contact-title">Contact us</h1>
      <ContactDetails contacts={contacts} />
      <ul className="contact__more">
        <li>
          <Link href="/faq">Read the help and FAQ</Link>
        </li>
        {session !== null && (
          <li>
            <Link href="/orders">Your orders</Link>
          </li>
        )}
      </ul>
    </section>
  )
}
