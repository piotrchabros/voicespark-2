import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getPool } from '@voicespark/db';
import { decrypt } from '@voicespark/core/crypto';
import { AppError, type ServiceContext } from '@voicespark/core/errors';
import { enqueue } from '@voicespark/core/queues';
import { getSetting } from '@voicespark/core/services/settings';
import * as profiles from '@voicespark/core/services/profiles';
import {
  addKeywordRule,
  choose,
  cleanupProfiles,
  confirmPreferences,
  createUser,
  ensureActivePrompt,
  insertVersion,
  MIN_WORDS,
  prose,
  publishPromptVersion,
  sampleBody,
  sampleDocument,
  seedAuthoredContent,
  seedDefinition,
  seedOwnPrompt,
  setAvailability,
  setMinWords,
  withSoleAvailableDefinition,
  withStableDefinitions,
  type SeededDefinition,
} from './helpers/profiles';

// US5 profiles service (T119; FR-028, FR-029, FR-031-FR-033, FR-035, FR-065-FR-067, FR-069).
// Queues are mocked (no Redis needed); enqueue calls are captured.
vi.mock('@voicespark/core/queues', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@voicespark/core/queues')>()),
  enqueue: vi.fn(async () => ({})),
  upsertScheduler: vi.fn(async () => undefined),
  removeScheduler: vi.fn(async () => undefined),
}));
// Lets a test make every inspection incomplete (classifier failure -> whole-item `inspection_failed`).
const inspection = vi.hoisted(() => ({ fail: false }));
vi.mock('@voicespark/core/services/inspection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@voicespark/core/services/inspection')>();
  return {
    ...actual,
    inspectForUser: vi.fn(async (...args: Parameters<typeof actual.inspectForUser>) =>
      inspection.fail
        ? {
            outcome: 'excluded' as const,
            counts: [
              { category: 'inspection_failed' as const, redactedValues: 0, wholeItem: true },
            ],
          }
        : actual.inspectForUser(...args),
    ),
  };
});

process.env.DATABASE_URL ??= 'postgres://voicespark:voicespark@localhost:55432/voicespark_test';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-00';
process.env.ENCRYPTION_KEYRING ??= JSON.stringify({ k1: Buffer.alloc(32, 1).toString('base64') });
process.env.ENCRYPTION_ACTIVE_KEY_ID ??= 'k1';
process.env.DEDUP_HMAC_KEY ??= Buffer.alloc(32, 2).toString('base64');
process.env.REDIS_URL ??= 'redis://localhost:56379';
process.env.NODE_ENV ??= 'test';

const API_KEY = 'ghp_aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5';
const PASSWORD = 'Hunter2xyz!';

/** Tests whose definitions must stay `available` while they run (see withSoleAvailableDefinition). */
const itStable = (name: string, fn: () => Promise<void>) =>
  it(name, () => withStableDefinitions(fn), 30_000);

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

interface Fixture {
  ctx: ServiceContext;
  sourceId: string;
  itemIds: string[];
  profileIds: string[];
}

/** A confirmed user with `words` authored words (one item) and one received item, choosing `defs`. */
async function userWith(defs: SeededDefinition[], words = MIN_WORDS + 10): Promise<Fixture> {
  const userId = await createUser();
  await confirmPreferences(userId);
  const { sourceId, itemIds } = await seedAuthoredContent({
    userId,
    items: [
      { text: prose(words), authorship: 'authored' },
      { text: prose(500, 'received'), authorship: 'received' },
    ],
  });
  const profileIds: string[] = [];
  for (const d of defs) profileIds.push(await choose(userId, d.definitionId));
  return { ctx: { userId, role: 'user' }, sourceId, itemIds, profileIds };
}

/** A fixture whose (single) profile already has a generated latest version. */
async function userWithVersion(def: SeededDefinition, body?: ReturnType<typeof sampleBody>) {
  const f = await userWith([def]);
  const promptVersionId = await ensureActivePrompt('tone_profile.generate');
  const versionId = await insertVersion({
    profileId: f.profileIds[0]!,
    body: body ?? sampleBody(f.itemIds[0]!),
    definitionVersionId: def.versionId,
    promptVersionId,
    sourceIds: [f.sourceId],
    authoredWords: MIN_WORDS + 10,
  });
  return { ...f, profileId: f.profileIds[0]!, versionId };
}

const generationsOf = async (userId: string) =>
  (
    await getPool().query<{
      id: string;
      profile_id: string;
      kind: string;
      status: string;
      definition_version_id: string;
      prompt_version_id: string;
      own_prompt_version_id: string | null;
      feedback_enc: string | null;
    }>(
      `select id, profile_id, kind, status, definition_version_id, prompt_version_id, own_prompt_version_id,
              feedback_enc
       from profile_generation where user_id = $1 order by requested_at, id`,
      [userId],
    )
  ).rows;

const versionsOf = async (profileId: string) =>
  (
    await getPool().query<{
      id: string;
      version_number: number;
      origin: string;
      prompt_version_id: string | null;
    }>(
      'select id, version_number, origin, prompt_version_id from profile_version where profile_id = $1 order by version_number',
      [profileId],
    )
  ).rows;

const notificationsOf = async (userId: string, type: string) =>
  (
    await getPool().query<{ payload: Record<string, unknown> }>(
      'select payload from notification where user_id = $1 and type = $2',
      [userId, type],
    )
  ).rows;

beforeAll(async () => {
  await getPool().query('select 1');
  await setMinWords(MIN_WORDS);
  await ensureActivePrompt('tone_profile.generate');
  await ensureActivePrompt('tone_profile.feedback');
});

beforeEach(() => {
  vi.mocked(enqueue).mockClear();
  inspection.fail = false;
});

afterAll(async () => {
  await cleanupProfiles();
  await closeDb();
});

describe('profiles.eligibility', () => {
  it('sums active authored items only against profile.min_authored_words', async () => {
    const userId = await createUser();
    const { sourceId, itemIds } = await seedAuthoredContent({
      userId,
      items: [
        { text: prose(30), authorship: 'authored' },
        { text: prose(25), authorship: 'authored' },
        { text: prose(900, 'received'), authorship: 'received' },
        { text: prose(900, 'deleting'), authorship: 'authored' },
      ],
    });
    await getPool().query(`update content_item set status = 'pending_deletion' where id = $1`, [
      itemIds[3],
    ]);
    expect(sourceId).toBeTruthy();

    expect(await profiles.eligibility({ userId })).toEqual({
      authoredWordCount: 55,
      authoredItemCount: 2,
      thresholdWords: MIN_WORDS,
      eligible: true,
    });

    const poor = await createUser();
    await seedAuthoredContent({ userId: poor, items: [{ text: prose(MIN_WORDS - 1) }] });
    expect(await profiles.eligibility({ userId: poor })).toMatchObject({
      authoredWordCount: MIN_WORDS - 1,
      eligible: false,
    });
  });
});

describe('profiles.generate', () => {
  itStable(
    'refuses below the threshold with 422 insufficient_content and creates nothing',
    async () => {
      const def = await seedDefinition();
      const f = await userWith([def], MIN_WORDS - 5);
      await expectCode(profiles.generate(f.ctx), 'insufficient_content', 422);
      expect(await generationsOf(f.ctx.userId)).toEqual([]);
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  itStable('refuses a retired definition with 409 definition_retired', async () => {
    const def = await seedDefinition();
    const f = await userWith([def]);
    await setAvailability(def.definitionId, 'retired');
    await expectCode(profiles.generate(f.ctx), 'definition_retired', 409);
    expect(await generationsOf(f.ctx.userId)).toEqual([]);
  });

  itStable('rejects profile ids that are not among the caller active profiles', async () => {
    const def = await seedDefinition();
    const f = await userWith([def]);
    const other = await userWith([def]);
    await expectCode(profiles.generate(f.ctx, [randomUUID()]), 'not_found');
    await expectCode(profiles.generate(f.ctx, [other.profileIds[0]!]), 'not_found');
  });

  itStable(
    'creates one generation per profile pinned to the current (uncached) active versions',
    async () => {
      const a = await seedDefinition();
      const b = await seedDefinition();
      const f = await userWith([a, b]);

      // Prime any cache, then move both active pointers by direct SQL: the next generation must use the new ids.
      await profiles.eligibility(f.ctx);
      const promptVersionId = await publishPromptVersion('tone_profile.generate');
      await getPool().query(
        `update tone_definition_version set status = 'superseded' where id = $1`,
        [b.versionId],
      );
      const { rows } = await getPool().query<{ id: string }>(
        `insert into tone_definition_version (definition_id, version_number, status, name, description, dimensions, created_by)
       select definition_id, 2, 'active', name, description, dimensions, created_by from tone_definition_version where id = $1
       returning id`,
        [b.versionId],
      );
      await getPool().query('update tone_definition set active_version_id = $2 where id = $1', [
        b.definitionId,
        rows[0]!.id,
      ]);

      const result = await profiles.generate(f.ctx);
      expect(result.generations).toHaveLength(2);
      expect(result.generations.map((g) => g.profileId).sort()).toEqual([...f.profileIds].sort());

      const gens = await generationsOf(f.ctx.userId);
      expect(gens).toHaveLength(2);
      for (const g of gens) {
        expect(g.kind).toBe('generate');
        expect(g.status).toBe('queued');
        expect(g.prompt_version_id).toBe(promptVersionId);
      }
      const byProfile = new Map(gens.map((g) => [g.profile_id, g]));
      expect(byProfile.get(f.profileIds[0]!)?.definition_version_id).toBe(a.versionId);
      expect(byProfile.get(f.profileIds[1]!)?.definition_version_id).toBe(rows[0]!.id);

      for (const g of result.generations) {
        expect(enqueue).toHaveBeenCalledWith(
          'profile.generate',
          { userId: f.ctx.userId, generationId: g.id },
          { jobId: `profile-${g.id}` },
        );
      }
    },
  );

  itStable('returns the queued generation instead of creating a second one', async () => {
    const def = await seedDefinition();
    const f = await userWith([def]);
    const first = await profiles.generate(f.ctx);
    const second = await profiles.generate(f.ctx, [f.profileIds[0]!]);
    expect(second.generations).toEqual(first.generations);
    expect(await generationsOf(f.ctx.userId)).toHaveLength(1);
  });
});

describe('profiles.regenerate and feedback', () => {
  itStable('regenerate creates a regenerate generation', async () => {
    const def = await seedDefinition();
    const f = await userWithVersion(def);
    const { generationId } = await profiles.regenerate(f.ctx, f.profileId);
    const [g] = await generationsOf(f.ctx.userId);
    expect(g).toMatchObject({ id: generationId, kind: 'regenerate', status: 'queued' });
    expect(enqueue).toHaveBeenCalledWith(
      'profile.generate',
      { userId: f.ctx.userId, generationId },
      { jobId: `profile-${generationId}` },
    );
  });

  itStable(
    'feedback stores the text encrypted and pins the tone_profile.feedback prompt',
    async () => {
      const def = await seedDefinition();
      const f = await userWithVersion(def);
      const feedbackPrompt = await ensureActivePrompt('tone_profile.feedback');
      const text = 'Please make the tone warmer and less formal.';

      const { generationId } = await profiles.feedback(f.ctx, f.profileId, text);
      const [g] = await generationsOf(f.ctx.userId);
      expect(g).toMatchObject({
        id: generationId,
        kind: 'feedback',
        prompt_version_id: feedbackPrompt,
      });
      expect(g!.feedback_enc).toBeTruthy();
      expect(g!.feedback_enc).not.toContain('warmer');
      expect(decrypt('user-content', g!.feedback_enc!)).toBe(text);
    },
  );

  itStable('feedback validates length and needs a latest version', async () => {
    const def = await seedDefinition();
    const f = await userWithVersion(def);
    await expectCode(profiles.feedback(f.ctx, f.profileId, ''), 'validation_failed');
    await expectCode(profiles.feedback(f.ctx, f.profileId, 'x'.repeat(2001)), 'validation_failed');

    const fresh = await userWith([def]);
    await expectCode(
      profiles.feedback(fresh.ctx, fresh.profileIds[0]!, 'warmer please'),
      'conflict',
    );
  });
});

describe('profiles.adjust', () => {
  itStable(
    'stores a manual_edit version with the adjusted values and no prompt version',
    async () => {
      const def = await seedDefinition();
      const f = await userWithVersion(def);

      const { version } = await profiles.adjust(f.ctx, f.profileId, {
        dimensions: {
          formality: 4,
          signature: 'Opens with a question.',
          phrases: ['cheers', 'talk soon'],
        },
        note: 'More formal at work.',
      });

      expect(version.origin).toBe('manual_edit');
      expect(version.versionNumber).toBe(2);
      expect(version.promptVersion).toBeNull();
      expect(version.definitionVersion.id).toBe(def.versionId);
      expect(version.format).toBe('structured');
      if (version.format !== 'structured') return;
      const dims = new Map(version.body.dimensions.map((d) => [d.key, d]));
      expect(dims.get('formality')).toMatchObject({ value: 4, explanation: 'Mostly casual.' });
      expect(dims.get('signature')?.value).toBe('Opens with a question.');
      expect(dims.get('phrases')?.value).toEqual(['cheers', 'talk soon']);
      expect(dims.get('energy')?.value).toBe('lively');

      const rows = await versionsOf(f.profileId);
      expect(rows.map((r) => [r.origin, r.prompt_version_id])).toEqual([
        ['generated', expect.any(String)],
        ['manual_edit', null],
      ]);
      const latest = await getPool().query(
        'select latest_version_id from tone_profile where id = $1',
        [f.profileId],
      );
      expect(latest.rows[0].latest_version_id).toBe(version.id);
    },
  );

  itStable(
    'refuses sensitive text, list and note values with 422 sensitive_content and stores nothing',
    async () => {
      const def = await seedDefinition();
      const f = await userWithVersion(def);

      const textErr = await expectCode(
        profiles.adjust(f.ctx, f.profileId, {
          dimensions: { signature: `deploy with api_key = ${API_KEY} today` },
        }),
        'sensitive_content',
        422,
      );
      // Field names only, never the value.
      expect(JSON.stringify({ message: textErr.message, details: textErr.details })).not.toContain(
        API_KEY,
      );
      expect(JSON.stringify(textErr.details)).toContain('signature');

      await expectCode(
        profiles.adjust(f.ctx, f.profileId, {
          dimensions: { phrases: ['cheers', `login password: ${PASSWORD}`] },
        }),
        'sensitive_content',
        422,
      );
      await expectCode(
        profiles.adjust(f.ctx, f.profileId, {
          dimensions: { formality: 3 },
          note: 'Reset your password here: https://app.service.test/reset/password?token=aB3dE9fG7hJ2kL5mN8pQ and enter verification code 482913.',
        }),
        'sensitive_content',
        422,
      );

      expect(await versionsOf(f.profileId)).toHaveLength(1);
    },
  );

  itStable(
    "inspects with the user's current preferences (a rule added later applies)",
    async () => {
      const def = await seedDefinition();
      const f = await userWithVersion(def);
      await addKeywordRule(f.ctx.userId, 'zanzibar');
      await expectCode(
        profiles.adjust(f.ctx, f.profileId, {
          dimensions: { signature: 'Mentions the Zanzibar trip a lot.' },
        }),
        'sensitive_content',
        422,
      );
      expect(await versionsOf(f.profileId)).toHaveLength(1);
    },
  );

  itStable('validates values against the dimension specs', async () => {
    const def = await seedDefinition();
    const f = await userWithVersion(def);
    await expectCode(
      profiles.adjust(f.ctx, f.profileId, { dimensions: { formality: 9 } }),
      'validation_failed',
      422,
    );
    await expectCode(
      profiles.adjust(f.ctx, f.profileId, { dimensions: { formality: 'high' } }),
      'validation_failed',
    );
    await expectCode(
      profiles.adjust(f.ctx, f.profileId, { dimensions: { energy: 'furious' } }),
      'validation_failed',
    );
    await expectCode(
      profiles.adjust(f.ctx, f.profileId, { dimensions: { unknown_key: 'x' } }),
      'validation_failed',
    );
    await expectCode(
      profiles.adjust(f.ctx, f.profileId, { dimensions: { signature: 'x'.repeat(601) } }),
      'validation_failed',
    );
    expect(await versionsOf(f.profileId)).toHaveLength(1);
  });

  itStable('needs a latest version', async () => {
    const def = await seedDefinition();
    const f = await userWith([def]);
    await expectCode(
      profiles.adjust(f.ctx, f.profileIds[0]!, { dimensions: { formality: 3 } }),
      'conflict',
    );
  });
});

describe('profiles read, rate and remove', () => {
  itStable('rates an own version; foreign profiles and versions are not_found', async () => {
    const def = await seedDefinition();
    const f = await userWithVersion(def);
    const other = await userWithVersion(def);

    const { profileVersion } = await profiles.rate(
      f.ctx,
      f.profileId,
      f.versionId,
      'sounds_like_me',
    );
    expect(profileVersion).toMatchObject({
      id: f.versionId,
      versionNumber: 1,
      rating: 'sounds_like_me',
    });
    expect(profileVersion.ratedAt).toBeTruthy();

    await expectCode(
      profiles.rate(other.ctx, f.profileId, f.versionId, 'not_like_me'),
      'not_found',
    );
    await expectCode(
      profiles.rate(f.ctx, f.profileId, other.versionId, 'not_like_me'),
      'not_found',
    );
    await expectCode(profiles.version(other.ctx, f.profileId, f.versionId), 'not_found');
    await expectCode(profiles.get(other.ctx, f.profileId), 'not_found');
  });

  itStable('get, versions and list show the decrypted latest version', async () => {
    const def = await seedDefinition();
    const f = await userWithVersion(def);
    const got = await profiles.get(f.ctx, f.profileId);
    expect(got.latestVersion?.id).toBe(f.versionId);
    expect(got.latestVersion?.body.summary).toBe('Short, direct and friendly.');
    expect(got.profile.canRegenerate).toBe(true);
    expect((await profiles.versions(f.ctx, f.profileId)).map((v) => v.id)).toEqual([f.versionId]);
    const list = await profiles.list(f.ctx);
    expect(list.map((p) => p.id)).toEqual([f.profileId]);
    expect(list[0]?.latestVersion?.id).toBe(f.versionId);
  });

  itStable(
    'remove deletes the profile, versions and generations and removes the choice',
    async () => {
      const def = await seedDefinition();
      const f = await userWithVersion(def);
      await profiles.regenerate(f.ctx, f.profileId);

      await profiles.remove(f.ctx, f.profileId);

      const pool = getPool();
      expect(
        (await pool.query('select id from tone_profile where id = $1', [f.profileId])).rowCount,
      ).toBe(0);
      expect(
        (await pool.query('select id from profile_version where profile_id = $1', [f.profileId]))
          .rowCount,
      ).toBe(0);
      expect((await generationsOf(f.ctx.userId)).length).toBe(0);
      const choice = await pool.query<{ removed_at: Date | null }>(
        'select removed_at from user_definition_choice where user_id = $1',
        [f.ctx.userId],
      );
      expect(choice.rows).toHaveLength(1);
      expect(choice.rows[0]!.removed_at).toBeInstanceOf(Date);
      await expectCode(profiles.get(f.ctx, f.profileId), 'not_found');
    },
  );
});

describe('profiles.recomputeOutdated', () => {
  itStable('marks sources_deleted once and notifies once', async () => {
    const def = await seedDefinition();
    const f = await userWithVersion(def);
    await getPool().query('delete from connected_source where id = $1', [f.sourceId]);

    expect((await profiles.recomputeOutdated(f.ctx.userId)).updated).toBe(1);
    const row = await getPool().query('select outdated_reason from tone_profile where id = $1', [
      f.profileId,
    ]);
    expect(row.rows[0].outdated_reason).toBe('sources_deleted');
    expect(await notificationsOf(f.ctx.userId, 'profile_outdated')).toEqual([
      { payload: { profileId: f.profileId, reason: 'sources_deleted' } },
    ]);

    expect((await profiles.recomputeOutdated(f.ctx.userId)).updated).toBe(0);
    expect(await notificationsOf(f.ctx.userId, 'profile_outdated')).toHaveLength(1);
  });

  itStable('marks significant_new_content when authored words grew beyond the ratio', async () => {
    const def = await seedDefinition();
    const f = await userWithVersion(def);
    const ratio = await getSetting('profile.significant_new_content_ratio');

    // Growth at exactly the ratio is not significant.
    const atLatest = MIN_WORDS + 10;
    await seedAuthoredContent({
      userId: f.ctx.userId,
      sourceId: f.sourceId,
      items: [{ text: 'a', words: Math.floor(atLatest * ratio) }],
    });
    expect((await profiles.recomputeOutdated(f.ctx.userId)).updated).toBe(0);

    await seedAuthoredContent({
      userId: f.ctx.userId,
      sourceId: f.sourceId,
      items: [{ text: 'b', words: 50 }],
    });
    expect((await profiles.recomputeOutdated(f.ctx.userId)).updated).toBe(1);
    const row = await getPool().query('select outdated_reason from tone_profile where id = $1', [
      f.profileId,
    ]);
    expect(row.rows[0].outdated_reason).toBe('significant_new_content');
    expect(await notificationsOf(f.ctx.userId, 'profile_outdated')).toEqual([
      { payload: { profileId: f.profileId, reason: 'significant_new_content' } },
    ]);
  });
});

describe('profiles.autoGenerateIfFirstEligible', () => {
  itStable('creates the first generation once; a second call is a no-op', async () => {
    const def = await seedDefinition();
    const f = await userWith([def]);
    const promptVersionId = await ensureActivePrompt('tone_profile.generate');

    const first = await profiles.autoGenerateIfFirstEligible(f.ctx.userId);
    expect(first.generations).toHaveLength(1);
    expect(first.generations[0]!.profileId).toBe(f.profileIds[0]);
    const [g] = await generationsOf(f.ctx.userId);
    expect(g).toMatchObject({
      kind: 'generate',
      definition_version_id: def.versionId,
      prompt_version_id: promptVersionId,
    });
    expect(enqueue).toHaveBeenCalledWith(
      'profile.generate',
      { userId: f.ctx.userId, generationId: g!.id },
      { jobId: `profile-${g!.id}` },
    );

    // Still a no-op once that generation finished without a version.
    await getPool().query(`update profile_generation set status = 'failed' where id = $1`, [g!.id]);
    expect((await profiles.autoGenerateIfFirstEligible(f.ctx.userId)).generations).toEqual([]);
    expect(await generationsOf(f.ctx.userId)).toHaveLength(1);
  });

  itStable('does nothing below the threshold', async () => {
    const def = await seedDefinition();
    const f = await userWith([def], MIN_WORDS - 5);
    expect((await profiles.autoGenerateIfFirstEligible(f.ctx.userId)).generations).toEqual([]);
    expect(await generationsOf(f.ctx.userId)).toEqual([]);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('auto-chooses the single available definition first', async () => {
    const only = await seedDefinition();
    const f = await userWith([]);
    await withSoleAvailableDefinition(only.definitionId, async () => {
      const result = await profiles.autoGenerateIfFirstEligible(f.ctx.userId);
      expect(result.generations).toHaveLength(1);
    });
    const choice = await getPool().query<{ definition_id: string }>(
      'select definition_id from user_definition_choice where user_id = $1 and removed_at is null',
      [f.ctx.userId],
    );
    expect(choice.rows.map((r) => r.definition_id)).toEqual([only.definitionId]);
    const [g] = await generationsOf(f.ctx.userId);
    expect(g?.definition_version_id).toBe(only.versionId);
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------------------------
// 002: generation pins, direct document edit, version view (T044)

/** A fixture whose (single) profile has a `document` latest version (aspects tempo, warmth; 2 excerpts). */
async function userWithDocument(
  def: SeededDefinition,
  opts: { own?: boolean } = {},
): Promise<Fixture & { profileId: string; versionId: string; ownVersionId: string | null }> {
  const f = await userWith([def]);
  const promptVersionId = await ensureActivePrompt('tone_profile.generate');
  const own = opts.own
    ? await seedOwnPrompt({
        userId: f.ctx.userId,
        definitionId: def.definitionId,
        text: '- Tempo: how fast it reads',
        basedOnDefinitionVersionId: def.versionId,
      })
    : null;
  const versionId = await insertVersion({
    profileId: f.profileIds[0]!,
    body: sampleDocument(f.itemIds[0]!),
    format: 'document',
    promptSource: own ? 'own' : 'default',
    ownPromptVersionId: own?.versionId ?? null,
    definitionVersionId: def.versionId,
    promptVersionId,
    sourceIds: [f.sourceId],
    authoredWords: MIN_WORDS + 10,
  });
  return { ...f, profileId: f.profileIds[0]!, versionId, ownVersionId: own?.versionId ?? null };
}

function editInput(baseVersionId: string) {
  return {
    baseVersionId,
    summary: 'Calm and clear.',
    sections: [
      { heading: 'Tempo', markdown: 'Slow and steady.' },
      { heading: 'Warmth', markdown: 'Warm greetings.' },
    ],
    doList: ['Be kind'],
    dontList: ['Rush'],
    keepExcerpts: [0],
  };
}

const versionRows = async (profileId: string) =>
  (
    await getPool().query<{
      id: string;
      origin: string;
      format: string;
      prompt_source: string | null;
      own_prompt_version_id: string | null;
      prompt_version_id: string | null;
      body_enc: string;
    }>(
      `select id, origin, format, prompt_source, own_prompt_version_id, prompt_version_id, body_enc
       from profile_version where profile_id = $1 order by version_number`,
      [profileId],
    )
  ).rows;

describe('profiles.createGenerations pins (002)', () => {
  itStable(
    'pins the active definition version, the wrapper version and no own prompt by default',
    async () => {
      const def = await seedDefinition();
      const f = await userWith([def]);
      const promptVersionId = await ensureActivePrompt('tone_profile.generate');
      await profiles.generate(f.ctx);
      const [g] = await generationsOf(f.ctx.userId);
      expect(g).toMatchObject({
        definition_version_id: def.versionId,
        prompt_version_id: promptVersionId,
        own_prompt_version_id: null,
      });
    },
  );

  itStable('pins the current own version while in use, and none after a reset', async () => {
    const def = await seedDefinition();
    const f = await userWithVersion(def);
    const own = await seedOwnPrompt({
      userId: f.ctx.userId,
      definitionId: def.definitionId,
      text: '- Tempo: how fast it reads',
      basedOnDefinitionVersionId: def.versionId,
    });
    await profiles.regenerate(f.ctx, f.profileId);
    await profiles.feedback(f.ctx, f.profileId, 'Warmer please.');
    const gens = await generationsOf(f.ctx.userId);
    expect(gens.map((g) => g.own_prompt_version_id)).toEqual([own.versionId, own.versionId]);

    await getPool().query('update own_analysis_prompt set in_use = false where id = $1', [
      own.ownPromptId,
    ]);
    await getPool().query(`update profile_generation set status = 'failed' where user_id = $1`, [
      f.ctx.userId,
    ]);
    await profiles.regenerate(f.ctx, f.profileId);
    const after = await generationsOf(f.ctx.userId);
    expect(after).toHaveLength(3);
    expect(after[2]!.own_prompt_version_id).toBeNull();
  });
});

describe('profiles.editDocument', () => {
  itStable(
    'stores a manual_edit document keeping the base prompt source, own version and aspect keys',
    async () => {
      const def = await seedDefinition();
      const f = await userWithDocument(def, { own: true });
      const input = editInput(f.versionId);
      input.sections.push({ heading: 'Rhythm', markdown: 'Short lines.' });

      const { version } = await profiles.editDocument(f.ctx, f.profileId, input);
      expect(version).toMatchObject({ origin: 'manual_edit', versionNumber: 2 });
      expect(Number.isNaN(Date.parse(version.createdAt))).toBe(false);

      const rows = await versionRows(f.profileId);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({
        id: version.id,
        origin: 'manual_edit',
        format: 'document',
        prompt_source: 'own',
        own_prompt_version_id: f.ownVersionId,
        prompt_version_id: null,
      });
      const body = JSON.parse(decrypt('user-content', rows[1]!.body_enc));
      expect(body.summary).toBe('Calm and clear.');
      expect(body.sections.map((s: { aspectKey: string }) => s.aspectKey)).toEqual([
        'tempo',
        'warmth',
        'custom_3',
      ]);
      expect(body.aspects).toEqual([
        { key: 'tempo', name: 'Tempo' },
        { key: 'warmth', name: 'Warmth' },
        { key: 'custom_3', name: 'Rhythm' },
      ]);
      expect(body.excerpts).toHaveLength(1);
      expect(body.excerpts[0].contentItemId).toBe(f.itemIds[0]);
      expect(body.doList).toEqual(['Be kind']);
      expect(body.dontList).toEqual(['Rush']);

      const latest = await getPool().query(
        'select latest_version_id from tone_profile where id = $1',
        [f.profileId],
      );
      expect(latest.rows[0].latest_version_id).toBe(version.id);

      const audits = await getPool().query<{
        actor_type: string;
        actor_user_id: string;
        target_type: string;
        target_id: string;
        metadata: Record<string, unknown>;
      }>(
        `select actor_type, actor_user_id, target_type, target_id, metadata from audit_log_entry
         where action = 'profile.document_edited' and actor_user_id = $1`,
        [f.ctx.userId],
      );
      expect(audits.rows).toEqual([
        {
          actor_type: 'user',
          actor_user_id: f.ctx.userId,
          target_type: 'profile',
          target_id: f.profileId,
          metadata: {
            profileId: f.profileId,
            versionId: version.id,
            baseVersionId: f.versionId,
            sectionCount: 3,
            excerptCount: 1,
          },
        },
      ]);
    },
  );

  itStable('refuses a stale base or a structured latest version with 409 conflict', async () => {
    const def = await seedDefinition();
    const f = await userWithDocument(def);
    await profiles.editDocument(f.ctx, f.profileId, editInput(f.versionId));
    await expectCode(
      profiles.editDocument(f.ctx, f.profileId, editInput(f.versionId)),
      'conflict',
      409,
    );
    expect(await versionRows(f.profileId)).toHaveLength(2);

    const s = await userWithVersion(def);
    await expectCode(
      profiles.editDocument(s.ctx, s.profileId, editInput(s.versionId)),
      'conflict',
      409,
    );
    const other = await userWithDocument(def);
    await expectCode(
      profiles.editDocument(other.ctx, f.profileId, editInput(f.versionId)),
      'not_found',
    );
  });

  itStable('validates the limits and names the field', async () => {
    const def = await seedDefinition();
    const f = await userWithDocument(def);
    const base = () => editInput(f.versionId);
    const cases: [ReturnType<typeof base>, string][] = [
      [{ ...base(), summary: '  ' }, 'summary'],
      [{ ...base(), summary: 'x'.repeat(1201) }, 'summary'],
      [{ ...base(), sections: [] }, 'sections'],
      [
        {
          ...base(),
          sections: Array.from({ length: 21 }, (_, i) => ({ heading: `H${i}`, markdown: 'x' })),
        },
        'sections',
      ],
      [{ ...base(), sections: [{ heading: '', markdown: 'x' }] }, 'sections[0].heading'],
      [
        { ...base(), sections: [{ heading: 'x'.repeat(121), markdown: 'x' }] },
        'sections[0].heading',
      ],
      [
        {
          ...base(),
          sections: [
            { heading: 'A', markdown: 'x' },
            { heading: 'B', markdown: 'x'.repeat(4001) },
          ],
        },
        'sections[1].markdown',
      ],
      [{ ...base(), doList: [] }, 'doList'],
      [{ ...base(), doList: Array.from({ length: 11 }, () => 'x') }, 'doList'],
      [{ ...base(), doList: ['x'.repeat(201)] }, 'doList'],
      [{ ...base(), dontList: [''] }, 'dontList'],
      [{ ...base(), keepExcerpts: [] }, 'keepExcerpts'],
      [{ ...base(), keepExcerpts: [2] }, 'keepExcerpts'],
      [{ ...base(), keepExcerpts: [-1] }, 'keepExcerpts'],
    ];
    for (const [input, field] of cases) {
      const err = await expectCode(
        profiles.editDocument(f.ctx, f.profileId, input),
        'validation_failed',
        422,
      );
      expect(err.details).toMatchObject({ field });
    }
    expect(await versionRows(f.profileId)).toHaveLength(1);
  });

  itStable(
    'refuses excluded or redacted text with 422 sensitive_content naming the fields only',
    async () => {
      const def = await seedDefinition();
      const f = await userWithDocument(def);
      await addKeywordRule(f.ctx.userId, 'zanzibar');
      const input = editInput(f.versionId);
      input.summary = `deploy with api_key = ${API_KEY} today`;
      input.sections[1]!.markdown = `login password: ${PASSWORD}`;
      input.sections[0]!.heading = 'Zanzibar trips';
      input.doList = ['Be kind', 'Talk about Zanzibar'];
      input.dontList = ['Rush'];

      const err = await expectCode(
        profiles.editDocument(f.ctx, f.profileId, input),
        'sensitive_content',
        422,
      );
      expect(err.details).toEqual({
        fields: ['doList[1]', 'sections[0].heading', 'sections[1].markdown', 'summary'],
      });
      const raw = JSON.stringify({ message: err.message, details: err.details });
      expect(raw).not.toContain(API_KEY);
      expect(raw).not.toContain(PASSWORD);
      expect(await versionRows(f.profileId)).toHaveLength(1);
    },
  );

  itStable('fails closed when inspection cannot complete', async () => {
    const def = await seedDefinition();
    const f = await userWithDocument(def);
    inspection.fail = true;
    const err = await expectCode(
      profiles.editDocument(f.ctx, f.profileId, editInput(f.versionId)),
      'sensitive_content',
      422,
    );
    expect((err.details as { fields: string[] }).fields).toContain('summary');
    expect(await versionRows(f.profileId)).toHaveLength(1);
  });

  itStable('adjust refuses a document latest version with 409 conflict', async () => {
    const def = await seedDefinition();
    const f = await userWithDocument(def);
    await expectCode(
      profiles.adjust(f.ctx, f.profileId, { dimensions: { formality: 3 } }),
      'conflict',
      409,
    );
    expect(await versionRows(f.profileId)).toHaveLength(1);
  });
});

describe('profiles version view (002)', () => {
  itStable(
    'a document version shows format, prompt source, analysis prompt and excerpt sources',
    async () => {
      const def = await seedDefinition();
      const f = await userWithDocument(def);
      const view = await profiles.version(f.ctx, f.profileId, f.versionId);
      expect(view.format).toBe('document');
      expect(view.promptSource).toBe('default');
      expect(view.analysisPrompt).toEqual({
        kind: 'default',
        definitionVersion: { id: def.versionId, versionNumber: 1 },
      });
      if (view.format !== 'document') return;
      expect(view.body.sections.map((s) => s.aspectKey)).toEqual(['tempo', 'warmth']);
      const today = new Date().toISOString().slice(0, 10);
      expect(view.excerptSources).toEqual({
        [f.itemIds[0]!]: { kind: 'note', itemDate: expect.any(String), sourceLabels: ['Uploads'] },
      });
      expect(view.excerptSources[f.itemIds[0]!]!.itemDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(view.excerptSources[f.itemIds[0]!]!.itemDate <= today).toBe(true);

      // A deleted item maps to null; get() returns the latest in the same shape.
      await getPool().query('delete from content_item where id = $1', [f.itemIds[0]]);
      const got = await profiles.get(f.ctx, f.profileId);
      expect(got.latestVersion?.format).toBe('document');
      expect(got.latestVersion?.excerptSources).toEqual({ [f.itemIds[0]!]: null });
    },
  );

  itStable(
    'own versions show the own version number; legacy versions have null prompt fields',
    async () => {
      const def = await seedDefinition();
      const f = await userWithDocument(def, { own: true });
      const view = await profiles.version(f.ctx, f.profileId, f.versionId);
      expect(view.promptSource).toBe('own');
      expect(view.analysisPrompt).toEqual({
        kind: 'own',
        ownVersion: { id: f.ownVersionId, versionNumber: 1 },
      });

      const legacy = await userWithVersion(def);
      const old = await profiles.version(legacy.ctx, legacy.profileId, legacy.versionId);
      expect(old.format).toBe('structured');
      expect(old.promptSource).toBeNull();
      expect(old.analysisPrompt).toBeNull();
      expect(old.excerptSources).toEqual({
        [legacy.itemIds[0]!]: {
          kind: 'note',
          itemDate: expect.any(String),
          sourceLabels: ['Uploads'],
        },
      });
    },
  );
});

describe('profiles.storeGeneratedDocument and loadGenerationForRun (002)', () => {
  itStable(
    'stores a document version with the generation pins and notifies profile_ready',
    async () => {
      const def = await seedDefinition();
      const f = await userWithVersion(def);
      const own = await seedOwnPrompt({
        userId: f.ctx.userId,
        definitionId: def.definitionId,
        text: '- Tempo: how fast it reads',
        basedOnDefinitionVersionId: def.versionId,
      });
      const { generationId } = await profiles.regenerate(f.ctx, f.profileId);

      const run = await profiles.loadGenerationForRun(generationId);
      expect(run?.ownPromptVersion).toMatchObject({ id: own.versionId, versionNumber: 1 });
      expect(profiles.decryptOwnPromptText(run!.ownPromptVersion!)).toBe(
        '- Tempo: how fast it reads',
      );

      const input = {
        document: sampleDocument(f.itemIds[0]!),
        languages: ['en'],
        contributingSourceIds: [f.sourceId],
        contributingItemCount: 1,
        authoredWordsNow: MIN_WORDS + 10,
      };
      const { versionId } = await profiles.storeGeneratedDocument(generationId, input);
      // A retried job returns the stored version.
      expect((await profiles.storeGeneratedDocument(generationId, input)).versionId).toBe(
        versionId,
      );

      const rows = await versionRows(f.profileId);
      expect(rows).toHaveLength(2);
      expect(rows[1]).toMatchObject({
        id: versionId,
        origin: 'regenerated',
        format: 'document',
        prompt_source: 'own',
        own_prompt_version_id: own.versionId,
      });
      expect(await notificationsOf(f.ctx.userId, 'profile_ready')).toEqual([
        { payload: { profileId: f.profileId, versionId } },
      ]);
      const view = await profiles.version(f.ctx, f.profileId, versionId);
      expect(view.format).toBe('document');
    },
  );
});
