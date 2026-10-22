import * as exclusionRules from '@voicespark/core/services/exclusion-rules';
import { RulesManager } from '@/components/filters/rules-manager';
import { requireUserOrRedirect } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

export default async function ExclusionRulesPage() {
  const ctx = await requireUserOrRedirect();
  const rules = await exclusionRules.list(ctx);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Exclusion rules</h1>
        <p className="text-muted-foreground text-sm">
          Messages matching a rule are never imported. Rules apply to future imports and ongoing
          syncing; after adding or changing a rule we can scan what is already stored and offer to
          remove matching items.
        </p>
      </div>
      <RulesManager initialRules={rules} limit={exclusionRules.RULE_LIMIT} />
    </div>
  );
}
