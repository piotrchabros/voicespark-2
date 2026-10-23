import type { ExcerptSource, VoiceDocument } from '@voicespark/core/prompting/document-schema';
import type { ProfileVersionViewBase } from '@voicespark/core/services/profiles';
import { DocMarkdown } from './doc-markdown';
import { ExcerptSourceLine } from './excerpt-source';

function promptUsedText(promptUsed: ProfileVersionViewBase['analysisPrompt']): string | null {
  if (!promptUsed) return null;
  return promptUsed.kind === 'default'
    ? `default v${promptUsed.definitionVersion.versionNumber}`
    : `your own prompt v${promptUsed.ownVersion.versionNumber}`;
}

function BulletList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-semibold">{title}</h2>
      <ul className="list-disc pl-5 text-sm break-words">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

// Read-only view of a document-format profile version (FR-018, FR-022).
export function DocumentView({
  document,
  excerptSources,
  promptUsed,
}: {
  document: VoiceDocument;
  excerptSources: Record<string, ExcerptSource | null>;
  promptUsed: ProfileVersionViewBase['analysisPrompt'];
}) {
  const prompt = promptUsedText(promptUsed);
  return (
    <div className="flex flex-col gap-6">
      {prompt ? <p className="text-muted-foreground text-xs">Prompt used: {prompt}</p> : null}
      <p className="text-sm break-words whitespace-pre-line">{document.summary}</p>
      {document.sections.map((s, i) => (
        <section key={i} className="flex flex-col gap-2">
          <h2 className="font-semibold break-words">{s.heading}</h2>
          <DocMarkdown markdown={s.markdown} />
        </section>
      ))}
      <BulletList title="Do" items={document.doList} />
      <BulletList title="Don't" items={document.dontList} />
      {document.excerpts.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="font-semibold">Excerpts</h2>
          {document.excerpts.map((e, i) => (
            <figure key={i} className="flex flex-col gap-1">
              <blockquote className="border-l-2 pl-3 text-sm break-words">{e.text}</blockquote>
              <figcaption>
                <ExcerptSourceLine
                  contentItemId={e.contentItemId}
                  source={e.contentItemId ? (excerptSources[e.contentItemId] ?? null) : null}
                />
              </figcaption>
            </figure>
          ))}
        </section>
      ) : null}
    </div>
  );
}
