import type { Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getPool } from '@voicespark/db';
import { decrypt, encrypt } from '@voicespark/core/crypto';
import { createFakeGenerationLlm, type ProfileBody } from '@voicespark/core/prompting';
import type { Classifier } from '@voicespark/filters';
import {
  LlmRefusedError,
  type LlmClient,
  type ParseStructuredArgs,
} from '@voicespark/integrations/anthropic';
import { InMemoryMemoryStore } from '@voicespark/integrations/supermemory';
import { createProfileHandler } from '../src/processors/profile';
import {
  addKeywordRule,
  addPinnedPromptVersion,
  choose,
  cleanupProfiles,
  confirmPreferences,
  createUser,
  insertVersion,
  MIN_WORDS,
  prose,
  sampleBody,
  seedAuthoredContent,
  seedDefinition,
  setAvailability,
  setMinWords,
  TEST_DIMENSIONS,
  withStableDefinitions,
  type SeededDefinition,
} from './helpers/profiles';

// profile.generate (T120, contracts/jobs.md behavior 4; constitution Principle I): every LLM input is re-inspected
// under the user's CURRENT preferences. Compose Postgres + in-memory Supermemory; queues mocked (no Redis needed).
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

const PASSWORD = 'Hunter2xyz!';
const API_KEY = 'ghp_aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bD1fH3jL5';
const CREDENTIAL_DELIVERY =
  'Reset your password here: https://app.service.test/reset/password?token=aB3dE9fG7hJ2kL5mN8pQ and enter verification code 482913.';

const AUTHORED_PLAIN = `Hi team, we ship the roadmap next week and keep things simple. ${prose(40)} Cheers, Ada`;
const AUTHORED_PASSWORD = `Quick note before the trip.\nLogin details\npassword: ${PASSWORD}\nThanks, Ada ${prose(12, 'trip')}`;
const AUTHORED_RULE = 'Booked the Zanzibar ferry for Tuesday morning, see you all there';
const RECEIVED = 'Vendor update: the invoices for March are attached, please review them';
const RECEIVED_RULE = 'Your Zanzibar hotel booking is confirmed for Tuesday';

// Every template variable this suite checks is delimited so it can be cut out of the captured prompt.
const SYSTEM_TEMPLATE = 'SYSTEM excluded=[{{excludedCategoryLabels}}]';
const USER_TEMPLATE = [
  'NAME[{{user.firstName}}]',
  'AUTHORED[',
  '{{authoredSamples}}',
  ']AUTHORED',
  'RECEIVED[',
  '{{receivedContext}}',
  ']RECEIVED',
  'PREVIOUS[{{previousProfileJson}}]PREVIOUS',
  'FEEDBACK[{{feedback}}]FEEDBACK',
].join('\n');

const classifier: Classifier = { classify: async () => ({ spans: [], mostlySensitive: false }) };
const itStable = (name: string, fn: () => Promise<void>) =>
  it(name, () => withStableDefinitions(fn), 30_000);

let generatePrompt: string;
let feedbackPrompt: string;

/** Wraps an LLM, recording every parseStructured call. */
function capturing(inner: LlmClient = createFakeGenerationLlm()) {
  const calls: ParseStructuredArgs<unknown>[] = [];
  const llm: LlmClient = {
    async parseStructured<T>(args: ParseStructuredArgs<T>): Promise<T> {
      calls.push(args as ParseStructuredArgs<unknown>);
      return inner.parseStructured(args);
    },
  };
  return { llm, calls };
}

/** Fake output with one excerpt replaced by text found in no sample: only 2 valid excerpts remain. */
function twoValidExcerpts(): LlmClient {
  const fake = createFakeGenerationLlm();
  return {
    async parseStructured<T>(args: ParseStructuredArgs<T>): Promise<T> {
      const out = (await fake.parseStructured(args)) as unknown as { excerpts: { text: string }[] };
      out.excerpts[0]!.text = 'a sentence that appears in no sample whatsoever';
      return out as unknown as T;
    },
  };
}

type RunResult = { outcome: string; versionId?: string; blockReason?: string; errorCode?: string };

async function run(
  llm: LlmClient,
  store: InMemoryMemoryStore,
  userId: string,
  generationId: string,
) {
  const handler = createProfileHandler({ store, classifier, llm });
  return handler(
    {
      id: `profile-${generationId}`,
      name: 'profile.generate',
      data: { userId, generationId },
      attemptsMade: 0,
      opts: { attempts: 3 },
      moveToDelayed: vi.fn(),
      updateData: vi.fn(),
    } as unknown as Job<{ userId: string; generationId: string }, unknown, 'profile.generate'>,
    'token',
  ) as Promise<RunResult>;
}

/** Settles a run that may end in UnrecoverableError (refusal, invalid output). */
const settle = (p: Promise<RunResult>) =>
  p.then(
    (r) => r,
    (e: unknown) => e,
  );

interface World {
  userId: string;
  store: InMemoryMemoryStore;
  def: SeededDefinition;
  profileId: string;
  sourceId: string;
  authoredIds: string[];
  authoredWords: number;
}

/** An eligible user: two authored samples (one with a password line) and one received item, choosing one definition. */
async function world(
  opts: { extraAuthored?: string[]; extraReceived?: string[]; def?: SeededDefinition } = {},
) {
  const userId = await createUser('Ada Lovelace');
  await confirmPreferences(userId);
  const store = new InMemoryMemoryStore();
  const authoredTexts = [AUTHORED_PLAIN, AUTHORED_PASSWORD, ...(opts.extraAuthored ?? [])];
  const { sourceId, itemIds } = await seedAuthoredContent({
    userId,
    store,
    items: [
      ...authoredTexts.map((text, i) => ({
        text,
        authorship: 'authored' as const,
        date: new Date(Date.UTC(2026, 0, 10 - i)),
      })),
      ...[RECEIVED, ...(opts.extraReceived ?? [])].map((text) => ({
        text,
        kind: 'email' as const,
        authorship: 'received' as const,
      })),
    ],
  });
  const def = opts.def ?? (await seedDefinition());
  const profileId = await choose(userId, def.definitionId);
  const authoredWords = authoredTexts.reduce(
    (n, t) => n + t.split(/\s+/).filter(Boolean).length,
    0,
  );
  expect(authoredWords).toBeGreaterThanOrEqual(MIN_WORDS);
  return {
    userId,
    store,
    def,
    profileId,
    sourceId,
    authoredIds: itemIds.slice(0, authoredTexts.length),
    authoredWords,
  } satisfies World;
}

async function insertGeneration(
  w: Pick<World, 'userId' | 'profileId' | 'def'>,
  kind: 'generate' | 'regenerate' | 'feedback' = 'generate',
  feedback?: string,
): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `insert into profile_generation (user_id, profile_id, kind, definition_version_id, prompt_version_id, feedback_enc)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [
      w.userId,
      w.profileId,
      kind,
      w.def.versionId,
      kind === 'feedback' ? feedbackPrompt : generatePrompt,
      feedback === undefined ? null : encrypt('user-content', feedback),
    ],
  );
  return rows[0]!.id;
}

/** Gives the profile a previous (latest) version. */
async function previousVersion(w: World, body: ProfileBody): Promise<string> {
  return insertVersion({
    profileId: w.profileId,
    body,
    definitionVersionId: w.def.versionId,
    promptVersionId: generatePrompt,
    sourceIds: [w.sourceId],
    authoredWords: w.authoredWords,
  });
}

const generationRow = async (id: string) =>
  (
    await getPool().query<{
      status: string;
      block_reason: string | null;
      error_code: string | null;
      result_version_id: string | null;
      started_at: Date | null;
      finished_at: Date | null;
    }>(
      'select status, block_reason, error_code, result_version_id, started_at, finished_at from profile_generation where id = $1',
      [id],
    )
  ).rows[0]!;

const versionCount = async (profileId: string) =>
  (await getPool().query('select id from profile_version where profile_id = $1', [profileId]))
    .rowCount;

/** The text between `start` and `end` in the captured user prompt. */
function section(prompt: string, start: string, end: string): string {
  const from = prompt.indexOf(start);
  const to = prompt.indexOf(end, from + start.length);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return prompt.slice(from + start.length, to);
}

const promptText = (call: ParseStructuredArgs<unknown>) => `${call.system}\n${call.user}`;

function samplesIn(prompt: string): { ref: string; text: string }[] {
  return [...prompt.matchAll(/<sample ref="(A[0-9]+)"[^>]*>([\s\S]*?)<\/sample>/g)].map((m) => ({
    ref: m[1]!,
    text: m[2]!,
  }));
}

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();

beforeAll(async () => {
  await getPool().query('select 1');
  await setMinWords(MIN_WORDS);
  generatePrompt = await addPinnedPromptVersion('tone_profile.generate', {
    system: SYSTEM_TEMPLATE,
    user: USER_TEMPLATE,
  });
  feedbackPrompt = await addPinnedPromptVersion('tone_profile.feedback', {
    system: SYSTEM_TEMPLATE,
    user: USER_TEMPLATE,
  });
});

afterAll(async () => {
  await cleanupProfiles();
  await closeDb();
});

describe('profile.generate: success', () => {
  itStable(
    'stores a verified, pinned version and builds the prompt only from inspected inputs',
    async () => {
      const w = await world();
      const generationId = await insertGeneration(w);
      const { llm, calls } = capturing();

      const result = await run(llm, w.store, w.userId, generationId);

      expect(result.outcome).toBe('succeeded');
      expect(result.versionId).toBeTruthy();
      const gen = await generationRow(generationId);
      expect(gen).toMatchObject({
        status: 'succeeded',
        result_version_id: result.versionId,
        error_code: null,
      });
      expect(gen.started_at).toBeInstanceOf(Date);
      expect(gen.finished_at).toBeInstanceOf(Date);

      // Captured prompt (Principle I).
      expect(calls).toHaveLength(1);
      const call = calls[0]!;
      expect(call.model).toBe('claude-sonnet-5-5');
      expect(call.maxTokens).toBe(8000);
      const all = promptText(call);
      expect(all).not.toContain(PASSWORD);
      const authored = section(call.user, 'AUTHORED[', ']AUTHORED');
      const samples = samplesIn(authored);
      expect(samples.length).toBe(2);
      expect(samples.some((s) => s.text.includes('we ship the roadmap next week'))).toBe(true);
      // The password sample is kept, redacted in place.
      expect(samples.some((s) => s.text.includes('Quick note before the trip.'))).toBe(true);
      expect(authored).not.toContain('Vendor update');
      const received = section(call.user, 'RECEIVED[', ']RECEIVED');
      expect(received).toContain('<received_context>');
      expect(received).toContain('Vendor update: the invoices for March');
      expect(all.split('Vendor update').length - 1).toBe(1);
      expect(section(call.user, 'NAME[', ']')).toBe('Ada');
      expect(section(call.user, 'PREVIOUS[', ']PREVIOUS')).toBe('');
      expect(section(call.system, 'excluded=[', ']')).not.toBe('');

      // Stored version.
      const { rows } = await getPool().query<{
        id: string;
        version_number: number;
        origin: string;
        body_enc: string;
        definition_version_id: string;
        prompt_version_id: string;
        languages: string[];
        contributing_source_ids: string[];
        contributing_item_count: number;
      }>('select * from profile_version where profile_id = $1', [w.profileId]);
      expect(rows).toHaveLength(1);
      const v = rows[0]!;
      expect(v).toMatchObject({
        id: result.versionId,
        version_number: 1,
        origin: 'generated',
        definition_version_id: w.def.versionId,
        prompt_version_id: generatePrompt,
      });
      expect(v.body_enc).not.toContain('roadmap');
      expect(v.languages.length).toBeGreaterThan(0);
      expect(v.contributing_source_ids).toEqual([w.sourceId]);
      expect(v.contributing_item_count).toBe(2);

      const body = JSON.parse(decrypt('user-content', v.body_enc)) as ProfileBody;
      expect(body.dimensions.map((d) => d.key).sort()).toEqual(
        TEST_DIMENSIONS.map((d) => d.key).sort(),
      );
      expect(body.excerpts.length).toBeGreaterThanOrEqual(3);
      const byRef = new Map(samples.map((s) => [s.ref, normalize(s.text)]));
      for (const e of body.excerpts) {
        expect(byRef.get(e.sampleRef)).toContain(normalize(e.text));
        expect(w.authoredIds).toContain(e.contentItemId);
      }
      expect(JSON.stringify(body)).not.toContain(PASSWORD);
      expect(body.languages.length).toBeGreaterThan(0);

      const profile = await getPool().query(
        'select latest_version_id, authored_words_at_latest, outdated_reason from tone_profile where id = $1',
        [w.profileId],
      );
      expect(profile.rows[0]).toEqual({
        latest_version_id: result.versionId,
        authored_words_at_latest: w.authoredWords,
        outdated_reason: null,
      });
      const notes = await getPool().query(
        `select payload from notification where user_id = $1 and type = 'profile_ready'`,
        [w.userId],
      );
      expect(notes.rows).toEqual([
        { payload: { profileId: w.profileId, versionId: result.versionId } },
      ]);
    },
  );

  itStable(
    "re-inspects authored samples and received context under the user's current preferences",
    async () => {
      const w = await world({ extraAuthored: [AUTHORED_RULE], extraReceived: [RECEIVED_RULE] });
      // Stored before the rule existed; the rule must still apply at generation time.
      await addKeywordRule(w.userId, 'zanzibar');
      const generationId = await insertGeneration(w);
      const { llm, calls } = capturing();

      expect((await run(llm, w.store, w.userId, generationId)).outcome).toBe('succeeded');

      const all = promptText(calls[0]!);
      expect(all.toLowerCase()).not.toContain('zanzibar');
      expect(all).not.toContain('Booked the');
      expect(all).not.toContain('hotel booking');
      expect(samplesIn(calls[0]!.user)).toHaveLength(2);
      expect(all).toContain('Vendor update');
    },
  );

  itStable('generates one version per definition', async () => {
    const w = await world();
    const second = await seedDefinition();
    const profile2 = await choose(w.userId, second.definitionId);
    const g1 = await insertGeneration(w);
    const g2 = await insertGeneration({ userId: w.userId, profileId: profile2, def: second });
    const { llm, calls } = capturing();

    const r1 = await run(llm, w.store, w.userId, g1);
    const r2 = await run(llm, w.store, w.userId, g2);

    expect([r1.outcome, r2.outcome]).toEqual(['succeeded', 'succeeded']);
    expect(calls).toHaveLength(2);
    expect(await versionCount(w.profileId)).toBe(1);
    expect(await versionCount(profile2)).toBe(1);
    const v2 = await getPool().query(
      'select definition_version_id from profile_version where profile_id = $1',
      [profile2],
    );
    expect(v2.rows[0].definition_version_id).toBe(second.versionId);
  });

  itStable('retries once when fewer than 3 excerpts are valid, then succeeds', async () => {
    const w = await world();
    const generationId = await insertGeneration(w);
    const fake = createFakeGenerationLlm();
    const bad = twoValidExcerpts();
    let n = 0;
    const { llm, calls } = capturing({
      parseStructured: (args) =>
        n++ === 0 ? bad.parseStructured(args) : fake.parseStructured(args),
    });

    expect((await run(llm, w.store, w.userId, generationId)).outcome).toBe('succeeded');
    expect(calls).toHaveLength(2);
  });
});

describe('profile.generate: previous profile and feedback (Principle I)', () => {
  itStable('redacts sensitive values of the previous version in previousProfileJson', async () => {
    const w = await world();
    await previousVersion(w, sampleBody(w.authoredIds[0]!, ` Uses api_key = ${API_KEY} a lot.`));
    const generationId = await insertGeneration(w, 'regenerate');
    const { llm, calls } = capturing();

    expect((await run(llm, w.store, w.userId, generationId)).outcome).toBe('succeeded');

    const previous = section(calls[0]!.user, 'PREVIOUS[', ']PREVIOUS');
    expect(previous).toContain('Short, direct and friendly.');
    expect(previous).not.toContain(API_KEY);
    expect(promptText(calls[0]!)).not.toContain(API_KEY);
    // Prompt-facing JSON carries no content item ids.
    expect(previous).not.toContain(w.authoredIds[0]!);
    const origin = await getPool().query(
      'select origin, based_on_version_id from profile_version where id = (select result_version_id from profile_generation where id = $1)',
      [generationId],
    );
    expect(origin.rows[0].origin).toBe('regenerated');
  });

  itStable(
    'passes an empty previousProfileJson when the previous version is wholly excluded',
    async () => {
      const w = await world();
      const body = sampleBody(w.authoredIds[0]!);
      body.summary = 'Talks about the Zanzibar trip constantly.';
      await previousVersion(w, body);
      await addKeywordRule(w.userId, 'zanzibar');
      const generationId = await insertGeneration(w, 'regenerate');
      const { llm, calls } = capturing();

      expect((await run(llm, w.store, w.userId, generationId)).outcome).toBe('succeeded');

      expect(section(calls[0]!.user, 'PREVIOUS[', ']PREVIOUS')).toBe('');
      expect(promptText(calls[0]!).toLowerCase()).not.toContain('zanzibar');
      expect(promptText(calls[0]!)).not.toContain('Short, direct and friendly.');
    },
  );

  itStable(
    'fails a wholly excluded feedback with feedback_excluded and makes no LLM call',
    async () => {
      const w = await world();
      await previousVersion(w, sampleBody(w.authoredIds[0]!));
      const generationId = await insertGeneration(w, 'feedback', CREDENTIAL_DELIVERY);
      const { llm, calls } = capturing();

      const result = await settle(run(llm, w.store, w.userId, generationId));

      expect(calls).toHaveLength(0);
      expect(await generationRow(generationId)).toMatchObject({
        status: 'failed',
        error_code: 'feedback_excluded',
      });
      expect(result).toMatchObject({ outcome: 'failed', errorCode: 'feedback_excluded' });
      expect(await versionCount(w.profileId)).toBe(1);
    },
  );

  itStable('passes only the filtered feedback text to the LLM', async () => {
    const w = await world();
    await previousVersion(w, sampleBody(w.authoredIds[0]!));
    const generationId = await insertGeneration(
      w,
      'feedback',
      `Make it warmer. Also my login password: ${PASSWORD}`,
    );
    const { llm, calls } = capturing();

    expect((await run(llm, w.store, w.userId, generationId)).outcome).toBe('succeeded');

    const feedback = section(calls[0]!.user, 'FEEDBACK[', ']FEEDBACK');
    expect(feedback).toContain('Make it warmer.');
    expect(promptText(calls[0]!)).not.toContain(PASSWORD);
    expect(section(calls[0]!.user, 'PREVIOUS[', ']PREVIOUS')).toContain(
      'Short, direct and friendly.',
    );
    const v = await getPool().query(
      'select origin, prompt_version_id from profile_version where id = (select result_version_id from profile_generation where id = $1)',
      [generationId],
    );
    expect(v.rows[0]).toEqual({ origin: 'feedback', prompt_version_id: feedbackPrompt });
  });
});

describe('profile.generate: failures and blocks', () => {
  itStable('marks llm_refused when the model refuses', async () => {
    const w = await world();
    const generationId = await insertGeneration(w);
    const { llm, calls } = capturing({
      parseStructured: async () => {
        throw new LlmRefusedError();
      },
    });

    await settle(run(llm, w.store, w.userId, generationId));

    expect(calls).toHaveLength(1);
    expect(await generationRow(generationId)).toMatchObject({
      status: 'failed',
      error_code: 'llm_refused',
    });
    expect(await versionCount(w.profileId)).toBe(0);
  });

  itStable(
    'fails with invalid_output after exactly 2 calls with too few valid excerpts',
    async () => {
      const w = await world();
      const generationId = await insertGeneration(w);
      const { llm, calls } = capturing(twoValidExcerpts());

      await settle(run(llm, w.store, w.userId, generationId));

      expect(calls).toHaveLength(2);
      expect(await generationRow(generationId)).toMatchObject({
        status: 'failed',
        error_code: 'invalid_output',
      });
      expect(await versionCount(w.profileId)).toBe(0);
    },
  );

  itStable('blocks insufficient_content when the user fell below the threshold', async () => {
    const userId = await createUser();
    await confirmPreferences(userId);
    const store = new InMemoryMemoryStore();
    await seedAuthoredContent({ userId, store, items: [{ text: prose(MIN_WORDS - 10) }] });
    const def = await seedDefinition();
    const profileId = await choose(userId, def.definitionId);
    const generationId = await insertGeneration({ userId, profileId, def });
    const { llm, calls } = capturing();

    const result = await run(llm, store, userId, generationId);

    expect(result).toMatchObject({ outcome: 'blocked', blockReason: 'insufficient_content' });
    expect(await generationRow(generationId)).toMatchObject({
      status: 'blocked',
      block_reason: 'insufficient_content',
    });
    expect(calls).toHaveLength(0);
  });

  itStable('blocks definition_retired when the definition was retired after enqueue', async () => {
    const w = await world();
    const generationId = await insertGeneration(w);
    await setAvailability(w.def.definitionId, 'retired');
    const { llm, calls } = capturing();

    const result = await run(llm, w.store, w.userId, generationId);

    expect(result).toMatchObject({ outcome: 'blocked', blockReason: 'definition_retired' });
    expect(await generationRow(generationId)).toMatchObject({
      status: 'blocked',
      block_reason: 'definition_retired',
    });
    expect(calls).toHaveLength(0);
  });

  itStable('blocks definition_not_chosen when the choice was removed after enqueue', async () => {
    const w = await world();
    const generationId = await insertGeneration(w);
    await getPool().query(
      'update user_definition_choice set removed_at = now() where user_id = $1',
      [w.userId],
    );
    const { llm, calls } = capturing();

    const result = await run(llm, w.store, w.userId, generationId);

    expect(result).toMatchObject({ outcome: 'blocked', blockReason: 'definition_not_chosen' });
    expect(calls).toHaveLength(0);
  });
});
