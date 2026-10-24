import { describe, expect, it } from 'vitest';
import {
  JOBS,
  JOB_OPTIONS,
  JOB_QUEUE,
  PAYLOAD_SCHEMAS,
  HUB_CONCURRENCY,
  QUEUES,
  cappedExponentialBackoff,
  jobIds,
  type JobName,
} from '../src/queues';

const uuid = '3f2b8c1e-5a7d-4e90-8b1a-2c3d4e5f6a7b';

describe('queue payload schemas', () => {
  it('accepts id-only payloads', () => {
    expect(PAYLOAD_SCHEMAS['import.page'].safeParse({ userId: uuid, sourceId: uuid, importJobId: uuid }).success).toBe(true);
    expect(PAYLOAD_SCHEMAS['notify.send'].safeParse({ notificationId: uuid }).success).toBe(true);
    expect(PAYLOAD_SCHEMAS['maintenance.tmp-sweep'].safeParse({}).success).toBe(true);
    expect(PAYLOAD_SCHEMAS['deletion.execute'].safeParse({ deletionRequestId: uuid, waitCount: 3 }).success).toBe(true);
    expect(PAYLOAD_SCHEMAS['analysis.preview'].safeParse({ definitionVersionId: uuid, adminId: uuid }).success).toBe(true);
  });

  it('rejects content-like extra fields and non-uuid ids', () => {
    expect(PAYLOAD_SCHEMAS['draft.generate'].safeParse({ userId: uuid, draftId: uuid, brief: 'secret text' }).success).toBe(false);
    expect(PAYLOAD_SCHEMAS['maintenance.deletion-sla'].safeParse({ body: 'x' }).success).toBe(false);
    expect(PAYLOAD_SCHEMAS['sync.poll'].safeParse({ userId: 'nope', sourceId: uuid }).success).toBe(false);
    expect(PAYLOAD_SCHEMAS['deletion.execute'].safeParse({ deletionRequestId: uuid, waitCount: -1 }).success).toBe(false);
    expect(PAYLOAD_SCHEMAS['analysis.preview'].safeParse({ definitionVersionId: uuid, adminId: uuid, prompt: 'x' }).success).toBe(false);
    expect(PAYLOAD_SCHEMAS['analysis.preview'].safeParse({ definitionVersionId: uuid }).success).toBe(false);
    expect(PAYLOAD_SCHEMAS['analysis.preview'].safeParse({ definitionVersionId: 'nope', adminId: uuid }).success).toBe(false);
  });

  it('maps every job to a known queue and has options and a schema', () => {
    const queues = new Set<string>(Object.values(QUEUES));
    for (const name of Object.values(JOBS) as JobName[]) {
      expect(queues.has(JOB_QUEUE[name])).toBe(true);
      expect(JOB_OPTIONS[name].attempts).toBeGreaterThanOrEqual(1);
      expect(PAYLOAD_SCHEMAS[name]).toBeDefined();
    }
  });
});

describe('job ids', () => {
  it('never contain a colon', () => {
    const ids = Object.values(jobIds).map((fn) => fn(uuid, 1));
    expect(ids).toHaveLength(16);
    for (const value of ids) expect(value).not.toContain(':');
    expect(jobIds.import(uuid)).toBe(`import-${uuid}`);
    expect(jobIds.deletionVerify(uuid)).toBe(`deletion-${uuid}-verify`);
    expect(jobIds.preview(uuid)).toBe(`preview-${uuid}`);
  });
});

describe('context hub jobs', () => {
  it('accepts strict hub payloads and rejects extras', () => {
    expect(PAYLOAD_SCHEMAS['hub.thread'].safeParse({ userId: uuid, threadId: uuid, version: 2 }).success).toBe(true);
    expect(PAYLOAD_SCHEMAS['hub.backfill'].safeParse({ userId: uuid, sourceId: uuid }).success).toBe(true);
    expect(PAYLOAD_SCHEMAS['hub.sync'].safeParse({ userId: uuid }).success).toBe(true);
    expect(PAYLOAD_SCHEMAS['hub.file-extract'].safeParse({ userId: uuid, fileId: uuid }).success).toBe(true);
    expect(PAYLOAD_SCHEMAS['hub.refilter'].safeParse({ userId: uuid, policyVersion: 3 }).success).toBe(true);
    expect(PAYLOAD_SCHEMAS['maintenance.hub-blob-sweep'].safeParse({}).success).toBe(true);
    expect(PAYLOAD_SCHEMAS['hub.thread'].safeParse({ userId: uuid, threadId: uuid, version: 1, body: 'x' }).success).toBe(false);
    expect(PAYLOAD_SCHEMAS['hub.sync'].safeParse({ userId: uuid, sourceId: uuid }).success).toBe(false);
    expect(PAYLOAD_SCHEMAS['hub.thread'].safeParse({ userId: uuid, threadId: 'nope', version: 1 }).success).toBe(false);
    expect(PAYLOAD_SCHEMAS['maintenance.hub-sync-sweep'].safeParse({ x: 1 }).success).toBe(false);
  });

  it('routes hub jobs to hub and sweeps to maintenance', () => {
    for (const n of ['hub.thread', 'hub.backfill', 'hub.sync', 'hub.file-extract', 'hub.refilter'] as const) {
      expect(JOB_QUEUE[n]).toBe(QUEUES.hub);
    }
    for (const n of ['maintenance.hub-thread-sweep', 'maintenance.hub-sync-sweep', 'maintenance.hub-blob-sweep'] as const) {
      expect(JOB_QUEUE[n]).toBe(QUEUES.maintenance);
      expect(JOB_OPTIONS[n].attempts).toBe(1);
    }
  });

  it('removes finished runs of jobs re-enqueued under a fixed id', () => {
    // A kept completed or failed job would silently drop a later enqueue with the same id (re-enable, retry).
    for (const n of ['hub.thread', 'hub.backfill', 'hub.sync', 'hub.refilter'] as const) {
      expect(JOB_OPTIONS[n]).toMatchObject({ removeOnComplete: true, removeOnFail: true });
    }
  });

  it('sets attempts, backoff, ids and concurrency', () => {
    expect(JOB_OPTIONS['hub.thread'].attempts).toBe(1);
    expect(JOB_OPTIONS['hub.sync'].attempts).toBe(1);
    expect(JOB_OPTIONS['hub.backfill']).toMatchObject({ attempts: 5, backoff: { type: 'exponential', delay: 30_000 } });
    expect(JOB_OPTIONS['hub.file-extract']).toMatchObject({ attempts: 3, backoff: { type: 'exponential', delay: 10_000 } });
    expect(JOB_OPTIONS['hub.refilter']).toMatchObject({ attempts: 3, backoff: { type: 'exponential', delay: 30_000 } });
    expect(jobIds.hubThread(uuid, 4)).toBe(`hubthread-${uuid}-4`);
    expect(jobIds.hubBackfill(uuid)).toBe(`hubbackfill-${uuid}`);
    expect(jobIds.hubSync(uuid)).toBe(`hubsync-${uuid}`);
    expect(jobIds.hubFile(uuid)).toBe(`hubfile-${uuid}`);
    expect(jobIds.hubRefilter(uuid, 7)).toBe(`hubrefilter-${uuid}-7`);
    expect(HUB_CONCURRENCY).toEqual({ thread: 4, backfill: 1, sync: 4, fileExtract: 2, refilter: 1 });
  });
});

describe('analysis.preview', () => {
  it('runs on the profile queue with a single attempt', () => {
    expect(JOB_QUEUE['analysis.preview']).toBe(QUEUES.profile);
    expect(JOB_OPTIONS['analysis.preview'].attempts).toBe(1);
  });
});

describe('backoff', () => {
  it('doubles from 60 s and caps at 2 h', () => {
    expect(cappedExponentialBackoff(1)).toBe(60_000);
    expect(cappedExponentialBackoff(2)).toBe(120_000);
    expect(cappedExponentialBackoff(3)).toBe(240_000);
    expect(cappedExponentialBackoff(8)).toBe(7_200_000);
    expect(cappedExponentialBackoff(12)).toBe(7_200_000);
  });

  it('uses the capped strategy for deletion', () => {
    expect(JOB_OPTIONS['deletion.execute'].attempts).toBe(12);
    expect(JOB_OPTIONS['deletion.execute'].backoff).toEqual({ type: 'cappedExponential', delay: 60_000 });
  });
});
