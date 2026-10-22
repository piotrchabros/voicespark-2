import { and, eq, inArray, lt } from 'drizzle-orm';
import {
  contentItem,
  getDb,
  retroscan,
  withTransaction,
  type DbOrTx,
  type FilterCategory,
  type Retroscan,
  type RetroscanStatus,
  type RetroscanTrigger,
} from '@voicespark/db';
import { AppError, type ServiceContext } from '../errors';
import { enqueue, jobIds } from '../queues';
import { audit } from './audit';
import { requestDeletion } from './deletion';

/** A scan result waits this long for confirmation before maintenance dismisses it (T094). */
export const RETROSCAN_TTL_MS = 7 * 24 * 3600 * 1000;

export interface RetroscanView {
  id: string;
  status: RetroscanStatus;
  trigger: RetroscanTrigger;
  matchedCount: number;
  createdAt: string;
  expiresAt: string;
}

export interface CreateRetroscanInput {
  userId: string;
  trigger: RetroscanTrigger;
  exclusionRuleId?: string | null;
  categories: FilterCategory[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DISMISSABLE: readonly RetroscanStatus[] = ['awaiting_confirmation', 'no_matches', 'failed'];

function toView(r: Retroscan): RetroscanView {
  return {
    id: r.id,
    status: r.status,
    trigger: r.trigger,
    matchedCount: r.matchedCount,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
  };
}

async function findOwned(ctx: ServiceContext, id: string, db: DbOrTx): Promise<Retroscan | null> {
  if (!UUID_RE.test(id)) return null;
  const [row] = await db
    .select()
    .from(retroscan)
    .where(and(eq(retroscan.id, id), eq(retroscan.userId, ctx.userId)))
    .limit(1);
  return row ?? null;
}

/** Rule and category retroscans are only offered when there is something to scan (D-C22). */
export async function userHasContent(userId: string, db: DbOrTx = getDb()): Promise<boolean> {
  const [row] = await db
    .select({ id: contentItem.id })
    .from(contentItem)
    .where(eq(contentItem.userId, userId))
    .limit(1);
  return !!row;
}

/**
 * Inserts a `scanning` retroscan and enqueues `retroscan.scan`. The enqueue happens here, so callers inside a
 * transaction must call this after commit (the job would otherwise race the row).
 */
export async function create(input: CreateRetroscanInput, db: DbOrTx = getDb()): Promise<{ id: string }> {
  const [row] = await db
    .insert(retroscan)
    .values({
      userId: input.userId,
      trigger: input.trigger,
      exclusionRuleId: input.exclusionRuleId ?? null,
      categories: input.categories,
      status: 'scanning',
      expiresAt: new Date(Date.now() + RETROSCAN_TTL_MS),
    })
    .returning({ id: retroscan.id });
  if (!row) throw new Error('retroscan_insert_failed');
  await enqueue('retroscan.scan', { retroscanId: row.id }, { jobId: jobIds.retroscan(row.id) });
  return { id: row.id };
}

export async function get(ctx: ServiceContext, id: string): Promise<RetroscanView> {
  const row = await findOwned(ctx, id, getDb());
  if (!row) throw new AppError('not_found');
  return toView(row);
}

/** Worker use: loads the scan regardless of owner (the job payload carries only the id). */
export async function loadForScan(id: string): Promise<Retroscan | null> {
  const [row] = await getDb().select().from(retroscan).where(eq(retroscan.id, id)).limit(1);
  return row ?? null;
}

/** Records the scan outcome; only a `scanning` retroscan moves, so a retried job never overwrites a decision. */
export async function recordResult(
  id: string,
  r: { status: 'awaiting_confirmation' | 'no_matches' | 'failed'; matchedItemIds?: string[] },
): Promise<void> {
  const matchedItemIds = r.status === 'awaiting_confirmation' ? (r.matchedItemIds ?? []) : [];
  await getDb()
    .update(retroscan)
    .set({ status: r.status, matchedItemIds, matchedCount: matchedItemIds.length })
    .where(and(eq(retroscan.id, id), eq(retroscan.status, 'scanning')));
}

/** `awaiting_confirmation` (not expired) -> `purging`, then a `retroscan_purge` deletion request (FR-021, FR-062). */
export async function confirm(ctx: ServiceContext, id: string): Promise<{ deletionRequestId: string }> {
  if (!UUID_RE.test(id)) throw new AppError('not_found');
  await withTransaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(retroscan)
      .where(and(eq(retroscan.id, id), eq(retroscan.userId, ctx.userId)))
      .for('update')
      .limit(1);
    if (!row) throw new AppError('not_found');
    if (row.status !== 'awaiting_confirmation' || row.expiresAt.getTime() <= Date.now()) {
      throw new AppError('conflict', 'retroscan is not awaiting confirmation');
    }
    await tx.update(retroscan).set({ status: 'purging' }).where(eq(retroscan.id, id));
    await audit.record(
      {
        actorType: 'user',
        actorUserId: ctx.userId,
        action: 'retroscan.purge_confirmed',
        targetType: 'retroscan',
        targetId: id,
        metadata: { matchedCount: row.matchedCount },
      },
      tx,
    );
  });
  const { id: deletionRequestId } = await requestDeletion({
    userId: ctx.userId,
    scope: 'retroscan_purge',
    targetId: id,
    requestedBy: 'user',
  });
  return { deletionRequestId };
}

export async function dismiss(ctx: ServiceContext, id: string): Promise<void> {
  if (!UUID_RE.test(id)) throw new AppError('not_found');
  const db = getDb();
  const updated = await db
    .update(retroscan)
    .set({ status: 'dismissed' })
    .where(
      and(
        eq(retroscan.id, id),
        eq(retroscan.userId, ctx.userId),
        inArray(retroscan.status, [...DISMISSABLE]),
      ),
    )
    .returning({ id: retroscan.id });
  if (updated.length > 0) return;
  if (!(await findOwned(ctx, id, db))) throw new AppError('not_found');
  throw new AppError('conflict', 'retroscan cannot be dismissed');
}

/** Maintenance (T094): unconfirmed results past `expires_at` are dismissed. Returns the number dismissed. */
export async function expireStale(now: Date = new Date()): Promise<number> {
  const rows = await getDb()
    .update(retroscan)
    .set({ status: 'dismissed' })
    .where(and(eq(retroscan.status, 'awaiting_confirmation'), lt(retroscan.expiresAt, now)))
    .returning({ id: retroscan.id });
  return rows.length;
}
