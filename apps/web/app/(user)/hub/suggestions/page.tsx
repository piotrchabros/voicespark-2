import { list } from '@voicespark/core/services/hub/suggestions';
import { requireUserOrRedirect } from '@/lib/page-auth';
import type { SuggestionPage } from '@/components/hub/labels';
import { SuggestionQueue } from '@/components/hub/suggestion-card';

export const dynamic = 'force-dynamic';

// The suggestion queue (US4; FR-023): the first page renders on the server, the queue reloads after each decision.
export default async function SuggestionsPage() {
  const ctx = await requireUserOrRedirect();
  const page = (await list(ctx, {})) as SuggestionPage;
  return (
    <div className="flex flex-col gap-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Suggestions</h1>
        <p className="text-muted-foreground text-sm">
          Findings from email that were not certain enough to apply on their own, or that differ from what you
          entered. Accepting changes the record; rejecting keeps it as it is, and the same finding is not proposed
          again.
        </p>
      </div>
      <SuggestionQueue initial={page} />
    </div>
  );
}
