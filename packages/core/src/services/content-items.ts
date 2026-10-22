import { and, desc, eq, exists, inArray, lt, ne, or, sql } from 'drizzle-orm';
import {
  contentItem,
  contentItemOccurrence,
  deletionRequest,
  exclusionReport,
  getDb,
  withTransaction,
  type Authorship,
  type ContentKind,
  type FilterCategory,
} from '@voicespark/db';
import { getContentItem, type ContentItemRow } from '@voicespark/db/repos/user/content-items';
import {
  createMemoryStore,
  namespaceFor,
  type MemoryStore,
} from '@voicespark/integrations/supermemory';
import { subjectRef } from '../crypto';
import { loadEnv } from '../env';
import { AppError, type ServiceContext } from '../errors';
import { audit } from './audit';
import { requestDeletion } from './deletion';

export const CONTENT_ITEMS_MAX_LIMIT = 100;
const SNIPPET_LENGTH = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Cursor dates are millisecond ISO strings while Postgres keeps microseconds: compare/order on truncated values.
const itemDateMs = sql<Date>`date_trunc('milliseconds', ${contentItem.itemDate})`;

export interface ContentItemView {
  id: string;
  kind: ContentKind;
  authorship: Authorship;
  itemDate: string;
  sourceIds: string[];
  title?: string;
  snippet?: string;
}

export interface ContentItemsQuery {
  sourceId?: string;
  query?: string;
  cursor?: string;
  limit: number;
}

interface ItemRow {
  id: string;
  kind: ContentKind;
  authorship: Authorship;
  itemDate: Date;
  parentItemId: string | null;
}

/**
 * Lists the user's active items (parents and attachments), newest first with a keyset cursor. Title and snippet
 * come live from the owner's Supermemory namespace (never stored). With `query`, results follow search score
 * and are not paginated (`nextCursor` null).
 */
export async function list(
  ctx: ServiceContext,
  q: ContentItemsQuery,
  store?: MemoryStore,
): Promise<{ items: ContentItemView[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(Math.trunc(q.limit) || 1, 1), CONTENT_ITEMS_MAX_LIMIT);
  if (q.sourceId !== undefined && !UUID_RE.test(q.sourceId)) return { items: [], nextCursor: null };
  const memory = store ?? createMemoryStore(loadEnv());
  const ns = namespaceFor(ctx.userId);
  const db = getDb();

  const conditions = [eq(contentItem.userId, ctx.userId), eq(contentItem.status, 'active')];
  if (q.sourceId !== undefined) {
    conditions.push(
      exists(
        db
          .select({ id: contentItemOccurrence.id })
          .from(contentItemOccurrence)
          .where(
            and(
              eq(contentItemOccurrence.contentItemId, contentItem.id),
              eq(contentItemOccurrence.sourceId, q.sourceId),
            ),
          ),
      ),
    );
  }
  const columns = {
    id: contentItem.id,
    kind: contentItem.kind,
    authorship: contentItem.authorship,
    itemDate: contentItem.itemDate,
    parentItemId: contentItem.parentItemId,
  };

  let rows: ItemRow[];
  let nextCursor: string | null = null;
  const query = q.query?.trim();
  if (query) {
    const hits = await memory.search(ns, { query, limit: limit * 3 });
    const ranked = [...new Set(hits.map((h) => h.id))].filter((id) => UUID_RE.test(id));
    if (ranked.length === 0) return { items: [], nextCursor: null };
    const found = await db
      .select(columns)
      .from(contentItem)
      .where(and(...conditions, inArray(contentItem.id, ranked)));
    const byId = new Map(found.map((r) => [r.id, r]));
    rows = ranked.flatMap((id) => byId.get(id) ?? []).slice(0, limit);
  } else {
    if (q.cursor) {
      const { itemDate, id } = decodeCursor(q.cursor);
      conditions.push(
        or(
          lt(itemDateMs, itemDate),
          and(eq(itemDateMs, itemDate), lt(contentItem.id, id)),
        )!,
      );
    }
    const page = await db
      .select(columns)
      .from(contentItem)
      .where(and(...conditions))
      .orderBy(desc(itemDateMs), desc(contentItem.id))
      .limit(limit + 1);
    rows = page.slice(0, limit);
    const last = rows.at(-1);
    if (page.length > limit && last) nextCursor = encodeCursor(last.itemDate, last.id);
  }

  const sourceIds = await sourceIdsFor(rows);
  const items = await Promise.all(
    rows.map(async (r): Promise<ContentItemView> => {
      const doc = await memory.getDocument(ns, r.id);
      return {
        id: r.id,
        kind: r.kind,
        authorship: r.authorship,
        itemDate: r.itemDate.toISOString(),
        sourceIds:
          sourceIds.get(r.id) ?? (r.parentItemId ? sourceIds.get(r.parentItemId) : undefined) ?? [],
        ...(doc ? parseDocument(doc.content) : {}),
      };
    }),
  );
  return { items, nextCursor };
}

/**
 * Reports an item that should not have been kept (FR-022): records the report, audits it and requests an
 * `exclusion_report` deletion that purges the item. The deletion is requested after commit.
 */
export async function report(
  ctx: ServiceContext,
  id: string,
  category?: FilterCategory,
): Promise<{ reportId: string; deletionRequestId: string }> {
  const item = await ownedItem(ctx, id);
  if (item.status !== 'active') throw new AppError('not_found');
  const db = getDb();

  // Attachments may have no occurrence of their own: fall back to the parent's source.
  const occurrences = await db
    .select({
      itemId: contentItemOccurrence.contentItemId,
      sourceId: contentItemOccurrence.sourceId,
    })
    .from(contentItemOccurrence)
    .where(
      inArray(contentItemOccurrence.contentItemId, [
        id,
        ...(item.parentItemId ? [item.parentItemId] : []),
      ]),
    );
  const sourceId =
    occurrences.find((o) => o.itemId === id)?.sourceId ?? occurrences[0]?.sourceId ?? null;

  const reportId = await withTransaction(async (tx) => {
    const [row] = await tx
      .insert(exclusionReport)
      .values({
        userId: ctx.userId,
        contentItemId: id,
        sourceId,
        category: category ?? null,
        status: 'received',
      })
      .returning({ id: exclusionReport.id });
    if (!row) throw new AppError('internal_error');
    await audit.record(
      {
        actorType: 'user',
        actorUserId: ctx.userId,
        action: 'exclusion.report_submitted',
        targetType: 'exclusion_report',
        targetId: row.id,
        subjectRef: subjectRef(ctx.userId),
        ...(category ? { metadata: { category } } : {}),
      },
      tx,
    );
    return row.id;
  });

  const { id: deletionRequestId } = await requestDeletion({
    userId: ctx.userId,
    scope: 'exclusion_report',
    targetId: reportId,
    requestedBy: 'user',
  });
  return { reportId, deletionRequestId };
}

/**
 * Deletes one item and its attachments (DELETE /api/content-items/{id}, T145) through a `content_item`
 * deletion request; the request is audited here and the purge on completion.
 */
export async function remove(
  ctx: ServiceContext,
  id: string,
): Promise<{ deletionRequestId: string }> {
  const item = await ownedItem(ctx, id);
  if (item.status !== 'active')
    throw new AppError('conflict', 'This item is already being deleted');
  const [pending] = await getDb()
    .select({ id: deletionRequest.id })
    .from(deletionRequest)
    .where(
      and(
        eq(deletionRequest.userId, ctx.userId),
        eq(deletionRequest.scope, 'content_item'),
        eq(deletionRequest.targetId, id),
        ne(deletionRequest.status, 'completed'),
      ),
    )
    .orderBy(desc(deletionRequest.requestedAt), desc(deletionRequest.id))
    .limit(1);
  if (pending) return { deletionRequestId: pending.id };
  await audit.record({
    actorType: 'user',
    actorUserId: ctx.userId,
    action: 'content.deletion_requested',
    targetType: 'content_item',
    targetId: id,
    subjectRef: subjectRef(ctx.userId),
    metadata: { scope: 'content_item' },
  });
  const { id: deletionRequestId } = await requestDeletion({
    userId: ctx.userId,
    scope: 'content_item',
    targetId: id,
    requestedBy: 'user',
  });
  return { deletionRequestId };
}

/** The owner's item; foreign, unknown or malformed ids are `not_found`. */
async function ownedItem(ctx: ServiceContext, id: string): Promise<ContentItemRow> {
  if (!UUID_RE.test(id)) throw new AppError('not_found');
  const item = await getContentItem(ctx, id);
  if (!item) throw new AppError('not_found');
  return item;
}

async function sourceIdsFor(rows: ItemRow[]): Promise<Map<string, string[]>> {
  const ids = [...new Set(rows.flatMap((r) => (r.parentItemId ? [r.id, r.parentItemId] : [r.id])))];
  const map = new Map<string, string[]>();
  if (ids.length === 0) return map;
  const occurrences = await getDb()
    .select({
      itemId: contentItemOccurrence.contentItemId,
      sourceId: contentItemOccurrence.sourceId,
    })
    .from(contentItemOccurrence)
    .where(inArray(contentItemOccurrence.contentItemId, ids));
  for (const o of occurrences) {
    const list = map.get(o.itemId) ?? [];
    if (!list.includes(o.sourceId)) list.push(o.sourceId);
    map.set(o.itemId, list);
  }
  return map;
}

/** Title = first `Subject:`/`Title:` header line; snippet = first 200 chars of the body after the blank line. */
export function parseDocument(content: string): { title?: string; snippet?: string } {
  const split = content.indexOf('\n\n');
  const header = split === -1 ? content : content.slice(0, split);
  const body = split === -1 ? '' : content.slice(split + 2).trim();
  const out: { title?: string; snippet?: string } = {};
  for (const line of header.split('\n')) {
    const m = /^(?:Subject|Title):\s*(.*)$/.exec(line);
    if (m) {
      const title = m[1]!.trim();
      if (title) out.title = title;
      break;
    }
  }
  if (body) out.snippet = body.slice(0, SNIPPET_LENGTH);
  return out;
}

function encodeCursor(itemDate: Date, id: string): string {
  return Buffer.from(`${itemDate.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(cursor: string): { itemDate: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const itemDate = new Date(iso ?? '');
  if (!id || !UUID_RE.test(id) || Number.isNaN(itemDate.getTime())) {
    throw new AppError('validation_failed', 'Invalid cursor');
  }
  return { itemDate, id };
}
