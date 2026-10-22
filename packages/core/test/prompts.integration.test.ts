import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLogEntry,
  closeDb,
  getDb,
  getPool,
  promptTemplate,
  promptTemplateVersion,
  user,
  versionActivation,
} from '@voicespark/db';
import { and, count, eq, inArray } from 'drizzle-orm';
import { AppError } from '@voicespark/core/errors';
import * as prompts from '@voicespark/core/services/prompts';

// US6 / T129: prompt template service (custom prompts, drafts, publish/rollback, validate, preview).
process.env.DATABASE_URL ??= 'postgres://voicespark:voicespark@localhost:55432/voicespark_test';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-00';
process.env.ENCRYPTION_KEYRING ??= JSON.stringify({ k1: Buffer.alloc(32, 1).toString('base64') });
process.env.ENCRYPTION_ACTIVE_KEY_ID ??= 'k1';
process.env.DEDUP_HMAC_KEY ??= Buffer.alloc(32, 2).toString('base64');
process.env.REDIS_URL ??= 'redis://localhost:56379';
process.env.NODE_ENV ??= 'test';
process.env.APP_URL ??= 'http://localhost:3000';

const tag = randomUUID().replace(/-/g, '').slice(0, 10);
const userIds: string[] = [];
const promptIds: string[] = [];
let adminId: string;
let createdSystemPromptId: string | null = null;

const SYSTEM_TEMPLATE = 'You write short posts in the voice of {{user.firstName}}.';
const USER_TEMPLATE = 'Write about: {{brief}}';

const input = (label: string, over: Partial<Parameters<typeof prompts.create>[1]> = {}) => ({
  key: `custom.t_${label}_${tag}`,
  description: 'Test prompt',
  systemTemplate: SYSTEM_TEMPLATE,
  userTemplate: USER_TEMPLATE,
  model: 'claude-sonnet-5-5',
  effort: 'medium' as const,
  maxTokens: 1024,
  ...over,
});

async function errorOf(p: Promise<unknown>): Promise<AppError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return err as AppError;
}

async function createPrompt(label: string) {
  const created = await prompts.create(adminId, input(label));
  promptIds.push(created.prompt.id);
  return created;
}

async function auditActions(targetId: string): Promise<string[]> {
  const rows = await getDb().select({ action: auditLogEntry.action }).from(auditLogEntry).where(eq(auditLogEntry.targetId, targetId));
  return rows.map((r) => r.action);
}

beforeAll(async () => {
  await getPool().query('select 1');
  const [row] = await getDb()
    .insert(user)
    .values({ name: 'Prompt Admin', email: `promptadmin-${tag}@example.test`, role: 'admin' })
    .returning({ id: user.id });
  adminId = row!.id;
  userIds.push(adminId);
});

afterAll(async () => {
  const db = getDb();
  const ids = [...promptIds];
  if (createdSystemPromptId) ids.push(createdSystemPromptId);
  if (ids.length > 0) {
    await db.update(promptTemplate).set({ activeVersionId: null }).where(inArray(promptTemplate.id, ids));
    await db.delete(promptTemplate).where(inArray(promptTemplate.id, ids));
    await db.delete(versionActivation).where(inArray(versionActivation.entityId, ids));
  }
  if (userIds.length > 0) await db.delete(user).where(inArray(user.id, userIds));
  await closeDb();
});

describe('create', () => {
  it('creates a custom prompt with a v1 draft and audits it', async () => {
    const { prompt, draft } = await createPrompt('create');
    expect(prompt).toMatchObject({ key: `custom.t_create_${tag}`, isSystem: false, activeVersion: null });
    expect(draft).toMatchObject({ versionNumber: 1, status: 'draft', model: 'claude-sonnet-5-5', effort: 'medium', maxTokens: 1024 });
    expect(prompt.draftVersionId).toBe(draft.id);
    expect(await auditActions(prompt.id)).toContain('prompt.created');
  });

  it('rejects a model outside LLM_ALLOWED_MODELS with 422 model_not_allowed', async () => {
    const err = await errorOf(prompts.create(adminId, input('badmodel', { model: 'gpt-nope-1' })));
    expect(err.code).toBe('model_not_allowed');
    expect(err.status).toBe(422);
  });

  it('rejects maxTokens outside 256-64000 and system or malformed keys', async () => {
    for (const maxTokens of [100, 64001, 1000.5]) {
      expect((await errorOf(prompts.create(adminId, input('tokens', { maxTokens })))).code).toBe('validation_failed');
    }
    expect((await errorOf(prompts.create(adminId, input('x', { key: 'draft.bio' })))).code).toBe('conflict');
    expect((await errorOf(prompts.create(adminId, input('x', { key: 'custom.BAD KEY' })))).code).toBe('validation_failed');
  });

  it('rejects unknown template variables on create', async () => {
    const err = await errorOf(prompts.create(adminId, input('unk', { userTemplate: 'Hi {{secretVar}}' })));
    expect(err.code).toBe('unknown_template_variable');
    expect(err.status).toBe(422);
    expect(err.details).toMatchObject({ unknownVariables: ['secretVar'] });
  });
});

describe('draft, publish, rollback', () => {
  it('updateDraft refuses unknown variables and non-drafts (version_not_draft, 422)', async () => {
    const { prompt, draft } = await createPrompt('update');
    const err = await errorOf(prompts.updateDraft(adminId, prompt.id, draft.id, { userTemplate: 'Hi {{secretVar}}' }));
    expect(err.code).toBe('unknown_template_variable');
    expect(err.status).toBe(422);

    const ok = await prompts.updateDraft(adminId, prompt.id, draft.id, { userTemplate: 'Topic: {{brief}}', maxTokens: 2048, changeNote: 'tweak' });
    expect(ok).toMatchObject({ userTemplate: 'Topic: {{brief}}', maxTokens: 2048, changeNote: 'tweak' });
    expect((await errorOf(prompts.updateDraft(adminId, prompt.id, draft.id, { model: 'gpt-nope-1' }))).code).toBe('model_not_allowed');

    await prompts.publish(adminId, prompt.id, draft.id);
    const notDraft = await errorOf(prompts.updateDraft(adminId, prompt.id, draft.id, { changeNote: 'late' }));
    expect(notDraft.code).toBe('version_not_draft');
    expect(notDraft.status).toBe(422);
  });

  it('publishes: active, previous superseded, activation row, audit, getActiveVersion immediately; then rolls back', async () => {
    const { prompt, draft: v1 } = await createPrompt('publish');
    const first = await prompts.publish(adminId, prompt.id, v1.id);
    expect(first.activeVersion).toMatchObject({ id: v1.id, versionNumber: 1 });
    expect((await prompts.getActiveVersion(prompt.key))?.id).toBe(v1.id);

    // A second draft can only be created when none exists.
    const v2 = await prompts.createDraft(adminId, prompt.id);
    expect(v2).toMatchObject({ versionNumber: 2, status: 'draft' });
    expect((await errorOf(prompts.createDraft(adminId, prompt.id))).code).toBe('conflict');
    await prompts.updateDraft(adminId, prompt.id, v2.id, { systemTemplate: 'Version two for {{user.firstName}}.' });
    await prompts.publish(adminId, prompt.id, v2.id);
    expect((await prompts.getActiveVersion(prompt.key))?.id).toBe(v2.id);

    const detail = await prompts.adminGet(prompt.id);
    expect(detail.versions.find((v) => v.id === v1.id)?.status).toBe('superseded');
    expect(detail.versions.find((v) => v.id === v2.id)?.status).toBe('active');

    const activations = await getDb()
      .select()
      .from(versionActivation)
      .where(and(eq(versionActivation.entityType, 'prompt'), eq(versionActivation.entityId, prompt.id)));
    expect(activations).toHaveLength(2);
    expect(activations.find((a) => a.toVersionId === v2.id)).toMatchObject({ action: 'publish', fromVersionId: v1.id, actorUserId: adminId });

    // Rollback only targets superseded versions.
    expect((await errorOf(prompts.rollback(adminId, prompt.id, v2.id))).code).toBe('conflict');
    const rolled = await prompts.rollback(adminId, prompt.id, v1.id);
    expect(rolled.activeVersion).toMatchObject({ id: v1.id });
    expect((await prompts.getActiveVersion(prompt.key))?.id).toBe(v1.id);
    expect((await prompts.getVersion(v2.id))).toMatchObject({ id: v2.id, key: prompt.key });

    expect(await auditActions(prompt.id)).toEqual(
      expect.arrayContaining(['prompt.created', 'prompt.version_drafted', 'prompt.version_published', 'prompt.rolled_back']),
    );
    const history = await prompts.history(prompt.id);
    expect(history).toHaveLength(3);
    expect(history[0]).toMatchObject({ action: 'rollback', toVersion: { id: v1.id } });
  });

  it('discardDraft removes only drafts', async () => {
    const { prompt, draft } = await createPrompt('discard');
    await prompts.discardDraft(adminId, prompt.id, draft.id);
    expect(await getDb().select().from(promptTemplateVersion).where(eq(promptTemplateVersion.id, draft.id))).toHaveLength(0);
    const second = await prompts.createDraft(adminId, prompt.id);
    await prompts.publish(adminId, prompt.id, second.id);
    expect((await errorOf(prompts.discardDraft(adminId, prompt.id, second.id))).code).toBe('version_not_draft');
  });

  it('publish rejects a draft missing required variables with 422 unknown_template_variable', async () => {
    // System keys have required variables (draft.*: brief, profileJson). Use the seeded row, or create a minimal one.
    const db = getDb();
    let [tpl] = await db.select().from(promptTemplate).where(eq(promptTemplate.key, 'draft.bio'));
    if (!tpl) {
      [tpl] = await db
        .insert(promptTemplate)
        .values({ key: 'draft.bio', isSystem: true, description: 'test system prompt', createdBy: adminId })
        .returning();
      createdSystemPromptId = tpl!.id;
      const [v] = await db
        .insert(promptTemplateVersion)
        .values({
          promptTemplateId: tpl!.id,
          versionNumber: 1,
          status: 'active',
          systemTemplate: 'Bio writer.',
          userTemplate: '{{brief}} {{profileJson}}',
          model: 'claude-sonnet-5-5',
          effort: 'medium',
          maxTokens: 1024,
          createdBy: adminId,
          publishedBy: adminId,
          publishedAt: new Date(),
        })
        .returning();
      await db.update(promptTemplate).set({ activeVersionId: v!.id }).where(eq(promptTemplate.id, tpl!.id));
    }
    const activeBefore = (await prompts.getActiveVersion('draft.bio'))!.id;
    const draft = await prompts.createDraft(adminId, tpl!.id);
    try {
      await prompts.updateDraft(adminId, tpl!.id, draft.id, { systemTemplate: 'No variables here.', userTemplate: 'Still none.' });
      const validation = await prompts.validate(draft.id);
      expect(validation.valid).toBe(false);
      expect(validation.missingRequired).toEqual(expect.arrayContaining(['brief', 'profileJson']));
      const err = await errorOf(prompts.publish(adminId, tpl!.id, draft.id));
      expect(err.code).toBe('unknown_template_variable');
      expect(err.status).toBe(422);
      expect((await prompts.getActiveVersion('draft.bio'))!.id).toBe(activeBefore);
    } finally {
      await prompts.discardDraft(adminId, tpl!.id, draft.id);
    }
  });
});

describe('validate, preview, diff', () => {
  it('validate reports a clean template as valid', async () => {
    const { draft } = await createPrompt('validate');
    expect(await prompts.validate(draft.id)).toEqual({ valid: true, unknownVariables: [], missingRequired: [] });
  });

  it('preview renders the fixture (SAMPLE data) and stores nothing', async () => {
    const { prompt, draft } = await createPrompt('preview');
    const before = await getDb().select({ n: count() }).from(promptTemplateVersion).where(eq(promptTemplateVersion.promptTemplateId, prompt.id));
    const rendered = await prompts.preview(draft.id);
    expect(rendered.user).toContain('SAMPLE');
    expect(typeof rendered.system).toBe('string');
    const again = await prompts.preview(draft.id, { isRevision: true });
    expect(again.user).toContain('SAMPLE');
    const after = await getDb().select({ n: count() }).from(promptTemplateVersion).where(eq(promptTemplateVersion.promptTemplateId, prompt.id));
    expect(after[0]!.n).toBe(before[0]!.n);
    const [row] = await getDb().select().from(promptTemplateVersion).where(eq(promptTemplateVersion.id, draft.id));
    expect(row!.userTemplate).toBe(USER_TEMPLATE);
  });

  it('diff lists a changed userTemplate', async () => {
    const { prompt, draft: v1 } = await createPrompt('diff');
    await prompts.publish(adminId, prompt.id, v1.id);
    const v2 = await prompts.createDraft(adminId, prompt.id);
    await prompts.updateDraft(adminId, prompt.id, v2.id, { userTemplate: 'Different: {{brief}}' });
    const d = await prompts.diff(prompt.id, v1.id, v2.id);
    expect(d.from).toMatchObject({ id: v1.id });
    expect(d.to).toMatchObject({ id: v2.id });
    const change = d.changes.find((c) => c.path === 'userTemplate');
    expect(change).toMatchObject({ op: 'changed', before: USER_TEMPLATE, after: 'Different: {{brief}}' });
    expect(d.changes.some((c) => c.path === 'model')).toBe(false);
  });
});
