'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { GenerationStatus } from './generation-status';

const FEEDBACK_MAX = 2000;

async function errorMessage(res: Response): Promise<string> {
  if (res.status === 429) return 'Too many requests. Try again later.';
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body.error?.message ?? 'Something went wrong.';
  } catch {
    return 'Something went wrong.';
  }
}

// Regenerate and feedback both start a generation and poll it; the feedback text is never logged or echoed.
export function FeedbackForm({
  profileId,
  canRegenerate,
}: {
  profileId: string;
  canRegenerate: boolean;
}) {
  const router = useRouter();
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [generationId, setGenerationId] = useState<string | null>(null);
  const done = useCallback(() => {
    setGenerationId(null);
    router.refresh();
  }, [router]);

  async function start(action: 'regenerate' | 'feedback') {
    setPending(true);
    try {
      const res = await fetch(`/api/profiles/${profileId}/${action}`, {
        method: 'POST',
        ...(action === 'feedback'
          ? {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ feedback: text }),
            }
          : {}),
      });
      if (!res.ok) {
        toast.error(await errorMessage(res));
        return;
      }
      const { generationId: id } = (await res.json()) as { generationId: string };
      if (action === 'feedback') setText('');
      setGenerationId(id);
    } catch {
      toast.error('Network error. Try again.');
    } finally {
      setPending(false);
    }
  }

  if (generationId) return <GenerationStatus generationId={generationId} onDone={done} />;

  return (
    <div className="flex flex-col gap-4">
      {canRegenerate ? (
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          onClick={() => start('regenerate')}
          className="sm:self-start"
        >
          Regenerate
        </Button>
      ) : null}
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) void start('feedback');
        }}
      >
        <Label htmlFor="profile-feedback">Tell us what to change</Label>
        <textarea
          id="profile-feedback"
          value={text}
          maxLength={FEEDBACK_MAX}
          rows={4}
          onChange={(e) => setText(e.target.value)}
          className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
        />
        <Button
          type="submit"
          disabled={pending || !text.trim() || !canRegenerate}
          className="sm:self-start"
        >
          Regenerate with feedback
        </Button>
      </form>
    </div>
  );
}
