'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { GenerationStatus } from './generation-status';

export interface ProfileCardData {
  id: string;
  definition: { id: string; name: string; retired: boolean };
  latestVersion: { id: string; versionNumber: number; createdAt: string } | null;
  outdatedReason: 'sources_deleted' | 'significant_new_content' | null;
  canRegenerate: boolean;
  activeGenerationId: string | null;
}

export interface AvailableOption {
  id: string;
  name: string;
}

const OUTDATED_TEXT: Record<string, string> = {
  sources_deleted: 'A source this profile was built from was deleted.',
  significant_new_content: 'You have written a lot of new content since this profile was made.',
};

export function ProfileCard({
  profile,
  available,
  chosenIds,
}: {
  profile: ProfileCardData;
  available: AvailableOption[];
  chosenIds: string[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generationId, setGenerationId] = useState<string | null>(profile.activeGenerationId);

  async function regenerate() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/profiles/${profile.id}/regenerate`, { method: 'POST' });
      if (res.status === 429) {
        setError('You have requested too many generations. Please try again later.');
        return;
      }
      if (!res.ok) {
        setError('Could not start regeneration. Please try again.');
        return;
      }
      const data = (await res.json()) as { generationId: string };
      setGenerationId(data.generationId);
    } catch {
      setError('Could not start regeneration. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function switchTo(definitionId: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/definition-choices', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ definitionIds: [...new Set([...chosenIds, definitionId])] }),
      });
      if (!res.ok) {
        setError('Could not save your choice. Please try again.');
        return;
      }
      router.refresh();
    } catch {
      setError('Could not save your choice. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  const retired = profile.definition.retired;
  const switchOptions = available.filter((d) => !chosenIds.includes(d.id));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span>{profile.definition.name}</span>
          {retired ? <Badge variant="secondary">Retired</Badge> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {profile.latestVersion ? (
          <p>
            Version {profile.latestVersion.versionNumber}, created{' '}
            {new Date(profile.latestVersion.createdAt).toLocaleDateString()}
          </p>
        ) : (
          <p className="text-muted-foreground">No version generated yet.</p>
        )}

        {retired ? (
          <div role="note" className="rounded-md border p-3">
            <p>This definition has been retired and can no longer be regenerated.</p>
            {switchOptions.length > 0 ? (
              <div className="mt-2 flex flex-col gap-2">
                <p className="text-muted-foreground">Choose an available definition instead:</p>
                <div className="flex flex-wrap gap-2">
                  {switchOptions.map((d) => (
                    <Button
                      key={d.id}
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() => switchTo(d.id)}
                    >
                      {d.name}
                    </Button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {profile.outdatedReason && !retired ? (
          <div role="note" className="flex flex-col gap-2 rounded-md border p-3">
            <p>Outdated: {OUTDATED_TEXT[profile.outdatedReason] ?? 'New content is available.'}</p>
            {profile.canRegenerate ? (
              <Button
                size="sm"
                className="self-start"
                onClick={regenerate}
                disabled={busy || generationId !== null}
              >
                Regenerate
              </Button>
            ) : null}
          </div>
        ) : null}

        {generationId ? (
          <GenerationStatus
            key={generationId}
            generationId={generationId}
            onDone={() => {
              setGenerationId(null);
              router.refresh();
            }}
          />
        ) : null}
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}

        {profile.latestVersion ? (
          <Link href={`/profiles/${profile.id}`} className="underline">
            View profile
          </Link>
        ) : null}
      </CardContent>
    </Card>
  );
}
