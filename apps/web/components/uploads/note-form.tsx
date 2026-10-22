'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FiltersLink, uploadError } from './upload-dropzone';

const NOTE_MAX_CHARS = 100_000;
const NOTE_TITLE_MAX = 200;

export function NoteForm() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [authored, setAuthored] = useState(true);
  const [pending, setPending] = useState(false);
  const [needsFilters, setNeedsFilters] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setPending(true);
    setNeedsFilters(false);
    try {
      const res = await fetch('/api/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text,
          ...(title.trim() ? { title: title.trim() } : {}),
          authorship: authored ? 'authored' : 'received',
        }),
      });
      if (!res.ok) {
        const err = await uploadError(res);
        if (err.needsFilters) setNeedsFilters(true);
        toast.error(err.message);
        return;
      }
      toast.success('Note received.');
      setTitle('');
      setText('');
      router.refresh();
    } catch {
      toast.error('Network error. Try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <Label htmlFor="note-title">Title (optional)</Label>
        <Input id="note-title" value={title} maxLength={NOTE_TITLE_MAX} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="note-text">Note</Label>
        <textarea
          id="note-text"
          value={text}
          maxLength={NOTE_MAX_CHARS}
          rows={8}
          required
          onChange={(e) => setText(e.target.value)}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        />
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="note-authored" checked={authored} onCheckedChange={(v) => setAuthored(v === true)} />
        <Label htmlFor="note-authored">I wrote this</Label>
      </div>
      {needsFilters ? (
        <p role="alert" className="text-sm text-destructive">
          <FiltersLink /> before adding content.
        </p>
      ) : null}
      <Button type="submit" disabled={pending || !text.trim()} className="self-start">
        {pending ? 'Saving...' : 'Save note'}
      </Button>
    </form>
  );
}
