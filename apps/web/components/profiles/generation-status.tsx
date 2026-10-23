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

const ERROR_TEXT: Record<string, string> = {
  invalid_output: 'The generated profile did not pass our checks. Please try again.',
  analysis_prompt_excluded:
    'Your own analysis prompt contains content we cannot use. Edit your prompt or use the default prompt.',
  analysis_prompt_missing:
    'The analysis prompt is no longer available. Choose a prompt and try again.',
  inspection_failed: 'We could not check the result. Please try again later.',
  output_excluded:
    'The generated profile contained content that cannot be stored, so it was discarded.',
  feedback_excluded: 'Your feedback contained content we cannot use. Edit it and try again.',
  llm_refused: 'The model declined to produce a profile from this content.',
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
  else
    text = ERROR_TEXT[generation.errorCode ?? ''] ?? 'Generation failed. Please try again later.';

  return (
    <p role="status" className="text-muted-foreground text-sm">
      {text}
    </p>
  );
}
