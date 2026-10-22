import * as definitions from '@voicespark/core/services/definitions';
import * as profiles from '@voicespark/core/services/profiles';
import { DefinitionChooser } from '@/components/profiles/definition-chooser';
import { EligibilityMeter } from '@/components/profiles/eligibility-meter';
import { OutdatedBanner } from '@/components/profiles/outdated-banner';
import { ProfileCard } from '@/components/profiles/profile-card';
import { requireUserOrRedirect } from '@/lib/page-auth';

export const dynamic = 'force-dynamic';

export default async function ProfilesPage() {
  const ctx = await requireUserOrRedirect();
  // A single available definition is pre-chosen (FR-065).
  await definitions.autoChooseIfSingle(ctx);
  const [available, eligibility, list] = await Promise.all([
    definitions.listAvailable(ctx),
    profiles.eligibility(ctx),
    profiles.list(ctx),
  ]);
  const chosenIds = available.filter((d) => d.chosen).map((d) => d.id);
  const visible = list.filter((p) => p.status !== 'removed');

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8">
      <OutdatedBanner
        profiles={visible
          .filter((p) => p.outdatedReason === 'sources_deleted')
          .map((p) => ({ id: p.id, name: p.definition.name }))}
      />

      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Profiles</h1>
        <p className="text-muted-foreground text-sm">
          Choose how your writing voice should be described, then generate a profile for each
          choice.
        </p>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Definitions</h2>
        <DefinitionChooser definitions={available} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Writing collected</h2>
        <EligibilityMeter
          authoredWordCount={eligibility.authoredWordCount}
          thresholdWords={eligibility.thresholdWords}
          eligible={eligibility.eligible}
          hasChoice={chosenIds.length > 0}
        />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Your profiles</h2>
        {visible.length === 0 ? (
          <p className="text-muted-foreground text-sm">No profiles yet.</p>
        ) : (
          visible.map((p) => (
            <ProfileCard
              key={p.id}
              profile={{
                id: p.id,
                definition: p.definition,
                latestVersion: p.latestVersion,
                outdatedReason: p.outdatedReason,
                canRegenerate: p.canRegenerate,
                activeGenerationId: p.activeGeneration?.id ?? null,
              }}
              available={available.map((d) => ({ id: d.id, name: d.name }))}
              chosenIds={chosenIds}
            />
          ))
        )}
      </section>
    </div>
  );
}
