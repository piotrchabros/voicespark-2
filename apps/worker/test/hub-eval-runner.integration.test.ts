import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getPool } from '@voicespark/db';
import { hubExtractionSchema } from '@voicespark/core/hub/extraction-schema';
import { loadConversations, type EvalConversation } from '../eval/hub/format';
import { METRIC_NAMES, pct, summarize, type FileResult } from '../eval/hub/grade';
import {
  createRecordingLlm,
  createReplayLlm,
  loadRecordings,
  writeRecording,
} from '../eval/hub/llm';
import { runConversation } from '../eval/hub/runner';
import { createSyntheticLlm } from '../eval/hub/synthetic-llm';

// T150 (research R14): the eval runner and grader without recordings. Synthetic answers built from each
// conversation's `expected` labels go through the real `recordMessage`, `hub.thread`, policy and apply code; a
// perfect answer must grade 100% on SC-004 with no wrong auto-applied fact, a deliberately wrong one must be
// reported as misses. Also checks the record/replay round trip of the replay client. Needs Postgres (no Redis:
// enqueues are captured).

vi.mock('@voicespark/core/queues', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@voicespark/core/queues')>()),
  enqueue: vi.fn(async () => ({})),
}));

process.env.DATABASE_URL ??= 'postgres://voicespark:voicespark@localhost:55432/voicespark_test';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-00';
process.env.ENCRYPTION_KEYRING ??= JSON.stringify({ k1: Buffer.alloc(32, 1).toString('base64') });
process.env.ENCRYPTION_ACTIVE_KEY_ID ??= 'k1';
process.env.DEDUP_HMAC_KEY ??= Buffer.alloc(32, 2).toString('base64');
process.env.NODE_ENV ??= 'test';

/** Business thread with links, a seeded owner-conflict person, a cross-mailbox duplicate, a role address, a
 * multi-address seed with a sister-company domain, a newsletter. */
const IDS = ['en-01', 'pl-18', 'x-01', 'holdout-03', 'holdout-07', 'holdout-01'];
const all = await loadConversations();
const pick = (id: string): EvalConversation => all.find((c) => c.id === id)!;

afterAll(async () => {
  await closeDb();
});

const sc004 = ['peopleCorrect', 'personCompanyLinks', 'projects'] as const;

describe('hub eval runner (synthetic answers)', () => {
  it('grades a perfect answer at 100% on SC-004 and SC-005 with no wrong auto-applied fact', async () => {
    const results: FileResult[] = [];
    for (const id of IDS) {
      const c = pick(id);
      const { result, runs } = await runConversation(c, createSyntheticLlm(c, 'perfect'));
      expect(result.error, id).toBeNull();
      expect(
        runs.every((r) => r.outcome === 'done' || r.outcome === 'skipped'),
        id,
      ).toBe(true);
      for (const m of sc004) expect(pct(result.metrics[m]) ?? 1, `${id} ${m}`).toBe(1);
      expect(result.metrics.duplicatePeople.hit, id).toBe(0);
      expect(result.metrics.automatedPeople.hit, id).toBe(0);
      expect(pct(result.metrics.autoPrecision) ?? 1, id).toBe(1);
      expect(
        result.misses.filter((m) => !m.startsWith('suggestion ')),
        id,
      ).toEqual([]);
      results.push(result);
    }
    // The newsletter is skipped before any model call; the cross-mailbox pair is one conversation.
    expect(results.find((r) => r.id === 'holdout-01')!.threads).toEqual([
      expect.objectContaining({ status: 'skipped' }),
    ]);
    expect(results.find((r) => r.id === 'x-01')!.threads).toHaveLength(1);
    const s = summarize('synthetic', results);
    for (const m of METRIC_NAMES)
      if (m !== 'suggestionShare') expect(s.metrics[m].pass, m).toBe(true);
    // Every user the runner made is gone again.
    const { rows } = await getPool().query(
      'select count(*)::int as n from "user" where email like \'hub-eval-%@example.test\'',
    );
    expect(rows[0].n).toBe(0);
  }, 120_000);

  it('reports misses for a wrong answer', async () => {
    const c = pick('en-01');
    const { result } = await runConversation(c, createSyntheticLlm(c, 'wrong'));
    expect(result.error).toBeNull();
    expect(pct(result.metrics.peopleCorrect)).toBe(0);
    expect(pct(result.metrics.personCompanyLinks)).toBe(0);
    expect(result.misses.some((m) => m.startsWith('person '))).toBe(true);
    expect(result.misses.some((m) => m.startsWith('link person_company'))).toBe(true);
    expect(summarize('wrong', [result]).passed).toBe(false);
  }, 60_000);

  it('replays a recording made from the same pipeline, and fails a stale one', async () => {
    const c = pick('holdout-07');
    const recorder = createRecordingLlm(createSyntheticLlm(c, 'perfect'));
    const recorded = await runConversation(c, recorder);
    expect(recorder.calls.map((x) => x.purpose)).toContain('extract');
    // Known-record ids differ per run: the recording keeps names only.
    expect(JSON.stringify(recorder.calls)).not.toMatch(
      /"existing(Person|Company|Project)Id":"[0-9a-f]{8}-/,
    );

    const dir = await mkdtemp(path.join(tmpdir(), 'hub-eval-rec-'));
    try {
      expect((await loadRecordings(dir)).size).toBe(0);
      expect((await loadRecordings(path.join(dir, 'missing'))).size).toBe(0);
      await writeRecording(
        {
          id: c.id,
          model: 'synthetic',
          promptVersion: 'hub-extract-v1',
          recordedAt: new Date().toISOString(),
          calls: recorder.calls,
        },
        dir,
      );
      const recording = (await loadRecordings(dir)).get(c.id)!;

      const replay = createReplayLlm(recording);
      const replayed = await runConversation(c, replay);
      expect(replay.problems).toEqual([]);
      expect(replayed.result.metrics).toEqual(recorded.result.metrics);

      const stale = createReplayLlm({
        ...recording,
        calls: recording.calls.map((x) => ({ ...x, promptHash: '0'.repeat(64) })),
      });
      await runConversation(c, stale);
      expect(stale.problems.length).toBeGreaterThan(0);
      expect(stale.problems[0]).toMatch(/prompt differs/);

      const empty = createReplayLlm({ ...recording, calls: [] });
      await expect(
        empty.parseStructured({
          model: 'm',
          effort: 'low',
          maxTokens: 1,
          system: 's',
          user: 'u',
          schema: hubExtractionSchema,
        }),
      ).rejects.toThrow(/no recorded extract call #1/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
