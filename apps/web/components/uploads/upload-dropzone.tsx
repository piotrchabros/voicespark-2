'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

const ERROR_TEXT: Record<string, string> = {
  unsupported_type: 'Unsupported file type. Use PDF, DOCX, TXT or MD.',
  too_large: 'That file is too large.',
};

/** Maps a failed upload/note response to a user message; `needsFilters` is set for 409 filter_confirmation_required. */
export async function uploadError(res: Response): Promise<{ message: string; needsFilters: boolean }> {
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    const code = body.error?.code ?? '';
    if (code === 'filter_confirmation_required') {
      return { message: 'Confirm your exclusion filters before adding content.', needsFilters: true };
    }
    return { message: ERROR_TEXT[code] ?? body.error?.message ?? 'Something went wrong.', needsFilters: false };
  } catch {
    return { message: 'Something went wrong.', needsFilters: false };
  }
}

export function FiltersLink() {
  return (
    <Link href="/onboarding/filters?returnTo=/uploads" className="underline">
      Confirm your exclusion filters
    </Link>
  );
}

export function UploadDropzone({ maxMb }: { maxMb: number }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [authored, setAuthored] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [pending, setPending] = useState(false);
  const [needsFilters, setNeedsFilters] = useState(false);

  async function send(files: FileList | File[]) {
    setPending(true);
    setNeedsFilters(false);
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.set('file', file);
        form.set('authorship', authored ? 'authored' : 'received');
        const res = await fetch('/api/uploads', { method: 'POST', body: form });
        if (!res.ok) {
          const err = await uploadError(res);
          if (err.needsFilters) setNeedsFilters(true);
          toast.error(`${file.name}: ${err.message}`);
        } else {
          toast.success(`${file.name} received.`);
        }
      }
      router.refresh();
    } catch {
      toast.error('Network error. Try again.');
    } finally {
      setPending(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length > 0) void send(e.dataTransfer.files);
        }}
        className={`flex flex-col items-center gap-3 rounded-md border-2 border-dashed p-6 text-center ${
          dragging ? 'border-primary bg-muted' : ''
        }`}
      >
        <p className="text-sm">Drag and drop files here, or choose them.</p>
        <p className="text-xs text-muted-foreground">PDF, DOCX, TXT, MD up to {maxMb} MB</p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept=".pdf,.docx,.txt,.md"
          className="sr-only"
          aria-label="Choose files"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) void send(e.target.files);
          }}
        />
        <Button type="button" disabled={pending} onClick={() => inputRef.current?.click()}>
          {pending ? 'Uploading...' : 'Choose files'}
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="upload-authored" checked={authored} onCheckedChange={(v) => setAuthored(v === true)} />
        <Label htmlFor="upload-authored">I wrote this</Label>
      </div>
      {needsFilters ? (
        <p role="alert" className="text-sm text-destructive">
          <FiltersLink /> before adding content.
        </p>
      ) : null}
    </div>
  );
}
