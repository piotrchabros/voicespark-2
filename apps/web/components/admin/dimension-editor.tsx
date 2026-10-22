'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { Dimension } from '@voicespark/db';
import { adminSend, apiErrorMessage } from '@/components/admin/version-panel';
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

// Dimension editing for definition drafts (FR-038, FR-040). The server validates with dimensionsSchema and stays the
// authority; this form only shapes the input.

type ValueType = Dimension['valueType'];

const VALUE_TYPES: { value: ValueType; label: string }[] = [
  { value: 'scale', label: 'Scale' },
  { value: 'enum', label: 'Enum' },
  { value: 'text', label: 'Text' },
  { value: 'list', label: 'List' },
];

export const MAX_DIMENSIONS = 20;

const textareaClass = 'w-full rounded-md border bg-background px-3 py-2 text-sm';

/** Editable form shape: numbers and allowed values are kept as raw text while typing. */
export interface DimensionDraft {
  key: string;
  name: string;
  description: string;
  valueType: ValueType;
  scaleMin: string;
  scaleMax: string;
  minLabel: string;
  maxLabel: string;
  allowedValues: string;
  guidance: string;
}

export function blankDimension(): DimensionDraft {
  return {
    key: '',
    name: '',
    description: '',
    valueType: 'scale',
    scaleMin: '1',
    scaleMax: '5',
    minLabel: '',
    maxLabel: '',
    allowedValues: '',
    guidance: '',
  };
}

export function toDraft(d: Dimension): DimensionDraft {
  return {
    key: d.key,
    name: d.name,
    description: d.description,
    valueType: d.valueType,
    scaleMin: d.scale ? String(d.scale.min) : '1',
    scaleMax: d.scale ? String(d.scale.max) : '5',
    minLabel: d.scale?.minLabel ?? '',
    maxLabel: d.scale?.maxLabel ?? '',
    allowedValues: (d.allowedValues ?? []).join('\n'),
    guidance: d.guidance ?? '',
  };
}

export function fromDraft(d: DimensionDraft): Dimension {
  const dim: Dimension = {
    key: d.key.trim(),
    name: d.name.trim(),
    description: d.description.trim(),
    valueType: d.valueType,
  };
  if (d.valueType === 'scale') {
    dim.scale = {
      min: Number(d.scaleMin),
      max: Number(d.scaleMax),
      minLabel: d.minLabel.trim(),
      maxLabel: d.maxLabel.trim(),
    };
  }
  if (d.valueType === 'enum') {
    dim.allowedValues = d.allowedValues
      .split(/[\n,]/)
      .map((v) => v.trim())
      .filter((v) => v !== '');
  }
  if (d.guidance.trim() !== '') dim.guidance = d.guidance.trim();
  return dim;
}

/** Controlled list of dimension fields; shared by the new-definition form and the draft editor. */
export function DimensionListEditor({
  value,
  onChange,
  idPrefix,
}: {
  value: DimensionDraft[];
  onChange: (next: DimensionDraft[]) => void;
  idPrefix: string;
}) {
  function update(index: number, patch: Partial<DimensionDraft>) {
    onChange(value.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  }
  function move(index: number, by: -1 | 1) {
    const target = index + by;
    if (target < 0 || target >= value.length) return;
    const next = [...value];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  }

  return (
    <div className="flex flex-col gap-4">
      {value.map((d, i) => {
        const id = `${idPrefix}-${i}`;
        return (
          <fieldset key={i} className="flex flex-col gap-3 rounded-md border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <legend className="text-sm font-medium">Dimension {i + 1}</legend>
              <span className="flex gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  Up
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={i === value.length - 1}
                  onClick={() => move(i, 1)}
                >
                  Down
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={value.length <= 1}
                  onClick={() => onChange(value.filter((_, j) => j !== i))}
                >
                  Remove
                </Button>
              </span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${id}-key`}>Key</Label>
                <Input
                  id={`${id}-key`}
                  value={d.key}
                  placeholder="formality"
                  pattern="[a-z][a-z0-9_]{1,40}"
                  title="Lowercase letters, digits and underscores, starting with a letter"
                  required
                  onChange={(e) => update(i, { key: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${id}-name`}>Name</Label>
                <Input
                  id={`${id}-name`}
                  value={d.name}
                  required
                  onChange={(e) => update(i, { name: e.target.value })}
                />
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-description`}>Description</Label>
              <textarea
                id={`${id}-description`}
                value={d.description}
                rows={2}
                required
                className={textareaClass}
                onChange={(e) => update(i, { description: e.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-type`}>Value type</Label>
              <Select
                value={d.valueType}
                onValueChange={(v) => update(i, { valueType: v as ValueType })}
              >
                <SelectTrigger id={`${id}-type`} className="w-full sm:w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VALUE_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {d.valueType === 'scale' ? (
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`${id}-min`}>Minimum</Label>
                  <Input
                    id={`${id}-min`}
                    type="number"
                    value={d.scaleMin}
                    required
                    onChange={(e) => update(i, { scaleMin: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`${id}-max`}>Maximum</Label>
                  <Input
                    id={`${id}-max`}
                    type="number"
                    value={d.scaleMax}
                    required
                    onChange={(e) => update(i, { scaleMax: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`${id}-min-label`}>Minimum label</Label>
                  <Input
                    id={`${id}-min-label`}
                    value={d.minLabel}
                    placeholder="casual"
                    onChange={(e) => update(i, { minLabel: e.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`${id}-max-label`}>Maximum label</Label>
                  <Input
                    id={`${id}-max-label`}
                    value={d.maxLabel}
                    placeholder="formal"
                    onChange={(e) => update(i, { maxLabel: e.target.value })}
                  />
                </div>
              </div>
            ) : null}
            {d.valueType === 'enum' ? (
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${id}-allowed`}>
                  Allowed values (one per line or comma separated)
                </Label>
                <textarea
                  id={`${id}-allowed`}
                  value={d.allowedValues}
                  rows={3}
                  required
                  className={textareaClass}
                  onChange={(e) => update(i, { allowedValues: e.target.value })}
                />
              </div>
            ) : null}
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-guidance`}>Guidance (optional)</Label>
              <textarea
                id={`${id}-guidance`}
                value={d.guidance}
                rows={2}
                className={textareaClass}
                onChange={(e) => update(i, { guidance: e.target.value })}
              />
            </div>
          </fieldset>
        );
      })}
      <Button
        type="button"
        variant="outline"
        className="sm:self-start"
        disabled={value.length >= MAX_DIMENSIONS}
        onClick={() => onChange([...value, blankDimension()])}
      >
        Add dimension
      </Button>
    </div>
  );
}

/** Edits a draft version's name, description and dimensions (PATCH draft only). */
export function DimensionEditor({
  definitionId,
  draft,
}: {
  definitionId: string;
  draft: {
    id: string;
    versionNumber: number;
    name: string;
    description: string;
    dimensions: Dimension[];
  };
}) {
  const router = useRouter();
  const [name, setName] = useState(draft.name);
  const [description, setDescription] = useState(draft.description);
  const [dimensions, setDimensions] = useState(() => draft.dimensions.map(toDraft));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const r = await adminSend(
      `/api/admin/definitions/${definitionId}/versions/${draft.id}`,
      'PATCH',
      { name: name.trim(), description: description.trim(), dimensions: dimensions.map(fromDraft) },
    );
    setSaving(false);
    if (!r.ok) {
      setError(apiErrorMessage(r.error));
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
      <DimensionListEditor value={dimensions} onChange={setDimensions} idPrefix="draft-dim" />
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button type="submit" disabled={saving} className="sm:self-start">
        Save draft (version {draft.versionNumber})
      </Button>
    </form>
  );
}
