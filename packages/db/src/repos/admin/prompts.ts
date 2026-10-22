import { asc, desc, eq } from 'drizzle-orm';
import { getDb } from '../../client';
import { promptTemplate, promptTemplateVersion } from '../../schema';
import { versionHistory } from './history';
import type { AdminPromptListItem, HistoryEntry, PromptVersionView } from './types';

type VersionRow = typeof promptTemplateVersion.$inferSelect;

export function toPromptVersionView(v: VersionRow): PromptVersionView {
  return {
    id: v.id,
    versionNumber: v.versionNumber,
    status: v.status,
    systemTemplate: v.systemTemplate,
    userTemplate: v.userTemplate,
    model: v.model,
    effort: v.effort,
    maxTokens: v.maxTokens,
    changeNote: v.changeNote,
    createdAt: v.createdAt.toISOString(),
    createdBy: v.createdBy,
    publishedAt: v.publishedAt ? v.publishedAt.toISOString() : null,
    publishedBy: v.publishedBy,
  };
}

async function listItems(promptId?: string): Promise<AdminPromptListItem[]> {
  const db = getDb();
  const templates = await db
    .select()
    .from(promptTemplate)
    .where(promptId ? eq(promptTemplate.id, promptId) : undefined)
    .orderBy(asc(promptTemplate.key));
  if (templates.length === 0) return [];

  const versions = await db
    .select({
      id: promptTemplateVersion.id,
      promptTemplateId: promptTemplateVersion.promptTemplateId,
      versionNumber: promptTemplateVersion.versionNumber,
      status: promptTemplateVersion.status,
      model: promptTemplateVersion.model,
    })
    .from(promptTemplateVersion)
    .where(promptId ? eq(promptTemplateVersion.promptTemplateId, promptId) : undefined);

  return templates.map((t) => {
    const active = versions.find((v) => v.id === t.activeVersionId);
    const draft = versions.find((v) => v.promptTemplateId === t.id && v.status === 'draft');
    return {
      id: t.id,
      key: t.key,
      isSystem: t.isSystem,
      description: t.description,
      activeVersion: active
        ? { id: active.id, versionNumber: active.versionNumber, model: active.model }
        : null,
      draftVersionId: draft?.id ?? null,
    };
  });
}

export async function listPrompts(): Promise<AdminPromptListItem[]> {
  return listItems();
}

export async function getPromptItem(id: string): Promise<AdminPromptListItem | null> {
  const [item] = await listItems(id);
  return item ?? null;
}

/** Newest first. */
export async function listPromptVersions(id: string): Promise<PromptVersionView[]> {
  const rows = await getDb()
    .select()
    .from(promptTemplateVersion)
    .where(eq(promptTemplateVersion.promptTemplateId, id))
    .orderBy(desc(promptTemplateVersion.versionNumber));
  return rows.map(toPromptVersionView);
}

export async function promptHistory(id: string): Promise<HistoryEntry[]> {
  return versionHistory('prompt', id);
}
