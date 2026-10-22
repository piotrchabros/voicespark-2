import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '../../client';
import { connectedSource } from '../../schema';
import type { UserContext } from './types';

export type ConnectedSourceRow = typeof connectedSource.$inferSelect;

/** Null for ids owned by another user (the route audits the foreign access). */
export async function getSource(ctx: UserContext, id: string): Promise<ConnectedSourceRow | null> {
  const [row] = await getDb()
    .select()
    .from(connectedSource)
    .where(and(eq(connectedSource.id, id), eq(connectedSource.userId, ctx.userId)))
    .limit(1);
  return row ?? null;
}

export async function listSources(ctx: UserContext): Promise<ConnectedSourceRow[]> {
  return getDb()
    .select()
    .from(connectedSource)
    .where(eq(connectedSource.userId, ctx.userId))
    .orderBy(asc(connectedSource.connectedAt), asc(connectedSource.id));
}
