import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../client';
import {
  toneDefinitionVersion,
  promptTemplateVersion,
  user,
  versionActivation,
} from '../../schema';
import type { HistoryEntry, VersionRef } from './types';

/** Publish/rollback history of a definition or prompt, newest first (FR-042). */
export async function versionHistory(
  entityType: 'definition' | 'prompt',
  entityId: string,
): Promise<HistoryEntry[]> {
  const db = getDb();
  const rows = await db
    .select({
      action: versionActivation.action,
      fromVersionId: versionActivation.fromVersionId,
      toVersionId: versionActivation.toVersionId,
      actorId: versionActivation.actorUserId,
      actorName: user.name,
      occurredAt: versionActivation.occurredAt,
    })
    .from(versionActivation)
    .leftJoin(user, eq(user.id, versionActivation.actorUserId))
    .where(
      and(eq(versionActivation.entityType, entityType), eq(versionActivation.entityId, entityId)),
    )
    .orderBy(desc(versionActivation.occurredAt), asc(versionActivation.id));
  if (rows.length === 0) return [];

  const versionIds = [
    ...new Set(
      rows.flatMap((r) => (r.fromVersionId ? [r.fromVersionId, r.toVersionId] : [r.toVersionId])),
    ),
  ];
  const refs = new Map<string, VersionRef>();
  const versionTable = entityType === 'definition' ? toneDefinitionVersion : promptTemplateVersion;
  const found = await db
    .select({ id: versionTable.id, versionNumber: versionTable.versionNumber })
    .from(versionTable)
    .where(inArray(versionTable.id, versionIds));
  for (const v of found) refs.set(v.id, v);

  return rows.map((r) => ({
    action: r.action,
    fromVersion: (r.fromVersionId && refs.get(r.fromVersionId)) || null,
    toVersion: refs.get(r.toVersionId) ?? { id: r.toVersionId, versionNumber: 0 },
    actor: { id: r.actorId, name: r.actorName ?? null },
    occurredAt: r.occurredAt.toISOString(),
  }));
}
