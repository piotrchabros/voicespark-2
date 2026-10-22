import { redirect } from 'next/navigation';
import * as filterPreferences from '@voicespark/core/services/filter-preferences';
import { CONSENT_SUMMARY } from '@voicespark/integrations/oauth';
import { ConnectForms } from '@/components/sources/connect-forms';
import { requireUserOrRedirect } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

const ERROR_MESSAGES: Record<string, string> = {
  oauth_cancelled: 'You cancelled at the provider, so no mailbox was connected.',
  oauth_failed: 'The connection could not be completed. Please try again.',
};

const view = (s: { title: string; items: string[] }) => ({ title: s.title, items: s.items });

export default async function ConnectSourcePage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const ctx = await requireUserOrRedirect();
  // FR-061: nothing can be connected before the exclusion filters are confirmed.
  const prefs = await filterPreferences.get(ctx);
  if (prefs.confirmedAt === null) redirect('/onboarding/filters?returnTo=/sources/connect');

  const { error } = await searchParams;
  const banner = error ? ERROR_MESSAGES[error] : undefined;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Connect a mailbox</h1>
      {banner ? (
        <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">
          {banner}
        </p>
      ) : null}
      <ConnectForms
        consent={{
          gmail: view(CONSENT_SUMMARY.gmail),
          microsoft: view(CONSENT_SUMMARY.microsoft),
          imap: view(CONSENT_SUMMARY.imap),
        }}
      />
    </div>
  );
}
