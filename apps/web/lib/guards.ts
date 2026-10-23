import { headers } from 'next/headers';
import { eq } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import {
  connectedSource,
  contentItem,
  deletionRequest,
  draft,
  exclusionRule,
  filterPreferences,
  getDb,
  importJob,
  notification,
  ownAnalysisPrompt,
  ownAnalysisPromptVersion,
  retroscan,
  profileGeneration,
  signInIdentity,
  toneProfile,
  upload,
  user,
} from '@voicespark/db';
import { audit } from '@voicespark/core/services/audit';
import { getAuth } from './auth';
import { AppError } from './http';

export interface UserContext {
  userId: string;
  role: 'user' | 'admin';
}

// Better Auth's cookie cache lasts 60 s, so status and role are re-read from the database.
export async function requireUser(): Promise<UserContext> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  if (!session) throw new AppError('unauthenticated');
  const [row] = await getDb()
    .select({ role: user.role, status: user.status })
    .from(user)
    .where(eq(user.id, session.user.id))
    .limit(1);
  if (!row) throw new AppError('unauthenticated');
  if (row.status !== 'active') throw new AppError('account_suspended');
  return { userId: session.user.id, role: row.role === 'admin' ? 'admin' : 'user' };
}

export async function requireAdmin(): Promise<UserContext> {
  const ctx = await requireUser();
  if (ctx.role !== 'admin') throw new AppError('admin_required');
  return ctx;
}

export type ForeignResourceType =
  | 'source'
  | 'content_item'
  | 'import_job'
  | 'notification'
  | 'deletion_request'
  | 'retroscan'
  | 'exclusion_rule'
  | 'identity'
  | 'upload'
  | 'profile'
  | 'profile_generation'
  | 'draft'
  | 'own_prompt_version';

interface ForeignResourceTable {
  table: PgTable;
  idColumn: PgColumn;
  userIdColumn: PgColumn;
}

// Later phases extend this map as new user-scoped resources gain by-id routes.
export const FOREIGN_RESOURCE_TABLES: Record<
  Exclude<ForeignResourceType, 'own_prompt_version'>,
  ForeignResourceTable
> = {
  source: { table: connectedSource, idColumn: connectedSource.id, userIdColumn: connectedSource.userId },
  content_item: { table: contentItem, idColumn: contentItem.id, userIdColumn: contentItem.userId },
  import_job: { table: importJob, idColumn: importJob.id, userIdColumn: importJob.userId },
  notification: { table: notification, idColumn: notification.id, userIdColumn: notification.userId },
  deletion_request: {
    table: deletionRequest,
    idColumn: deletionRequest.id,
    userIdColumn: deletionRequest.userId,
  },
  retroscan: { table: retroscan, idColumn: retroscan.id, userIdColumn: retroscan.userId },
  exclusion_rule: { table: exclusionRule, idColumn: exclusionRule.id, userIdColumn: exclusionRule.userId },
  identity: { table: signInIdentity, idColumn: signInIdentity.accountId, userIdColumn: signInIdentity.userId },
  upload: { table: upload, idColumn: upload.id, userIdColumn: upload.userId },
  profile: { table: toneProfile, idColumn: toneProfile.id, userIdColumn: toneProfile.userId },
  profile_generation: {
    table: profileGeneration,
    idColumn: profileGeneration.id,
    userIdColumn: profileGeneration.userId,
  },
  draft: { table: draft, idColumn: draft.id, userIdColumn: draft.userId },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Call after a user-scoped by-id lookup returned nothing. For an admin, checks (id and owner
 * columns only, never content) whether the id belongs to another user and, if so, writes
 * `admin.content_access_denied`. The caller still responds 404 `not_found` (Constitution III).
 */
export async function auditForeignAccess(
  ctx: UserContext,
  resourceType: ForeignResourceType,
  id: string,
): Promise<void> {
  if (ctx.role !== 'admin' || !UUID_RE.test(id)) return;
  const [row] =
    resourceType === 'own_prompt_version'
      ? await getDb()
          .select({ id: ownAnalysisPromptVersion.id, userId: ownAnalysisPrompt.userId })
          .from(ownAnalysisPromptVersion)
          .innerJoin(
            ownAnalysisPrompt,
            eq(ownAnalysisPrompt.id, ownAnalysisPromptVersion.ownPromptId),
          )
          .where(eq(ownAnalysisPromptVersion.id, id))
          .limit(1)
      : await (() => {
          const { table, idColumn, userIdColumn } = FOREIGN_RESOURCE_TABLES[resourceType];
          return getDb()
            .select({ id: idColumn, userId: userIdColumn })
            .from(table)
            .where(eq(idColumn, id))
            .limit(1);
        })();
  if (!row || row.userId === ctx.userId) return;
  await audit.record({
    actorType: 'admin',
    actorUserId: ctx.userId,
    action: 'admin.content_access_denied',
    targetType: resourceType,
    targetId: id,
    metadata: { resourceType, targetId: id },
  });
}

export async function requireFiltersConfirmed(ctx: UserContext): Promise<void> {
  const [row] = await getDb()
    .select({ confirmedAt: filterPreferences.confirmedAt })
    .from(filterPreferences)
    .where(eq(filterPreferences.userId, ctx.userId))
    .limit(1);
  if (!row?.confirmedAt) throw new AppError('filter_confirmation_required');
}
