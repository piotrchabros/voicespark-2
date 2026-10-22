import { asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '../../client';
import { toneDefinition, toneDefinitionVersion, userDefinitionChoice } from '../../schema';
import { versionHistory } from './history';
import type { AdminDefinitionListItem, DefinitionVersionView, HistoryEntry } from './types';

type VersionRow = typeof toneDefinitionVersion.$inferSelect;

export function toDefinitionVersionView(v: VersionRow): DefinitionVersionView {
  return {
    id: v.id,
    versionNumber: v.versionNumber,
    status: v.status,
    name: v.name,
    description: v.description,
    dimensions: v.dimensions,
    createdAt: v.createdAt.toISOString(),
    createdBy: v.createdBy,
    publishedAt: v.publishedAt ? v.publishedAt.toISOString() : null,
    publishedBy: v.publishedBy,
  };
}

async function listItems(definitionId?: string): Promise<AdminDefinitionListItem[]> {
  const db = getDb();
  const defs = await db
    .select()
    .from(toneDefinition)
    .where(definitionId ? eq(toneDefinition.id, definitionId) : undefined)
    .orderBy(asc(toneDefinition.createdAt), asc(toneDefinition.id));
  if (defs.length === 0) return [];

  const [versions, choices] = await Promise.all([
    db
      .select({
        id: toneDefinitionVersion.id,
        definitionId: toneDefinitionVersion.definitionId,
        versionNumber: toneDefinitionVersion.versionNumber,
        status: toneDefinitionVersion.status,
        name: toneDefinitionVersion.name,
      })
      .from(toneDefinitionVersion)
      .where(definitionId ? eq(toneDefinitionVersion.definitionId, definitionId) : undefined),
    db
      .select({
        definitionId: userDefinitionChoice.definitionId,
        count: sql<number>`count(*)::int`,
      })
      .from(userDefinitionChoice)
      .where(isNull(userDefinitionChoice.removedAt))
      .groupBy(userDefinitionChoice.definitionId),
  ]);
  const choiceCount = new Map(choices.map((c) => [c.definitionId, c.count]));

  return defs.map((d) => {
    const active = versions.find((v) => v.id === d.activeVersionId);
    const draft = versions.find((v) => v.definitionId === d.id && v.status === 'draft');
    return {
      id: d.id,
      key: d.key,
      availability: d.availability,
      activeVersion: active
        ? { id: active.id, versionNumber: active.versionNumber, name: active.name }
        : null,
      draftVersionId: draft?.id ?? null,
      userChoiceCount: choiceCount.get(d.id) ?? 0,
    };
  });
}

export async function listDefinitions(): Promise<AdminDefinitionListItem[]> {
  return listItems();
}

export async function getDefinitionItem(id: string): Promise<AdminDefinitionListItem | null> {
  const [item] = await listItems(id);
  return item ?? null;
}

/** Newest first. */
export async function listDefinitionVersions(id: string): Promise<DefinitionVersionView[]> {
  const rows = await getDb()
    .select()
    .from(toneDefinitionVersion)
    .where(eq(toneDefinitionVersion.definitionId, id))
    .orderBy(desc(toneDefinitionVersion.versionNumber));
  return rows.map(toDefinitionVersionView);
}

export async function definitionHistory(id: string): Promise<HistoryEntry[]> {
  return versionHistory('definition', id);
}
