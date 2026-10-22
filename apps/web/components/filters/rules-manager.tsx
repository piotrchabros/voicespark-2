'use client';

import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { RetroscanDialog } from '@/components/retroscan-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type RuleType = 'sender' | 'domain' | 'folder_label' | 'keyword';

export interface RuleItem {
  id: string;
  type: RuleType;
  value: string;
  createdAt: string;
  updatedAt: string;
}

const TYPES: { value: RuleType; label: string; placeholder: string; hint: string }[] = [
  {
    value: 'sender',
    label: 'Sender',
    placeholder: 'name@example.com',
    hint: 'Enter a valid email address',
  },
  {
    value: 'domain',
    label: 'Domain',
    placeholder: 'example.com',
    hint: 'Enter a domain such as example.com',
  },
  {
    value: 'folder_label',
    label: 'Folder or label',
    placeholder: 'Receipts',
    hint: 'Folder or label must be 1-200 characters',
  },
  {
    value: 'keyword',
    label: 'Keyword',
    placeholder: 'invoice',
    hint: 'Keyword must be 3-100 characters',
  },
];

const typeInfo = (t: RuleType) => TYPES.find((x) => x.value === t) ?? TYPES[0]!;

interface ApiError {
  error?: { code?: string; message?: string };
}

// Mirrors the server-side messages of normalizeRuleValue; the server stays the authority.
function errorMessage(type: RuleType, body: ApiError | null): string {
  const code = body?.error?.code;
  if (code === 'validation_failed') return typeInfo(type).hint;
  if (code === 'conflict') return body?.error?.message ?? 'This rule already exists';
  if (code === 'not_found') return 'This rule no longer exists.';
  return 'Something went wrong. Please try again.';
}

async function send(
  url: string,
  method: 'POST' | 'PATCH' | 'DELETE',
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

export function RulesManager({ initialRules, limit }: { initialRules: RuleItem[]; limit: number }) {
  const [rules, setRules] = useState(initialRules);
  const [type, setType] = useState<RuleType>('sender');
  const [value, setValue] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{
    id: string;
    value: string;
    error: string | null;
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [retroscanId, setRetroscanId] = useState<string | null>(null);
  const atLimit = rules.length >= limit;

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy('add');
    setAddError(null);
    const r = await send('/api/exclusion-rules', 'POST', { type, value });
    setBusy(null);
    if (!r.ok) {
      setAddError(errorMessage(type, r.error));
      return;
    }
    const { rule, retroscanId: scan } = r.data as { rule: RuleItem; retroscanId: string | null };
    setRules((prev) => [...prev, rule]);
    setValue('');
    toast.success('Rule added.');
    setRetroscanId(scan);
  }

  async function saveEdit(rule: RuleItem) {
    if (!editing) return;
    setBusy(rule.id);
    const r = await send(`/api/exclusion-rules/${rule.id}`, 'PATCH', { value: editing.value });
    setBusy(null);
    if (!r.ok) {
      setEditing({ ...editing, error: errorMessage(rule.type, r.error) });
      return;
    }
    const { rule: updated, retroscanId: scan } = r.data as {
      rule: RuleItem;
      retroscanId: string | null;
    };
    setRules((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
    setEditing(null);
    toast.success('Rule updated.');
    setRetroscanId(scan);
  }

  async function remove(rule: RuleItem) {
    setBusy(rule.id);
    const r = await send(`/api/exclusion-rules/${rule.id}`, 'DELETE');
    setBusy(null);
    if (!r.ok && r.error?.error?.code !== 'not_found') {
      toast.error('Could not delete the rule.');
      return;
    }
    setRules((prev) => prev.filter((x) => x.id !== rule.id));
    if (editing?.id === rule.id) setEditing(null);
    toast.success('Rule deleted.');
  }

  const info = typeInfo(type);

  return (
    <div className="flex flex-col gap-6">
      <form
        onSubmit={(e) => void add(e)}
        className="flex flex-col gap-3 rounded-lg border p-3 sm:p-4"
        noValidate
      >
        <h2 className="font-medium">Add a rule</h2>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex flex-col gap-2">
            <Label htmlFor="rule-type">Type</Label>
            <Select
              value={type}
              onValueChange={(v) => {
                setType(v as RuleType);
                setAddError(null);
              }}
            >
              <SelectTrigger id="rule-type" className="w-full sm:w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Label htmlFor="rule-value">Value</Label>
            <Input
              id="rule-value"
              value={value}
              placeholder={info.placeholder}
              aria-invalid={addError !== null}
              aria-describedby="rule-value-hint"
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={busy !== null || atLimit || value.trim() === ''}>
            Add rule
          </Button>
        </div>
        <p
          id="rule-value-hint"
          role={addError ? 'alert' : undefined}
          className={addError ? 'text-destructive text-sm' : 'text-muted-foreground text-sm'}
        >
          {addError ?? info.hint}
        </p>
        {atLimit ? (
          <p className="text-muted-foreground text-sm">
            You have reached the limit of {limit} rules.
          </p>
        ) : null}
      </form>

      <section className="flex flex-col gap-3">
        <h2 className="font-medium">
          Your rules{' '}
          <span className="text-muted-foreground text-sm font-normal">
            ({rules.length} of {limit})
          </span>
        </h2>
        {rules.length === 0 ? (
          <p className="text-muted-foreground text-sm">No rules yet.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {rules.map((rule) => {
              const isEditing = editing?.id === rule.id;
              return (
                <li key={rule.id} className="flex flex-col gap-3 rounded-lg border p-3 sm:p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <Badge variant="secondary">{typeInfo(rule.type).label}</Badge>
                      {isEditing ? null : <span className="text-sm break-all">{rule.value}</span>}
                    </div>
                    {isEditing ? null : (
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy !== null}
                          onClick={() =>
                            setEditing({ id: rule.id, value: rule.value, error: null })
                          }
                        >
                          Edit
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={busy !== null}
                          onClick={() => void remove(rule)}
                        >
                          Delete
                        </Button>
                      </div>
                    )}
                  </div>
                  {isEditing ? (
                    <div className="flex flex-col gap-2">
                      <Label htmlFor={`edit-${rule.id}`} className="sr-only">
                        Rule value
                      </Label>
                      <Input
                        id={`edit-${rule.id}`}
                        value={editing.value}
                        aria-invalid={editing.error !== null}
                        onChange={(e) =>
                          setEditing({ ...editing, value: e.target.value, error: null })
                        }
                      />
                      <p
                        role={editing.error ? 'alert' : undefined}
                        className={
                          editing.error
                            ? 'text-destructive text-sm'
                            : 'text-muted-foreground text-sm'
                        }
                      >
                        {editing.error ?? typeInfo(rule.type).hint}
                      </p>
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          disabled={busy !== null || editing.value.trim() === ''}
                          onClick={() => void saveEdit(rule)}
                        >
                          Save
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditing(null)}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <RetroscanDialog retroscanId={retroscanId} onClose={() => setRetroscanId(null)} />
    </div>
  );
}
