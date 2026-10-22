'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { DraftContentType } from '@voicespark/db';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { draftApiError } from './draft-status';

const BRIEF_MAX = 2000;

const CONTENT_TYPES: { value: DraftContentType; label: string; hint: string }[] = [
  { value: 'social_post', label: 'Social post', hint: 'Up to 300 words' },
  { value: 'bio', label: 'Bio', hint: 'Up to 250 words' },
  { value: 'short_article', label: 'Short article', hint: 'Up to 1,500 words' },
];

// New draft request (FR-049, FR-050); the brief is only sent to the API, never logged.
export function DraftForm({
  profiles,
  initialProfileId,
}: {
  profiles: { id: string; name: string }[];
  initialProfileId: string | null;
}) {
  const router = useRouter();
  const [contentType, setContentType] = useState<DraftContentType>('social_post');
  const [profileId, setProfileId] = useState(initialProfileId ?? profiles[0]?.id ?? '');
  const [brief, setBrief] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const briefLength = brief.trim().length;
  const valid = profileId !== '' && briefLength >= 1 && brief.length <= BRIEF_MAX;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/drafts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contentType, profileId, brief }),
      });
      if (!res.ok) {
        setError(await draftApiError(res));
        return;
      }
      const { draftId } = (await res.json()) as { draftId: string };
      router.push(`/drafts/${draftId}`);
    } catch {
      toast.error('Network error. Try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-sm font-medium">Content type</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {CONTENT_TYPES.map((t) => (
            <label
              key={t.value}
              className="has-[:checked]:border-primary has-[:checked]:bg-accent flex cursor-pointer items-start gap-3 rounded-lg border p-3"
            >
              <input
                type="radio"
                name="contentType"
                value={t.value}
                checked={contentType === t.value}
                onChange={() => setContentType(t.value)}
                className="mt-1"
              />
              <span className="flex flex-col">
                <span className="text-sm font-medium">{t.label}</span>
                <span className="text-muted-foreground text-xs">{t.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-col gap-2">
        <Label htmlFor="draft-profile">Profile</Label>
        <Select value={profileId} onValueChange={setProfileId}>
          <SelectTrigger id="draft-profile" className="w-full sm:w-72">
            <SelectValue placeholder="Choose a profile" />
          </SelectTrigger>
          <SelectContent>
            {profiles.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="draft-brief">Topic or brief</Label>
        <textarea
          id="draft-brief"
          name="brief"
          value={brief}
          maxLength={BRIEF_MAX}
          rows={6}
          required
          placeholder="What should the draft be about?"
          onChange={(e) => setBrief(e.target.value)}
          className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
        />
        <p className="text-muted-foreground text-right text-xs" aria-live="polite">
          {brief.length} / {BRIEF_MAX}
        </p>
      </div>

      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}

      <Button type="submit" disabled={pending || !valid} className="sm:self-start">
        {pending ? 'Requesting...' : 'Write draft'}
      </Button>
    </form>
  );
}
