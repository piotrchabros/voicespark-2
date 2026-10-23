'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { DiffOp } from '@voicespark/core/text-diff';
import type { OwnPromptDetail, OwnPromptVersionItem } from '@voicespark/core/services/own-prompts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { TextDiff } from '@/components/ui/text-diff';

interface ApiError {
  code?: string;
  message?: string;
  details?: { reason?: string; maxChars?: number };
}

async function readError(res: Response): Promise<ApiError> {
  try {
    return ((await res.json()) as { error?: ApiError }).error ?? {};
  } catch {
    return {};
  }
}

function describe(res: Response, err: ApiError, maxChars: number): string {
  if (res.status === 429) return 'Too many requests. Try again later.';
  if (err.code === 'validation_failed') {
    return err.details?.reason === 'too_long'
      ? `The prompt is too long (maximum ${maxChars.toLocaleString()} characters).`
      : 'The prompt cannot be empty.';
  }
  if (err.code === 'conflict') {
    return 'This prompt was changed elsewhere. Reload the page to see the latest version.';
  }
  if (err.code === 'definition_retired') {
    return 'This tone definition has been retired, so its prompt can no longer be changed.';
  }
  return err.message ?? 'Something went wrong.';
}

export function AnalysisPromptEditor({
  definitionId,
  detail,
  versions,
}: {
  definitionId: string;
  detail: OwnPromptDetail;
  versions: OwnPromptVersionItem[];
}) {
  const router = useRouter();
  const maxChars = detail.limits.maxChars;
  const own = detail.own;
  const inUse = own?.inUse === true && own.currentVersion !== null;
  const current = own?.currentVersion ?? null;

  const [text, setText] = useState(current?.promptText ?? detail.default.promptText);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewed, setViewed] = useState<{ versionNumber: number; promptText: string } | null>(null);
  const [diff, setDiff] = useState<DiffOp[] | null>(null);

  async function run(fn: () => Promise<Response>, success: string) {
    setPending(true);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) {
        setError(describe(res, await readError(res), maxChars));
        return false;
      }
      toast.success(success);
      setDiff(null);
      setViewed(null);
      router.refresh();
      return true;
    } catch {
      setError('Network error. Try again.');
      return false;
    } finally {
      setPending(false);
    }
  }

  const base = `/api/analysis-prompts/${definitionId}`;

  async function customise() {
    const ok = await run(() => fetch(`${base}/customise`, { method: 'POST' }), 'Prompt created.');
    if (ok) setText(detail.default.promptText);
  }

  function save() {
    if (!current) return;
    void run(
      () =>
        fetch(base, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ promptText: text, baseVersionId: current.id }),
        }),
      'Prompt saved.',
    );
  }

  function reset() {
    void run(() => fetch(`${base}/reset`, { method: 'POST' }), 'Now using the default.');
  }

  async function viewVersion(v: OwnPromptVersionItem) {
    setError(null);
    try {
      const res = await fetch(`${base}/versions/${v.id}`);
      if (!res.ok) {
        setError(describe(res, await readError(res), maxChars));
        return;
      }
      const body = (await res.json()) as { promptText: string };
      setViewed({ versionNumber: v.versionNumber, promptText: body.promptText });
    } catch {
      setError('Network error. Try again.');
    }
  }

  async function compare() {
    setError(null);
    try {
      const res = await fetch(`${base}/compare`);
      if (!res.ok) {
        setError(describe(res, await readError(res), maxChars));
        return;
      }
      setDiff(((await res.json()) as { diff: DiffOp[] }).diff);
    } catch {
      setError('Network error. Try again.');
    }
  }

  const over = text.length > maxChars;
  const unchanged = current !== null && text === current.promptText;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={inUse ? 'default' : 'secondary'}>{inUse ? 'Own prompt' : 'Default'}</Badge>
        <span className="text-muted-foreground text-sm">
          Default v{detail.default.versionNumber}
          {inUse && current ? `, your version ${current.versionNumber}` : ''}
        </span>
      </div>

      {!inUse ? (
        <div className="flex flex-col gap-3">
          <pre className="max-h-80 overflow-auto rounded-md border p-3 text-sm whitespace-pre-wrap break-words">
            {detail.default.promptText}
          </pre>
          {!detail.definition.retired ? (
            <Button
              type="button"
              className="sm:self-start"
              disabled={pending}
              onClick={() => void customise()}
            >
              Customise
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <Label htmlFor="analysis-prompt-text">Your analysis prompt</Label>
          <textarea
            id="analysis-prompt-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={14}
            className="border-input bg-background w-full rounded-md border p-3 text-sm"
            aria-describedby="analysis-prompt-count"
          />
          <p
            id="analysis-prompt-count"
            className={over ? 'text-destructive text-sm' : 'text-muted-foreground text-sm'}
          >
            {text.length.toLocaleString()} / {maxChars.toLocaleString()} characters
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={pending || over || unchanged || text.trim().length === 0}
              onClick={save}
            >
              {pending ? 'Saving...' : 'Save'}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => void compare()}
            >
              Compare with default
            </Button>
            <Button type="button" variant="outline" disabled={pending} onClick={reset}>
              Reset to default
            </Button>
          </div>
        </div>
      )}

      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}

      {diff ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Your prompt compared with the default</h3>
          <TextDiff ops={diff} label="Differences between your prompt and the default" />
        </div>
      ) : null}

      {versions.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Your versions</h3>
          <ul className="flex flex-col gap-2">
            {versions.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>
                  Version {v.versionNumber}, based on default v
                  {v.basedOnDefinitionVersion.versionNumber},{' '}
                  {new Date(v.createdAt).toLocaleString()}
                  {v.inUseNow ? ' (in use)' : ''}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void viewVersion(v)}
                >
                  View
                </Button>
              </li>
            ))}
          </ul>
          {viewed ? (
            <div className="flex flex-col gap-1">
              <p className="text-muted-foreground text-sm">Version {viewed.versionNumber}</p>
              <pre className="max-h-80 overflow-auto rounded-md border p-3 text-sm whitespace-pre-wrap break-words">
                {viewed.promptText}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
