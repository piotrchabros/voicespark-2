import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  getDb,
  ownAnalysisPrompt,
  ownAnalysisPromptVersion,
  toneDefinition,
  toneDefinitionVersion,
  toneProfile,
  userDefinitionChoice,
  withTransaction,
  type AuditAction,
  type DbOrTx,
  type OwnAnalysisPrompt,
  type OwnAnalysisPromptVersion,
  type Tx,
} from '@voicespark/db';
import {
  getOwnPrompt,
  getVersionWithText,
  insertOwnPrompt,
  insertOwnPromptVersion,
  listOwnPrompts,
  listVersionMeta,
  lockOwnPrompt,
  setCurrentVersion,
  setInUse,
} from '@voicespark/db/repos/user/own-prompts';
import { decrypt, encrypt } from '../crypto';
import { AppError, type ServiceContext } from '../errors';
import { textDiff, type DiffOp } from '../text-diff';
import { audit } from './audit';

// Own analysis prompts (US3, US4; data-model.md "Own-prompt state machine"). User-only: every read is scoped to
// the caller and to definitions they chose or have a profile for. The text is user content (encrypted at rest);
// audit metadata carries ids and counts only.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const OWN_PROMPT_MAX_CHARS = 20000;

export interface OwnPromptCurrentVersionRef {
  id: string;
  versionNumber: number;
  basedOnDefinitionVersionId: string;
  createdAt: string;
}

export interface OwnPromptListItem {
  definition: { id: string; name: string; retired: boolean };
  profileId: string | null;
  mode: 'default' | 'own';
  default: { definitionVersionId: string; versionNumber: number };
  own: { id: string; inUse: boolean; currentVersion: OwnPromptCurrentVersionRef | null } | null;
  defaultChangedSinceBase: boolean;
}

export interface OwnPromptDetail {
  definition: { id: string; name: string; retired: boolean };
  default: { definitionVersionId: string; versionNumber: number; promptText: string };
  own: {
    id: string;
    inUse: boolean;
    currentVersion: {
      id: string;
      versionNumber: number;
      promptText: string;
      basedOnDefinitionVersion: { id: string; versionNumber: number };
      createdAt: string;
    } | null;
  } | null;
  limits: { maxChars: typeof OWN_PROMPT_MAX_CHARS };
}

export interface OwnPromptVersionItem {
  id: string;
  versionNumber: number;
  basedOnDefinitionVersion: { id: string; versionNumber: number };
  createdAt: string;
  inUseNow: boolean;
}

export interface OwnPromptSaved {
  own: { id: string; inUse: true; currentVersion: OwnPromptCurrentVersionRef };
}

interface ScopedDefinition {
  id: string;
  name: string;
  retired: boolean;
  activeVersionId: string | null;
  activeVersionNumber: number | null;
  activePrompt: string | null;
  profileId: string | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Scope

/** Definitions the user has an active choice or a profile for; `tx` locks the definition rows FOR SHARE. */
async function scopedDefinitions(
  db: DbOrTx,
  userId: string,
  definitionId?: string,
  lock = false,
): Promise<ScopedDefinition[]> {
  const chosen = sql`exists (select 1 from ${userDefinitionChoice} where ${userDefinitionChoice.userId} = ${userId} and ${userDefinitionChoice.definitionId} = ${toneDefinition.id} and ${userDefinitionChoice.removedAt} is null)`;
  const query = db
    .select({
      id: toneDefinition.id,
      key: toneDefinition.key,
      availability: toneDefinition.availability,
      activeVersionId: toneDefinition.activeVersionId,
      activeVersionNumber: toneDefinitionVersion.versionNumber,
      activeName: toneDefinitionVersion.name,
      activePrompt: toneDefinitionVersion.analysisPrompt,
      profileId: toneProfile.id,
    })
    .from(toneDefinition)
    .leftJoin(toneDefinitionVersion, eq(toneDefinitionVersion.id, toneDefinition.activeVersionId))
    .leftJoin(
      toneProfile,
      and(eq(toneProfile.definitionId, toneDefinition.id), eq(toneProfile.userId, userId)),
    )
    .where(
      and(
        definitionId === undefined ? undefined : eq(toneDefinition.id, definitionId),
        sql`(${chosen} or ${toneProfile.id} is not null)`,
      ),
    )
    .orderBy(toneDefinitionVersion.name, toneDefinition.id);
  const rows = lock ? await query.for('share', { of: toneDefinition }) : await query;
  return rows.map((r) => ({
    id: r.id,
    name: r.activeName ?? r.key,
    retired: r.availability !== 'available' || !r.activeVersionId,
    activeVersionId: r.activeVersionId,
    activeVersionNumber: r.activeVersionNumber,
    activePrompt: r.activePrompt,
    profileId: r.profileId,
  }));
}

async function scopedOrThrow(
  db: DbOrTx,
  userId: string,
  definitionId: string,
  lock = false,
): Promise<ScopedDefinition> {
  if (!UUID_RE.test(definitionId)) throw new AppError('not_found');
  const [def] = await scopedDefinitions(db, userId, definitionId, lock);
  if (!def) throw new AppError('not_found');
  return def;
}

function activeDefault(def: ScopedDefinition): { id: string; versionNumber: number; text: string } {
  if (!def.activeVersionId || def.activeVersionNumber === null) throw new AppError('not_found');
  return {
    id: def.activeVersionId,
    versionNumber: def.activeVersionNumber,
    text: def.activePrompt ?? '',
  };
}

async function definitionVersionOf(
  db: DbOrTx,
  definitionId: string,
  versionId: string,
): Promise<{ id: string; versionNumber: number; analysisPrompt: string | null }> {
  if (!UUID_RE.test(versionId)) throw new AppError('not_found');
  const [row] = await db
    .select({
      id: toneDefinitionVersion.id,
      versionNumber: toneDefinitionVersion.versionNumber,
      analysisPrompt: toneDefinitionVersion.analysisPrompt,
    })
    .from(toneDefinitionVersion)
    .where(
      and(
        eq(toneDefinitionVersion.id, versionId),
        eq(toneDefinitionVersion.definitionId, definitionId),
      ),
    )
    .limit(1);
  if (!row) throw new AppError('not_found');
  return row;
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers

function assertPromptText(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') {
    throw new AppError('validation_failed', undefined, {
      field: 'promptText',
      reason: 'empty',
      maxChars: OWN_PROMPT_MAX_CHARS,
    });
  }
  if (trimmed.length > OWN_PROMPT_MAX_CHARS) {
    throw new AppError('validation_failed', undefined, {
      field: 'promptText',
      reason: 'too_long',
      maxChars: OWN_PROMPT_MAX_CHARS,
    });
  }
  return trimmed;
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | undefined;
  return e?.code === '23505' || e?.cause?.code === '23505';
}

function toRef(v: OwnAnalysisPromptVersion): OwnPromptCurrentVersionRef {
  return {
    id: v.id,
    versionNumber: v.versionNumber,
    basedOnDefinitionVersionId: v.basedOnDefinitionVersionId,
    createdAt: v.createdAt.toISOString(),
  };
}

async function auditTransition(
  tx: Tx,
  ctx: ServiceContext,
  action: AuditAction,
  definitionId: string,
  v: Pick<
    OwnAnalysisPromptVersion,
    'id' | 'ownPromptId' | 'basedOnDefinitionVersionId' | 'charCount'
  >,
): Promise<void> {
  await audit.record(
    {
      actorType: 'user',
      actorUserId: ctx.userId,
      action,
      targetType: 'definition',
      targetId: definitionId,
      metadata: {
        ownPromptId: v.ownPromptId,
        versionId: v.id,
        basedOnDefinitionVersionId: v.basedOnDefinitionVersionId,
        charCount: v.charCount,
      },
    },
    tx,
  );
}

/** Inserts a version with `text`, makes it current and in use, and audits `action`. */
async function storeVersion(
  tx: Tx,
  ctx: ServiceContext,
  own: OwnAnalysisPrompt,
  text: string,
  basedOnDefinitionVersionId: string,
  action: AuditAction,
): Promise<OwnPromptSaved> {
  const version = await insertOwnPromptVersion(
    ctx,
    {
      ownPromptId: own.id,
      promptTextEnc: encrypt('user-content', text),
      charCount: text.length,
      basedOnDefinitionVersionId,
    },
    tx,
  );
  await setCurrentVersion(ctx, own.id, version.id, tx);
  await auditTransition(tx, ctx, action, own.definitionId, version);
  return { own: { id: own.id, inUse: true, currentVersion: toRef(version) } };
}

/** The current version with text, or null when the row has none (or it is not this user's). */
async function currentVersion(ctx: ServiceContext, own: OwnAnalysisPrompt, db: DbOrTx = getDb()) {
  if (!own.currentVersionId) return null;
  return getVersionWithText(ctx, own.currentVersionId, db);
}

// ---------------------------------------------------------------------------------------------------------------
// Reads

export async function list(ctx: ServiceContext): Promise<OwnPromptListItem[]> {
  const db = getDb();
  const [defs, owns] = await Promise.all([
    scopedDefinitions(db, ctx.userId),
    listOwnPrompts(ctx, db),
  ]);
  const ownByDefinition = new Map(owns.map((o) => [o.definitionId, o]));
  const currentIds = owns.flatMap((o) => (o.currentVersionId ? [o.currentVersionId] : []));
  // Current version metadata plus the based-on default text; never the own ciphertext.
  const metas =
    currentIds.length === 0
      ? []
      : await db
          .select({
            id: ownAnalysisPromptVersion.id,
            versionNumber: ownAnalysisPromptVersion.versionNumber,
            basedOnDefinitionVersionId: ownAnalysisPromptVersion.basedOnDefinitionVersionId,
            basePrompt: toneDefinitionVersion.analysisPrompt,
            createdAt: ownAnalysisPromptVersion.createdAt,
          })
          .from(ownAnalysisPromptVersion)
          .innerJoin(
            ownAnalysisPrompt,
            eq(ownAnalysisPrompt.id, ownAnalysisPromptVersion.ownPromptId),
          )
          .innerJoin(
            toneDefinitionVersion,
            eq(toneDefinitionVersion.id, ownAnalysisPromptVersion.basedOnDefinitionVersionId),
          )
          .where(
            and(
              inArray(ownAnalysisPromptVersion.id, currentIds),
              eq(ownAnalysisPrompt.userId, ctx.userId),
            ),
          );
  const metaById = new Map(metas.map((m) => [m.id, m]));

  const items: OwnPromptListItem[] = [];
  for (const d of defs) {
    if (!d.activeVersionId || d.activeVersionNumber === null) continue;
    const o = ownByDefinition.get(d.id);
    const meta = o?.currentVersionId ? metaById.get(o.currentVersionId) : undefined;
    const inUse = o?.inUse === true;
    const changed =
      inUse &&
      meta !== undefined &&
      meta.basedOnDefinitionVersionId !== d.activeVersionId &&
      (meta.basePrompt ?? '').trim() !== (d.activePrompt ?? '').trim();
    items.push({
      definition: { id: d.id, name: d.name, retired: d.retired },
      profileId: d.profileId,
      mode: inUse ? 'own' : 'default',
      default: { definitionVersionId: d.activeVersionId, versionNumber: d.activeVersionNumber },
      own: o
        ? {
            id: o.id,
            inUse: o.inUse,
            currentVersion: meta
              ? {
                  id: meta.id,
                  versionNumber: meta.versionNumber,
                  basedOnDefinitionVersionId: meta.basedOnDefinitionVersionId,
                  createdAt: meta.createdAt.toISOString(),
                }
              : null,
          }
        : null,
      defaultChangedSinceBase: changed,
    });
  }
  return items;
}

export async function get(ctx: ServiceContext, definitionId: string): Promise<OwnPromptDetail> {
  const db = getDb();
  const def = await scopedOrThrow(db, ctx.userId, definitionId);
  const active = activeDefault(def);
  const own = await getOwnPrompt(ctx, definitionId, db);
  const current = own ? await currentVersion(ctx, own, db) : null;
  return {
    definition: { id: def.id, name: def.name, retired: def.retired },
    default: {
      definitionVersionId: active.id,
      versionNumber: active.versionNumber,
      promptText: active.text,
    },
    own: own
      ? {
          id: own.id,
          inUse: own.inUse,
          currentVersion: current
            ? {
                id: current.id,
                versionNumber: current.versionNumber,
                promptText: decrypt('user-content', current.promptTextEnc),
                basedOnDefinitionVersion: {
                  id: current.basedOnDefinitionVersionId,
                  versionNumber: current.basedOnVersionNumber,
                },
                createdAt: current.createdAt.toISOString(),
              }
            : null,
        }
      : null,
    limits: { maxChars: OWN_PROMPT_MAX_CHARS },
  };
}

export async function listVersions(
  ctx: ServiceContext,
  definitionId: string,
): Promise<OwnPromptVersionItem[]> {
  const db = getDb();
  await scopedOrThrow(db, ctx.userId, definitionId);
  const own = await getOwnPrompt(ctx, definitionId, db);
  if (!own) return [];
  const metas = await listVersionMeta(ctx, own.id, db);
  return metas.map((m) => ({
    id: m.id,
    versionNumber: m.versionNumber,
    basedOnDefinitionVersion: {
      id: m.basedOnDefinitionVersionId,
      versionNumber: m.basedOnVersionNumber,
    },
    createdAt: m.createdAt.toISOString(),
    inUseNow: own.inUse && own.currentVersionId === m.id,
  }));
}

export async function getVersion(
  ctx: ServiceContext,
  definitionId: string,
  versionId: string,
): Promise<OwnPromptVersionItem & { promptText: string }> {
  const db = getDb();
  await scopedOrThrow(db, ctx.userId, definitionId);
  if (!UUID_RE.test(versionId)) throw new AppError('not_found');
  const v = await getVersionWithText(ctx, versionId, db);
  if (!v || v.definitionId !== definitionId) throw new AppError('not_found');
  const own = await getOwnPrompt(ctx, definitionId, db);
  return {
    id: v.id,
    versionNumber: v.versionNumber,
    basedOnDefinitionVersion: {
      id: v.basedOnDefinitionVersionId,
      versionNumber: v.basedOnVersionNumber,
    },
    createdAt: v.createdAt.toISOString(),
    inUseNow: own?.inUse === true && own.currentVersionId === v.id,
    promptText: decrypt('user-content', v.promptTextEnc),
  };
}

/** Current own version (first side: the default, second side: the own text). */
export async function compare(
  ctx: ServiceContext,
  definitionId: string,
): Promise<{
  own: { versionId: string; versionNumber: number };
  default: { definitionVersionId: string; versionNumber: number };
  diff: DiffOp[];
}> {
  const db = getDb();
  const def = await scopedOrThrow(db, ctx.userId, definitionId);
  const active = activeDefault(def);
  const own = await getOwnPrompt(ctx, definitionId, db);
  const current = own ? await currentVersion(ctx, own, db) : null;
  if (!current) throw new AppError('not_found');
  return {
    own: { versionId: current.id, versionNumber: current.versionNumber },
    default: { definitionVersionId: active.id, versionNumber: active.versionNumber },
    diff: textDiff(active.text, decrypt('user-content', current.promptTextEnc)),
  };
}

/** What changed between two default versions of the definition (FR-013); `toId` defaults to the active one. */
export async function defaultChanges(
  ctx: ServiceContext,
  definitionId: string,
  fromId: string | undefined,
  toId?: string,
): Promise<{
  from: { id: string; versionNumber: number };
  to: { id: string; versionNumber: number };
  diff: DiffOp[];
}> {
  const db = getDb();
  const def = await scopedOrThrow(db, ctx.userId, definitionId);
  if (!fromId) throw new AppError('validation_failed', undefined, { field: 'from' });
  const from = await definitionVersionOf(db, definitionId, fromId);
  const to = await definitionVersionOf(db, definitionId, toId ?? activeDefault(def).id);
  return {
    from: { id: from.id, versionNumber: from.versionNumber },
    to: { id: to.id, versionNumber: to.versionNumber },
    diff: textDiff(from.analysisPrompt ?? '', to.analysisPrompt ?? ''),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Transitions (one transaction each; the own prompt row is locked FOR UPDATE)

/** none -> own (version 1) or reset -> own (fresh copy of the current default). */
export async function customise(
  ctx: ServiceContext,
  definitionId: string,
): Promise<OwnPromptSaved> {
  try {
    return await withTransaction(async (tx) => {
      const def = await scopedOrThrow(tx, ctx.userId, definitionId, true);
      if (def.retired) throw new AppError('definition_retired');
      const active = activeDefault(def);
      const existing = await lockOwnPrompt(ctx, definitionId, tx);
      if (existing?.inUse)
        throw new AppError('conflict', 'An own analysis prompt is already in use');
      if (active.text.trim() === '')
        throw new AppError('conflict', 'The default analysis prompt is empty');
      const own = existing ?? (await insertOwnPrompt(ctx, definitionId, tx));
      return storeVersion(tx, ctx, own, active.text, active.id, 'analysis_prompt.customised');
    });
  } catch (err) {
    // A concurrent first customise won the unique (user, definition) row.
    if (isUniqueViolation(err))
      throw new AppError('conflict', 'An own analysis prompt is already in use');
    throw err;
  }
}

/**
 * own -> own (based_on kept from the base version) or reset -> own (based_on = the active default version).
 * The text is not inspected here; it is inspected before each use in a generation.
 */
export async function save(
  ctx: ServiceContext,
  definitionId: string,
  input: { promptText: string; baseVersionId: string },
): Promise<OwnPromptSaved> {
  return withTransaction(async (tx) => {
    const def = await scopedOrThrow(tx, ctx.userId, definitionId, true);
    if (def.retired) throw new AppError('definition_retired');
    const own = await lockOwnPrompt(ctx, definitionId, tx);
    if (!own) throw new AppError('not_found');
    const text = assertPromptText(input.promptText);
    if (!own.currentVersionId || own.currentVersionId !== input.baseVersionId) {
      throw new AppError('conflict', 'The own analysis prompt changed since it was opened');
    }
    let basedOn = activeDefault(def).id;
    if (own.inUse) {
      const base = await getVersionWithText(ctx, own.currentVersionId, tx);
      if (!base)
        throw new AppError('conflict', 'The own analysis prompt changed since it was opened');
      basedOn = base.basedOnDefinitionVersionId;
    }
    return storeVersion(tx, ctx, own, text, basedOn, 'analysis_prompt.saved');
  });
}

/** own -> reset; idempotent when already reset. Allowed for a retired definition. */
export async function reset(
  ctx: ServiceContext,
  definitionId: string,
): Promise<{ own: { id: string; inUse: false } }> {
  return withTransaction(async (tx) => {
    await scopedOrThrow(tx, ctx.userId, definitionId, true);
    const own = await lockOwnPrompt(ctx, definitionId, tx);
    if (!own) throw new AppError('not_found');
    if (own.inUse) {
      await setInUse(ctx, own.id, false, tx);
      const current = await currentVersion(ctx, own, tx);
      if (current) await auditTransition(tx, ctx, 'analysis_prompt.reset', definitionId, current);
    }
    return { own: { id: own.id, inUse: false } };
  });
}
