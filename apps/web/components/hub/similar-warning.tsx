import Link from 'next/link';
import type { HubKind } from './labels';

export interface SimilarRecord {
  id: string;
  name: string;
}

// FR-003: same-name records are shown as a warning with links; it never blocks saving.
export function SimilarWarning({
  kind,
  similar,
  currentId,
}: {
  kind: HubKind;
  similar: SimilarRecord[];
  currentId?: string;
}) {
  const others = similar.filter((s) => s.id !== currentId);
  if (others.length === 0) return null;
  return (
    <div
      role="region"
      aria-label="Similar records"
      aria-live="polite"
      className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm"
    >
      <p className="font-medium">A record with the same name already exists.</p>
      <p className="text-muted-foreground">
        Your changes are saved. You can keep both or open the existing one.
      </p>
      <ul className="mt-2 list-disc pl-5">
        {others.map((s) => (
          <li key={s.id}>
            <Link href={`/hub/${kind}/${s.id}`} className="underline">
              {s.name}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
