'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { JSONContent } from '@tiptap/react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { NoteEditor } from './note-editor';
import { NoteView } from './note-view';
import { SyncStatusBadge } from './sync-status';
import { hubApiError, plural, type HubKind, type HubNoteItem } from './labels';

const UNTITLED = 'Untitled note';

// Notes section of the detail screen (US2, FR-008): every note of the record, newest change first, with one editor
// open at a time. The list comes from the page (one request, SC-002); a save refreshes it.
export function NoteList({ kind, recordId, notes }: { kind: HubKind; recordId: string; notes: HubNoteItem[] }) {
  const router = useRouter();
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function saved(note: HubNoteItem) {
    toast.success('Note saved.');
    if (note.redactedValues > 0) {
      toast.info(`${plural(note.redactedValues, 'sensitive value')} excluded from the note before saving.`);
    }
    setEditing(null);
    router.refresh();
  }

  async function remove(id: string) {
    setPending(true);
    try {
      const res = await fetch(`/api/hub/notes/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        toast.error(await hubApiError(res));
        return;
      }
      toast.success('Note removed.');
      setRemoving(null);
      router.refresh();
    } catch {
      toast.error('Network error. Try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="hub-notes-heading" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id="hub-notes-heading" className="text-lg font-semibold">
          Notes
        </h2>
        {editing !== 'new' ? (
          <Button variant="outline" size="sm" onClick={() => setEditing('new')}>
            New note
          </Button>
        ) : null}
      </div>
      {editing === 'new' ? (
        <NoteEditor kind={kind} recordId={recordId} onSaved={saved} onCancel={() => setEditing(null)} />
      ) : null}
      {notes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No notes yet.</p>
      ) : (
        <ul className="flex flex-col gap-3" aria-label="Notes">
          {notes.map((n) => (
            <li key={n.id}>
              {editing === n.id ? (
                <NoteEditor
                  kind={kind}
                  recordId={recordId}
                  note={n}
                  onSaved={saved}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <article aria-label={n.title || UNTITLED} className="flex flex-col gap-2 rounded-md border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-col">
                      <h3 className="font-medium">{n.title || UNTITLED}</h3>
                      <span className="text-xs text-muted-foreground">
                        Changed {new Date(n.updatedAt).toLocaleString()}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {n.sync ? <SyncStatusBadge sync={n.sync} /> : null}
                      {n.redactedValues > 0 ? (
                        <Badge variant="outline">{plural(n.redactedValues, 'value')} excluded</Badge>
                      ) : null}
                      <Button variant="ghost" size="sm" onClick={() => setEditing(n.id)}>
                        Change note
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setRemoving(n.id)}>
                        Remove note
                      </Button>
                    </div>
                  </div>
                  {removing === n.id ? (
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span>Remove this note permanently?</span>
                      <Button variant="destructive" size="sm" disabled={pending} onClick={() => void remove(n.id)}>
                        Remove permanently
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setRemoving(null)}>
                        Keep
                      </Button>
                    </div>
                  ) : null}
                  <NoteView key={n.updatedAt} body={n.body as JSONContent} />
                </article>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
