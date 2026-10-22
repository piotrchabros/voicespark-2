'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';

type Rating = 'sounds_like_me' | 'not_like_me';

export function RatingButtons({
  profileId,
  versionId,
  rating,
}: {
  profileId: string;
  versionId: string;
  rating: Rating | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function rate(next: Rating) {
    setPending(true);
    try {
      const res = await fetch(`/api/profiles/${profileId}/versions/${versionId}/rating`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rating: next }),
      });
      if (!res.ok) toast.error('Could not save your rating.');
      else router.refresh();
    } catch {
      toast.error('Network error. Try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Button
        type="button"
        variant={rating === 'sounds_like_me' ? 'default' : 'outline'}
        disabled={pending}
        aria-pressed={rating === 'sounds_like_me'}
        onClick={() => rate('sounds_like_me')}
      >
        Sounds like me
      </Button>
      <Button
        type="button"
        variant={rating === 'not_like_me' ? 'default' : 'outline'}
        disabled={pending}
        aria-pressed={rating === 'not_like_me'}
        onClick={() => rate('not_like_me')}
      >
        Not like me
      </Button>
    </div>
  );
}
