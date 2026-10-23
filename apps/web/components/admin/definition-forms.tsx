'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { adminSend, apiErrorMessage, type ApiError } from '@/components/admin/version-panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// Mirrors ANALYSIS_PROMPT_MAX_CHARS in @voicespark/db; the server enforces it (422 too_long).
const ANALYSIS_PROMPT_MAX_CHARS = 20000;

const textareaClass = 'w-full rounded-md border bg-background px-3 py-2 text-sm';

/** Like apiErrorMessage, but names the analysis prompt problems from details.field/reason. */
function formErrorMessage(body: ApiError | null): string {
  const details = body?.error?.details;
  if (body?.error?.code === 'validation_failed' && details?.field === 'analysisPrompt') {
    return details.reason === 'too_long'
      ? `The analysis prompt is longer than ${ANALYSIS_PROMPT_MAX_CHARS.toLocaleString()} characters.`
      : 'The analysis prompt is empty.';
  }
  return apiErrorMessage(body);
}

/** Analysis prompt textarea with a live character counter (FR-001, R18). */
function AnalysisPromptField({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const over = value.length > ANALYSIS_PROMPT_MAX_CHARS;
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>Analysis prompt</Label>
      <textarea
        id={id}
        value={value}
        rows={12}
        aria-describedby={`${id}-count`}
        className={`${textareaClass} font-mono`}
        onChange={(e) => onChange(e.target.value)}
      />
      <p
        id={`${id}-count`}
        className={`text-xs ${over ? 'text-destructive' : 'text-muted-foreground'}`}
      >
        {value.length.toLocaleString()} / {ANALYSIS_PROMPT_MAX_CHARS.toLocaleString()} characters
      </p>
    </div>
  );
}

// New definitions start retired with a draft version 1; they become available after publishing (FR-038, FR-068).
export function NewDefinitionForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [analysisPrompt, setAnalysisPrompt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function create(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const r = await adminSend('/api/admin/definitions', 'POST', {
      key: key.trim(),
      name: name.trim(),
      description: description.trim(),
      analysisPrompt,
    });
    setSaving(false);
    if (!r.ok) {
      setError(formErrorMessage(r.error));
      return;
    }
    const { definition } = r.data as { definition: { id: string } };
    toast.success('Definition created as a draft.');
    router.push(`/admin/definitions/${definition.id}`);
  }

  if (!open) {
    return (
      <Button className="sm:self-start" onClick={() => setOpen(true)}>
        New definition
      </Button>
    );
  }

  return (
    <form onSubmit={create} className="flex flex-col gap-4 rounded-md border p-4">
      <h2 className="text-lg font-semibold">New definition</h2>
      <div className="flex flex-col gap-1">
        <Label htmlFor="new-def-key">Key</Label>
        <Input
          id="new-def-key"
          value={key}
          placeholder="business_formal"
          pattern="[a-z][a-z0-9_]{2,63}"
          title="3-64 lowercase letters, digits and underscores, starting with a letter"
          required
          onChange={(e) => setKey(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="new-def-name">Name</Label>
        <Input
          id="new-def-name"
          value={name}
          maxLength={80}
          required
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="new-def-description">Description</Label>
        <textarea
          id="new-def-description"
          value={description}
          maxLength={500}
          rows={3}
          required
          className={textareaClass}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <AnalysisPromptField
        id="new-def-analysis-prompt"
        value={analysisPrompt}
        onChange={setAnalysisPrompt}
      />
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          disabled={saving || analysisPrompt.length > ANALYSIS_PROMPT_MAX_CHARS}
        >
          Create draft
        </Button>
        <Button type="button" variant="outline" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Edits a draft version's name, description and analysis prompt (PATCH, draft only). */
export function DraftVersionForm({
  definitionId,
  draft,
}: {
  definitionId: string;
  draft: { id: string; name: string; description: string; analysisPrompt: string | null };
}) {
  const router = useRouter();
  const [name, setName] = useState(draft.name);
  const [description, setDescription] = useState(draft.description);
  const [analysisPrompt, setAnalysisPrompt] = useState(draft.analysisPrompt ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const r = await adminSend(
      `/api/admin/definitions/${definitionId}/versions/${draft.id}`,
      'PATCH',
      { name: name.trim(), description: description.trim(), analysisPrompt },
    );
    setSaving(false);
    if (!r.ok) {
      setError(formErrorMessage(r.error));
      return;
    }
    toast.success('Draft saved.');
    router.refresh();
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Label htmlFor="draft-name">Name</Label>
        <Input
          id="draft-name"
          value={name}
          maxLength={80}
          required
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="draft-description">Description</Label>
        <textarea
          id="draft-description"
          value={description}
          maxLength={500}
          rows={3}
          required
          className={textareaClass}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <AnalysisPromptField
        id="draft-analysis-prompt"
        value={analysisPrompt}
        onChange={setAnalysisPrompt}
      />
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button
        type="submit"
        disabled={saving || analysisPrompt.length > ANALYSIS_PROMPT_MAX_CHARS}
        className="sm:self-start"
      >
        Save draft
      </Button>
    </form>
  );
}

export function AvailabilityToggle({
  definitionId,
  availability,
  hasActiveVersion,
}: {
  definitionId: string;
  availability: 'available' | 'retired';
  hasActiveVersion: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const next = availability === 'available' ? 'retired' : 'available';

  async function toggle() {
    setPending(true);
    const r = await adminSend(`/api/admin/definitions/${definitionId}/availability`, 'PUT', {
      availability: next,
    });
    setPending(false);
    if (!r.ok) {
      toast.error(apiErrorMessage(r.error));
      return;
    }
    toast.success(next === 'available' ? 'Definition is now available.' : 'Definition retired.');
    router.refresh();
  }

  return (
    <Button
      size="sm"
      variant={availability === 'available' ? 'outline' : 'default'}
      disabled={pending || (next === 'available' && !hasActiveVersion)}
      title={next === 'available' && !hasActiveVersion ? 'Publish a version first' : undefined}
      onClick={toggle}
    >
      {availability === 'available' ? 'Retire' : 'Make available'}
    </Button>
  );
}
