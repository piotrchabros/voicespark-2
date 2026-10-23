import { requireUserOrRedirect } from '@/lib/page-auth';
import { RecordForm } from './record-form';
import { KIND_LABELS, type HubKind } from './labels';

// Shared by the three create pages.
export async function NewRecordPage({ kind }: { kind: HubKind }) {
  await requireUserOrRedirect();
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">New {KIND_LABELS[kind].singular}</h1>
      <RecordForm kind={kind} />
    </div>
  );
}
