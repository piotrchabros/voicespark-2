import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { getDb } from '../../client';
import {
  connectedSource,
  contentItem,
  contentItemOccurrence,
  profileGeneration,
  profileVersion,
  toneDefinition,
  toneDefinitionVersion,
  toneProfile,
  type ContentKind,
  type DefinitionAvailability,
  type ProfileGeneration,
  type ProfileVersion,
  type ToneProfile,
} from '../../schema';
import type { UserContext } from './types';

export interface ExcerptSourceRow {
  itemId: string;
  kind: ContentKind;
  itemDate: Date;
  /** `connected_source.account_label` of every source the item occurs in (unique, sorted). */
  sourceLabels: string[];
}

export interface ProfileListRow {
  profile: ToneProfile;
  definitionKey: string;
  definitionAvailability: DefinitionAvailability;
  definitionName: string | null;
}

/** Null for ids owned by another user. */
export async function getProfile(ctx: UserContext, id: string): Promise<ToneProfile | null> {
  const [row] = await getDb()
    .select()
    .from(toneProfile)
    .where(and(eq(toneProfile.id, id), eq(toneProfile.userId, ctx.userId)))
    .limit(1);
  return row ?? null;
}

export async function listProfiles(ctx: UserContext): Promise<ProfileListRow[]> {
  const rows = await getDb()
    .select({
      profile: toneProfile,
      definitionKey: toneDefinition.key,
      definitionAvailability: toneDefinition.availability,
      definitionName: toneDefinitionVersion.name,
    })
    .from(toneProfile)
    .innerJoin(toneDefinition, eq(toneDefinition.id, toneProfile.definitionId))
    .leftJoin(toneDefinitionVersion, eq(toneDefinitionVersion.id, toneDefinition.activeVersionId))
    .where(eq(toneProfile.userId, ctx.userId))
    .orderBy(asc(toneProfile.createdAt), asc(toneProfile.id));
  return rows;
}

/** Versions are scoped through the owning profile's `user_id`. */
export async function getVersion(
  ctx: UserContext,
  profileId: string,
  versionId: string,
): Promise<ProfileVersion | null> {
  const [row] = await getDb()
    .select({ version: profileVersion })
    .from(profileVersion)
    .innerJoin(toneProfile, eq(toneProfile.id, profileVersion.profileId))
    .where(
      and(
        eq(profileVersion.id, versionId),
        eq(profileVersion.profileId, profileId),
        eq(toneProfile.userId, ctx.userId),
      ),
    )
    .limit(1);
  return row?.version ?? null;
}

export async function listVersions(ctx: UserContext, profileId: string): Promise<ProfileVersion[]> {
  const rows = await getDb()
    .select({ version: profileVersion })
    .from(profileVersion)
    .innerJoin(toneProfile, eq(toneProfile.id, profileVersion.profileId))
    .where(and(eq(profileVersion.profileId, profileId), eq(toneProfile.userId, ctx.userId)))
    .orderBy(desc(profileVersion.versionNumber));
  return rows.map((r) => r.version);
}

export async function getGeneration(
  ctx: UserContext,
  id: string,
): Promise<ProfileGeneration | null> {
  const [row] = await getDb()
    .select()
    .from(profileGeneration)
    .where(and(eq(profileGeneration.id, id), eq(profileGeneration.userId, ctx.userId)))
    .limit(1);
  return row ?? null;
}

/** Queued or running generations of the user. */
export async function activeGenerations(ctx: UserContext): Promise<ProfileGeneration[]> {
  return getDb()
    .select()
    .from(profileGeneration)
    .where(
      and(
        eq(profileGeneration.userId, ctx.userId),
        inArray(profileGeneration.status, ['queued', 'running']),
      ),
    )
    .orderBy(asc(profileGeneration.requestedAt), asc(profileGeneration.id));
}

/** Source facts of the user's content items quoted as excerpts; ids that are gone (or foreign) are absent. */
export async function getExcerptSources(
  ctx: UserContext,
  itemIds: string[],
): Promise<ExcerptSourceRow[]> {
  if (itemIds.length === 0) return [];
  const rows = await getDb()
    .select({
      itemId: contentItem.id,
      kind: contentItem.kind,
      itemDate: contentItem.itemDate,
      label: connectedSource.accountLabel,
    })
    .from(contentItem)
    .leftJoin(contentItemOccurrence, eq(contentItemOccurrence.contentItemId, contentItem.id))
    .leftJoin(
      connectedSource,
      and(
        eq(connectedSource.id, contentItemOccurrence.sourceId),
        eq(connectedSource.userId, ctx.userId),
      ),
    )
    .where(and(inArray(contentItem.id, itemIds), eq(contentItem.userId, ctx.userId)));
  const byId = new Map<string, ExcerptSourceRow>();
  for (const r of rows) {
    const entry = byId.get(r.itemId) ?? {
      itemId: r.itemId,
      kind: r.kind,
      itemDate: r.itemDate,
      sourceLabels: [],
    };
    if (r.label !== null && !entry.sourceLabels.includes(r.label)) entry.sourceLabels.push(r.label);
    byId.set(r.itemId, entry);
  }
  return [...byId.values()].map((e) => ({ ...e, sourceLabels: e.sourceLabels.sort() }));
}
