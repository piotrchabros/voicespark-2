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
  seedAuthoredContent,
  seedDefinition,
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
      feedback_enc: string | null;
    }>(
      `select id, profile_id, kind, status, definition_version_id, prompt_version_id, feedback_enc
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
