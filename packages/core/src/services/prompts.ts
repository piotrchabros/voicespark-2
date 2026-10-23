import { and, desc, eq } from 'drizzle-orm';
import {
  getDb,
  PROMPT_EFFORTS,
  promptTemplate,
  promptTemplateVersion,
  SYSTEM_PROMPT_KEYS,
  toneDefinitionVersion,
  versionActivation,
  withTransaction,
  type DbOrTx,
  type PromptEffort,
  type PromptTemplateVersion,
} from '@voicespark/db';
import {
  getPromptItem,
  listPromptVersions,
  listPrompts,
  promptHistory,
  toPromptVersionView,
} from '@voicespark/db/repos/admin/prompts';
import type {
  AdminPromptListItem,
  HistoryEntry,
  PromptVersionView,
  VersionRef,
} from '@voicespark/db/repos/admin/types';
import { loadEnv } from '../env';
import { AppError } from '../errors';
import fixture from '../prompting/preview-fixture.json' with { type: 'json' };
import {
  familyFor,
  render,
  validateTemplate,
  type TemplatePair,
  type TemplateValidation,
} from '../prompting';
import { buildMessages, wrapAnalysisPrompt } from '../prompting/analysis';
import { jsonDiff, type DiffEntry } from '../versioning';
import { audit } from './audit';

const CUSTOM_KEY = /^custom\.[a-z0-9_]{2,60}$/;
const MAX_TOKENS_MIN = 256;
const MAX_TOKENS_MAX = 64_000;
const DESCRIPTION_MAX = 500;
const CHANGE_NOTE_MAX = 500;

export interface PromptDraftPatch {
  systemTemplate?: string;
  userTemplate?: string;
  model?: string;
  effort?: PromptEffort;
  maxTokens?: number;
  changeNote?: string | null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Generation-facing reads (uncached on purpose: a publish applies to the next generation, R16)

/** The active version of a prompt key, read through `active_version_id` on every call. */
export async function getActiveVersion(key: string, db: DbOrTx = getDb()): Promise<PromptTemplateVersion | null> {
  const [row] = await db
    .select({ version: promptTemplateVersion })
    .from(promptTemplate)
    .innerJoin(promptTemplateVersion, eq(promptTemplateVersion.id, promptTemplate.activeVersionId))
    .where(eq(promptTemplate.key, key))
    .limit(1);
  return row?.version ?? null;
}

export async function getVersion(
  versionId: string,
  db: DbOrTx = getDb(),
): Promise<(PromptTemplateVersion & { key: string }) | null> {
  if (!isUuid(versionId)) return null;
  const [row] = await db
    .select({ version: promptTemplateVersion, key: promptTemplate.key })
    .from(promptTemplateVersion)
    .innerJoin(promptTemplate, eq(promptTemplate.id, promptTemplateVersion.promptTemplateId))
    .where(eq(promptTemplateVersion.id, versionId))
    .limit(1);
  return row ? { ...row.version, key: row.key } : null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Admin

export async function adminList(): Promise<AdminPromptListItem[]> {
  return listPrompts();
}

export async function adminGet(id: string): Promise<{ prompt: AdminPromptListItem; versions: PromptVersionView[] }> {
  const prompt = await requireItem(id);
  return { prompt, versions: await listPromptVersions(id) };
}

export async function create(
  adminId: string,
  input: {
    key: string;
    description: string;
    systemTemplate: string;
    userTemplate: string;
    model: string;
    effort: PromptEffort;
    maxTokens: number;
  },
): Promise<{ prompt: AdminPromptListItem; draft: PromptVersionView }> {
  if ((SYSTEM_PROMPT_KEYS as readonly string[]).includes(input.key)) {
    throw new AppError('conflict', 'System prompts already exist');
  }
  if (!CUSTOM_KEY.test(input.key)) throw new AppError('validation_failed', undefined, { field: 'key' });
  const description = input.description?.trim() ?? '';
  if (description.length < 1 || description.length > DESCRIPTION_MAX) {
    throw new AppError('validation_failed', undefined, { field: 'description' });
  }
  assertSettings(input);
  assertTemplates(input.key, input.systemTemplate, input.userTemplate, 'save');

  let promptId: string;
  let draft: PromptTemplateVersion;
  try {
    ({ promptId, draft } = await withTransaction(async (tx) => {
      const [template] = await tx
        .insert(promptTemplate)
        .values({ key: input.key, isSystem: false, description, createdBy: adminId })
        .returning({ id: promptTemplate.id });
      const [version] = await tx
        .insert(promptTemplateVersion)
        .values({
          promptTemplateId: template!.id,
          versionNumber: 1,
          status: 'draft',
          systemTemplate: input.systemTemplate,
          userTemplate: input.userTemplate,
          model: input.model,
          effort: input.effort,
          maxTokens: input.maxTokens,
          createdBy: adminId,
        })
        .returning();
      await audit.record(
        {
          actorType: 'admin',
          actorUserId: adminId,
          action: 'prompt.created',
          targetType: 'prompt',
          targetId: template!.id,
          metadata: { versionId: version!.id },
        },
        tx,
      );
      return { promptId: template!.id, draft: version! };
    }));
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError('conflict', 'Prompt key already exists');
    throw err;
  }
  return { prompt: await requireItem(promptId), draft: toPromptVersionView(draft) };
}

/** New draft copied from `fromVersionId`, else the active version, else the latest one. */
export async function createDraft(adminId: string, id: string, fromVersionId?: string): Promise<PromptVersionView> {
  try {
    const draft = await withTransaction(async (tx) => {
      await lockTemplate(tx, id);
      const versions = await tx
        .select()
        .from(promptTemplateVersion)
        .where(eq(promptTemplateVersion.promptTemplateId, id))
        .orderBy(desc(promptTemplateVersion.versionNumber));
      if (versions.some((v) => v.status === 'draft')) throw new AppError('conflict', 'A draft already exists');
      const source =
        fromVersionId !== undefined
          ? versions.find((v) => v.id === fromVersionId)
          : (versions.find((v) => v.status === 'active') ?? versions[0] ?? blankVersion());
      if (!source) throw new AppError('not_found');
      const [version] = await tx
        .insert(promptTemplateVersion)
        .values({
          promptTemplateId: id,
          versionNumber: (versions[0]?.versionNumber ?? 0) + 1,
          status: 'draft',
          systemTemplate: source.systemTemplate,
          userTemplate: source.userTemplate,
          model: source.model,
          effort: source.effort,
          maxTokens: source.maxTokens,
          createdBy: adminId,
        })
        .returning();
      await audit.record(
        {
          actorType: 'admin',
          actorUserId: adminId,
          action: 'prompt.version_drafted',
          targetType: 'prompt',
          targetId: id,
          metadata: source.id ? { versionId: version!.id, fromVersionId: source.id } : { versionId: version!.id },
        },
        tx,
      );
      return version!;
    });
    return toPromptVersionView(draft);
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError('conflict', 'A draft already exists');
    throw err;
  }
}

/** Drafts only; refuses unknown template variables (missing required ones are checked on publish). */
export async function updateDraft(
  adminId: string,
  id: string,
  versionId: string,
  patch: PromptDraftPatch,
): Promise<PromptVersionView> {
  void adminId;
  const version = await requireVersion(id, versionId);
  if (version.status !== 'draft') throw new AppError('version_not_draft');
  const next = {
    systemTemplate: patch.systemTemplate ?? version.systemTemplate,
    userTemplate: patch.userTemplate ?? version.userTemplate,
    model: patch.model ?? version.model,
    effort: patch.effort ?? version.effort,
    maxTokens: patch.maxTokens ?? version.maxTokens,
    changeNote: patch.changeNote === undefined ? version.changeNote : patch.changeNote,
  };
  if (typeof next.systemTemplate !== 'string' || typeof next.userTemplate !== 'string') {
    throw new AppError('validation_failed', undefined, { field: 'template' });
  }
  if (next.changeNote !== null && (typeof next.changeNote !== 'string' || next.changeNote.length > CHANGE_NOTE_MAX)) {
    throw new AppError('validation_failed', undefined, { field: 'changeNote' });
  }
  assertSettings(next);
  assertTemplates(version.key, next.systemTemplate, next.userTemplate, 'save');

  const [row] = await getDb()
    .update(promptTemplateVersion)
    .set(next)
    .where(and(eq(promptTemplateVersion.id, versionId), eq(promptTemplateVersion.status, 'draft')))
    .returning();
  if (!row) throw new AppError('version_not_draft');
  return toPromptVersionView(row);
}

export async function discardDraft(adminId: string, id: string, versionId: string): Promise<void> {
  void adminId;
  const version = await requireVersion(id, versionId);
  if (version.status !== 'draft') throw new AppError('version_not_draft');
  const deleted = await getDb()
    .delete(promptTemplateVersion)
    .where(and(eq(promptTemplateVersion.id, versionId), eq(promptTemplateVersion.status, 'draft')))
    .returning({ id: promptTemplateVersion.id });
  if (deleted.length === 0) throw new AppError('version_not_draft');
}

/** Draft -> active; the previous active version becomes superseded (FR-041, FR-042). */
export async function publish(adminId: string, id: string, versionId: string): Promise<AdminPromptListItem> {
  await withTransaction(async (tx) => {
    const template = await lockTemplate(tx, id);
    const version = await versionOf(tx, id, versionId);
    if (version.status !== 'draft') throw new AppError('version_not_draft');
    assertModel(version.model);
    assertTemplates(template.key, version.systemTemplate, version.userTemplate, 'publish');
    await activate(tx, adminId, template, version.id, 'publish');
  });
  return requireItem(id);
}

/** Re-activates a superseded version (FR-042). */
export async function rollback(adminId: string, id: string, versionId: string): Promise<AdminPromptListItem> {
  await withTransaction(async (tx) => {
    const template = await lockTemplate(tx, id);
    const version = await versionOf(tx, id, versionId);
    if (version.status !== 'superseded') throw new AppError('conflict', 'Only superseded versions can be rolled back to');
    // A superseded version may predate a whitelist change (e.g. the dimension-based v1 of tone_profile.*).
    assertTemplates(template.key, version.systemTemplate, version.userTemplate, 'publish');
    await activate(tx, adminId, template, version.id, 'rollback');
  });
  return requireItem(id);
}

export async function validate(versionId: string): Promise<TemplateValidation> {
  const version = await getVersion(versionId);
  if (!version) throw new AppError('not_found');
  return validateTemplate(version.key, version.systemTemplate, version.userTemplate);
}

/** Renders against the synthetic preview fixture only; never user data, nothing stored (FR-057). */
export async function preview(
  versionId: string,
  opts: { isRevision?: boolean } = {},
): Promise<{ system: string; user: string }> {
  const version = await getVersion(versionId);
  if (!version) throw new AppError('not_found');
  const variables = previewVariables(version.key);
  if (opts.isRevision !== undefined) variables.isRevision = opts.isRevision;
  const family = familyFor(version.key);
  if (family === 'tone_profile.generate' || family === 'tone_profile.feedback') return renderAnalysis(version, variables);
  return render(version, variables);
}

/** Admin definition preview (FR-004): active `tone_profile.{kind}` wrapper + fixture, with this version's analysis prompt. */
export async function previewDefinitionVersion(
  definitionVersionId: string,
  kind: 'generate' | 'feedback' = 'generate',
): Promise<{ system: string; user: string }> {
  if (!isUuid(definitionVersionId)) throw new AppError('not_found');
  const [dv] = await getDb()
    .select({
      name: toneDefinitionVersion.name,
      description: toneDefinitionVersion.description,
      analysisPrompt: toneDefinitionVersion.analysisPrompt,
    })
    .from(toneDefinitionVersion)
    .where(eq(toneDefinitionVersion.id, definitionVersionId))
    .limit(1);
  if (!dv) throw new AppError('not_found');
  const key = `tone_profile.${kind}`;
  const wrapper = await getActiveVersion(key);
  if (!wrapper) throw new AppError('not_found');
  const variables = previewVariables(key);
  variables.definition = { name: dv.name, description: dv.description };
  return renderAnalysis(wrapper, { ...variables, analysisPrompt: dv.analysisPrompt ?? '' });
}

export async function history(id: string): Promise<HistoryEntry[]> {
  await requireItem(id);
  return promptHistory(id);
}

export async function diff(
  id: string,
  versionId: string,
  againstId: string,
): Promise<{ from: VersionRef; to: VersionRef; changes: DiffEntry[] }> {
  const [from, to] = await Promise.all([requireVersion(id, versionId), requireVersion(id, againstId)]);
  return {
    from: { id: from.id, versionNumber: from.versionNumber },
    to: { id: to.id, versionNumber: to.versionNumber },
    changes: jsonDiff(diffable(from), diffable(to)),
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Internals

type Fixture = Record<string, Record<string, unknown>>;

/** Layers 1-4 of contracts/analysis-prompt.md: the raw `analysisPrompt` is wrapped, then guard and reminder added. */
function renderAnalysis(version: TemplatePair, variables: Record<string, unknown>): { system: string; user: string } {
  const raw = typeof variables.analysisPrompt === 'string' ? variables.analysisPrompt : '';
  const labels = typeof variables.excludedCategoryLabels === 'string' ? variables.excludedCategoryLabels : '';
  const rendered = render(version, { ...variables, analysisPrompt: wrapAnalysisPrompt(raw, 'default') });
  return buildMessages(rendered.system, rendered.user, labels);
}

function previewVariables(key: string): Record<string, unknown> {
  const entries = fixture as Fixture;
  const own = entries[key];
  if (own) return structuredClone(own);
  // draft.* keys without their own entry share the first draft entry; custom.* get the merge of all entries.
  if (familyFor(key) === 'draft') {
    const shared = Object.entries(entries).find(([k]) => k.startsWith('draft.'));
    if (shared) return structuredClone(shared[1]);
  }
  return structuredClone(Object.assign({}, ...Object.values(entries)) as Record<string, unknown>);
}

/** Source for a draft of a prompt whose only (never published) draft was discarded. */
function blankVersion(): Pick<
  PromptTemplateVersion,
  'id' | 'systemTemplate' | 'userTemplate' | 'model' | 'effort' | 'maxTokens'
> {
  const env = loadEnv();
  const model = env.LLM_ALLOWED_MODELS.includes(env.LLM_PROFILE_MODEL)
    ? env.LLM_PROFILE_MODEL
    : (env.LLM_ALLOWED_MODELS[0] ?? env.LLM_PROFILE_MODEL);
  return { id: '', systemTemplate: '', userTemplate: '', model, effort: 'medium', maxTokens: 1024 };
}

function diffable(v: PromptTemplateVersion): Record<string, unknown> {
  return {
    systemTemplate: v.systemTemplate,
    userTemplate: v.userTemplate,
    model: v.model,
    effort: v.effort,
    maxTokens: v.maxTokens,
  };
}

async function activate(
  tx: DbOrTx,
  adminId: string,
  template: { id: string; activeVersionId: string | null },
  versionId: string,
  action: 'publish' | 'rollback',
): Promise<void> {
  const now = new Date();
  const fromVersionId = template.activeVersionId;
  await tx
    .update(promptTemplateVersion)
    .set({ status: 'superseded' })
    .where(and(eq(promptTemplateVersion.promptTemplateId, template.id), eq(promptTemplateVersion.status, 'active')));
  await tx
    .update(promptTemplateVersion)
    .set(
      action === 'publish'
        ? { status: 'active', publishedBy: adminId, publishedAt: now }
        : { status: 'active' },
    )
    .where(eq(promptTemplateVersion.id, versionId));
  await tx.update(promptTemplate).set({ activeVersionId: versionId }).where(eq(promptTemplate.id, template.id));
  await tx.insert(versionActivation).values({
    entityType: 'prompt',
    entityId: template.id,
    fromVersionId,
    toVersionId: versionId,
    action,
    actorUserId: adminId,
    occurredAt: now,
  });
  await audit.record(
    {
      actorType: 'admin',
      actorUserId: adminId,
      action: action === 'publish' ? 'prompt.version_published' : 'prompt.rolled_back',
      targetType: 'prompt',
      targetId: template.id,
      metadata: fromVersionId ? { versionId, fromVersionId } : { versionId },
    },
    tx,
  );
}

async function lockTemplate(
  tx: DbOrTx,
  id: string,
): Promise<{ id: string; key: string; activeVersionId: string | null }> {
  if (!isUuid(id)) throw new AppError('not_found');
  const [row] = await tx
    .select({ id: promptTemplate.id, key: promptTemplate.key, activeVersionId: promptTemplate.activeVersionId })
    .from(promptTemplate)
    .where(eq(promptTemplate.id, id))
    .for('update');
  if (!row) throw new AppError('not_found');
  return row;
}

async function versionOf(tx: DbOrTx, id: string, versionId: string): Promise<PromptTemplateVersion> {
  if (!isUuid(versionId)) throw new AppError('not_found');
  const [row] = await tx
    .select()
    .from(promptTemplateVersion)
    .where(and(eq(promptTemplateVersion.id, versionId), eq(promptTemplateVersion.promptTemplateId, id)))
    .limit(1);
  if (!row) throw new AppError('not_found');
  return row;
}

async function requireVersion(id: string, versionId: string): Promise<PromptTemplateVersion & { key: string }> {
  const version = await getVersion(versionId);
  if (!version || version.promptTemplateId !== id) throw new AppError('not_found');
  return version;
}

async function requireItem(id: string): Promise<AdminPromptListItem> {
  const item = isUuid(id) ? await getPromptItem(id) : null;
  if (!item) throw new AppError('not_found');
  return item;
}

function assertModel(model: string): void {
  if (!loadEnv().LLM_ALLOWED_MODELS.includes(model)) {
    throw new AppError('model_not_allowed', undefined, { allowedModels: loadEnv().LLM_ALLOWED_MODELS });
  }
}

function assertSettings(v: { model: string; effort: PromptEffort; maxTokens: number }): void {
  if (typeof v.model !== 'string') throw new AppError('validation_failed', undefined, { field: 'model' });
  assertModel(v.model);
  if (!(PROMPT_EFFORTS as readonly string[]).includes(v.effort)) {
    throw new AppError('validation_failed', undefined, { field: 'effort' });
  }
  if (!Number.isInteger(v.maxTokens) || v.maxTokens < MAX_TOKENS_MIN || v.maxTokens > MAX_TOKENS_MAX) {
    throw new AppError('validation_failed', undefined, { field: 'maxTokens' });
  }
}

/** Save refuses unknown variables; publish also refuses missing required ones (FR-039). */
function assertTemplates(key: string, systemTemplate: string, userTemplate: string, mode: 'save' | 'publish'): void {
  const result = validateTemplate(key, systemTemplate, userTemplate);
  const refused = mode === 'save' ? result.unknownVariables.length > 0 : !result.valid;
  if (refused) {
    throw new AppError('unknown_template_variable', undefined, {
      unknownVariables: result.unknownVariables,
      missingRequired: result.missingRequired,
    });
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID.test(value);
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | undefined;
  return e?.code === '23505' || e?.cause?.code === '23505';
}
