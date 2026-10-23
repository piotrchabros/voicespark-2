import Link from 'next/link';
import type { ExcerptSource } from '@voicespark/core/prompting/document-schema';

const KIND_LABELS: Record<string, string> = {
  email: 'Email',
  attachment: 'Attachment',
  file: 'File',
  note: 'Note',
};

export function ExcerptSourceLine({
  contentItemId,
  source,
}: {
  contentItemId: string | null;
  source: ExcerptSource | null;
}) {
  if (!source || !contentItemId) {
    return <p className="text-muted-foreground text-xs">source deleted</p>;
  }
  const labels = source.sourceLabels.join(', ');
  return (
    <p className="text-muted-foreground text-xs break-words">
      <Link
        href={`/content?item=${encodeURIComponent(contentItemId)}`}
        className="underline underline-offset-2"
      >
        {KIND_LABELS[source.kind] ?? source.kind}
      </Link>
      {' · '}
      <time dateTime={source.itemDate}>{source.itemDate}</time>
      {labels ? ` · ${labels}` : ''}
    </p>
  );
}
