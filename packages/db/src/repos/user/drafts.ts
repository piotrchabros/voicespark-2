import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import { getDb } from '../../client';
import {
  draft,
  hubCompany,
  hubPerson,
  hubProject,
  profileVersion,
  toneDefinition,
  toneDefinitionVersion,
  toneProfile,
  type Draft,
  type DraftContentType,
} from '../../schema';
import type { UserContext } from './types';

export interface DraftListRow {
  draft: Draft;
  definitionName: string | null;
  profileVersionNumber: number | null;
  /** Whether the pinned hub record still exists; false without a pin (no FK, so the pin outlives it). */
  hubRecordExists: boolean;
}

// Postgres keeps microseconds and JS Dates milliseconds, so keyset ordering and comparison use the
// millisecond-truncated timestamp (as notifications.list).
const createdAtMs = sql<Date>`date_trunc('milliseconds', ${draft.createdAt})`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function hubPin(kind: string, t: typeof hubPerson | typeof hubCompany | typeof hubProject) {
  return and(eq(draft.hubRecordKind, kind), eq(t.id, draft.hubRecordId), eq(t.userId, draft.userId));
}

function select() {
  return getDb()
    .select({
      draft,
      definitionName: toneDefinitionVersion.name,
      profileVersionNumber: profileVersion.versionNumber,
      hubRecordExists: sql<boolean>`coalesce(${hubPerson.id}, ${hubCompany.id}, ${hubProject.id}) is not null`,
    })
    .from(draft)
    .leftJoin(toneProfile, eq(toneProfile.id, draft.profileId))
    .leftJoin(toneDefinition, eq(toneDefinition.id, toneProfile.definitionId))
    .leftJoin(toneDefinitionVersion, eq(toneDefinitionVersion.id, toneDefinition.activeVersionId))
    .leftJoin(profileVersion, eq(profileVersion.id, draft.profileVersionId))
    .leftJoin(hubPerson, hubPin('person', hubPerson))
    .leftJoin(hubCompany, hubPin('company', hubCompany))
    .leftJoin(hubProject, hubPin('project', hubProject));
}

/** Null for ids owned by another user, missing ids and non-uuid input. */
export async function getDraft(ctx: UserContext, id: string): Promise<DraftListRow | null> {
  if (!UUID.test(id)) return null;
  const [row] = await select()
    .where(and(eq(draft.id, id), eq(draft.userId, ctx.userId)))
    .limit(1);
  return row ?? null;
}

/** Newest first; `before` is the keyset position of the last row of the previous page. */
export async function listDrafts(
  ctx: UserContext,
  q: {
    contentType?: DraftContentType;
    profileId?: string;
    before?: { createdAt: Date; id: string };
    limit: number;
  },
): Promise<DraftListRow[]> {
  const conditions = [eq(draft.userId, ctx.userId)];
  if (q.contentType) conditions.push(eq(draft.contentType, q.contentType));
  if (q.profileId) conditions.push(eq(draft.profileId, q.profileId));
  if (q.before) {
    conditions.push(
      or(
        lt(createdAtMs, q.before.createdAt),
        and(eq(createdAtMs, q.before.createdAt), lt(draft.id, q.before.id)),
      )!,
    );
  }
  return select()
    .where(and(...conditions))
    .orderBy(desc(createdAtMs), desc(draft.id))
    .limit(q.limit);
}
