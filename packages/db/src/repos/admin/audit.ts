import { and, count, desc, eq, gte, lt, lte, or, sql } from 'drizzle-orm';
import { getDb } from '../../client';
import { auditLogEntry, user } from '../../schema';
import type { AuditEntryView } from './types';

export interface AuditQuery {
  action?: string;
  actorUserId?: string;
  targetType?: string;
  targetId?: string;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit: number;
}

function decodeCursor(cursor: string): { occurredAt: Date; id: string } | null {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const occurredAt = iso ? new Date(iso) : null;
  if (!occurredAt || Number.isNaN(occurredAt.getTime()) || !id) return null;
  return { occurredAt, id };
}

// Postgres keeps microseconds and JS Dates milliseconds, so keyset ordering and comparison use the
// millisecond-truncated timestamp (as notifications.list).
const occurredAtMs = sql<Date>`date_trunc('milliseconds', ${auditLogEntry.occurredAt})`;

/** Never selects `metadata` values: only its keys leave the repository (D-A10). */
export async function queryAudit(
  q: AuditQuery,
): Promise<{ items: AuditEntryView[]; nextCursor: string | null }> {
  const conditions = [];
  if (q.action) conditions.push(eq(auditLogEntry.action, q.action));
  if (q.actorUserId) conditions.push(eq(auditLogEntry.actorUserId, q.actorUserId));
  if (q.targetType) conditions.push(eq(auditLogEntry.targetType, q.targetType));
  if (q.targetId) conditions.push(eq(auditLogEntry.targetId, q.targetId));
  if (q.from) conditions.push(gte(auditLogEntry.occurredAt, q.from));
  if (q.to) conditions.push(lte(auditLogEntry.occurredAt, q.to));
  const cursor = q.cursor ? decodeCursor(q.cursor) : null;
  if (cursor) {
    conditions.push(
      or(
        lt(occurredAtMs, cursor.occurredAt),
        and(eq(occurredAtMs, cursor.occurredAt), lt(auditLogEntry.id, cursor.id)),
      ),
    );
  }

  const rows = await getDb()
    .select({
      id: auditLogEntry.id,
      occurredAt: auditLogEntry.occurredAt,
      actorType: auditLogEntry.actorType,
      actorUserId: auditLogEntry.actorUserId,
      actorName: user.name,
      action: auditLogEntry.action,
      targetType: auditLogEntry.targetType,
      targetId: auditLogEntry.targetId,
      metadata: auditLogEntry.metadata,
    })
    .from(auditLogEntry)
    .leftJoin(user, eq(user.id, auditLogEntry.actorUserId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(occurredAtMs), desc(auditLogEntry.id))
    .limit(q.limit + 1);

  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > q.limit && last
      ? Buffer.from(`${last.occurredAt.toISOString()}|${last.id}`).toString('base64url')
      : null;

  return {
    items: page.map((r) => ({
      id: r.id,
      occurredAt: r.occurredAt.toISOString(),
      actorType: r.actorType,
      actor: r.actorUserId ? { id: r.actorUserId, name: r.actorName ?? null } : null,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      metadataKeys: r.metadata ? Object.keys(r.metadata) : [],
    })),
    nextCursor,
  };
}

export async function countActionsSince(action: string, since: Date): Promise<number> {
  const [row] = await getDb()
    .select({ n: count() })
    .from(auditLogEntry)
    .where(and(eq(auditLogEntry.action, action), gte(auditLogEntry.occurredAt, since)));
  return row?.n ?? 0;
}
