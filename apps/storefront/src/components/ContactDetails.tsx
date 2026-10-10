import Link from 'next/link'
import { mailtoHref, telHref, type SupportContacts } from '@/lib/support'

/**
 * Support details. `contacts` is already validated (`parseSupport`): the phone is E.164 and the address a plain
 * address, so the `href`s below cannot carry anything else. `null` or an empty set shows the "not available" message.
 */
export function ContactDetails({ contacts }: { contacts: SupportContacts | null }) {
  if (contacts === null || (contacts.phone === null && contacts.email === null)) {
    return (
      <div className="notice" role="status" data-testid="contact-unavailable">
        <p>Support details aren&apos;t available right now.</p>
        <p>
          Our <Link href="/faq">help articles</Link> may have your answer.
        </p>
      </div>
    )
  }
  return (
    <dl className="contact__list">
      {contacts.phone !== null && (
        <>
          <dt>Phone</dt>
          <dd>
            <a href={telHref(contacts.phone)} data-testid="contact-phone">
              {contacts.phone}
            </a>
          </dd>
        </>
      )}
      {contacts.email !== null && (
        <>
          <dt>Email</dt>
          <dd>
            <a href={mailtoHref(contacts.email)} data-testid="contact-email">
              {contacts.email}
            </a>
          </dd>
        </>
      )}
    </dl>
  )
}
