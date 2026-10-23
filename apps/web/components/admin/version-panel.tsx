'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatTime } from '@/lib/format';

// Version lifecycle for definitions and prompts (FR-041, FR-042): publish, discard, rollback, diff and history.
// Every call goes through the zod-validated admin API; only version metadata and definition/prompt fields appear here.

export interface ApiError {
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

const CODE_MESSAGES: Record<string, string> = {
  last_available_definition: 'This is the last available definition and cannot be retired',
  version_not_draft: 'Only a draft version can be changed',
  not_found: 'This item no longer exists. Refresh the page.',
};

/** Turns an admin API error body into a user-facing message. */
export function apiErrorMessage(body: ApiError | null): string {
  const err = body?.error;
  if (!err) return 'Something went wrong. Please try again.';
  if (err.code === 'validation_failed') {
    const fields = Array.isArray(err.details?.fields)
      ? (err.details.fields as string[])
      : Array.isArray(err.details?.issues)
        ? (err.details.issues as { path?: string }[]).map((i) => i.path ?? '')
        : [];
    const named = fields.filter((f) => f !== '');
    return named.length > 0
      ? `Check these fields: ${named.join(', ')}`
      : 'Some fields are invalid.';
  }
  if (err.code && CODE_MESSAGES[err.code]) return CODE_MESSAGES[err.code]!;
  return err.message ?? 'Something went wrong. Please try again.';
}

export async function adminSend(
  url: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body?: unknown,
): Promise<{ ok: true; data: unknown } | { ok: false; error: ApiError | null }> {
  try {
    const res = await fetch(url, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (!res.ok)
      return { ok: false, error: (await res.json().catch(() => null)) as ApiError | null };
    return { ok: true, data: res.status === 204 ? null : await res.json() };
  } catch {
    return { ok: false, error: null };
  }
}

type VersionStatus = 'draft' | 'active' | 'superseded';

interface VersionRef {
  id: string;
  versionNumber: number;
}

interface HistoryEntry {
  action: 'publish' | 'rollback';
  fromVersion: VersionRef | null;
  toVersion: VersionRef;
  actor: { id: string; name: string | null };
  occurredAt: string;
}

interface VersionDiff {
  from: VersionRef;
  to: VersionRef;
  changes: {
    path: string;
    op: 'added' | 'removed' | 'changed';
    before?: unknown;
    after?: unknown;
  }[];
}

const STATUS_VARIANT: Record<VersionStatus, 'default' | 'secondary' | 'outline'> = {
  active: 'default',
  draft: 'secondary',
  superseded: 'outline',
};

function show(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function VersionPanel(props: {
  kind: 'definitions' | 'prompts';
  entityId: string;
  versions: { id: string; versionNumber: number; status: VersionStatus }[];
}) {
  const { kind, entityId, versions } = props;
  const router = useRouter();
  const base = `/api/admin/${kind}/${entityId}`;
  const [busy, setBusy] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [diffFrom, setDiffFrom] = useState(versions[0]?.id ?? '');
  const [diffAgainst, setDiffAgainst] = useState(versions[1]?.id ?? '');
  const [diff, setDiff] = useState<VersionDiff | null>(null);
  const hasDraft = versions.some((v) => v.status === 'draft');
  // Refetch the history whenever the version states change (after router.refresh()).
  const versionsKey = versions.map((v) => `${v.id}:${v.status}`).join(',');

  useEffect(() => {
    let cancelled = false;
    adminSend(`${base}/history`, 'GET').then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setHistory(r.data as HistoryEntry[]);
        setHistoryFailed(false);
      } else {
        setHistoryFailed(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [base, versionsKey]);

  async function act(
    label: string,
    url: string,
    method: 'POST' | 'DELETE',
    body: unknown,
    success: string,
  ) {
    setBusy(label);
    const r = await adminSend(url, method, body);
    setBusy(null);
    if (!r.ok) {
      toast.error(apiErrorMessage(r.error));
      return;
    }
    toast.success(success);
    setDiff(null);
    router.refresh();
  }

  async function loadDiff() {
    if (!diffFrom || !diffAgainst || diffFrom === diffAgainst) {
      toast.error('Choose two different versions to compare.');
      return;
    }
    setBusy('diff');
    const r = await adminSend(
      `${base}/versions/${diffFrom}/diff?against=${encodeURIComponent(diffAgainst)}`,
      'GET',
    );
    setBusy(null);
    if (!r.ok) {
      toast.error(apiErrorMessage(r.error));
      return;
    }
    setDiff(r.data as VersionDiff);
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-medium">Versions</h3>
          {!hasDraft ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => act('new', `${base}/versions`, 'POST', {}, 'Draft created.')}
            >
              New draft from active
            </Button>
          ) : null}
        </div>
        {versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">No versions yet.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {versions.map((v) => (
              <li
                key={v.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2"
              >
                <span className="flex items-center gap-2">
                  Version {v.versionNumber}
                  <Badge variant={STATUS_VARIANT[v.status]}>{v.status}</Badge>
                </span>
                <span className="flex flex-wrap gap-2">
                  {v.status === 'draft' ? (
                    <>
                      <Button
                        size="sm"
                        disabled={busy !== null}
                        onClick={() =>
                          act(
                            `publish-${v.id}`,
                            `${base}/versions/${v.id}/publish`,
                            'POST',
                            undefined,
                            `Version ${v.versionNumber} published.`,
                          )
                        }
                      >
                        Publish
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={busy !== null}
                        onClick={() =>
                          act(
                            `discard-${v.id}`,
                            `${base}/versions/${v.id}`,
                            'DELETE',
                            undefined,
                            'Draft discarded.',
                          )
                        }
                      >
                        Discard
                      </Button>
                    </>
                  ) : null}
                  {v.status === 'superseded' ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy !== null}
                      onClick={() =>
                        act(
                          `rollback-${v.id}`,
                          `${base}/rollback`,
                          'POST',
                          { versionId: v.id },
                          `Rolled back to version ${v.versionNumber}.`,
                        )
                      }
                    >
                      Roll back to this
                    </Button>
                  ) : null}
                  {v.status !== 'draft' && !hasDraft ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() =>
                        act(
                          `copy-${v.id}`,
                          `${base}/versions`,
                          'POST',
                          { fromVersionId: v.id },
                          `Draft created from version ${v.versionNumber}.`,
                        )
                      }
                    >
                      Copy to draft
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {versions.length > 1 ? (
        <section className="flex flex-col gap-2">
          <h3 className="font-medium">Compare versions</h3>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex flex-col gap-1">
              <Label>Version</Label>
              <Select value={diffFrom} onValueChange={setDiffFrom}>
                <SelectTrigger className="w-full sm:w-40">
                  <SelectValue placeholder="Version" />
                </SelectTrigger>
                <SelectContent>
                  {versions.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      Version {v.versionNumber}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label>Against</Label>
              <Select value={diffAgainst} onValueChange={setDiffAgainst}>
                <SelectTrigger className="w-full sm:w-40">
                  <SelectValue placeholder="Against" />
                </SelectTrigger>
                <SelectContent>
                  {versions.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      Version {v.versionNumber}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={loadDiff}>
              Show diff
            </Button>
          </div>
          {diff ? (
            diff.changes.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Versions {diff.from.versionNumber} and {diff.to.versionNumber} are identical.
              </p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                <li className="text-muted-foreground">
                  Changes from version {diff.from.versionNumber} to version {diff.to.versionNumber}
                </li>
                {diff.changes.map((c) => (
                  <li key={`${c.op}:${c.path}`} className="rounded-md border p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={c.op === 'removed' ? 'destructive' : 'outline'}>{c.op}</Badge>
                      <code className="break-all">{c.path || '(root)'}</code>
                    </div>
                    {c.op !== 'added' ? (
                      <pre className="mt-1 whitespace-pre-wrap break-all text-muted-foreground">
                        - {show(c.before)}
                      </pre>
                    ) : null}
                    {c.op !== 'removed' ? (
                      <pre className="mt-1 whitespace-pre-wrap break-all">+ {show(c.after)}</pre>
                    ) : null}
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <h3 className="font-medium">History</h3>
        {historyFailed ? (
          <p className="text-sm text-muted-foreground">The history is unavailable.</p>
        ) : history === null ? (
          <p className="text-sm text-muted-foreground">Loading history...</p>
        ) : history.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing has been published yet.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {history.map((h) => (
              <li
                key={`${h.occurredAt}:${h.toVersion.id}`}
                className="flex flex-wrap justify-between gap-2"
              >
                <span>
                  {h.action === 'publish' ? 'Published' : 'Rolled back to'} version{' '}
                  {h.toVersion.versionNumber}
                  {h.fromVersion ? ` (was ${h.fromVersion.versionNumber})` : ''}
                </span>
                <span className="text-muted-foreground">
                  {h.actor.name ?? h.actor.id} - {formatTime(h.occurredAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
