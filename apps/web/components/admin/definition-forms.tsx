'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  DimensionListEditor,
  blankDimension,
  fromDraft,
  type DimensionDraft,
} from '@/components/admin/dimension-editor';
import { adminSend, apiErrorMessage } from '@/components/admin/version-panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

// New definitions start retired with a draft version 1; they become available after publishing (FR-038, FR-068).
export function NewDefinitionForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [dimensions, setDimensions] = useState<DimensionDraft[]>(() => [blankDimension()]);
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
      dimensions: dimensions.map(fromDraft),
    });
    setSaving(false);
    if (!r.ok) {
      setError(apiErrorMessage(r.error));
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
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <DimensionListEditor value={dimensions} onChange={setDimensions} idPrefix="new-def-dim" />
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={saving}>
          Create draft
        </Button>
        <Button type="button" variant="outline" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
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
