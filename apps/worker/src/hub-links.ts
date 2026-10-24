import type { connectedSource } from '@voicespark/db';

/** The provider "open original" link (data-model.md `hub_thread_source`): Gmail only; Graph and IMAP give none here. */
export function webLinkFor(type: (typeof connectedSource.$inferSelect)['type'], providerRef: string): string | null {
  return type === 'gmail' ? `https://mail.google.com/mail/#all/${encodeURIComponent(providerRef)}` : null;
}
