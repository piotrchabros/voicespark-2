import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  ANALYSIS_PROMPT_MAX_CHARS,
  getDb,
  notification,
  toneDefinition,
  toneDefinitionVersion,
  toneProfile,
  userDefinitionChoice,
  versionActivation,
  withTransaction,
  type DefinitionAvailability,
  type Tx,
  type ToneDefinitionVersion,
} from '@voicespark/db';
import {
  definitionHistory,
  getDefinitionItem,
  listDefinitionVersions,
  listDefinitions,
  toDefinitionVersionView as toView,
} from '@voicespark/db/repos/admin/definitions';
import { listInUseForDefinition } from '@voicespark/db/repos/system/own-prompts';
import type {
  AdminDefinitionListItem,
  DefinitionVersionView,
  HistoryEntry,
} from '@voicespark/db/repos/admin/types';
import { AppError, type ServiceContext } from '../errors';
import { jsonDiff, type DiffEntry } from '../versioning';
import { audit } from './audit';
import { enqueue } from '../queues';
import { NOTIFICATION_PAYLOAD_SCHEMA } from './notifications';

// Definitions service: user-facing choices (T118) and admin versioning (T128). Admin methods return ids, names,
// version numbers, the default analysis prompt and legacy dimensions only; no user content is ever read here.
// Own-prompt fan-out goes through repos/system/own-prompts (metadata only, never the user's prompt text).

export interface AvailableDefinition {
  id: string;
  name: string;
  description: string;
  chosen: boolean;
}

export type { AdminDefinitionListItem, DefinitionVersionView, HistoryEntry };

// ---------------------------------------------------------------------------------------------------------------
// User part

async function availableRows(db: ReturnType<typeof getDb> | Tx) {
  return db
    .select({
      id: toneDefinition.id,
      name: toneDefinitionVersion.name,
      description: toneDefinitionVersion.description,
    })
    .from(toneDefinition)
    .innerJoin(toneDefinitionVersion, eq(toneDefinitionVersion.id, toneDefinition.activeVersionId))
    .where(eq(toneDefinition.availability, 'available'))
    .orderBy(asc(toneDefinitionVersion.name), asc(toneDefinition.id));
}

async function activeChoiceIds(db: ReturnType<typeof getDb> | Tx, userId: string): Promise<string[]> {
  const rows = await db
    .select({ definitionId: userDefinitionChoice.definitionId })
    .from(userDefinitionChoice)
    .where(and(eq(userDefinitionChoice.userId, userId), isNull(userDefinitionChoice.removedAt)));
  return rows.map((r) => r.definitionId);
}

export async function listAvailable(ctx: ServiceContext): Promise<AvailableDefinition[]> {
  const db = getDb();
  const [rows, chosen] = await Promise.all([availableRows(db), activeChoiceIds(db, ctx.userId)]);
  const chosenSet = new Set(chosen);
  return rows.map((r) => ({ ...r, chosen: chosenSet.has(r.id) }));
}

export async function setChoices(
  ctx: ServiceContext,
  definitionIds: string[],
): Promise<AvailableDefinition[]> {
  const ids = [...new Set(definitionIds)];
  if (ids.length === 0) throw new AppError('validation_failed', 'Choose at least one definition');

  await withTransaction(async (tx) => {
    // Lock the chosen definitions so a concurrent retire cannot slip in between check and write.
    const found = await tx
      .select({ id: toneDefinition.id })
      .from(toneDefinition)
      .where(
        and(
          inArray(toneDefinition.id, ids),
          eq(toneDefinition.availability, 'available'),
          sql`${toneDefinition.activeVersionId} is not null`,
        ),
      )
      .for('share');
    if (found.length !== ids.length) throw new AppError('not_found');

    const current = new Set(await activeChoiceIds(tx, ctx.userId));
    const dropped = [...current].filter((id) => !ids.includes(id));
    const added = ids.filter((id) => !current.has(id));

    if (added.length > 0) {
      await tx
        .insert(userDefinitionChoice)
        .values(added.map((definitionId) => ({ userId: ctx.userId, definitionId })));
    }
    if (dropped.length > 0) {
      await tx
        .update(userDefinitionChoice)
        .set({ removedAt: new Date() })
        .where(
          and(
            eq(userDefinitionChoice.userId, ctx.userId),
            inArray(userDefinitionChoice.definitionId, dropped),
            isNull(userDefinitionChoice.removedAt),
          ),
        );
      await tx
        .update(toneProfile)
        .set({ status: 'removed', updatedAt: new Date() })
        .where(
          and(eq(toneProfile.userId, ctx.userId), inArray(toneProfile.definitionId, dropped)),
        );
    }
    await tx
      .insert(toneProfile)
      .values(ids.map((definitionId) => ({ userId: ctx.userId, definitionId, status: 'active' as const })))
      .onConflictDoUpdate({
        target: [toneProfile.userId, toneProfile.definitionId],
        set: { status: 'active', updatedAt: new Date() },
      });
  });

  return listAvailable(ctx);
}

/** Onboarding: exactly one available definition and no active choice yet -> choose it. */
export async function autoChooseIfSingle(ctx: ServiceContext): Promise<boolean> {
  const db = getDb();
  const available = await availableRows(db);
  if (available.length !== 1) return false;
  if ((await activeChoiceIds(db, ctx.userId)).length > 0) return false;
  await setChoices(ctx, [available[0]!.id]);
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Admin part

const KEY_RE = /^[a-z][a-z0-9_]{2,63}$/;
const nameSchema = z.string().min(1).max(80);
const descriptionSchema = z.string().min(1).max(500);

// Drafts may hold a null, empty or partial prompt; the length limit is checked first (analysisPromptTooLong).
const analysisPromptSchema = z.string().nullable().optional();

const createSchema = z.object({
  key: z.string().regex(KEY_RE),
  name: nameSchema,
  description: descriptionSchema,
  analysisPrompt: analysisPromptSchema,
});

const patchSchema = z.object({
  name: nameSchema.optional(),
  description: descriptionSchema.optional(),
  analysisPrompt: analysisPromptSchema,
});

const analysisPromptError = (reason: 'empty' | 'too_long') =>
  new AppError('validation_failed', undefined, {
    field: 'analysisPrompt',
    reason,
    maxChars: ANALYSIS_PROMPT_MAX_CHARS,
  });

/** Create and update-draft: `dimensions` is read-only legacy data, and the prompt has a length limit. */
function checkWritable(input: { analysisPrompt?: unknown; dimensions?: unknown }): void {
  if (input.dimensions !== undefined) {
    throw new AppError('validation_failed', 'dimensions are read-only', { field: 'dimensions' });
  }
  if (typeof input.analysisPrompt === 'string' && input.analysisPrompt.length > ANALYSIS_PROMPT_MAX_CHARS) {
    throw analysisPromptError('too_long');
  }
}

/** Publish and rollback: the target's prompt must be non-empty after trim and within the limit. */
function checkPublishable(version: ToneDefinitionVersion): void {
  const text = version.analysisPrompt ?? '';
  if (text.trim() === '') throw analysisPromptError('empty');
  if (text.length > ANALYSIS_PROMPT_MAX_CHARS) throw analysisPromptError('too_long');
}

function parseOrThrow<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw new AppError('validation_failed', undefined, {
      fields: r.error.issues.map((i) => i.path.join('.')),
    });
  }
  return r.data;
}

const versionNotDraft = () =>
  new AppError('version_not_draft', 'Only a draft version can be changed', undefined, 422);

type Db = ReturnType<typeof getDb> | Tx;

/** Reads through repos/admin, so call it after the transaction committed. */
async function itemOrThrow(id: string): Promise<AdminDefinitionListItem> {
  const item = await getDefinitionItem(id);
  if (!item) throw new AppError('not_found');
  return item;
}

/** Locks the definition row for the rest of the transaction. */
async function lockDefinition(tx: Tx, id: string) {
  const [row] = await tx.select().from(toneDefinition).where(eq(toneDefinition.id, id)).for('update');
  if (!row) throw new AppError('not_found');
  return row;
}

async function versionOf(tx: Db, definitionId: string, versionId: string) {
  const [row] = await tx
    .select()
    .from(toneDefinitionVersion)
    .where(
      and(
        eq(toneDefinitionVersion.id, versionId),
        eq(toneDefinitionVersion.definitionId, definitionId),
      ),
    );
  if (!row) throw new AppError('not_found');
  return row;
}

export async function adminList(): Promise<AdminDefinitionListItem[]> {
  return listDefinitions();
}

export async function adminGet(
  id: string,
): Promise<{ definition: AdminDefinitionListItem; versions: DefinitionVersionView[] }> {
  const definition = await itemOrThrow(id);
  return { definition, versions: await listDefinitionVersions(id) };
}

export async function adminGetVersion(
  definitionId: string,
  versionId: string,
): Promise<DefinitionVersionView> {
  return toView(await versionOf(getDb(), definitionId, versionId));
}

function isUniqueViolation(e: unknown): boolean {
  const code = (x: unknown) => (x as { code?: string } | null | undefined)?.code;
  return code(e) === '23505' || code((e as { cause?: unknown } | null)?.cause) === '23505';
}

export async function create(
  adminId: string,
  input: {
    key: string;
    name: string;
    description: string;
    analysisPrompt?: string | null;
    dimensions?: unknown;
  },
): Promise<{ definition: AdminDefinitionListItem; draft: DefinitionVersionView }> {
  checkWritable(input);
  const data = parseOrThrow(createSchema, input);
  let created: { id: string; draft: DefinitionVersionView };
  try {
    created = await withTransaction(async (tx) => {
      const [def] = await tx
        .insert(toneDefinition)
        .values({ key: data.key, availability: 'retired', createdBy: adminId })
        .returning({ id: toneDefinition.id });
      const [draft] = await tx
        .insert(toneDefinitionVersion)
        .values({
          definitionId: def!.id,
          versionNumber: 1,
          status: 'draft',
          name: data.name,
          description: data.description,
          dimensions: [],
          analysisPrompt: data.analysisPrompt ?? null,
          createdBy: adminId,
        })
        .returning();
      await audit.record(
        {
          actorType: 'admin',
          actorUserId: adminId,
          action: 'definition.created',
          targetType: 'definition',
          targetId: def!.id,
          metadata: { definitionId: def!.id },
        },
        tx,
      );
      return { id: def!.id, draft: toView(draft!) };
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError('conflict', 'Definition key already exists');
    throw e;
  }
  return { definition: await itemOrThrow(created.id), draft: created.draft };
}

export async function createDraft(
  adminId: string,
  id: string,
  fromVersionId?: string,
): Promise<DefinitionVersionView> {
  return withTransaction(async (tx) => {
    const def = await lockDefinition(tx, id);
    const all = await tx
      .select()
      .from(toneDefinitionVersion)
      .where(eq(toneDefinitionVersion.definitionId, id))
      .orderBy(desc(toneDefinitionVersion.versionNumber));
    if (all.some((v) => v.status === 'draft')) throw new AppError('conflict', 'A draft already exists');

    let source: ToneDefinitionVersion | undefined;
    if (fromVersionId !== undefined) {
      source = all.find((v) => v.id === fromVersionId);
      if (!source) throw new AppError('not_found');
    } else {
      source = all.find((v) => v.id === def.activeVersionId) ?? all[0];
    }
    const [draft] = await tx
      .insert(toneDefinitionVersion)
      .values({
        definitionId: id,
        versionNumber: (all[0]?.versionNumber ?? 0) + 1,
        status: 'draft',
        name: source?.name ?? '',
        description: source?.description ?? '',
        dimensions: source?.dimensions ?? [],
        analysisPrompt: source?.analysisPrompt ?? null,
        createdBy: adminId,
      })
      .returning();
    await audit.record(
      {
        actorType: 'admin',
        actorUserId: adminId,
        action: 'definition.version_drafted',
        targetType: 'definition',
        targetId: id,
        metadata: { definitionId: id, versionId: draft!.id },
      },
      tx,
    );
    return toView(draft!);
  });
}

export async function updateDraft(
  adminId: string,
  id: string,
  versionId: string,
  patch: { name?: string; description?: string; analysisPrompt?: string | null; dimensions?: unknown },
): Promise<DefinitionVersionView> {
  void adminId;
  checkWritable(patch);
  const data = parseOrThrow(patchSchema, patch);
  return withTransaction(async (tx) => {
    await lockDefinition(tx, id);
    const version = await versionOf(tx, id, versionId);
    if (version.status !== 'draft') throw versionNotDraft();
    const set: Partial<typeof toneDefinitionVersion.$inferInsert> = {};
    if (data.name !== undefined) set.name = data.name;
    if (data.description !== undefined) set.description = data.description;
    if (data.analysisPrompt !== undefined) set.analysisPrompt = data.analysisPrompt;
    if (Object.keys(set).length === 0) return toView(version);
    const [row] = await tx
      .update(toneDefinitionVersion)
      .set(set)
      .where(eq(toneDefinitionVersion.id, versionId))
      .returning();
    return toView(row!);
  });
}

export async function discardDraft(adminId: string, id: string, versionId: string): Promise<void> {
  void adminId;
  await withTransaction(async (tx) => {
    await lockDefinition(tx, id);
    const version = await versionOf(tx, id, versionId);
    if (version.status !== 'draft') throw versionNotDraft();
    await tx.delete(toneDefinitionVersion).where(eq(toneDefinitionVersion.id, versionId));
  });
}

const NOTIFY_CHUNK = 500;

/**
 * `notify()` for many users at once: same payload check, rows and `notify.send` jobs, but one insert per chunk so a
 * 1,000-user fan-out stays well inside the publish request (SC-005). Jobs that run before the commit retry.
 */
async function notifyDefaultChanged(
  tx: Tx,
  items: { userId: string; payload: Record<string, string> }[],
): Promise<void> {
  for (let i = 0; i < items.length; i += NOTIFY_CHUNK) {
    const rows = await tx
      .insert(notification)
      .values(
        items.slice(i, i + NOTIFY_CHUNK).map((it) => ({
          userId: it.userId,
          type: 'analysis_prompt_default_changed' as const,
          payload: NOTIFICATION_PAYLOAD_SCHEMA.parse(it.payload),
        })),
      )
      .returning({ id: notification.id });
    await Promise.all(rows.map((r) => enqueue('notify.send', { notificationId: r.id })));
  }
}

/**
 * Moves the active pointer to `target` (draft on publish, superseded on rollback) inside the caller's tx. When the
 * trimmed analysis prompt changes, every user with an own prompt in use for the definition is notified in the same
 * transaction (contracts/notifications.md).
 */
async function activate(
  tx: Tx,
  adminId: string,
  def: { id: string; activeVersionId: string | null },
  target: ToneDefinitionVersion,
  action: 'publish' | 'rollback',
): Promise<void> {
  const targetId = target.id;
  const previous =
    def.activeVersionId === null ? undefined : await versionOf(tx, def.id, def.activeVersionId);
  const analysisPromptChanged =
    (previous?.analysisPrompt ?? '').trim() !== (target.analysisPrompt ?? '').trim();
  if (def.activeVersionId !== null) {
    await tx
      .update(toneDefinitionVersion)
      .set({ status: 'superseded' })
      .where(eq(toneDefinitionVersion.id, def.activeVersionId));
  }
  await tx
    .update(toneDefinitionVersion)
    .set(
      action === 'publish'
        ? { status: 'active', publishedBy: adminId, publishedAt: new Date() }
        : { status: 'active' },
    )
    .where(eq(toneDefinitionVersion.id, targetId));
  await tx.update(toneDefinition).set({ activeVersionId: targetId }).where(eq(toneDefinition.id, def.id));
  await tx.insert(versionActivation).values({
    entityType: 'definition',
    entityId: def.id,
    fromVersionId: def.activeVersionId,
    toVersionId: targetId,
    action,
    actorUserId: adminId,
  });
  const recipients = analysisPromptChanged ? await listInUseForDefinition(tx, def.id) : [];
  await notifyDefaultChanged(
    tx,
    recipients.map((r) => ({
      userId: r.userId,
      payload: {
        definitionId: def.id,
        ownPromptId: r.ownPromptId,
        fromDefinitionVersionId: r.basedOnDefinitionVersionId,
        toDefinitionVersionId: targetId,
      },
    })),
  );
  await audit.record(
    {
      actorType: 'admin',
      actorUserId: adminId,
      action: action === 'publish' ? 'definition.version_published' : 'definition.rolled_back',
      targetType: 'definition',
      targetId: def.id,
      metadata: {
        definitionId: def.id,
        versionId: targetId,
        analysisPromptChanged,
        notifiedUsers: recipients.length,
      },
    },
    tx,
  );
}

export async function publish(
  adminId: string,
  id: string,
  versionId: string,
): Promise<AdminDefinitionListItem> {
  await withTransaction(async (tx) => {
    const def = await lockDefinition(tx, id);
    const version = await versionOf(tx, id, versionId);
    if (version.status !== 'draft') throw versionNotDraft();
    checkPublishable(version);
    await activate(tx, adminId, def, version, 'publish');
  });
  return itemOrThrow(id);
}

export async function rollback(
  adminId: string,
  id: string,
  versionId: string,
): Promise<AdminDefinitionListItem> {
  await withTransaction(async (tx) => {
    const def = await lockDefinition(tx, id);
    const version = await versionOf(tx, id, versionId);
    if (version.status !== 'superseded') {
      throw new AppError('conflict', 'Only a superseded version can be rolled back to');
    }
    checkPublishable(version);
    await activate(tx, adminId, def, version, 'rollback');
  });
  return itemOrThrow(id);
}

export async function setAvailability(
  adminId: string,
  id: string,
  availability: DefinitionAvailability,
): Promise<AdminDefinitionListItem> {
  await withTransaction(async (tx) => {
    const def = await lockDefinition(tx, id);
    if (def.availability === availability) return;
    if (availability === 'available') {
      if (def.activeVersionId === null) {
        throw new AppError('conflict', 'A definition needs an active version to become available');
      }
    } else {
      // Serialize concurrent retirements: lock every available row before counting.
      const available = await tx
        .select({ id: toneDefinition.id })
        .from(toneDefinition)
        .where(eq(toneDefinition.availability, 'available'))
        .orderBy(asc(toneDefinition.id))
        .for('update');
      if (available.filter((r) => r.id !== id).length === 0) {
        throw new AppError('last_available_definition');
      }
    }
    await tx.update(toneDefinition).set({ availability }).where(eq(toneDefinition.id, id));
    await audit.record(
      {
        actorType: 'admin',
        actorUserId: adminId,
        action: availability === 'available' ? 'definition.made_available' : 'definition.retired',
        targetType: 'definition',
        targetId: id,
        metadata: { definitionId: id },
      },
      tx,
    );
  });
  return itemOrThrow(id);
}

export async function history(id: string): Promise<HistoryEntry[]> {
  await itemOrThrow(id);
  return definitionHistory(id);
}

export async function diff(
  id: string,
  versionId: string,
  againstId: string,
): Promise<{
  from: { id: string; versionNumber: number };
  to: { id: string; versionNumber: number };
  changes: DiffEntry[];
}> {
  const db = getDb();
  const [a, b] = await Promise.all([versionOf(db, id, versionId), versionOf(db, id, againstId)]);
  const pick = (v: ToneDefinitionVersion) => ({
    name: v.name,
    description: v.description,
    analysisPrompt: v.analysisPrompt,
    dimensions: v.dimensions,
  });
  return {
    from: { id: a.id, versionNumber: a.versionNumber },
    to: { id: b.id, versionNumber: b.versionNumber },
    changes: jsonDiff(pick(a), pick(b)),
  };
}

/** Worker use: the pinned definition version for a generation. */
export async function getVersionForGeneration(
  versionId: string,
): Promise<ToneDefinitionVersion | null> {
  const [row] = await getDb()
    .select()
    .from(toneDefinitionVersion)
    .where(eq(toneDefinitionVersion.id, versionId));
  return row ?? null;
}
