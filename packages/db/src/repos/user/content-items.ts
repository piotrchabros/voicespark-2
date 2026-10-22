import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../../client';
import { contentItem } from '../../schema';
import type { UserContext } from './types';

export type ContentItemRow = typeof contentItem.$inferSelect;

export interface AuthoredItemSummary {
  id: string;
  kind: ContentItemRow['kind'];
  itemDate: Date;
  languageCode: string | null;
  wordCount: number;
  parentItemId: string | null;
}

export type ReceivedItemSummary = AuthoredItemSummary;

const summaryColumns = {
  id: contentItem.id,
  kind: contentItem.kind,
  itemDate: contentItem.itemDate,
  languageCode: contentItem.languageCode,
  wordCount: contentItem.wordCount,
  parentItemId: contentItem.parentItemId,
};

/** Null for ids owned by another user. */
export async function getContentItem(ctx: UserContext, id: string): Promise<ContentItemRow | null> {
  const [row] = await getDb()
    .select()
    .from(contentItem)
    .where(and(eq(contentItem.id, id), eq(contentItem.userId, ctx.userId)))
    .limit(1);
  return row ?? null;
}

export async function listActiveAuthored(ctx: UserContext): Promise<AuthoredItemSummary[]> {
  return getDb()
    .select(summaryColumns)
    .from(contentItem)
    .where(
      and(
        eq(contentItem.userId, ctx.userId),
        eq(contentItem.authorship, 'authored'),
        eq(contentItem.status, 'active'),
      ),
    )
    .orderBy(desc(contentItem.itemDate), desc(contentItem.id));
}

export async function listActiveReceived(
  ctx: UserContext,
  limit: number,
): Promise<ReceivedItemSummary[]> {
  return getDb()
    .select(summaryColumns)
    .from(contentItem)
    .where(
      and(
        eq(contentItem.userId, ctx.userId),
        eq(contentItem.authorship, 'received'),
        eq(contentItem.status, 'active'),
      ),
    )
    .orderBy(desc(contentItem.itemDate), desc(contentItem.id))
    .limit(limit);
}
