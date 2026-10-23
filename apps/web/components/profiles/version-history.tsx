import Link from 'next/link';
import { Badge } from '@/components/ui/badge';

export interface VersionHistoryItem {
  id: string;
  versionNumber: number;
  origin: string;
  format?: 'structured' | 'document';
  rating: string | null;
  createdAt: string;
}

const RATING_TEXT: Record<string, string> = {
  sounds_like_me: 'Sounds like me',
  not_like_me: 'Not like me',
};

export function VersionHistory({
  profileId,
  items,
  selectedId,
}: {
  profileId: string;
  items: VersionHistoryItem[];
  selectedId: string;
}) {
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {items.map((v) => (
        <li key={v.id} className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium">Version {v.versionNumber}</span>
            <Badge variant="outline">{v.origin.replace(/_/g, ' ')}</Badge>
            {v.format === 'document' ? <Badge variant="outline">document</Badge> : null}
            {v.rating ? (
              <Badge variant="secondary">{RATING_TEXT[v.rating] ?? v.rating}</Badge>
            ) : null}
          </span>
          <span className="flex items-center gap-3 text-muted-foreground">
            {new Date(v.createdAt).toLocaleString()}
            {v.id === selectedId ? (
              <span>Viewing</span>
            ) : (
              <Link href={`/profiles/${profileId}?version=${v.id}`} className="underline">
                View
              </Link>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
