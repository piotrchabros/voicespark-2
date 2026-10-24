'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { readHubError, type HubKind } from './labels';

const DESCRIPTION_MAX = 2000;

// FR-009, SC-001: attach a file in three steps at most (pick it, optionally describe it, upload). The server checks
// size and type; its reasons (413 `too_large`, 415 `unsupported_type` with the allowed types) are shown as they come.
export function FileUpload({ kind, recordId }: { kind: HubKind; recordId: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!file) {
      setError('Choose a file to attach.');
      return;
    }
    const form = new FormData();
    form.append('file', file);
    if (description.trim()) form.append('description', description.trim());
    setPending(true);
    try {
      const res = await fetch(`/api/hub/${kind}/${recordId}/files`, { method: 'POST', body: form });
      if (!res.ok) {
        const failure = await readHubError(res);
        const allowed = failure.details.allowed;
        setError(
          failure.code === 'unsupported_type' && allowed?.length
            ? `${failure.message} Allowed types: ${allowed.join(', ')}.`
            : failure.message,
        );
        return;
      }
      toast.success('File attached. Its text is being read.');
      setFile(null);
      setDescription('');
      if (inputRef.current) inputRef.current.value = '';
      router.refresh();
    } catch {
      setError('Network error. Try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3 rounded-md border p-3" aria-label="Attach a file">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="hub-file">File</Label>
          <Input
            id="hub-file"
            ref={inputRef}
            type="file"
            className="w-72"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setError(null);
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="hub-file-description">Description (optional)</Label>
          <Input
            id="hub-file-description"
            value={description}
            maxLength={DESCRIPTION_MAX}
            className="w-72"
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Uploading...' : 'Upload'}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}
