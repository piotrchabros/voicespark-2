import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditLogEntry, closeDb, draft, getDb, getPool, notification, user } from '@voicespark/db';
import { and, eq } from 'drizzle-orm';
import { decrypt } from '@voicespark/core/crypto';
import { AppError, type ServiceContext } from '@voicespark/core/errors';
import { enqueue } from '@voicespark/core/queues';
import * as drafts from '@voicespark/core/services/drafts';
import * as profiles from '@voicespark/core/services/profiles';
import {
  choose,
  cleanupProfiles,
  createUser,
  ensureActivePrompt,
  insertVersion,
  sampleBody,
  seedDefinition,
  type SeededDefinition,
} from './helpers/profiles';

// US8 drafts service (T151) plus the worker-facing seams T152 relies on (loadDraftForRun, decryptDraftInputs,
// markGenerating, completeDraft, failDraft). Queues are mocked; no LLM or memory store is reachable from here.
vi.mock('@voicespark/core/queues', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@voicespark/core/queues')>()),
  enqueue: vi.fn(async () => ({})),
  upsertScheduler: vi.fn(async () => undefined),
  removeScheduler: vi.fn(async () => undefined),
}));

process.env.DATABASE_URL ??= 'postgres://voicespark:voicespark@localhost:55432/voicespark_test';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-00';
process.env.ENCRYPTION_KEYRING ??= JSON.stringify({ k1: Buffer.alloc(32, 1).toString('base64') });
process.env.ENCRYPTION_ACTIVE_KEY_ID ??= 'k1';
process.env.DEDUP_HMAC_KEY ??= Buffer.alloc(32, 2).toString('base64');
process.env.REDIS_URL ??= 'redis://localhost:56379';
process.env.NODE_ENV ??= 'test';

const DEF_NAME = 'Warm Voice';
const DRAFT_KEYS = ['draft.social_post', 'draft.bio', 'draft.short_article'] as const;

let def: SeededDefinition;
let profilePromptId: string;

interface Author {
  ctx: ServiceContext;
  profileId: string;
  versionId: string;
}

async function expectCode(p: Promise<unknown>, code: string, status?: number): Promise<AppError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  if (status !== undefined) expect((err as AppError).status).toBe(status);
  return err as AppError;
}

/** A user with an active profile whose latest version is v1. */
async function author(): Promise<Author> {
  const userId = await createUser('Ada Lovelace');
  const profileId = await choose(userId, def.definitionId);
  const versionId = await insertVersion({
    profileId,
    body: sampleBody(randomUUID()),
    definitionVersionId: def.versionId,
    promptVersionId: profilePromptId,
  });
  return { ctx: { userId, role: 'user' }, profileId, versionId };
}

async function activePromptId(key: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    'select active_version_id as id from prompt_template where key = $1',
    [key],
  );
  return rows[0]!.id;
}

async function row(id: string) {
  const [r] = await getDb().select().from(draft).where(eq(draft.id, id));
  return r;
}

/** Creates a draft and completes it the way the worker would. */
async function readyDraft(
  a: Author,
  opts: { contentType?: 'social_post' | 'bio' | 'short_article'; title?: string | null; body?: string } = {},
): Promise<string> {
  const { draftId } = await drafts.create(a.ctx, {
    contentType: opts.contentType ?? 'social_post',
    profileId: a.profileId,
    brief: 'Announce the spring workshop for new volunteers',
  });
  await drafts.completeDraft(draftId, {
    title: opts.title ?? null,
    body: opts.body ?? 'Generated body text',
    notes: null,
    truncated: false,
    redactionsApplied: 0,
  });
  return draftId;
}

const notificationsOf = (userId: string, type: 'draft_ready' | 'draft_failed') =>
  getDb()
    .select()
    .from(notification)
    .where(and(eq(notification.userId, userId), eq(notification.type, type)));

beforeAll(async () => {
  await getPool().query('select 1');
  def = await seedDefinition({ name: DEF_NAME });
  profilePromptId = await ensureActivePrompt('tone_profile.generate');
  for (const key of DRAFT_KEYS) await ensureActivePrompt(key);
});

beforeEach(() => {
  vi.mocked(enqueue).mockClear();
});

afterAll(async () => {
  await cleanupProfiles();
  await closeDb();
});

// ---------------------------------------------------------------------------------------------------------------------

describe('limits and surface', () => {
  it('exposes the contract limits and no publish operation (FR-056)', () => {
    expect(drafts.BRIEF_MAX).toBe(2000);
    expect(drafts.FEEDBACK_MAX).toBe(2000);
    expect(drafts.EDITED_TEXT_MAX).toBe(20000);
    expect(drafts.TOPIC_CHARS).toBe(120);
    expect(Object.keys(drafts)).not.toContain('publish');
    expect(Object.keys(drafts).filter((k) => /publish/i.test(k))).toEqual([]);
  });
});

describe('create', () => {
  it('refuses with 409 no_profile when the user has no versioned profile', async () => {
    const userId = await createUser();
    const ctx: ServiceContext = { userId, role: 'user' };
    await expectCode(drafts.create(ctx, { contentType: 'bio', profileId: randomUUID(), brief: 'hello' }), 'no_profile', 409);

    // A chosen profile without any version is not enough either.
    const profileId = await choose(userId, def.definitionId);
    await expectCode(drafts.create(ctx, { contentType: 'bio', profileId, brief: 'hello' }), 'no_profile', 409);
    expect(await getDb().select().from(draft).where(eq(draft.userId, userId))).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses another user's profile id with no_profile", async () => {
    const owner = await author();
    const other = await author();
    await expectCode(
      drafts.create(other.ctx, { contentType: 'social_post', profileId: owner.profileId, brief: 'hello' }),
      'no_profile',
    );
  });

  it('pins the latest profile version and the active prompt, encrypts brief/topic and enqueues draft-{id}', async () => {
    const a = await author();
    const brief = `  ${'Spring workshop for volunteers '.repeat(8)}  `;
    const { draftId } = await drafts.create(a.ctx, { contentType: 'short_article', profileId: a.profileId, brief });

    const r = await row(draftId);
    expect(r).toMatchObject({
      userId: a.ctx.userId,
      contentType: 'short_article',
      profileId: a.profileId,
      profileVersionId: a.versionId,
      promptVersionId: await activePromptId('draft.short_article'),
      parentDraftId: null,
      status: 'queued',
      rating: null,
      feedbackEnc: null,
      generatedTextEnc: null,
    });
    expect(r!.briefEnc).not.toContain('Spring workshop');
    expect(decrypt('user-content', r!.briefEnc)).toBe(brief);
    expect(r!.topicEnc).not.toContain('Spring workshop');
    expect(decrypt('user-content', r!.topicEnc)).toBe(brief.trim().slice(0, 120));
    expect(enqueue).toHaveBeenCalledWith(
      'draft.generate',
      { userId: a.ctx.userId, draftId },
      { jobId: `draft-${draftId}` },
    );
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['too long', 'x'.repeat(2001)],
  ])('rejects a %s brief with validation_failed', async (_label, brief) => {
    const a = await author();
    await expectCode(drafts.create(a.ctx, { contentType: 'bio', profileId: a.profileId, brief }), 'validation_failed');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('accepts a 2000-character brief', async () => {
    const a = await author();
    await expect(
      drafts.create(a.ctx, { contentType: 'bio', profileId: a.profileId, brief: 'y'.repeat(2000) }),
    ).resolves.toEqual({ draftId: expect.any(String) });
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('list', () => {
  it('lists newest first with profile, version number, filters and a keyset cursor', async () => {
    const a = await author();
    const ids: string[] = [];
    for (const contentType of ['social_post', 'bio', 'short_article'] as const) {
      ids.push((await drafts.create(a.ctx, { contentType, profileId: a.profileId, brief: `Brief for ${contentType}` })).draftId);
    }

    const all = await drafts.list(a.ctx, { limit: 50 });
    expect(all.items.map((i) => i.id)).toEqual([...ids].reverse());
    expect(all.nextCursor).toBeNull();
    expect(all.items[0]).toEqual({
      id: ids[2],
      contentType: 'short_article',
      topic: 'Brief for short_article',
      profile: { id: a.profileId, definitionName: DEF_NAME },
      profileVersionNumber: 1,
      status: 'queued',
      rating: null,
      createdAt: expect.any(String),
    });
    expect(new Date(all.items[0]!.createdAt).toISOString()).toBe(all.items[0]!.createdAt);

    const bios = await drafts.list(a.ctx, { contentType: 'bio', limit: 50 });
    expect(bios.items.map((i) => i.id)).toEqual([ids[1]]);
    expect((await drafts.list(a.ctx, { profileId: a.profileId, limit: 50 })).items).toHaveLength(3);
    expect((await drafts.list(a.ctx, { profileId: randomUUID(), limit: 50 })).items).toEqual([]);

    const page1 = await drafts.list(a.ctx, { limit: 2 });
    expect(page1.items.map((i) => i.id)).toEqual([ids[2], ids[1]]);
    expect(page1.nextCursor).toEqual(expect.any(String));
    const page2 = await drafts.list(a.ctx, { limit: 2, cursor: page1.nextCursor! });
    expect(page2.items.map((i) => i.id)).toEqual([ids[0]]);
    expect(page2.nextCursor).toBeNull();

    await expectCode(drafts.list(a.ctx, { limit: 2, cursor: 'garbage!' }), 'validation_failed');
  });

  it("never lists another user's drafts", async () => {
    const a = await author();
    const b = await author();
    await drafts.create(a.ctx, { contentType: 'bio', profileId: a.profileId, brief: 'mine' });
    expect((await drafts.list(b.ctx, { limit: 50 })).items).toEqual([]);
  });

  it('keeps drafts when their profile is deleted and shows profile null (D-D1)', async () => {
    const a = await author();
    const id = await readyDraft(a);
    await profiles.remove(a.ctx, a.profileId);

    expect(await row(id)).toBeDefined();
    const listed = await drafts.list(a.ctx, { limit: 50 });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]).toMatchObject({ id, profile: null, profileVersionNumber: null });
    const view = await drafts.get(a.ctx, id);
    expect(view).toMatchObject({ profile: null, profileVersionNumber: null, text: 'Generated body text' });

    // Regenerating it has no profile to pin.
    await expectCode(drafts.regenerate(a.ctx, id), 'no_profile', 409);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('get, edit, rate', () => {
  it('get returns the decrypted view; text = edited ?? generated', async () => {
    const a = await author();
    const id = await readyDraft(a, { contentType: 'short_article', title: 'Workshop', body: 'Generated body text' });

    const view = await drafts.get(a.ctx, id);
    expect(view).toMatchObject({
      id,
      contentType: 'short_article',
      status: 'ready',
      brief: 'Announce the spring workshop for new volunteers',
      title: 'Workshop',
      text: 'Generated body text',
      generatedText: 'Generated body text',
      editedText: null,
      feedback: null,
      notes: null,
      truncated: false,
      redactionsApplied: 0,
      errorCode: null,
      profileVersionId: a.versionId,
      promptVersionId: await activePromptId('draft.short_article'),
      parentDraftId: null,
      profile: { id: a.profileId, definitionName: DEF_NAME },
      profileVersionNumber: 1,
    });
    expect(view.completedAt).toEqual(expect.any(String));

    const edited = await drafts.edit(a.ctx, id, 'My own edit');
    expect(edited).toMatchObject({ text: 'My own edit', editedText: 'My own edit', generatedText: 'Generated body text' });
    const r = await row(id);
    expect(r!.editedTextEnc).not.toContain('My own edit');
    expect(decrypt('user-content', r!.editedTextEnc!)).toBe('My own edit');
    expect((await drafts.get(a.ctx, id)).text).toBe('My own edit');
  });

  it('edit is only allowed on a ready draft and is length-limited', async () => {
    const a = await author();
    const { draftId } = await drafts.create(a.ctx, { contentType: 'bio', profileId: a.profileId, brief: 'b' });
    await expectCode(drafts.edit(a.ctx, draftId, 'too early'), 'conflict');
    const ready = await readyDraft(a);
    await expectCode(drafts.edit(a.ctx, ready, 'z'.repeat(20001)), 'validation_failed');
  });

  it('rate is only allowed on a ready draft and sets rated_at', async () => {
    const a = await author();
    const { draftId } = await drafts.create(a.ctx, { contentType: 'bio', profileId: a.profileId, brief: 'b' });
    await expectCode(drafts.rate(a.ctx, draftId, 'sounds_like_me'), 'conflict');

    const ready = await readyDraft(a);
    const view = await drafts.rate(a.ctx, ready, 'sounds_like_me');
    expect(view.rating).toBe('sounds_like_me');
    const r = await row(ready);
    expect(r!.rating).toBe('sounds_like_me');
    expect(r!.ratedAt).toBeInstanceOf(Date);

    expect((await drafts.rate(a.ctx, ready, 'not_like_me')).rating).toBe('not_like_me');
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('regenerate (FR-053, FR-058, D-D2)', () => {
  it('creates a new row with parent and feedback, pinning the current profile version and prompt', async () => {
    const a = await author();
    const parentId = await readyDraft(a);
    const v2 = await insertVersion({
      profileId: a.profileId,
      body: sampleBody(randomUUID(), ' Newer.'),
      definitionVersionId: def.versionId,
      promptVersionId: profilePromptId,
    });
    const parentBefore = await row(parentId);
    vi.mocked(enqueue).mockClear();

    const { draftId } = await drafts.regenerate(a.ctx, parentId, 'Shorter please');

    expect(draftId).not.toBe(parentId);
    const child = await row(draftId);
    expect(child).toMatchObject({
      userId: a.ctx.userId,
      contentType: 'social_post',
      parentDraftId: parentId,
      profileId: a.profileId,
      profileVersionId: v2,
      promptVersionId: await activePromptId('draft.social_post'),
      status: 'queued',
    });
    expect(child!.feedbackEnc).not.toContain('Shorter');
    expect(decrypt('user-content', child!.feedbackEnc!)).toBe('Shorter please');
    expect(decrypt('user-content', child!.briefEnc)).toBe('Announce the spring workshop for new volunteers');
    expect(enqueue).toHaveBeenCalledWith('draft.generate', { userId: a.ctx.userId, draftId }, { jobId: `draft-${draftId}` });

    // The parent is untouched.
    expect(await row(parentId)).toEqual(parentBefore);
    expect((await drafts.get(a.ctx, draftId)).feedback).toBe('Shorter please');
  });

  it('allows no feedback and rejects feedback over 2000 characters', async () => {
    const a = await author();
    const parentId = await readyDraft(a);
    const { draftId } = await drafts.regenerate(a.ctx, parentId);
    expect((await row(draftId))!.feedbackEnc).toBeNull();
    await expectCode(drafts.regenerate(a.ctx, parentId, 'f'.repeat(2001)), 'validation_failed');
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('exportDraft', () => {
  it('md with a title, txt with a title line, using the edited text when present', async () => {
    const a = await author();
    const id = await readyDraft(a, { contentType: 'short_article', title: 'My Title', body: 'Body text' });

    const md = await drafts.exportDraft(a.ctx, id, 'md');
    expect(md.body).toBe('# My Title\n\nBody text\n');
    expect(md.contentType).toMatch(/^text\/markdown/);
    expect(md.filename).toMatch(/^draft-\d{4}-\d{2}-\d{2}-short_article\.md$/);

    const txt = await drafts.exportDraft(a.ctx, id, 'txt');
    expect(txt.body).toMatch(/^My Title\n\nBody text\n?$/);
    expect(txt.contentType).toMatch(/^text\/plain/);
    expect(txt.filename).toMatch(/^draft-\d{4}-\d{2}-\d{2}-short_article\.txt$/);

    await drafts.edit(a.ctx, id, 'Edited body');
    expect((await drafts.exportDraft(a.ctx, id, 'md')).body).toBe('# My Title\n\nEdited body\n');
  });

  it('md without a title is the body only', async () => {
    const a = await author();
    const id = await readyDraft(a, { contentType: 'social_post', body: 'Just the post' });
    const md = await drafts.exportDraft(a.ctx, id, 'md');
    expect(md.body).toMatch(/^Just the post\n?$/);
    expect(md.filename).toMatch(/^draft-\d{4}-\d{2}-\d{2}-social_post\.md$/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('remove (FR-055)', () => {
  it('hard-deletes, keeps a child with parent_draft_id null and audits draft.deleted', async () => {
    const a = await author();
    const parentId = await readyDraft(a, { contentType: 'bio' });
    const { draftId: childId } = await drafts.regenerate(a.ctx, parentId, 'again');

    await drafts.remove(a.ctx, parentId);

    expect(await row(parentId)).toBeUndefined();
    expect((await row(childId))!.parentDraftId).toBeNull();
    const audits = await getDb()
      .select()
      .from(auditLogEntry)
      .where(and(eq(auditLogEntry.action, 'draft.deleted'), eq(auditLogEntry.targetId, parentId)));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actorType: 'user', actorUserId: a.ctx.userId, targetType: 'draft' });
    expect(audits[0]!.metadata).toEqual({ contentType: 'bio' });
    await expectCode(drafts.get(a.ctx, parentId), 'not_found');
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('cross-user access (constitution III/VI)', () => {
  it('every by-id operation on a foreign, unknown or malformed id is not_found and changes nothing', async () => {
    const owner = await author();
    const other = await author();
    const id = await readyDraft(owner);
    const before = await row(id);

    for (const target of [id, randomUUID(), 'not-a-uuid']) {
      await expectCode(drafts.get(other.ctx, target), 'not_found');
      await expectCode(drafts.edit(other.ctx, target, 'x'), 'not_found');
      await expectCode(drafts.regenerate(other.ctx, target, 'x'), 'not_found');
      await expectCode(drafts.rate(other.ctx, target, 'not_like_me'), 'not_found');
      await expectCode(drafts.exportDraft(other.ctx, target, 'md'), 'not_found');
      await expectCode(drafts.remove(other.ctx, target), 'not_found');
    }
    expect(await row(id)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Worker-facing seams (T152). Constitution I: every LLM input of a draft (brief, profile, feedback, previous draft) is
// handed to the processor decrypted so it can be inspect()ed under the user's CURRENT policy; nothing here calls an
// LLM. The processor-level assertions (excluded brief/profile -> no LLM call, memory snippets) are in
// apps/worker/test/draft-generate.integration.test.ts.

describe('worker-facing seams', () => {
  it('loadDraftForRun + decryptDraftInputs expose brief, feedback, previous draft and the pinned profile body', async () => {
    const a = await author();
    const parentId = await readyDraft(a, { body: 'Parent generated' });
    await drafts.edit(a.ctx, parentId, 'Parent edited');
    const { draftId } = await drafts.regenerate(a.ctx, parentId, 'Make it warmer');

    const run = await drafts.loadDraftForRun(draftId);
    expect(run).not.toBeNull();
    expect(run!.draft.id).toBe(draftId);
    expect(run!.user).toEqual({ name: 'Ada Lovelace', status: 'active' });
    expect(run!.profileVersion?.id).toBe(a.versionId);
    expect(run!.definitionName).toBe(DEF_NAME);
    expect(run!.promptVersion.id).toBe(run!.draft.promptVersionId);
    expect(run!.parent?.id).toBe(parentId);

    const inputs = drafts.decryptDraftInputs(run!);
    expect(inputs.brief).toBe('Announce the spring workshop for new volunteers');
    expect(inputs.feedback).toBe('Make it warmer');
    // The parent's edited text wins over its generated text.
    expect(inputs.previousDraft).toBe('Parent edited');
    expect(inputs.profileBody?.summary).toBe(sampleBody('x').summary);
    expect(inputs.profileBody?.dimensions.map((d) => d.key)).toEqual(['formality', 'energy', 'signature', 'phrases']);
  });

  it('previousDraft falls back to the generated text; a first draft has no feedback or previous draft', async () => {
    const a = await author();
    const parentId = await readyDraft(a, { body: 'Parent generated' });
    const { draftId } = await drafts.regenerate(a.ctx, parentId);
    expect(drafts.decryptDraftInputs((await drafts.loadDraftForRun(draftId))!).previousDraft).toBe('Parent generated');

    const first = drafts.decryptDraftInputs((await drafts.loadDraftForRun(parentId))!);
    expect(first.feedback).toBeNull();
    expect(first.previousDraft).toBeNull();
  });

  it('reports a vanished pinned profile version as null and an unknown draft as null', async () => {
    const a = await author();
    const { draftId } = await drafts.create(a.ctx, { contentType: 'bio', profileId: a.profileId, brief: 'b' });
    await profiles.remove(a.ctx, a.profileId);
    const run = await drafts.loadDraftForRun(draftId);
    expect(run).not.toBeNull();
    expect(run!.profileVersion).toBeNull();
    expect(drafts.decryptDraftInputs(run!).profileBody).toBeNull();
    expect(await drafts.loadDraftForRun(randomUUID())).toBeNull();
  });

  it('markGenerating moves queued -> generating and refuses finished drafts', async () => {
    const a = await author();
    const { draftId } = await drafts.create(a.ctx, { contentType: 'bio', profileId: a.profileId, brief: 'b' });
    expect(await drafts.markGenerating(draftId)).toBe(true);
    expect((await row(draftId))!.status).toBe('generating');
    expect(await drafts.markGenerating(draftId)).toBe(true);
    const ready = await readyDraft(a);
    expect(await drafts.markGenerating(ready)).toBe(false);
  });

  it('completeDraft encrypts the output, sets ready + completed_at and notifies draft_ready', async () => {
    const a = await author();
    const { draftId } = await drafts.create(a.ctx, { contentType: 'short_article', profileId: a.profileId, brief: 'b' });
    await drafts.completeDraft(draftId, {
      title: 'Title here',
      body: 'Body with [REDACTED: password]',
      notes: 'Kept it short',
      truncated: true,
      redactionsApplied: 2,
    });

    const r = await row(draftId);
    expect(r).toMatchObject({ status: 'ready', truncated: true, redactionsApplied: 2, errorCode: null });
    expect(r!.completedAt).toBeInstanceOf(Date);
    expect(r!.generatedTextEnc).not.toContain('Body with');
    expect(decrypt('user-content', r!.titleEnc!)).toBe('Title here');
    expect(decrypt('user-content', r!.notesEnc!)).toBe('Kept it short');
    const view = await drafts.get(a.ctx, draftId);
    expect(view).toMatchObject({ notes: 'Kept it short', truncated: true, redactionsApplied: 2 });

    const notes = await notificationsOf(a.ctx.userId, 'draft_ready');
    expect(notes.map((n) => n.payload)).toEqual([{ draftId }]);
  });

  it.each(['brief_excluded', 'profile_excluded'])(
    'failDraft(%s) stores failed with the code, keeps no output and notifies draft_failed',
    async (code) => {
      const a = await author();
      const { draftId } = await drafts.create(a.ctx, { contentType: 'bio', profileId: a.profileId, brief: 'b' });
      await drafts.markGenerating(draftId);

      await drafts.failDraft(draftId, code, { notify: true });

      const r = await row(draftId);
      expect(r).toMatchObject({ status: 'failed', errorCode: code, generatedTextEnc: null, titleEnc: null });
      const notes = await notificationsOf(a.ctx.userId, 'draft_failed');
      expect(notes.map((n) => n.payload)).toEqual([{ draftId }]);
      expect((await drafts.get(a.ctx, draftId)).errorCode).toBe(code);
    },
  );

  it('failDraft without notify (user_inactive) writes no notification', async () => {
    const a = await author();
    const { draftId } = await drafts.create(a.ctx, { contentType: 'bio', profileId: a.profileId, brief: 'b' });
    await getDb().update(user).set({ status: 'pending_deletion' }).where(eq(user.id, a.ctx.userId));
    expect((await drafts.loadDraftForRun(draftId))!.user.status).toBe('pending_deletion');

    await drafts.failDraft(draftId, 'user_inactive', { notify: false });

    expect((await row(draftId))).toMatchObject({ status: 'failed', errorCode: 'user_inactive' });
    expect(await notificationsOf(a.ctx.userId, 'draft_failed')).toHaveLength(0);
  });
});
