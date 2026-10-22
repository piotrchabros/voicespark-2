'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { GenerationStatus } from './generation-status';

export function EligibilityMeter({
  authoredWordCount,
  thresholdWords,
  eligible,
  hasChoice,
}: {
  authoredWordCount: number;
  thresholdWords: number;
  eligible: boolean;
  hasChoice: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generationIds, setGenerationIds] = useState<string[]>([]);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/profiles/generate', { method: 'POST' });
      if (res.status === 429) {
        setError('You have requested too many generations. Please try again later.');
        return;
      }
      if (!res.ok) {
        setError('Could not start generation. Please try again.');
        return;
      }
      const data = (await res.json()) as { generations: { id: string }[] };
      setGenerationIds(data.generations.map((g) => g.id));
      router.refresh();
    } catch {
      setError('Could not start generation. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const percent =
    thresholdWords > 0 ? Math.min(100, (authoredWordCount / thresholdWords) * 100) : 100;

  return (
    <div className="flex flex-col gap-3">
      <Progress value={percent} aria-label="Writing collected" />
      <p className="text-sm">
        {authoredWordCount} of {thresholdWords} words{eligible ? '' : '; add sent mail or notes'}
      </p>
      {eligible && hasChoice ? (
        <Button className="self-start" onClick={generate} disabled={busy}>
          {busy ? 'Starting...' : 'Generate profiles'}
        </Button>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      {generationIds.map((id) => (
        <GenerationStatus key={id} generationId={id} onDone={() => router.refresh()} />
      ))}
    </div>
  );
}
