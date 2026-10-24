'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { DeleteRecordDialog } from './delete-record-dialog';
import { MergeDialog } from './merge-dialog';
import { RecordForm } from './record-form';
import type { HubKind, HubRecord } from './labels';

// Edit, Merge and Delete of the detail screen; the form stays open after a save so a similar-records warning can be
// read. Merge (US4, FR-005) keeps this record and folds another one of the same kind into it.
export function RecordDetailActions({ kind, record }: { kind: HubKind; record: HubRecord }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [deleting, setDeleting] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2">
        <Button variant="outline" onClick={() => setEditing((v) => !v)}>
          {editing ? 'Close editor' : 'Edit'}
        </Button>
        <Button variant="outline" onClick={() => setMerging(true)}>
          Merge
        </Button>
        <Button variant="destructive" onClick={() => setDeleting(true)}>
          Delete
        </Button>
      </div>
      {editing ? <RecordForm kind={kind} record={record} /> : null}
      <MergeDialog kind={kind} record={record} open={merging} onOpenChange={setMerging} />
      <DeleteRecordDialog
        kind={kind}
        id={record.id}
        name={record.name}
        open={deleting}
        onOpenChange={setDeleting}
        onDeleted={() => router.push(`/hub/${kind}`)}
      />
    </div>
  );
}
