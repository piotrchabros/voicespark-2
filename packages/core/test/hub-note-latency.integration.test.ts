import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { closeDb } from '@voicespark/db';
import type { ServiceContext } from '@voicespark/core/errors';
import type { HubNoteDoc } from '@voicespark/core/hub/content-schema';
import { createRecordedClassifier } from '@voicespark/filters';
import * as notes from '@voicespark/core/services/hub/notes';
import * as records from '@voicespark/core/services/hub/records';
import { cleanupProfiles, createUser } from './helpers/profiles';

// Note save latency (T153, plan.md "Performance Goals": note save p95 under 3 s with synchronous inspection including
// the classifier). The recorded classifier answers "nothing sensitive", so the deterministic detectors and the
// classifier call both run inside every save. If p95 exceeds 3 s the fallback is async staging (research Risk 12), a
// follow-up and not a change here.
vi.mock('@voicespark/core/queues', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@voicespark/core/queues')>()),
  enqueue: vi.fn(async () => ({})),
}));

vi.mock('@voicespark/core/services/inspection', async (importOriginal) => {
  const real = await importOriginal<typeof import('@voicespark/core/services/inspection')>();
  const recorded = createRecordedClassifier();
  return { ...real, getClassifier: vi.fn(() => recorded) };
});

process.env.DATABASE_URL ??= 'postgres://voicespark:voicespark@localhost:55432/voicespark_test';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-00';
process.env.ENCRYPTION_KEYRING ??= JSON.stringify({ k1: Buffer.alloc(32, 1).toString('base64') });
process.env.ENCRYPTION_ACTIVE_KEY_ID ??= 'k1';
process.env.DEDUP_HMAC_KEY ??= Buffer.alloc(32, 2).toString('base64');
process.env.REDIS_URL ??= 'redis://localhost:56379';
process.env.HUB_FILES_DIR ??= mkdtempSync(join(tmpdir(), 'hub-note-latency-'));
process.env.NODE_ENV ??= 'test';

const SAVES = 100;
const P95_LIMIT_MS = 3_000;

const body = (i: number): HubNoteDoc => ({
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: `Meeting ${i}` }] },
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: `Discussed the harvest plan, delivery windows and the revised budget for round ${i}. Next steps agreed with the team.`,
        },
      ],
    },
    { type: 'bulletList', content: [1, 2, 3].map((n) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: `Action item ${n} for round ${i}` }] }] })) },
  ],
});

afterAll(async () => {
  await cleanupProfiles();
  await closeDb();
});

describe('note save latency (plan.md "Performance Goals")', () => {
  it(`p95 of ${SAVES} saves with the recorded classifier is under 3 s`, async () => {
    const ctx: ServiceContext = { userId: await createUser(), role: 'user' };
    const { record } = await records.create(ctx, 'person', { name: 'Anna Nowak' });

    const durations: number[] = [];
    for (let i = 0; i < SAVES; i++) {
      const started = performance.now();
      await notes.create(ctx, 'person', record.id, { title: `Minutes ${i}`, body: body(i) });
      durations.push(performance.now() - started);
    }
    durations.sort((a, b) => a - b);
    const p95 = durations[Math.ceil(SAVES * 0.95) - 1]!;
    console.info(
      `hub note save: n=${SAVES} p50=${durations[Math.floor(SAVES / 2)]!.toFixed(1)} ms p95=${p95.toFixed(1)} ms max=${durations[SAVES - 1]!.toFixed(1)} ms`,
    );
    expect(p95).toBeLessThan(P95_LIMIT_MS);
  }, 120_000);
});
