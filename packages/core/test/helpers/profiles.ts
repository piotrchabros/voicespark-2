import { randomBytes, randomUUID } from 'node:crypto';
import {
  FILTER_CATEGORIES,
  getPool,
  type Authorship,
  type ContentKind,
  type DefinitionAvailability,
  type Dimension,
} from '@voicespark/db';
import { encrypt } from '@voicespark/core/crypto';
import type { ProfileBody } from '@voicespark/core/prompting';
import type { VoiceDocument } from '@voicespark/core/prompting/document-schema';
import { buildAnalysisPromptFromDimensions } from '@voicespark/db/data/analysis-prompts';
import type { FilteredText } from '@voicespark/filters';
import { META, namespaceFor, type MemoryStore } from '@voicespark/integrations/supermemory';

// US5 test fixtures (core). Raw SQL on purpose: the fixtures must not depend on the services under test.
// Definitions, prompt templates and app settings are global rows shared with other suites running in parallel.
// DEFINITION_LOCK: tests that rely on their definitions staying `available` (and every seeding write) hold it
// shared; `withSoleAvailableDefinition` holds it exclusively while it retires everything else.

const connect = () => getPool().connect();
type PoolClient = Awaited<ReturnType<typeof connect>>;

const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';
const DEFINITION_LOCK = 8_105_005;

export const MIN_WORDS = 50;

// > 0 while this file's current test holds DEFINITION_LOCK shared; nested seeding then must not queue for it again
// (a queued exclusive request would block the second shared request and deadlock).
let stableDepth = 0;

async function lockShared(c: PoolClient): Promise<void> {
  if (stableDepth === 0)
    await c.query('select pg_advisory_xact_lock_shared($1)', [DEFINITION_LOCK]);
}

export const TEST_DIMENSIONS: Dimension[] = [
  {
    key: 'formality',
    name: 'Formality',
    description: 'How formal the writing is',
    valueType: 'scale',
    scale: { min: 1, max: 5, minLabel: 'very casual', maxLabel: 'very formal' },
  },
  {
    key: 'energy',
    name: 'Energy',
    description: 'Overall energy',
    valueType: 'enum',
    allowedValues: ['calm', 'lively'],
  },
  { key: 'signature', name: 'Signature move', description: 'A typical habit', valueType: 'text' },
  { key: 'phrases', name: 'Phrases', description: 'Recurring phrases', valueType: 'list' },
];

const userIds: string[] = [];
const definitionIds: string[] = [];

export async function createUser(name = 'Ada Lovelace'): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `insert into "user" (name, email) values ($1, $2) returning id`,
    [name, `us5-${randomUUID()}@example.test`],
  );
  userIds.push(rows[0]!.id);
  return rows[0]!.id;
}

/** Confirmed filter preferences (all 10 categories). */
export async function confirmPreferences(userId: string): Promise<void> {
  await getPool().query(
    `insert into filter_preferences (user_id, selected_categories, confirmed_at)
     values ($1, $2::filter_category[], now())
     on conflict (user_id) do update set confirmed_at = now()`,
    [userId, [...FILTER_CATEGORIES]],
  );
}

export async function addKeywordRule(userId: string, keyword: string): Promise<void> {
  await getPool().query(
    `insert into exclusion_rule (user_id, type, value) values ($1, 'keyword', $2)`,
    [userId, keyword],
  );
}

export async function setMinWords(n: number = MIN_WORDS): Promise<void> {
  await getPool().query(
    `insert into app_setting (key, value) values ('profile.min_authored_words', $1::jsonb)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [JSON.stringify(n)],
  );
}

export interface SeededDefinition {
  definitionId: string;
  versionId: string;
  dimensions: Dimension[];
}

/** A definition with an active v1. `availability` defaults to `available`. */
export async function seedDefinition(
  opts: {
    key?: string;
    dims?: Dimension[];
    availability?: DefinitionAvailability;
    name?: string;
    /** `undefined` builds the default from the dimensions; `null` leaves the column empty. */
    analysisPrompt?: string | null;
  } = {},
): Promise<SeededDefinition> {
  const key = opts.key ?? `t_${randomBytes(6).toString('hex')}`;
  const dims = opts.dims ?? TEST_DIMENSIONS;
  const name = opts.name ?? `Voice ${key}`;
  const description = `Test definition ${key}`;
  const analysisPrompt =
    opts.analysisPrompt === undefined
      ? buildAnalysisPromptFromDimensions({ name, description, dimensions: dims })
      : opts.analysisPrompt;
  return inTx(async (c) => {
    await lockShared(c);
    const def = await c.query<{ id: string }>(
      `insert into tone_definition (key, availability, created_by) values ($1, $2, $3) returning id`,
      [key, opts.availability ?? 'available', SYSTEM_ACTOR],
    );
    const definitionId = def.rows[0]!.id;
    const ver = await c.query<{ id: string }>(
      `insert into tone_definition_version
         (definition_id, version_number, status, name, description, dimensions, analysis_prompt, created_by,
          published_by, published_at)
       values ($1, 1, 'active', $2, $3, $4::jsonb, $5, $6, $6, now()) returning id`,
      [definitionId, name, description, JSON.stringify(dims), analysisPrompt, SYSTEM_ACTOR],
    );
    await c.query('update tone_definition set active_version_id = $2 where id = $1', [
      definitionId,
      ver.rows[0]!.id,
    ]);
    definitionIds.push(definitionId);
    return { definitionId, versionId: ver.rows[0]!.id, dimensions: dims };
  });
}

export async function setAvailability(
  definitionId: string,
  availability: DefinitionAvailability,
): Promise<void> {
  await inTx(async (c) => {
    await lockShared(c);
    await c.query('update tone_definition set availability = $2 where id = $1', [
      definitionId,
      availability,
    ]);
  });
}

/** Runs `fn` while no `withSoleAvailableDefinition` window can retire this suite's definitions. */
export async function withStableDefinitions<T>(fn: () => Promise<T>): Promise<T> {
  const c = await connect();
  try {
    await c.query('select pg_advisory_lock_shared($1)', [DEFINITION_LOCK]);
    stableDepth += 1;
    return await fn();
  } finally {
    stableDepth = Math.max(0, stableDepth - 1);
    await c.query('select pg_advisory_unlock_shared($1)', [DEFINITION_LOCK]).catch(() => undefined);
    c.release();
  }
}

/**
 * Runs `fn` while `definitionId` is the only `available` definition (others are retired for the duration and
 * restored afterwards). Holds DEFINITION_LOCK so suites using these helpers cannot add available definitions meanwhile.
 */
export async function withSoleAvailableDefinition<T>(
  definitionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const c = await connect();
  try {
    await c.query('select pg_advisory_lock($1)', [DEFINITION_LOCK]);
    const others = await c.query<{ id: string }>(
      `update tone_definition set availability = 'retired' where availability = 'available' and id <> $1 returning id`,
      [definitionId],
    );
    await c.query(`update tone_definition set availability = 'available' where id = $1`, [
      definitionId,
    ]);
    try {
      return await fn();
    } finally {
      await c.query(
        `update tone_definition set availability = 'available' where id = any($1::uuid[])`,
        [others.rows.map((r) => r.id)],
      );
    }
  } finally {
    await c.query('select pg_advisory_unlock($1)', [DEFINITION_LOCK]).catch(() => undefined);
    c.release();
  }
}

/** A chosen definition with its active (version-less) profile, written directly. Returns the profile id. */
export async function choose(userId: string, definitionId: string): Promise<string> {
  const pool = getPool();
  await pool.query('insert into user_definition_choice (user_id, definition_id) values ($1, $2)', [
    userId,
    definitionId,
  ]);
  const { rows } = await pool.query<{ id: string }>(
    `insert into tone_profile (user_id, definition_id, status) values ($1, $2, 'active') returning id`,
    [userId, definitionId],
  );
  return rows[0]!.id;
}

/** A valid profile body for TEST_DIMENSIONS; `extra` is appended to the `signature` value. */
export function sampleBody(contentItemId: string, extra = ''): ProfileBody {
  return {
    summary: 'Short, direct and friendly.',
    languages: [{ code: 'en', share: 1 }],
    dimensions: [
      { key: 'formality', value: 2, explanation: 'Mostly casual.', evidenceRefs: ['A1'] },
      { key: 'energy', value: 'lively', explanation: 'Upbeat.', evidenceRefs: ['A1'] },
      {
        key: 'signature',
        value: `Ends with a question.${extra}`,
        explanation: 'Seen often.',
        evidenceRefs: ['A1'],
      },
      {
        key: 'phrases',
        value: ['keep things simple'],
        explanation: 'Recurring.',
        evidenceRefs: ['A1'],
      },
    ],
    excerpts: [
      { text: 'we ship the roadmap', sampleRef: 'A1', contentItemId, dimensionKeys: ['formality'] },
      { text: 'next week and keep', sampleRef: 'A1', contentItemId, dimensionKeys: ['energy'] },
      { text: 'things simple', sampleRef: 'A1', contentItemId, dimensionKeys: ['phrases'] },
    ],
    doList: ['Be brief'],
    dontList: ['Avoid jargon'],
  };
}

/** A valid VoiceDocument; one section and one excerpt per aspect (default: tempo, warmth). */
export function sampleDocument(
  contentItemId: string,
  aspects: string[] = ['tempo', 'warmth'],
): VoiceDocument {
  return {
    aspects: aspects.map((key) => ({ key, name: key.charAt(0).toUpperCase() + key.slice(1) })),
    summary: 'Short, direct and friendly.',
    sections: aspects.map((key) => ({
      aspectKey: key,
      heading: key.charAt(0).toUpperCase() + key.slice(1),
      markdown: `Notes on ${key}.`,
    })),
    doList: ['Be brief'],
    dontList: ['Avoid jargon'],
    excerpts: aspects.map((key) => ({
      text: 'we ship the roadmap next week',
      sampleRef: 'A1',
      contentItemId,
      aspectKeys: [key],
    })),
    languages: [{ code: 'en', share: 1 }],
  };
}

/** Inserts a `generated` profile version (body encrypted) and makes it the profile's latest. */
export async function insertVersion(input: {
  profileId: string;
  body: ProfileBody | VoiceDocument;
  format?: 'structured' | 'document';
  promptSource?: 'default' | 'own' | null;
  ownPromptVersionId?: string | null;
  definitionVersionId: string;
  promptVersionId: string;
  sourceIds?: string[];
  authoredWords?: number;
}): Promise<string> {
  const pool = getPool();
  const { rows } = await pool.query<{ id: string }>(
    `insert into profile_version
       (profile_id, version_number, origin, definition_version_id, prompt_version_id, body_enc, languages,
        contributing_source_ids, contributing_item_count, format, prompt_source, own_prompt_version_id)
     select $1, coalesce(max(version_number), 0) + 1, 'generated', $2, $3, $4, '{en}', $5::uuid[], 1,
            $6::profile_version_format, $7::analysis_prompt_source, $8

     from profile_version where profile_id = $1
     returning id`,
    [
      input.profileId,
      input.definitionVersionId,
      input.promptVersionId,
      encrypt('user-content', JSON.stringify(input.body)),
      input.sourceIds ?? [],
      input.format ?? 'structured',
      input.promptSource ?? null,
      input.ownPromptVersionId ?? null,
    ],
  );
  await pool.query(
    'update tone_profile set latest_version_id = $2, authored_words_at_latest = $3 where id = $1',
    [input.profileId, rows[0]!.id, input.authoredWords ?? 0],
  );
  return rows[0]!.id;
}

/** Publishes a new active version of a (system) prompt template, creating the template when missing. */
export async function publishPromptVersion(
  key: string,
  templates: { system?: string; user?: string } = {},
): Promise<string> {
  return addPromptVersion(key, 'active', templates);
}

/** A non-active version (for pinning directly on generations); does not move the active pointer. */
export async function addPinnedPromptVersion(
  key: string,
  templates: { system?: string; user?: string } = {},
): Promise<string> {
  return addPromptVersion(key, 'superseded', templates);
}

/** The active version id of `key`, publishing one when the template has none. */
export async function ensureActivePrompt(key: string): Promise<string> {
  const { rows } = await getPool().query<{ active: string | null }>(
    'select active_version_id as active from prompt_template where key = $1',
    [key],
  );
  return rows[0]?.active ?? publishPromptVersion(key);
}

/**
 * Default templates per key family; each must pass the product whitelist (validateTemplate in
 * packages/core/src/prompting/variables.ts) so an active version left on the shared DB is publishable.
 */
function defaultTemplates(key: string): { system: string; user: string } {
  if (key.startsWith('draft.')) {
    return {
      system: 'You write a {{contentTypeLabel}} in the voice described. Excluded: {{excludedCategoryLabels}}',
      user: 'Brief: {{brief}}\nProfile: {{profileJson}}\nMemory:\n{{memoryContext}}',
    };
  }
  const user =
    'Voice: {{definition.name}}\nSamples:\n{{authoredSamples}}\n{{analysisPrompt}}\nContext:\n{{receivedContext}}\nPrevious: {{previousDocumentJson}}';
  return {
    system: 'You build tone profiles. Excluded: {{excludedCategoryLabels}}',
    // `feedback` is whitelisted for tone_profile.feedback (and custom.*), not for tone_profile.generate.
    user: key === 'tone_profile.generate' ? user : `${user}\n{{feedback}}`,
  };
}

async function addPromptVersion(
  key: string,
  status: 'active' | 'superseded',
  templates: { system?: string; user?: string },
): Promise<string> {
  return inTx(async (c) => {
    await c.query(
      `insert into prompt_template (key, is_system, description, created_by) values ($1, $2, 'test', $3)
       on conflict (key) do nothing`,
      [key, !key.startsWith('custom.'), SYSTEM_ACTOR],
    );
    const tpl = await c.query<{ id: string }>(
      'select id from prompt_template where key = $1 for update',
      [key],
    );
    const templateId = tpl.rows[0]!.id;
    if (status === 'active') {
      await c.query(
        `update prompt_template_version set status = 'superseded' where prompt_template_id = $1 and status = 'active'`,
        [templateId],
      );
    }
    const ver = await c.query<{ id: string }>(
      `insert into prompt_template_version
         (prompt_template_id, version_number, status, system_template, user_template, model, effort, max_tokens,
          created_by, published_by, published_at)
       select $1, coalesce(max(version_number), 0) + 1, $2, $3, $4, 'claude-sonnet-5-5', 'medium', 8000, $5, $5, now()
       from prompt_template_version where prompt_template_id = $1
       returning id`,
      [
        templateId,
        status,
        templates.system ?? defaultTemplates(key).system,
        templates.user ?? defaultTemplates(key).user,
        SYSTEM_ACTOR,
      ],
    );
    if (status === 'active') {
      await c.query('update prompt_template set active_version_id = $2 where id = $1', [
        templateId,
        ver.rows[0]!.id,
      ]);
    }
    return ver.rows[0]!.id;
  });
}

/** A user's own analysis prompt with version 1; `inUse` defaults to true. */
export async function seedOwnPrompt(input: {
  userId: string;
  definitionId: string;
  text: string;
  basedOnDefinitionVersionId: string;
  inUse?: boolean;
}): Promise<{ ownPromptId: string; versionId: string }> {
  return inTx(async (c) => {
    // in_use = true needs a current version (non-deferrable CHECK), so insert false, add the version, then flip.
    const own = await c.query<{ id: string }>(
      `insert into own_analysis_prompt (user_id, definition_id, in_use) values ($1, $2, false) returning id`,
      [input.userId, input.definitionId],
    );
    const ownPromptId = own.rows[0]!.id;
    const ver = await c.query<{ id: string }>(
      `insert into own_analysis_prompt_version
         (own_prompt_id, version_number, prompt_text_enc, char_count, based_on_definition_version_id)
       values ($1, 1, $2, $3, $4) returning id`,
      [
        ownPromptId,
        encrypt('user-content', input.text),
        input.text.length,
        input.basedOnDefinitionVersionId,
      ],
    );
    await c.query(
      'update own_analysis_prompt set current_version_id = $2, in_use = $3, updated_at = now() where id = $1',
      [ownPromptId, ver.rows[0]!.id, input.inUse ?? true],
    );
    return { ownPromptId, versionId: ver.rows[0]!.id };
  });
}

export interface SeedItem {
  text: string;
  kind?: ContentKind;
  authorship?: Authorship;
  date?: Date;
  /** Defaults to the whitespace word count of `text`. */
  words?: number;
  lang?: string;
}

/**
 * One `uploads` connected_source plus active content items (and occurrences). With a `store`, each item is also
 * written as a document (`Title: x` header + text) with `vs_*` metadata, cast to FilteredText as if it had been
 * stored earlier under older preferences.
 */
export async function seedAuthoredContent(input: {
  userId: string;
  items: SeedItem[];
  store?: MemoryStore;
  sourceId?: string;
}): Promise<{ sourceId: string; itemIds: string[] }> {
  const pool = getPool();
  const sourceId =
    input.sourceId ??
    (
      await pool.query<{ id: string }>(
        `insert into connected_source (user_id, type, account_label, status, consent_text_version)
         values ($1, 'uploads', 'Uploads', 'connected', 'v1') returning id`,
        [input.userId],
      )
    ).rows[0]!.id;
  const itemIds: string[] = [];
  for (const item of input.items) {
    const id = randomUUID();
    const kind = item.kind ?? 'note';
    const authorship = item.authorship ?? 'authored';
    const date = item.date ?? new Date();
    const words = item.words ?? item.text.split(/\s+/).filter(Boolean).length;
    await pool.query(
      `insert into content_item
         (id, user_id, kind, authorship, item_date, language_code, word_count, content_hash, filter_policy_version, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 1, 'active')`,
      [
        id,
        input.userId,
        kind,
        authorship,
        date,
        item.lang ?? 'en',
        words,
        randomBytes(32).toString('hex'),
      ],
    );
    await pool.query(
      `insert into content_item_occurrence (content_item_id, source_id, provider_ref) values ($1, $2, $3)`,
      [id, sourceId, randomUUID()],
    );
    if (input.store) {
      await input.store.addDocuments(namespaceFor(input.userId), [
        {
          id,
          content: `Title: x\n\n${item.text}` as FilteredText,
          documentDate: date.toISOString(),
          metadata: {
            [META.contentItemId]: id,
            [META.kind]: kind,
            [META.authorship]: authorship,
            [META.sourceIds]: [sourceId],
            [META.itemTs]: Math.floor(date.getTime() / 1000),
            [META.wordCount]: words,
            [META.lang]: item.lang ?? 'en',
            [META.filterPolicyVersion]: 1,
          },
        },
      ]);
    }
    itemIds.push(id);
  }
  return { sourceId, itemIds };
}

/** `n` words of plain authored prose. */
export function prose(n: number, seed = 'alpha'): string {
  const words = [
    'we',
    'ship',
    'the',
    'roadmap',
    'next',
    'week',
    'and',
    'keep',
    'things',
    'simple',
    seed,
  ];
  return Array.from({ length: n }, (_, i) => words[i % words.length]).join(' ');
}

/** Deletes every user (cascading profiles, versions, generations, choices, content) and definition created here. */
export async function cleanupProfiles(): Promise<void> {
  const pool = getPool();
  if (userIds.length > 0) {
    await pool.query('delete from deletion_request where user_id = any($1::uuid[])', [userIds]);
    await pool.query('delete from audit_log_entry where actor_user_id = any($1::uuid[])', [
      userIds,
    ]);
    await pool.query('delete from "user" where id = any($1::uuid[])', [userIds]);
  }
  if (definitionIds.length > 0) {
    await inTx(async (c) => {
      await lockShared(c);
      await c.query(
        'update tone_definition set active_version_id = null where id = any($1::uuid[])',
        [definitionIds],
      );
      await c.query('delete from tone_definition where id = any($1::uuid[])', [definitionIds]);
    });
  }
}

async function inTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await connect();
  try {
    await c.query('begin');
    const result = await fn(c);
    await c.query('commit');
    return result;
  } catch (err) {
    await c.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}
