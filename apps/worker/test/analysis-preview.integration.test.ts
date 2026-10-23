import type { Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getPool } from '@voicespark/db';
import {
  ANALYSIS_GUARD_REMINDER,
  createFakeGenerationLlm,
  FAKE_DOC_MARKERS,
  fillLabels,
  stripNeutralizer,
} from '@voicespark/core/prompting';
import type { Classifier } from '@voicespark/filters';
import {
  createFakeLlm,
  type LlmClient,
  type ParseStructuredArgs,
} from '@voicespark/integrations/anthropic';
import type { MemoryStore } from '@voicespark/integrations/supermemory';
import {
  createAnalysisPreviewHandler,
  type AnalysisPreviewResult,
} from '../src/processors/analysis-preview';
import {
  cleanupProfiles,
  createUser,
  ensureActivePrompt,
  seedDefinition,
} from './helpers/profiles';

// analysis.preview (T029, contracts/jobs.md behavior 10): synthetic samples only, no DB writes, no Supermemory.
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

const PROMPT =
  'Describe the voice.\n- Tone: how the writing feels.\n- Warmth: how friendly it reads.';

// Tables a generation, notification or audit entry would write to.
const WATCHED_TABLES = [
  'profile_version',
  'profile_generation',
  'notification',
  'audit_log_entry',
  'own_analysis_prompt_version',
  'tone_definition_version',
  'prompt_template_version',
  'content_item',
];

/** Fails the test on any access: the preview must never touch Supermemory or the classifier. */
function forbidden<T extends object>(name: string, touched: string[]): T {
  return new Proxy({} as T, {
    get: (_t, prop) => {
      touched.push(`${name}.${String(prop)}`);
      throw new Error(`${name} must not be used`);
    },
  });
}

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

async function rowCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of WATCHED_TABLES) {
    const { rows } = await getPool().query<{ n: string }>(
      `select count(*)::text as n from ${table}`,
    );
    out[table] = Number(rows[0]!.n);
  }
  return out;
}

async function createAdmin(status: 'active' | 'suspended' = 'active'): Promise<string> {
  const id = await createUser('Grace Admin');
  await getPool().query(
    `update "user" set role = 'admin', status = $2::user_status,
       suspended_at = case when $2 = 'suspended' then now() else null end
     where id = $1`,
    [id, status],
  );
  return id;
}

async function preview(
  llm: LlmClient,
  data: { definitionVersionId: string; adminId: string },
  touched: string[] = [],
): Promise<AnalysisPreviewResult> {
  const handler = createAnalysisPreviewHandler({
    llm,
    store: forbidden<MemoryStore>('store', touched),
    classifier: forbidden<Classifier>('classifier', touched),
  });
  const job = {
    id: 'preview-test',
    name: 'analysis.preview',
    data,
    attemptsMade: 0,
    opts: { attempts: 1 },
  } as unknown as Job<typeof data, unknown, 'analysis.preview'>;
  return (await handler(job)) as AnalysisPreviewResult;
}

let adminId: string;

beforeAll(async () => {
  await ensureActivePrompt('tone_profile.generate');
  adminId = await createAdmin();
});

afterAll(async () => {
  await cleanupProfiles();
  await closeDb();
});

describe('analysis.preview', () => {
  it('runs the active wrapper over synthetic samples only and writes nothing', async () => {
    const { versionId } = await seedDefinition({ analysisPrompt: PROMPT });
    const { llm, calls } = capturing();
    const touched: string[] = [];
    const before = await rowCounts();

    const result = await preview(llm, { definitionVersionId: versionId, adminId }, touched);

    expect(result.status).toBe('done');
    expect(result.problems).toEqual([]);
    expect(result.markdown).toContain('Fake document summary.');
    expect(result.markdown).toContain('### Tone');
    expect(result.markdown).toContain('### Warmth');
    expect(touched).toEqual([]);
    expect(await rowCounts()).toEqual(before);

    expect(calls).toHaveLength(1);
    const user = stripNeutralizer(calls[0]!.user);
    const samples = [...user.matchAll(/<sample [^>]*>([\s\S]*?)<\/sample>/g)].map((m) => m[1]!);
    expect(samples.length).toBeGreaterThan(0);
    for (const text of samples) expect(text.startsWith('SAMPLE TEXT')).toBe(true);
    const items = [...user.matchAll(/<item [^>]*>([\s\S]*?)<\/item>/g)].map((m) => m[1]!);
    for (const text of items) expect(text.startsWith('SAMPLE TEXT')).toBe(true);
    expect(user).toContain('<analysis_prompt source="default">\nDescribe the voice.');
    expect(calls[0]!.system.startsWith('You write a tone-of-voice document')).toBe(true);
  }, 30_000);

  it('fails for a non-admin or suspended admin without calling the model', async () => {
    const { versionId } = await seedDefinition({ analysisPrompt: PROMPT });
    const { llm, calls } = capturing();
    const plain = await createUser();
    const suspended = await createAdmin('suspended');

    for (const id of [plain, suspended]) {
      expect(await preview(llm, { definitionVersionId: versionId, adminId: id })).toEqual({
        status: 'failed',
        markdown: null,
        problems: ['admin_required'],
      });
    }
    expect(calls).toHaveLength(0);
  }, 30_000);

  it('fails for a missing version or an empty analysis prompt', async () => {
    const { llm, calls } = capturing();
    expect(
      await preview(llm, { definitionVersionId: '00000000-0000-4000-8000-0000000000ff', adminId }),
    ).toEqual({ status: 'failed', markdown: null, problems: ['not_found'] });

    const { versionId } = await seedDefinition({ analysisPrompt: null });
    expect(await preview(llm, { definitionVersionId: versionId, adminId })).toEqual({
      status: 'failed',
      markdown: null,
      problems: ['analysis_prompt_missing'],
    });
    expect(calls).toHaveLength(0);
  }, 30_000);

  it('retries once with the problem codes before the reminder, then fails with invalid_output', async () => {
    const { versionId } = await seedDefinition({
      analysisPrompt: `${PROMPT}\n${FAKE_DOC_MARKERS.noSummary}`,
    });
    const { llm, calls } = capturing();

    const result = await preview(llm, { definitionVersionId: versionId, adminId });

    expect(result).toEqual({
      status: 'failed',
      markdown: null,
      problems: ['invalid_output', 'summary_missing'],
    });
    expect(calls).toHaveLength(2);
    const retry = calls[1]!.user;
    const hint =
      'The previous answer had these problems: summary_missing. Return the full corrected JSON.';
    expect(calls[0]!.user).not.toContain(hint);
    expect(retry).toContain(hint);
    const reminder = retry.slice(retry.lastIndexOf('Reminder from the system.'));
    expect(retry.endsWith(reminder)).toBe(true);
    expect(retry.indexOf(hint)).toBeLessThan(retry.lastIndexOf('Reminder from the system.'));
    expect(reminder).toBe(
      fillLabels(ANALYSIS_GUARD_REMINDER, reminder.match(/categories \((.*)\)\./)![1]!),
    );
  }, 30_000);

  it('counts unparseable output as a failed call', async () => {
    const { versionId } = await seedDefinition({ analysisPrompt: PROMPT });
    const { llm, calls } = capturing(createFakeLlm(() => ({ summary: 42 })));

    expect(await preview(llm, { definitionVersionId: versionId, adminId })).toEqual({
      status: 'failed',
      markdown: null,
      problems: ['invalid_output', 'output_unparseable'],
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.user).toContain('The previous answer had these problems: output_unparseable.');
  }, 30_000);

  it('reports a refusal as llm_refused', async () => {
    const { versionId } = await seedDefinition({
      analysisPrompt: `${PROMPT}\n${FAKE_DOC_MARKERS.refuse}`,
    });
    const { llm, calls } = capturing();

    expect(await preview(llm, { definitionVersionId: versionId, adminId })).toEqual({
      status: 'failed',
      markdown: null,
      problems: ['llm_refused'],
    });
    expect(calls).toHaveLength(1);
  }, 30_000);
});
