'use client';

import { useEffect, useRef, useState } from 'react';

interface Generation {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked';
  blockReason: 'insufficient_content' | 'definition_retired' | 'definition_not_chosen' | null;
  errorCode: string | null;
  resultVersionId: string | null;
}

const BLOCK_TEXT: Record<string, string> = {
  insufficient_content: 'Not enough of your own writing yet. Add sent mail or notes and try again.',
  definition_retired: 'This definition is no longer available.',
  definition_not_chosen: 'This definition is no longer chosen.',
};

// Polls the generation every 3 s until it settles, then calls onDone once (FR-035, FR-066).
export function GenerationStatus({
  generationId,
  onDone,
}: {
  generationId: string;
  onDone: () => void;
}) {
  const [generation, setGeneration] = useState<Generation | null>(null);
  const [failed, setFailed] = useState(false);
  const onDoneRef = useRef(onDone);

  useEffect(() => {
    onDoneRef.current = onDone;
  });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const res = await fetch(`/api/profile-generations/${generationId}`);
        if (!res.ok) throw new Error('generation_failed');
        const data = (await res.json()) as Generation;
        if (cancelled) return;
        setGeneration(data);
        if (data.status === 'queued' || data.status === 'running') {
          timer = setTimeout(poll, 3000);
        } else {
          onDoneRef.current();
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [generationId]);

  let text: string;
  if (failed) text = 'The generation status is unavailable.';
  else if (!generation || generation.status === 'queued') text = 'Queued...';
  else if (generation.status === 'running') text = 'Generating your profile...';
  else if (generation.status === 'succeeded') text = 'Profile ready.';
  else if (generation.status === 'blocked')
    text = BLOCK_TEXT[generation.blockReason ?? ''] ?? 'Generation was blocked.';
  else text = 'Generation failed. Please try again later.';

  return (
    <p role="status" className="text-muted-foreground text-sm">
      {text}
    </p>
  );
}
