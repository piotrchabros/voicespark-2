import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getPool, type DraftContentType } from '@voicespark/db';
import type { ServiceContext } from '@voicespark/core/errors';
import { createFakeGenerationLlm, DRAFT_PROMPT_KEY } from '@voicespark/core/prompting';
import * as drafts from '@voicespark/core/services/drafts';
import { createRecordedClassifier } from '@voicespark/filters';
import { InMemoryMemoryStore } from '@voicespark/integrations/supermemory';
import { createDraftHandler, type DraftRunResult } from '../src/processors/draft';
import {
  choose,
  cleanupProfiles,
  confirmPreferences,
  createUser,
  ensureActivePrompt,
  insertVersion,
  publishPromptVersion,
  sampleBody,
  seedAuthoredContent,
  seedDefinition,
} from './helpers/profiles';

// SC-012: a draft is ready within 60 s of the request. The pipeline around the model (load + decrypt, inspection of
// every input under current preferences, memory search, render, output inspection, persist, notify) is measured here
// with the deterministic fake LLM over 20 sequential runs; the real-model latency is a pilot measurement (runbook).
// Compose Postgres + in-memory Supermemory; queues mocked.
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

const RUNS = 20;
const SC012_MS = 60_000;
const CONTENT_TYPES: DraftContentType[] = ['social_post', 'bio', 'short_article'];
const BRIEFS = [
  'Announce the roadmap launch next week to the whole community and invite feedback',
  'Introduce myself to a new team as the person who keeps things simple',
  'Explain why we ship small changes often and what it means for customers',
  'Thank the early readers for their patience during the slow season',
];

/** Draft prompt templates may not be seeded in this database; a minimal one keeps the run representative. */
async function ensureDraftPrompt(type: DraftContentType): Promise<void> {
  const key = DRAFT_PROMPT_KEY[type];
  const { rows } = await getPool().query<{ active: string | null }>(
    'select active_version_id as active from prompt_template where key = $1',
    [key],
  );
  if (rows[0]?.active) return;
  await publishPromptVersion(key, {
    system:
      'You write a {{contentTypeLabel}} in the voice described. Excluded: {{excludedCategoryLabels}}',
    user: 'Brief: {{brief}}\nProfile: {{profileJson}}\nMemory:\n{{memoryContext}}',
  });
}

function fakeJob(userId: string, draftId: string) {
  return {
    id: `draft-${draftId}`,
    name: 'draft.generate',
    data: { userId, draftId },
    attemptsMade: 0,
    opts: { attempts: 2 },
    moveToDelayed: vi.fn(),
    updateData: vi.fn(),
  } as unknown as Job<{ userId: string; draftId: string }, unknown, 'draft.generate'>;
}

/** Nearest-rank percentile of `sorted` ascending. */
function percentile(sorted: number[], p: number): number {
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

beforeAll(async () => {
  await getPool().query('select 1');
  for (const type of CONTENT_TYPES) await ensureDraftPrompt(type);
});

afterAll(async () => {
  await cleanupProfiles();
  await closeDb();
});

describe('SC-012: draft latency', () => {
  it(
    `p95 of ${RUNS} sequential draft runs with the fake LLM is under 60 s`,
    async () => {
      const userId = await createUser('Ada Lovelace');
      const ctx: ServiceContext = { userId, role: 'user' };
      await confirmPreferences(userId);
      const profilePrompt = await ensureActivePrompt('tone_profile.generate');
      const def = await seedDefinition({ name: 'Voice Latency Test' });
      const profileId = await choose(userId, def.definitionId);
      await insertVersion({
        profileId,
        body: sampleBody(randomUUID()),
        definitionVersionId: def.versionId,
        promptVersionId: profilePrompt,
      });
      // Some own memory so the search and snippet path is exercised.
      const store = new InMemoryMemoryStore();
      await seedAuthoredContent({
        userId,
        store,
        items: Array.from({ length: 30 }, (_, i) => ({
          text: `Note number ${i}: we demoed the roadmap launch to a room of customers and kept things simple throughout.`,
        })),
      });
      const handler = createDraftHandler({
        store,
        classifier: createRecordedClassifier(),
        llm: createFakeGenerationLlm(),
      });

      const durations: number[] = [];
      for (let i = 0; i < RUNS; i++) {
        const { draftId } = await drafts.create(ctx, {
          contentType: CONTENT_TYPES[i % CONTENT_TYPES.length]!,
          profileId,
          brief: BRIEFS[i % BRIEFS.length]!,
        });
        const started = Date.now();
        const result = (await handler(fakeJob(userId, draftId), 'token')) as DraftRunResult;
        durations.push(Date.now() - started);
        expect(result.outcome).toBe('ready');
        expect((await drafts.get(ctx, draftId)).status).toBe('ready');
      }

      const sorted = [...durations].sort((a, b) => a - b);
      const p50Ms = percentile(sorted, 50);
      const p95Ms = percentile(sorted, 95);
      console.info({ sc: 'SC-012', runs: RUNS, p50Ms, p95Ms, maxMs: sorted.at(-1) });
      expect(p95Ms).toBeLessThan(SC012_MS);
    },
    RUNS * SC012_MS,
  );
});
