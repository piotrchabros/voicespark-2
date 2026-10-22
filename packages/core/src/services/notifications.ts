import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { getDb, notification, user, type DbOrTx, type Notification, type NotificationType } from '@voicespark/db';
import { enqueue } from '../queues';

export type NotificationPayload = Record<string, string | number | boolean | null>;
export type NotificationRow = Notification;

const scalar = z.union([
  z.null(),
  z.number(),
  z.boolean(),
  z.uuid(),
  z.string().regex(/^[a-z0-9_.-]{1,64}$/),
]);

/** Ids, counts and enum literals only: never content or excluded values (FR-020, FR-048). */
export const NOTIFICATION_PAYLOAD_SCHEMA = z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/), scalar);

/**
 * Inserts the in-app row, then enqueues `notify.send`. Inside a transaction the job may run before the
 * commit; the handler retries when the row is not visible yet.
 */
export async function notify(
  userId: string,
  type: NotificationType,
  payload: NotificationPayload,
  db: DbOrTx = getDb(),
): Promise<{ id: string }> {
  const safe = NOTIFICATION_PAYLOAD_SCHEMA.parse(payload);
  const [row] = await db.insert(notification).values({ userId, type, payload: safe }).returning({ id: notification.id });
  if (!row) throw new Error('notification_insert_failed');
  await enqueue('notify.send', { notificationId: row.id });
  return { id: row.id };
}

export async function markRead(userId: string, notificationId: string): Promise<boolean> {
  const rows = await getDb()
    .update(notification)
    .set({ readAt: new Date() })
    .where(and(eq(notification.id, notificationId), eq(notification.userId, userId), isNull(notification.readAt)))
    .returning({ id: notification.id });
  if (rows.length > 0) return true;
  // Already read still counts as success; a missing or foreign id does not.
  const [existing] = await getDb()
    .select({ id: notification.id })
    .from(notification)
    .where(and(eq(notification.id, notificationId), eq(notification.userId, userId)))
    .limit(1);
  return existing !== undefined;
}

// Cursor is `<createdAt ISO>|<id>` base64url-encoded; newest first. Postgres keeps microseconds and JS Dates
// milliseconds, so ordering and comparison use the millisecond-truncated timestamp.
const createdAtMs = sql<Date>`date_trunc('milliseconds', ${notification.createdAt})`;

function encodeCursor(row: NotificationRow): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (!iso || !id || !z.uuid().safeParse(id).success) return null;
  const createdAt = new Date(iso);
  return Number.isNaN(createdAt.getTime()) ? null : { createdAt, id };
}

export async function list(
  userId: string,
  q: { cursor?: string; limit: number },
): Promise<{ items: NotificationRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(1, Math.trunc(q.limit)), 100);
  const cursor = q.cursor ? decodeCursor(q.cursor) : null;
  const rows = await getDb()
    .select()
    .from(notification)
    .where(
      and(
        eq(notification.userId, userId),
        cursor
          ? or(
              lt(createdAtMs, cursor.createdAt),
              and(eq(createdAtMs, cursor.createdAt), lt(notification.id, cursor.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(createdAtMs), desc(notification.id))
    .limit(limit + 1);
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
}

/** Used by the `notify.send` handler: the row plus the recipient address, or null when gone. */
export async function getForDelivery(
  notificationId: string,
): Promise<{ notification: NotificationRow; email: string } | null> {
  const [row] = await getDb()
    .select({ notification, email: user.email })
    .from(notification)
    .innerJoin(user, eq(user.id, notification.userId))
    .where(eq(notification.id, notificationId))
    .limit(1);
  return row ?? null;
}

export async function markEmailSent(notificationId: string): Promise<void> {
  await getDb()
    .update(notification)
    .set({ emailSentAt: new Date() })
    .where(and(eq(notification.id, notificationId), isNull(notification.emailSentAt)));
}
