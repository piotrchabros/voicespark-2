import { and, eq } from 'drizzle-orm';
import { deletionRequest, getDb } from '@voicespark/db';
import { flaggedDeletions } from '@voicespark/db/repos/system/deletions';
import { enqueue, jobIds } from '../queues';
import { audit } from './audit';

// Deletion SLA check (T143, R19, SC-009), run every 15 min by `maintenance.deletion-sla`. Ids and counts only.

export interface DeletionSlaResult {
  /** Non-completed requests overdue or due within 2 h. */
  flagged: number;
  /** Of those, already past `due_by`. */
  overdue: number;
  /** `failed` requests reset to `pending` and enqueued again. */
  requeued: number;
}

/**
 * Flags at-risk requests and re-enqueues `failed` ones under a fresh job id (`deletion-{id}-r{attempts}`): the old
 * `deletion-{id}` job stays in the failed set and would swallow a re-add (D-U7d). One `deletion.sla_flagged` audit entry
 * per run, only when something is flagged (D-U7f).
 */
export async function runDeletionSla(now: Date = new Date()): Promise<DeletionSlaResult> {
  const rows = await flaggedDeletions(now);
  const overdue = rows.filter((r) => r.dueBy.getTime() < now.getTime()).length;
  let requeued = 0;
  for (const row of rows) {
    if (row.status !== 'failed') continue;
    // last_error_code is kept for the admin view; the guard skips a row another run already reset.
    const reset = await getDb()
      .update(deletionRequest)
      .set({ status: 'pending' })
      .where(and(eq(deletionRequest.id, row.id), eq(deletionRequest.status, 'failed')))
      .returning({ id: deletionRequest.id });
    if (reset.length === 0) continue;
    await enqueue(
      'deletion.execute',
      { deletionRequestId: row.id },
      { jobId: jobIds.deletionRetry(row.id, row.attempts) },
    );
    requeued++;
  }
  const result = { flagged: rows.length, overdue, requeued };
  if (result.flagged > 0) {
    await audit.record({ actorType: 'system', action: 'deletion.sla_flagged', metadata: { ...result } });
  }
  return result;
}
