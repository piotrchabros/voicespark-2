import { randomUUID } from 'node:crypto';
import { UnrecoverableError, type Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getPool, type DraftContentType } from '@voicespark/db';
import { decrypt, encrypt } from '@voicespark/core/crypto';
import {
  createFakeGenerationLlm,
  documentToMarkdown,
  structuredToDocument,
  type ProfileBody,
  type VoiceDocument,
} from '@voicespark/core/prompting';
import type { Classifier } from '@voicespark/filters';
import {
  LlmRefusedError,
  type LlmClient,
  type ParseStructuredArgs,
} from '@voicespark/integrations/anthropic';
import { InMemoryMemoryStore, namespaceFor } from '@voicespark/integrations/supermemory';
import { createDraftHandler, handlers } from '../src/processors/draft';
import {
  addKeywordRule,
  addPinnedPromptVersion,
  choose,
  cleanupProfiles,
  confirmPreferences,
  createUser,
  ensureActivePrompt,
  insertVersion,
  prose,
  sampleBody,
  sampleDocument,
  seedAuthoredContent,
  seedDefinition,
  TEST_DIMENSIONS,
} from './helpers/profiles';

// draft.generate (T152, contracts/jobs.md behavior 5; constitution Principle I): every LLM input of a draft is
// re-inspected under the user's CURRENT preferences; memory comes only from the user's own namespace and nothing is
// written to Supermemory. Compose Postgres + in-memory Supermemory; queues mocked (no Redis needed).
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
const BRIEF = 'Announce the roadmap launch next week to the whole community and invite feedback';
const REDACTION = /\[excluded: [^\]]+\]/;
const DEFINITION_NAME = 'Voice Drafts Test';
const CONTENT_TYPES: DraftContentType[] = ['social_post', 'bio', 'short_article'];
const SC012_MS = 60_000;

// Every template variable this suite checks is delimited so it can be cut out of the captured prompt. The
// `Brief: ` line is what the fake LLM echoes into the draft body.
const systemTemplate = (type: DraftContentType) =>
  `PINNED-DRAFT-SYSTEM-${type} excluded=[{{excludedCategoryLabels}}]`;
const USER_TEMPLATE = [
  'Brief: {{brief}}',
  'NAME[{{user.firstName}}] TYPE[{{contentTypeLabel}}] DEF[{{definitionName}}] LANG[{{languageHint}}]',
  'PROFILE[{{profileJson}}]PROFILE',
  'SUMMARY[{{profileSummary}}]SUMMARY',
  'MEMORY[{{memoryContext}}]MEMORY',
  'VOICE[{{voiceDocument}}]VOICE',
  '{{#isRevision}}REVISION PREVIOUS[{{previousDraft}}]PREVIOUS FEEDBACK[{{feedback}}]FEEDBACK{{/isRevision}}',
].join('\n');

const LABELS: Record<DraftContentType, string> = {
  social_post: 'social post',
  bio: 'bio',
  short_article: 'short article',
};

const classifier: Classifier = { classify: async () => ({ spans: [], mostlySensitive: false }) };

const pinned = {} as Record<DraftContentType, string>;
let profilePrompt: string;

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

/** An LLM answering every call with `out` (bypasses the fake). */
const answering = (out: {
  title: string | null;
  body: string;
  notes: string | null;
}): LlmClient => ({
  parseStructured: async <T>() => out as unknown as T,
});

interface World {
  userId: string;
  store: InMemoryMemoryStore;
  profileId: string;
  versionId: string;
}

/**
 * A user (Ada) with confirmed preferences and a versioned profile; `body` customises the pinned version and
 * `document` pins a document version instead.
 */
async function world(opts: { body?: ProfileBody; document?: VoiceDocument } = {}): Promise<World> {
  const userId = await createUser('Ada Lovelace');
  await confirmPreferences(userId);
  const store = new InMemoryMemoryStore();
  const def = await seedDefinition({ name: DEFINITION_NAME });
  const profileId = await choose(userId, def.definitionId);
  const versionId = await insertVersion({
    profileId,
    body: opts.document ?? opts.body ?? sampleBody(randomUUID()),
    format: opts.document ? 'document' : 'structured',
    promptSource: opts.document ? 'default' : null,
    definitionVersionId: def.versionId,
    promptVersionId: profilePrompt,
  });
  return { userId, store, profileId, versionId };
}

async function insertDraft(
  w: World,
  input: {
    contentType?: DraftContentType;
    brief?: string;
    feedback?: string;
    parentDraftId?: string;
    status?: 'queued' | 'ready';
    generatedText?: string;
    editedText?: string;
  } = {},
): Promise<string> {
  const type = input.contentType ?? 'social_post';
  const brief = input.brief ?? BRIEF;
  const enc = (v: string | undefined) => (v === undefined ? null : encrypt('user-content', v));
  const { rows } = await getPool().query<{ id: string }>(
    `insert into draft (user_id, content_type, profile_id, profile_version_id, prompt_version_id, parent_draft_id,
       topic_enc, brief_enc, feedback_enc, generated_text_enc, edited_text_enc, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
    [
      w.userId,
      type,
      w.profileId,
      w.versionId,
      pinned[type],
      input.parentDraftId ?? null,
      encrypt('user-content', brief.trim().slice(0, 120)),
      encrypt('user-content', brief),
      enc(input.feedback),
      enc(input.generatedText),
      enc(input.editedText),
      input.status ?? 'queued',
    ],
  );
  return rows[0]!.id;
}

function fakeJob(userId: string, draftId: string, attemptsMade = 0) {
  return {
    id: `draft-${draftId}`,
    name: 'draft.generate',
    data: { userId, draftId },
    attemptsMade,
    opts: { attempts: 3 },
    moveToDelayed: vi.fn(),
    updateData: vi.fn(),
  } as unknown as Job<{ userId: string; draftId: string }, unknown, 'draft.generate'>;
}

async function run(llm: LlmClient, w: World, draftId: string, attemptsMade = 0) {
  const handler = createDraftHandler({ store: w.store, classifier, llm });
  const started = Date.now();
  try {
    return await handler(fakeJob(w.userId, draftId, attemptsMade), 'token');
  } finally {
    // SC-012 smoke: every run (success or failure) finishes well under 60 s.
    expect(Date.now() - started).toBeLessThan(SC012_MS);
  }
}

/** Settles a run that may reject (refusal, final failure). */
const settle = (p: Promise<unknown>) =>
  p.then(
    (r) => r,
    (e: unknown) => e,
  );

interface DraftRow {
  status: string;
  error_code: string | null;
  generated_text_enc: string | null;
  title_enc: string | null;
  redactions_applied: number;
  completed_at: Date | null;
}

const draftRow = async (id: string) =>
  (
    await getPool().query<DraftRow>(
      'select status, error_code, generated_text_enc, title_enc, redactions_applied, completed_at from draft where id = $1',
      [id],
    )
  ).rows[0]!;

const storedText = (row: DraftRow) =>
  row.generated_text_enc === null ? null : decrypt('user-content', row.generated_text_enc);

const notifications = async (userId: string, type: 'draft_ready' | 'draft_failed') =>
  (
    await getPool().query<{ payload: Record<string, unknown> }>(
      'select payload from notification where user_id = $1 and type = $2',
      [userId, type],
    )
  ).rows.map((r) => r.payload);

/** The text between `start` and `end` in a captured prompt. */
function section(prompt: string, start: string, end: string): string {
  const from = prompt.indexOf(start);
  const to = prompt.indexOf(end, from + start.length);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return prompt.slice(from + start.length, to);
}

const promptText = (call: ParseStructuredArgs<unknown>) => `${call.system}\n${call.user}`;

beforeAll(async () => {
  await getPool().query('select 1');
  profilePrompt = await ensureActivePrompt('tone_profile.generate');
  for (const type of CONTENT_TYPES) {
    // Pinned, NOT active: the run must render the draft's pinned version, not the current active one.
    pinned[type] = await addPinnedPromptVersion(`draft.${type}`, {
      system: systemTemplate(type),
      user: USER_TEMPLATE,
    });
  }
});

afterAll(async () => {
  await cleanupProfiles();
  await closeDb();
});

describe('draft.generate: module', () => {
  it('exports the handler map entry', () => {
    expect(typeof handlers['draft.generate']).toBe('function');
    expect(typeof createDraftHandler).toBe('function');
  });
});

describe('draft.generate: success', () => {
  for (const type of CONTENT_TYPES) {
    it(`generates a ready ${type} from the pinned prompt version`, async () => {
      const w = await world();
      const draftId = await insertDraft(w, { contentType: type });
      const { llm, calls } = capturing();

      await run(llm, w, draftId);

      expect(calls).toHaveLength(1);
      const call = calls[0]!;
      expect(call.system).toContain(`PINNED-DRAFT-SYSTEM-${type}`);
      expect(section(call.system, 'excluded=[', ']')).not.toBe('');
      expect(call.model).toBe('claude-sonnet-5-5');
      expect(call.effort).toBe('medium');
      expect(call.maxTokens).toBe(8000);
      expect(call.user).toContain(`Brief: ${BRIEF}`);
      expect(section(call.user, 'NAME[', ']')).toBe('Ada');
      expect(section(call.user, 'TYPE[', ']')).toBe(LABELS[type]);
      expect(section(call.user, 'DEF[', ']')).toBe(DEFINITION_NAME);
      expect(section(call.user, 'LANG[', ']')).toBe('en');
      const profileJson = section(call.user, 'PROFILE[', ']PROFILE');
      expect(JSON.parse(profileJson)).toMatchObject({ summary: 'Short, direct and friendly.' });
      expect(section(call.user, 'SUMMARY[', ']SUMMARY')).toBe('Short, direct and friendly.');
      expect(call.user).not.toContain('REVISION');

      const row = await draftRow(draftId);
      expect(row.status).toBe('ready');
      expect(row.error_code).toBeNull();
      expect(row.completed_at).toBeInstanceOf(Date);
      expect(row.redactions_applied).toBe(0);
      expect(row.generated_text_enc).not.toContain('Fake');
      expect(storedText(row)).toContain(`Fake ${LABELS[type]} draft.`);
      expect(storedText(row)).toContain('roadmap launch');
      const title = row.title_enc === null ? null : decrypt('user-content', row.title_enc);
      expect(title).toBe(type === 'short_article' ? 'Fake title' : null);
      expect(await notifications(w.userId, 'draft_ready')).toEqual([{ draftId }]);
      expect(await notifications(w.userId, 'draft_failed')).toEqual([]);
    });
  }

  it('skips a draft that is already ready (no second LLM call)', async () => {
    const w = await world();
    const draftId = await insertDraft(w);
    const { llm, calls } = capturing();

    await run(llm, w, draftId);
    await run(llm, w, draftId);

    expect(calls).toHaveLength(1);
    expect((await draftRow(draftId)).status).toBe('ready');
    expect(await notifications(w.userId, 'draft_ready')).toHaveLength(1);
  });
});

describe('draft.generate: profile formats (jobs.md behavior 5)', () => {
  it('drafts from a document version: document profileJson without item ids plus the voiceDocument markdown', async () => {
    const itemId = randomUUID();
    const doc = sampleDocument(itemId);
    const w = await world({ document: doc });
    const draftId = await insertDraft(w);
    const { llm, calls } = capturing();

    await run(llm, w, draftId);

    expect(calls).toHaveLength(1);
    const user = calls[0]!.user;
    const profileJson = section(user, 'PROFILE[', ']PROFILE');
    expect(JSON.parse(profileJson)).toEqual({
      format: 'document',
      summary: doc.summary,
      sections: doc.sections.map(({ heading, markdown }) => ({ heading, markdown })),
      doList: doc.doList,
      dontList: doc.dontList,
      excerpts: doc.excerpts.map(({ text }) => ({ text })),
      languages: doc.languages,
    });
    expect(profileJson).not.toContain('contentItemId');
    expect(profileJson).not.toContain('sampleRef');
    expect(promptText(calls[0]!)).not.toContain(itemId);
    expect(section(user, 'SUMMARY[', ']SUMMARY')).toBe(doc.summary);
    expect(section(user, 'LANG[', ']')).toBe('en');
    const voice = section(user, 'VOICE[', ']VOICE');
    expect(voice).toBe(documentToMarkdown(doc));
    expect(voice).toContain('### Tempo');
    expect(voice).toContain('- Be brief');
    expect((await draftRow(draftId)).status).toBe('ready');
  });

  it('drafts from a legacy structured version: profileJson byte-identical to 001 (SC-006)', async () => {
    const body = sampleBody(randomUUID());
    const w = await world({ body });
    const draftId = await insertDraft(w);
    const { llm, calls } = capturing();

    await run(llm, w, draftId);

    // The 001 serialisation, spelled out: the whole body with excerpts reduced to text, sampleRef, dimensionKeys.
    const legacy = JSON.stringify({
      ...body,
      excerpts: body.excerpts.map(({ text, sampleRef, dimensionKeys }) => ({
        text,
        sampleRef,
        dimensionKeys,
      })),
    });
    const user = calls[0]!.user;
    expect(section(user, 'PROFILE[', ']PROFILE')).toBe(legacy);
    expect(section(user, 'SUMMARY[', ']SUMMARY')).toBe(body.summary);
    expect(section(user, 'LANG[', ']')).toBe('en');
    // voiceDocument renders the legacy body as a document, sections named after the definition's dimensions.
    const voice = section(user, 'VOICE[', ']VOICE');
    expect(voice).toBe(documentToMarkdown(structuredToDocument(body, TEST_DIMENSIONS)));
    expect(voice).toContain('### Signature move');
    expect((await draftRow(draftId)).status).toBe('ready');
  });

  it('passes an empty voiceDocument when it is wholly excluded but the profile JSON is usable', async () => {
    const doc = sampleDocument(randomUUID());
    const w = await world({ document: doc });
    const draftId = await insertDraft(w);
    // Inspection is per text: only the voiceDocument markdown is wholly excluded.
    const markdown = documentToMarkdown(doc);
    const excluding: Classifier = {
      classify: async (text: string) => ({ spans: [], mostlySensitive: text.includes(markdown) }),
    };
    const { llm, calls } = capturing();
    const handler = createDraftHandler({ store: w.store, classifier: excluding, llm });

    await handler(fakeJob(w.userId, draftId), 'token');

    expect(calls).toHaveLength(1);
    expect(section(calls[0]!.user, 'VOICE[', ']VOICE')).toBe('');
    expect(JSON.parse(section(calls[0]!.user, 'PROFILE[', ']PROFILE'))).toMatchObject({
      format: 'document',
    });
  });
});

describe('draft.generate: inputs are inspected under current preferences (Principle I)', () => {
  it('redacts a credential in the brief before the LLM call and counts it', async () => {
    const w = await world();
    const draftId = await insertDraft(w, { brief: `${BRIEF}, our token is api_key = ${API_KEY}` });
    const { llm, calls } = capturing();
    const search = vi.spyOn(w.store, 'search');

    await run(llm, w, draftId);

    expect(calls).toHaveLength(1);
    expect(promptText(calls[0]!)).not.toContain(API_KEY);
    expect(section(calls[0]!.user, 'Brief: ', '\n')).toMatch(REDACTION);
    // The memory search query is the INSPECTED brief, in the user's own namespace.
    expect(search).toHaveBeenCalled();
    for (const [ns, q] of search.mock.calls) {
      expect(ns).toBe(namespaceFor(w.userId));
      expect(q.query).not.toContain(API_KEY);
    }
    const row = await draftRow(draftId);
    expect(row.status).toBe('ready');
    expect(row.redactions_applied).toBeGreaterThanOrEqual(1);
    expect(storedText(row)).not.toContain(API_KEY);
    expect(storedText(row)).toMatch(REDACTION);
  });

  it('fails brief_excluded for a credential-delivery brief without any LLM call or search', async () => {
    const w = await world();
    const draftId = await insertDraft(w, { brief: CREDENTIAL_DELIVERY });
    const { llm, calls } = capturing();
    const search = vi.spyOn(w.store, 'search');

    await settle(run(llm, w, draftId));

    expect(calls).toHaveLength(0);
    expect(search).not.toHaveBeenCalled();
    const row = await draftRow(draftId);
    expect(row).toMatchObject({ status: 'failed', error_code: 'brief_excluded' });
    expect(row.generated_text_enc).toBeNull();
    expect(await notifications(w.userId, 'draft_failed')).toEqual([
      expect.objectContaining({ draftId }),
    ]);
    expect(await notifications(w.userId, 'draft_ready')).toEqual([]);
  });

  it('fails profile_excluded when a rule added after the version excludes the pinned profile', async () => {
    const body = sampleBody(randomUUID());
    body.summary = 'Talks about the Zanzibar trip constantly.';
    const w = await world({ body });
    await addKeywordRule(w.userId, 'zanzibar');
    const draftId = await insertDraft(w);
    const { llm, calls } = capturing();

    await settle(run(llm, w, draftId));

    expect(calls).toHaveLength(0);
    expect(await draftRow(draftId)).toMatchObject({
      status: 'failed',
      error_code: 'profile_excluded',
    });
    expect(await notifications(w.userId, 'draft_failed')).toHaveLength(1);
  });

  it('redacts a credential inside the pinned profile in profileJson and counts it', async () => {
    const w = await world({ body: sampleBody(randomUUID(), ` Uses api_key = ${API_KEY} a lot.`) });
    const draftId = await insertDraft(w);
    const { llm, calls } = capturing();

    await run(llm, w, draftId);

    const profileJson = section(calls[0]!.user, 'PROFILE[', ']PROFILE');
    expect(profileJson).toContain('Short, direct and friendly.');
    expect(promptText(calls[0]!)).not.toContain(API_KEY);
    expect((await draftRow(draftId)).redactions_applied).toBeGreaterThanOrEqual(1);
  });

  it('inspects the previous draft (edited text) and feedback of a revision', async () => {
    const w = await world();
    const parentId = await insertDraft(w, {
      status: 'ready',
      generatedText: 'GENERATED-PARENT-TEXT should not be used',
      editedText: `EDITED-PARENT-TEXT about the launch.\nLogin details\npassword: ${PASSWORD}\nThanks, Ada ${prose(12, 'launch')}`,
    });
    const draftId = await insertDraft(w, {
      parentDraftId: parentId,
      feedback: `Make it warmer. Also my login password: ${PASSWORD}`,
    });
    const { llm, calls } = capturing();

    await run(llm, w, draftId);

    const user = calls[0]!.user;
    expect(user).toContain('REVISION');
    const previous = section(user, 'PREVIOUS[', ']PREVIOUS');
    expect(previous).toContain('EDITED-PARENT-TEXT');
    expect(previous).not.toContain('GENERATED-PARENT-TEXT');
    expect(section(user, 'FEEDBACK[', ']FEEDBACK')).toContain('Make it warmer.');
    expect(promptText(calls[0]!)).not.toContain(PASSWORD);
    const row = await draftRow(draftId);
    expect(row.status).toBe('ready');
    expect(row.redactions_applied).toBeGreaterThanOrEqual(2);
  });

  it('omits a wholly excluded feedback from the prompt and still completes', async () => {
    const w = await world();
    const parentId = await insertDraft(w, {
      status: 'ready',
      generatedText: 'PARENT-GENERATED a short post about the launch.',
    });
    const draftId = await insertDraft(w, {
      parentDraftId: parentId,
      feedback: CREDENTIAL_DELIVERY,
    });
    const { llm, calls } = capturing();

    await run(llm, w, draftId);

    expect(calls).toHaveLength(1);
    const user = calls[0]!.user;
    expect(section(user, 'FEEDBACK[', ']FEEDBACK')).toBe('');
    expect(section(user, 'PREVIOUS[', ']PREVIOUS')).toContain('PARENT-GENERATED');
    expect(promptText(calls[0]!)).not.toContain('482913');
    expect(promptText(calls[0]!)).not.toContain('reset/password');
    expect((await draftRow(draftId)).status).toBe('ready');
  });

  it("uses only the user's own accepted memory snippets and writes nothing to the store", async () => {
    const w = await world();
    const other = await createUser('Bob Other');
    await addKeywordRule(w.userId, 'zanzibar');
    await seedAuthoredContent({
      userId: w.userId,
      store: w.store,
      items: [
        { text: 'OWNMEMORYMARKER we demoed the roadmap launch to forty customers last week' },
        { text: 'ZANZIBARMARKER roadmap launch party in Zanzibar next week' },
      ],
    });
    await seedAuthoredContent({
      userId: other,
      store: w.store,
      items: [{ text: 'OTHERUSERMARKER the roadmap launch next week for the whole community' }],
    });
    const draftId = await insertDraft(w);
    const { llm, calls } = capturing();
    const search = vi.spyOn(w.store, 'search');
    const add = vi.spyOn(w.store, 'addDocuments');

    await run(llm, w, draftId);

    const all = promptText(calls[0]!);
    const memory = section(calls[0]!.user, 'MEMORY[', ']MEMORY');
    expect(memory).toContain('<memory ref="M1">');
    expect(memory).toContain('OWNMEMORYMARKER');
    expect(all).not.toContain('OTHERUSERMARKER');
    expect(all).not.toContain('ZANZIBARMARKER');
    expect(all.toLowerCase()).not.toContain('zanzibar');
    for (const [ns] of search.mock.calls) expect(ns).toBe(namespaceFor(w.userId));
    expect(add).not.toHaveBeenCalled();
    const row = await draftRow(draftId);
    expect(row.status).toBe('ready');
    expect(storedText(row)).toContain('[M1]');
  });
});

describe('draft.generate: output inspection', () => {
  it('redacts a password in the model output and counts it', async () => {
    const w = await world();
    const draftId = await insertDraft(w);
    const { llm, calls } = capturing(
      answering({
        title: null,
        body: `Quick note before the launch.\nLogin details\npassword: ${PASSWORD}\nThanks, Ada ${prose(12, 'launch')}`,
        notes: null,
      }),
    );

    await run(llm, w, draftId);

    expect(calls).toHaveLength(1);
    const row = await draftRow(draftId);
    expect(row.status).toBe('ready');
    expect(storedText(row)).not.toContain(PASSWORD);
    expect(storedText(row)).toContain('Quick note before the launch.');
    expect(storedText(row)).toMatch(REDACTION);
    expect(row.redactions_applied).toBeGreaterThanOrEqual(1);
  });
});

describe('draft.generate: failures', () => {
  it('fails llm_refused without retry and notifies', async () => {
    const w = await world();
    const draftId = await insertDraft(w);
    const { llm, calls } = capturing({
      parseStructured: async () => {
        throw new LlmRefusedError();
      },
    });

    const result = await settle(run(llm, w, draftId));

    expect(result).toBeInstanceOf(UnrecoverableError);
    expect(calls).toHaveLength(1);
    expect(await draftRow(draftId)).toMatchObject({ status: 'failed', error_code: 'llm_refused' });
    expect(await notifications(w.userId, 'draft_failed')).toHaveLength(1);
  });

  it('rethrows a generic error on a non-final attempt without failing the draft', async () => {
    const w = await world();
    const draftId = await insertDraft(w);
    const { llm, calls } = capturing({
      parseStructured: async () => {
        throw new Error('upstream_timeout');
      },
    });

    const result = await settle(run(llm, w, draftId, 0));

    expect(calls).toHaveLength(1);
    expect(result).toBeInstanceOf(Error);
    expect(result).not.toBeInstanceOf(UnrecoverableError);
    expect((await draftRow(draftId)).status).not.toBe('failed');
    expect(await notifications(w.userId, 'draft_failed')).toEqual([]);
  });

  it('fails generation_failed on the final attempt and notifies', async () => {
    const w = await world();
    const draftId = await insertDraft(w);
    const { llm, calls } = capturing({
      parseStructured: async () => {
        throw new Error('upstream_timeout');
      },
    });

    const result = await settle(run(llm, w, draftId, 2));

    expect(calls).toHaveLength(1);
    expect(result).toBeInstanceOf(Error);
    expect(await draftRow(draftId)).toMatchObject({
      status: 'failed',
      error_code: 'generation_failed',
    });
    expect(await notifications(w.userId, 'draft_failed')).toHaveLength(1);
  });

  it('fails profile_deleted when the pinned profile version is gone', async () => {
    const w = await world();
    const draftId = await insertDraft(w);
    await getPool().query('delete from tone_profile where id = $1', [w.profileId]);
    const { llm, calls } = capturing();

    await settle(run(llm, w, draftId));

    expect(calls).toHaveLength(0);
    expect(await draftRow(draftId)).toMatchObject({
      status: 'failed',
      error_code: 'profile_deleted',
    });
    expect(await notifications(w.userId, 'draft_failed')).toHaveLength(1);
  });

  it('fails user_inactive without notifying when the user is pending deletion', async () => {
    const w = await world();
    const draftId = await insertDraft(w);
    await getPool().query(`update "user" set status = 'pending_deletion' where id = $1`, [
      w.userId,
    ]);
    const { llm, calls } = capturing();

    await settle(run(llm, w, draftId));

    expect(calls).toHaveLength(0);
    expect(await draftRow(draftId)).toMatchObject({
      status: 'failed',
      error_code: 'user_inactive',
    });
    expect(await notifications(w.userId, 'draft_failed')).toEqual([]);
  });
});
