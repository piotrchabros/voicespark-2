'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { VoiceDocument } from '@voicespark/core/prompting/document-schema';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// Mirrors DOCUMENT_LIMITS (contract POST /api/profiles/{id}/document); not imported, to keep core server-side.
const LIMITS = {
  summary: 1200,
  sectionsMax: 20,
  heading: 120,
  markdown: 4000,
  listMax: 10,
  listItem: 200,
};

interface ErrorBody {
  error?: { code?: string; message?: string; details?: { fields?: unknown; field?: unknown } };
}

interface SectionDraft {
  id: number;
  heading: string;
  markdown: string;
}

interface ListItemDraft {
  id: number;
  text: string;
}

const TEXTAREA = 'border-input bg-background w-full rounded-md border px-3 py-2 text-sm';

function Counter({ value, max }: { value: string; max: number }) {
  return (
    <span className="text-muted-foreground text-xs">
      {value.length}/{max}
    </span>
  );
}

export function DocumentEditor({
  profileId,
  baseVersionId,
  document,
}: {
  profileId: string;
  baseVersionId: string;
  document: VoiceDocument;
}) {
  const router = useRouter();
  const [nextId, setNextId] = useState(
    () => document.sections.length + document.doList.length + document.dontList.length,
  );
  const [summary, setSummary] = useState(document.summary);
  const [sections, setSections] = useState<SectionDraft[]>(() =>
    document.sections.map((s, i) => ({ id: i, heading: s.heading, markdown: s.markdown })),
  );
  const [doList, setDoList] = useState<ListItemDraft[]>(() =>
    document.doList.map((text, i) => ({ id: document.sections.length + i, text })),
  );
  const [dontList, setDontList] = useState<ListItemDraft[]>(() =>
    document.dontList.map((text, i) => ({
      id: document.sections.length + document.doList.length + i,
      text,
    })),
  );
  const [kept, setKept] = useState<boolean[]>(() => document.excerpts.map(() => true));
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [badFields, setBadFields] = useState<Set<string>>(new Set());

  const fresh = () => {
    setNextId((n) => n + 1);
    return nextId;
  };

  function fieldName(field: string): string {
    const section = /^sections\[(\d+)\]\.(heading|markdown)$/.exec(field);
    if (section) return `Section ${Number(section[1]) + 1} ${section[2]}`;
    const list = /^(doList|dontList)\[(\d+)\]$/.exec(field);
    if (list) return `${list[1] === 'doList' ? 'Do' : "Don't"} item ${Number(list[2]) + 1}`;
    if (field === 'summary') return 'Summary';
    if (field === 'keepExcerpts') return 'Excerpts';
    return field;
  }

  function hasProblem(field: string): boolean {
    return badFields.has(field);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setProblem(null);
    setBadFields(new Set());
    const keepExcerpts = kept.flatMap((k, i) => (k ? [i] : []));
    setPending(true);
    try {
      const res = await fetch(`/api/profiles/${profileId}/document`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          baseVersionId,
          summary,
          sections: sections.map(({ heading, markdown }) => ({ heading, markdown })),
          doList: doList.map((x) => x.text),
          dontList: dontList.map((x) => x.text),
          keepExcerpts,
        }),
      });
      if (res.ok) {
        toast.success('Saved as a new version.');
        router.push(`/profiles/${profileId}`);
        router.refresh();
        return;
      }
      let body: ErrorBody = {};
      try {
        body = (await res.json()) as ErrorBody;
      } catch {
        // fall through to generic message
      }
      const code = body.error?.code;
      if (code === 'sensitive_content') {
        // Field names only; submitted values are never echoed.
        const fields = Array.isArray(body.error?.details?.fields)
          ? (body.error.details.fields as string[])
          : [];
        setBadFields(new Set(fields));
        setProblem(
          `Some text contains sensitive content and was not saved${fields.length ? `: ${fields.map(fieldName).join(', ')}` : ''}. Remove it and try again.`,
        );
      } else if (code === 'validation_failed') {
        const f = body.error?.details?.field;
        if (typeof f === 'string') setBadFields(new Set([f]));
        setProblem(`Invalid value${typeof f === 'string' ? ` for ${fieldName(f)}` : ''}.`);
      } else if (code === 'conflict') {
        setProblem(
          'This profile changed since you opened it. Reload the page to edit the latest version.',
        );
      } else {
        setProblem(body.error?.message ?? 'Something went wrong.');
      }
    } catch {
      setProblem('Network error. Try again.');
    } finally {
      setPending(false);
    }
  }

  function updateSection(id: number, patch: Partial<SectionDraft>) {
    setSections((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  }

  function renderList(
    title: string,
    prefix: 'doList' | 'dontList',
    items: ListItemDraft[],
    setItems: React.Dispatch<React.SetStateAction<ListItemDraft[]>>,
  ) {
    return (
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">{title}</legend>
        {items.map((item, i) => (
          <div key={item.id} className="flex flex-col gap-1">
            <div className="flex gap-2">
              <Input
                aria-label={`${title} item ${i + 1}`}
                aria-invalid={hasProblem(`${prefix}[${i}]`) || undefined}
                value={item.text}
                maxLength={LIMITS.listItem}
                onChange={(e) =>
                  setItems((prev) =>
                    prev.map((x) => (x.id === item.id ? { ...x, text: e.target.value } : x)),
                  )
                }
              />
              <Button
                type="button"
                variant="outline"
                disabled={items.length <= 1}
                onClick={() => setItems((prev) => prev.filter((x) => x.id !== item.id))}
              >
                Remove
              </Button>
            </div>
            <Counter value={item.text} max={LIMITS.listItem} />
          </div>
        ))}
        {items.length < LIMITS.listMax ? (
          <Button
            type="button"
            variant="outline"
            className="sm:self-start"
            onClick={() => setItems((prev) => [...prev, { id: fresh(), text: '' }])}
          >
            Add item
          </Button>
        ) : null}
      </fieldset>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <Label htmlFor="doc-summary">Summary</Label>
        <textarea
          id="doc-summary"
          rows={4}
          required
          maxLength={LIMITS.summary}
          aria-invalid={hasProblem('summary') || undefined}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          className={TEXTAREA}
        />
        <Counter value={summary} max={LIMITS.summary} />
      </div>

      {sections.map((s, i) => (
        <fieldset key={s.id} className="flex flex-col gap-2 rounded-md border p-3">
          <legend className="px-1 text-sm font-medium">Section {i + 1}</legend>
          <Label htmlFor={`doc-heading-${s.id}`}>Heading</Label>
          <Input
            id={`doc-heading-${s.id}`}
            required
            maxLength={LIMITS.heading}
            aria-invalid={hasProblem(`sections[${i}].heading`) || undefined}
            value={s.heading}
            onChange={(e) => updateSection(s.id, { heading: e.target.value })}
          />
          <Counter value={s.heading} max={LIMITS.heading} />
          <Label htmlFor={`doc-markdown-${s.id}`}>Text</Label>
          <textarea
            id={`doc-markdown-${s.id}`}
            rows={6}
            maxLength={LIMITS.markdown}
            aria-invalid={hasProblem(`sections[${i}].markdown`) || undefined}
            value={s.markdown}
            onChange={(e) => updateSection(s.id, { markdown: e.target.value })}
            className={TEXTAREA}
          />
          <Counter value={s.markdown} max={LIMITS.markdown} />
          <Button
            type="button"
            variant="outline"
            disabled={sections.length <= 1}
            className="sm:self-start"
            onClick={() => setSections((prev) => prev.filter((x) => x.id !== s.id))}
          >
            Remove section
          </Button>
        </fieldset>
      ))}
      {sections.length < LIMITS.sectionsMax ? (
        <Button
          type="button"
          variant="outline"
          className="sm:self-start"
          onClick={() =>
            setSections((prev) => [...prev, { id: fresh(), heading: '', markdown: '' }])
          }
        >
          Add section
        </Button>
      ) : null}

      {renderList('Do', 'doList', doList, setDoList)}
      {renderList("Don't", 'dontList', dontList, setDontList)}

      {document.excerpts.length > 0 ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">Excerpts (can be removed, not edited)</legend>
          {document.excerpts.map((x, i) => (
            <div key={i} className="flex items-start gap-2">
              <input
                id={`doc-excerpt-${i}`}
                type="checkbox"
                checked={kept[i] ?? false}
                onChange={(e) =>
                  setKept((prev) => prev.map((k, j) => (j === i ? e.target.checked : k)))
                }
                className="mt-1"
              />
              <label htmlFor={`doc-excerpt-${i}`} className="text-sm break-words">
                {x.text}
              </label>
            </div>
          ))}
        </fieldset>
      ) : null}

      {problem ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} className="sm:self-start">
        Save as new version
      </Button>
    </form>
  );
}
