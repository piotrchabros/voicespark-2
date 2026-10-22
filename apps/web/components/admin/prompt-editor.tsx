'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { PromptEffort } from '@voicespark/db';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// Mirrors the prompts service bounds (maxTokens 256-64000, change note <= 500).
const MAX_TOKENS_MIN = 256;
const MAX_TOKENS_MAX = 64_000;
const CHANGE_NOTE_MAX = 500;

const TEXTAREA_CLASS =
  'min-h-40 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50';

/** Serializable copy of the prompting `VariableSpec` for one key family. */
export interface VariableHelpSpec {
  scalars: readonly string[];
  lists: Readonly<Record<string, readonly string[]>>;
  sections: readonly string[];
  required: readonly string[];
}

export interface PromptDraft {
  id: string;
  versionNumber: number;
  systemTemplate: string;
  userTemplate: string;
  model: string;
  effort: PromptEffort;
  maxTokens: number;
  changeNote: string | null;
}

interface ApiError {
  code: string;
  message: string;
  details?: {
    unknownVariables?: string[];
    missingRequired?: string[];
    issues?: { path: string; message: string }[];
  };
}

interface Validation {
  valid: boolean;
  unknownVariables: string[];
  missingRequired: string[];
}

async function readError(res: Response): Promise<ApiError> {
  try {
    const body = (await res.json()) as { error?: ApiError };
    return body.error ?? { code: 'unknown', message: 'Something went wrong.' };
  } catch {
    return { code: 'unknown', message: 'Something went wrong.' };
  }
}

function errorText(err: ApiError): string {
  if (err.code === 'model_not_allowed') return 'That model is not in the allowed model list.';
  if (err.code === 'unknown_template_variable')
    return 'The templates use variables this prompt key does not allow.';
  if (err.code === 'conflict') return err.message || 'A prompt with that key already exists.';
  if (err.code === 'validation_failed' && err.details?.issues?.length) {
    return err.details.issues
      .map((i) => (i.path ? `${i.path}: ${i.message}` : i.message))
      .join('; ');
  }
  return err.message || 'Something went wrong.';
}

/** Turns an `unknown_template_variable` error into the same shape as a validate result. */
function validationFromError(err: ApiError): Validation | null {
  if (err.code !== 'unknown_template_variable') return null;
  return {
    valid: false,
    unknownVariables: err.details?.unknownVariables ?? [],
    missingRequired: err.details?.missingRequired ?? [],
  };
}

async function send(
  url: string,
  method: string,
  body?: unknown,
): Promise<{ res: Response } | { error: ApiError }> {
  try {
    const res = await fetch(url, {
      method,
      ...(body !== undefined
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : {}),
    });
    if (!res.ok) return { error: await readError(res) };
    return { res };
  } catch {
    return { error: { code: 'network', message: 'Network error. Try again.' } };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Variable whitelist help

export function VariableHelp({ promptKey, spec }: { promptKey: string; spec: VariableHelpSpec }) {
  const required = new Set(spec.required);
  const lists = Object.entries(spec.lists);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Allowed variables</CardTitle>
        <CardDescription className="break-all">
          Whitelist for <code>{promptKey}</code>. Any other variable is rejected on save.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <ul className="flex flex-col gap-1">
          {spec.scalars.map((name) => (
            <li key={name} className="flex flex-wrap items-center gap-2">
              <code className="break-all">{`{{${name}}}`}</code>
              {required.has(name) ? (
                <span className="text-xs text-muted-foreground">required</span>
              ) : null}
            </li>
          ))}
        </ul>
        {lists.length > 0 ? (
          <div className="flex flex-col gap-1">
            <p className="font-medium">Lists</p>
            {lists.map(([name, fields]) => (
              <div key={name}>
                <code className="break-all">{`{{#${name}}}...{{/${name}}}`}</code>
                {required.has(name) ? (
                  <span className="ml-2 text-xs text-muted-foreground">required</span>
                ) : null}
                <p className="text-xs text-muted-foreground break-words">
                  Item fields: {fields.map((f) => `{{${f}}}`).join(', ')}
                </p>
              </div>
            ))}
          </div>
        ) : null}
        {spec.sections.length > 0 ? (
          <div className="flex flex-col gap-1">
            <p className="font-medium">Sections</p>
            {spec.sections.map((name) => (
              <code key={name} className="break-all">{`{{#${name}}}...{{/${name}}}`}</code>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ValidationResult({ result }: { result: Validation }) {
  if (result.valid)
    return <p className="text-sm text-green-700 dark:text-green-400">Templates are valid.</p>;
  return (
    <div className="flex flex-col gap-1 text-sm text-destructive" role="alert">
      {result.unknownVariables.length > 0 ? (
        <p className="break-words">Unknown variables: {result.unknownVariables.join(', ')}</p>
      ) : null}
      {result.missingRequired.length > 0 ? (
        <p className="break-words">
          Missing required variables: {result.missingRequired.join(', ')}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Shared template / settings fields

interface FieldValues {
  systemTemplate: string;
  userTemplate: string;
  model: string;
  effort: PromptEffort;
  maxTokens: string;
}

function TemplateFields({
  idPrefix,
  values,
  onChange,
  models,
  efforts,
  disabled,
}: {
  idPrefix: string;
  values: FieldValues;
  onChange: (patch: Partial<FieldValues>) => void;
  models: string[];
  efforts: readonly PromptEffort[];
  disabled: boolean;
}) {
  const modelOptions =
    models.includes(values.model) || !values.model ? models : [values.model, ...models];
  return (
    <>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${idPrefix}-system`}>System template</Label>
        <textarea
          id={`${idPrefix}-system`}
          className={TEXTAREA_CLASS}
          value={values.systemTemplate}
          disabled={disabled}
          onChange={(e) => onChange({ systemTemplate: e.target.value })}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${idPrefix}-user`}>User template</Label>
        <textarea
          id={`${idPrefix}-user`}
          className={TEXTAREA_CLASS}
          value={values.userTemplate}
          disabled={disabled}
          onChange={(e) => onChange({ userTemplate: e.target.value })}
        />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${idPrefix}-model`}>Model</Label>
          <Select
            value={values.model}
            disabled={disabled}
            onValueChange={(model) => onChange({ model })}
          >
            <SelectTrigger id={`${idPrefix}-model`} className="w-full">
              <SelectValue placeholder="Choose a model" />
            </SelectTrigger>
            <SelectContent>
              {modelOptions.map((m) => (
                <SelectItem key={m} value={m}>
                  {models.includes(m) ? m : `${m} (not allowed)`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${idPrefix}-effort`}>Effort</Label>
          <Select
            value={values.effort}
            disabled={disabled}
            onValueChange={(effort) => onChange({ effort: effort as PromptEffort })}
          >
            <SelectTrigger id={`${idPrefix}-effort`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {efforts.map((e) => (
                <SelectItem key={e} value={e}>
                  {e}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${idPrefix}-max-tokens`}>Max tokens</Label>
          <Input
            id={`${idPrefix}-max-tokens`}
            type="number"
            inputMode="numeric"
            min={MAX_TOKENS_MIN}
            max={MAX_TOKENS_MAX}
            value={values.maxTokens}
            disabled={disabled}
            onChange={(e) => onChange({ maxTokens: e.target.value })}
          />
        </div>
      </div>
    </>
  );
}

function parseMaxTokens(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MAX_TOKENS_MIN || n > MAX_TOKENS_MAX) return null;
  return n;
}

// ---------------------------------------------------------------------------------------------------------------------
// New custom prompt

export function NewPromptForm({
  models,
  efforts,
  defaultModel,
}: {
  models: string[];
  efforts: readonly PromptEffort[];
  defaultModel: string;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [key, setKey] = useState('custom.');
  const [description, setDescription] = useState('');
  const [values, setValues] = useState<FieldValues>({
    systemTemplate: '',
    userTemplate: '',
    model: defaultModel,
    effort: efforts.includes('medium') ? 'medium' : (efforts[0] ?? 'medium'),
    maxTokens: '1024',
  });
  const [validation, setValidation] = useState<Validation | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const maxTokens = parseMaxTokens(values.maxTokens);
    if (maxTokens === null) {
      toast.error(`Max tokens must be a whole number from ${MAX_TOKENS_MIN} to ${MAX_TOKENS_MAX}.`);
      return;
    }
    setPending(true);
    setValidation(null);
    const result = await send('/api/admin/prompts', 'POST', {
      key: key.trim(),
      description: description.trim(),
      systemTemplate: values.systemTemplate,
      userTemplate: values.userTemplate,
      model: values.model,
      effort: values.effort,
      maxTokens,
    });
    setPending(false);
    if ('error' in result) {
      setValidation(validationFromError(result.error));
      toast.error(errorText(result.error));
      return;
    }
    const { prompt } = (await result.res.json()) as { prompt: { id: string } };
    toast.success('Custom prompt created as a draft.');
    router.push(`/admin/prompts/${prompt.id}`);
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="new-prompt-key">Key</Label>
          <Input
            id="new-prompt-key"
            value={key}
            required
            maxLength={67}
            pattern="custom\.[a-z0-9_]{2,60}"
            title="custom. followed by 2-60 lowercase letters, digits or underscores"
            onChange={(e) => setKey(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">custom.name using a-z, 0-9 and _</p>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="new-prompt-description">Description</Label>
          <Input
            id="new-prompt-description"
            value={description}
            maxLength={500}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
      </div>
      <TemplateFields
        idPrefix="new-prompt"
        values={values}
        onChange={(patch) => setValues((v) => ({ ...v, ...patch }))}
        models={models}
        efforts={efforts}
        disabled={pending}
      />
      {validation ? <ValidationResult result={validation} /> : null}
      <Button
        type="submit"
        className="sm:self-start"
        disabled={
          pending || !values.systemTemplate.trim() || !values.userTemplate.trim() || !values.model
        }
      >
        Create custom prompt
      </Button>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Draft editor

export function CreateDraftButton({ promptId }: { promptId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function create() {
    setPending(true);
    const result = await send(`/api/admin/prompts/${promptId}/versions`, 'POST');
    setPending(false);
    if ('error' in result) {
      toast.error(errorText(result.error));
      return;
    }
    toast.success('Draft created from the active version.');
    router.refresh();
  }

  return (
    <Button onClick={create} disabled={pending} className="sm:self-start">
      Create draft
    </Button>
  );
}

export function PromptEditor({
  promptId,
  draft,
  models,
  efforts,
}: {
  promptId: string;
  draft: PromptDraft;
  models: string[];
  efforts: readonly PromptEffort[];
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [values, setValues] = useState<FieldValues>({
    systemTemplate: draft.systemTemplate,
    userTemplate: draft.userTemplate,
    model: draft.model,
    effort: draft.effort,
    maxTokens: String(draft.maxTokens),
  });
  const [changeNote, setChangeNote] = useState(draft.changeNote ?? '');
  const [dirty, setDirty] = useState(false);
  const [validation, setValidation] = useState<Validation | null>(null);

  const versionUrl = `/api/admin/prompts/${promptId}/versions/${draft.id}`;

  /** Saves the draft; returns false (after showing the error) when the save was rejected. */
  async function save(): Promise<boolean> {
    const maxTokens = parseMaxTokens(values.maxTokens);
    if (maxTokens === null) {
      toast.error(`Max tokens must be a whole number from ${MAX_TOKENS_MIN} to ${MAX_TOKENS_MAX}.`);
      return false;
    }
    const result = await send(versionUrl, 'PATCH', {
      systemTemplate: values.systemTemplate,
      userTemplate: values.userTemplate,
      model: values.model,
      effort: values.effort,
      maxTokens,
      changeNote: changeNote.trim() === '' ? null : changeNote.trim(),
    });
    if ('error' in result) {
      setValidation(validationFromError(result.error));
      toast.error(errorText(result.error));
      return false;
    }
    setDirty(false);
    return true;
  }

  async function onSave() {
    setPending(true);
    setValidation(null);
    const ok = await save();
    setPending(false);
    if (ok) {
      toast.success('Draft saved.');
      router.refresh();
    }
  }

  async function onValidate() {
    setPending(true);
    setValidation(null);
    // Validation runs on the stored draft, so unsaved edits are saved first.
    if (dirty && !(await save())) {
      setPending(false);
      return;
    }
    const result = await send(`${versionUrl}/validate`, 'POST');
    setPending(false);
    if ('error' in result) {
      toast.error(errorText(result.error));
      return;
    }
    setValidation((await result.res.json()) as Validation);
  }

  function change(patch: Partial<FieldValues>) {
    setValues((v) => ({ ...v, ...patch }));
    setDirty(true);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Draft v{draft.versionNumber}</CardTitle>
        <CardDescription>
          Publish, discard and diff the draft in the versions panel below.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <TemplateFields
          idPrefix={`draft-${draft.id}`}
          values={values}
          onChange={change}
          models={models}
          efforts={efforts}
          disabled={pending}
        />
        <div className="flex flex-col gap-2">
          <Label htmlFor={`draft-${draft.id}-note`}>Change note</Label>
          <Input
            id={`draft-${draft.id}-note`}
            value={changeNote}
            maxLength={CHANGE_NOTE_MAX}
            disabled={pending}
            onChange={(e) => {
              setChangeNote(e.target.value);
              setDirty(true);
            }}
          />
        </div>
        {validation ? <ValidationResult result={validation} /> : null}
        <div className="flex flex-wrap gap-2">
          <Button onClick={onSave} disabled={pending || !dirty}>
            Save draft
          </Button>
          <Button variant="outline" onClick={onValidate} disabled={pending}>
            Validate
          </Button>
        </div>
        {dirty ? (
          <p className="text-xs text-muted-foreground">
            Unsaved changes. Preview uses the saved draft.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// Preview (synthetic fixture only, FR-057)

export function PromptPreview({
  promptId,
  versions,
  supportsRevision,
}: {
  promptId: string;
  versions: { id: string; label: string }[];
  supportsRevision: boolean;
}) {
  const [versionId, setVersionId] = useState(versions[0]?.id ?? '');
  const [isRevision, setIsRevision] = useState(false);
  const [pending, setPending] = useState(false);
  const [rendered, setRendered] = useState<{ system: string; user: string } | null>(null);

  async function preview() {
    if (!versionId) return;
    setPending(true);
    const result = await send(
      `/api/admin/prompts/${promptId}/versions/${versionId}/preview`,
      'POST',
      supportsRevision ? { isRevision } : undefined,
    );
    setPending(false);
    if ('error' in result) {
      toast.error(errorText(result.error));
      return;
    }
    setRendered((await result.res.json()) as { system: string; user: string });
  }

  if (versions.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Preview</CardTitle>
        <CardDescription>
          Renders with a synthetic fixture only. No user data is used and nothing is stored.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex flex-col gap-2">
            <Label htmlFor={`preview-${promptId}-version`}>Version</Label>
            <Select
              value={versionId}
              onValueChange={(v) => {
                setVersionId(v);
                setRendered(null);
              }}
            >
              <SelectTrigger id={`preview-${promptId}-version`} className="w-full sm:w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {versions.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {supportsRevision ? (
            <div className="flex items-center gap-2 sm:pb-2">
              <Checkbox
                id={`preview-${promptId}-revision`}
                checked={isRevision}
                onCheckedChange={(v) => setIsRevision(v === true)}
              />
              <Label htmlFor={`preview-${promptId}-revision`}>Render as revision</Label>
            </div>
          ) : null}
          <Button variant="outline" onClick={preview} disabled={pending || !versionId}>
            Render preview
          </Button>
        </div>
        {rendered ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">System</p>
              <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap break-words">
                {rendered.system}
              </pre>
            </div>
            <div className="flex flex-col gap-1">
              <p className="text-sm font-medium">User</p>
              <pre className="max-h-96 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap break-words">
                {rendered.user}
              </pre>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
