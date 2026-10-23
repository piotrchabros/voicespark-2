'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

// Shown when the default analysis prompt changed since the user's own prompt was based on it (FR-012..014).
export function DefaultChangedBanner({
  profileId,
  definitionId,
  fromDefinitionVersionId,
  toDefinitionVersionId,
}: {
  profileId: string;
  definitionId: string;
  fromDefinitionVersionId: string;
  toDefinitionVersionId: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const query = new URLSearchParams({
    from: fromDefinitionVersionId,
    to: toDefinitionVersionId,
  }).toString();

  async function switchToDefault() {
    setPending(true);
    try {
      const res = await fetch(`/api/analysis-prompts/${definitionId}/reset`, { method: 'POST' });
      if (!res.ok) {
        toast.error('Could not switch to the default. Please try again.');
        return;
      }
      toast.success('Now using the default analysis prompt.');
      router.refresh();
    } catch {
      toast.error('Network error. Try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      role="status"
      className="flex flex-col gap-3 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 sm:p-4"
    >
      <div className="space-y-1">
        <p className="font-medium">The default analysis prompt has changed</p>
        <p className="text-muted-foreground text-sm">
          Your own prompt was based on an older default. Your prompt keeps being used until you
          switch.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild size="sm" variant="outline">
          <Link href={`/profiles/${profileId}/analysis-prompt?${query}`}>See what changed</Link>
        </Button>
        <Button size="sm" disabled={pending} onClick={() => void switchToDefault()}>
          {pending ? 'Switching...' : 'Use the default'}
        </Button>
      </div>
    </div>
  );
}
