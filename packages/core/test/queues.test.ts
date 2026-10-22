import { describe, expect, it } from 'vitest';
import {
  JOBS,
  JOB_OPTIONS,
  JOB_QUEUE,
  PAYLOAD_SCHEMAS,
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
  });

  it('rejects content-like extra fields and non-uuid ids', () => {
    expect(PAYLOAD_SCHEMAS['draft.generate'].safeParse({ userId: uuid, draftId: uuid, brief: 'secret text' }).success).toBe(false);
    expect(PAYLOAD_SCHEMAS['maintenance.deletion-sla'].safeParse({ body: 'x' }).success).toBe(false);
    expect(PAYLOAD_SCHEMAS['sync.poll'].safeParse({ userId: 'nope', sourceId: uuid }).success).toBe(false);
    expect(PAYLOAD_SCHEMAS['deletion.execute'].safeParse({ deletionRequestId: uuid, waitCount: -1 }).success).toBe(false);
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
    expect(ids).toHaveLength(10);
    for (const value of ids) expect(value).not.toContain(':');
    expect(jobIds.import(uuid)).toBe(`import-${uuid}`);
    expect(jobIds.deletionVerify(uuid)).toBe(`deletion-${uuid}-verify`);
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
