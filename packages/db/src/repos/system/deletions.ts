import { and, asc, count, lt, ne } from 'drizzle-orm';
import { getDb, type DbOrTx } from '../../client';
import { deletionRequest, type DeletionScope, type DeletionStatus } from '../../schema';

/** Requests due within this window (or already overdue) are flagged by the SLA check (FR-055). */
export const DELETION_AT_RISK_MS = 2 * 60 * 60 * 1000;

export interface FlaggedDeletion {
  id: string;
  scope: DeletionScope;
  status: DeletionStatus;
  dueBy: Date;
  attempts: number;
}

function atRisk(now: Date) {
  return and(
    ne(deletionRequest.status, 'completed'),
    lt(deletionRequest.dueBy, new Date(now.getTime() + DELETION_AT_RISK_MS)),
  );
}

export async function flaggedDeletions(now: Date, db: DbOrTx = getDb()): Promise<FlaggedDeletion[]> {
  return db
    .select({
      id: deletionRequest.id,
      scope: deletionRequest.scope,
      status: deletionRequest.status,
      dueBy: deletionRequest.dueBy,
      attempts: deletionRequest.attempts,
    })
    .from(deletionRequest)
    .where(atRisk(now))
    .orderBy(asc(deletionRequest.dueBy), asc(deletionRequest.id));
}

export async function countFlaggedDeletions(now: Date, db: DbOrTx = getDb()): Promise<number> {
  const [row] = await db.select({ n: count() }).from(deletionRequest).where(atRisk(now));
  return Number(row?.n ?? 0);
}
