import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getPool } from '@voicespark/db';
import { AppError, type ServiceContext } from '@voicespark/core/errors';
import { enqueue } from '@voicespark/core/queues';
import * as mailboxes from '@voicespark/core/services/hub/mailboxes';
import { cleanupProfiles, createUser } from './helpers/profiles';

// US3 mailbox settings (T101; contracts/http-api.md "Mailboxes and ignore rules"; FR-012, FR-022, FR-031, FR-032).
vi.mock('@voicespark/core/queues', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@voicespark/core/queues')>()),
  enqueue: vi.fn(async () => ({})),
}));

process.env.DATABASE_URL ??= 'postgres://voicespark:voicespark@localhost:55432/voicespark_test';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-00';
process.env.ENCRYPTION_KEYRING ??= JSON.stringify({ k1: Buffer.alloc(32, 1).toString('base64') });
process.env.ENCRYPTION_ACTIVE_KEY_ID ??= 'k1';
process.env.DEDUP_HMAC_KEY ??= Buffer.alloc(32, 2).toString('base64');
process.env.REDIS_URL ??= 'redis://localhost:56379';
process.env.NODE_ENV ??= 'test';

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

const q = async <T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T[]> =>
  (await getPool().query<T>(sql, params)).rows;

async function newCtx(): Promise<ServiceContext> {
  return { userId: await createUser(), role: 'user' };
}

async function newSource(userId: string, label = 'box@example.test'): Promise<string> {
  const rows = await q<{ id: string }>(
    `insert into connected_source (user_id, type, account_label, account_address, status, consent_text_version)
     values ($1, 'imap', $2, $2, 'connected', 'v1') returning id`,
    [userId, label],
  );
  return rows[0]!.id;
}

async function newThread(userId: string, sourceId: string, status: string, key: string): Promise<string> {
  const rows = await q<{ id: string }>(
    `insert into hub_thread (user_id, thread_key, status, attempts, last_error_code, next_attempt_at)
     values ($1, $2, $3, 8, 'llm_unavailable', null) returning id`,
    [userId, key.repeat(64).slice(0, 64), status],
  );
  await q('insert into hub_thread_source (user_id, thread_id, source_id) values ($1, $2, $3)', [
    userId,
    rows[0]!.id,
    sourceId,
  ]);
  return rows[0]!.id;
}

async function auditRows(userId: string, action: string) {
  return q<{ metadata: Record<string, unknown> }>(
    'select metadata from audit_log_entry where actor_user_id = $1 and action = $2',
    [userId, action],
  );
}

const enqueueMock = vi.mocked(enqueue);

beforeEach(() => {
  enqueueMock.mockClear();
});

afterAll(async () => {
  await cleanupProfiles();
  await closeDb();
});

describe('hub mailboxes', () => {
  it('is off for a source without a row', async () => {
    const ctx = await newCtx();
    const sourceId = await newSource(ctx.userId);
    expect(await mailboxes.isEnabled(sourceId)).toBe(false);
    const [item] = await mailboxes.list(ctx);
    expect(item).toMatchObject({ sourceId, enabled: false, backfillState: 'none', dataChoice: null, failedThreads: [] });
  });

  it('enable stores consent, sets backfill pending, enqueues hub.backfill and audits', async () => {
    const ctx = await newCtx();
    const sourceId = await newSource(ctx.userId);
    const mailbox = await mailboxes.enable(ctx, sourceId, { acknowledgeAi: true });
    expect(mailbox).toMatchObject({ sourceId, enabled: true, backfillState: 'pending', dataChoice: null });
    expect(await mailboxes.isEnabled(sourceId)).toBe(true);
    const [row] = await q<Record<string, unknown>>('select * from hub_mailbox_setting where source_id = $1', [sourceId]);
    expect(row!.consent_text_version).toBe(mailboxes.HUB_CONSENT_TEXT_VERSION);
    expect(row!.enabled_at).toBeInstanceOf(Date);
    expect(row!.disabled_at).toBeNull();
    expect(row!.backfill_state).toBe('pending');
    expect(enqueueMock).toHaveBeenCalledWith(
      'hub.backfill',
      { userId: ctx.userId, sourceId },
      { jobId: `hubbackfill-${sourceId}` },
    );
    const audits = await auditRows(ctx.userId, 'hub.mailbox_enabled');
    expect(audits.map((a) => a.metadata)).toEqual([
      { sourceId, consentTextVersion: mailboxes.HUB_CONSENT_TEXT_VERSION },
    ]);
  });

  it('enable without acknowledgeAi true is 422 validation_failed and changes nothing', async () => {
    const ctx = await newCtx();
    const sourceId = await newSource(ctx.userId);
    await expectCode(mailboxes.enable(ctx, sourceId, {} as never), 'validation_failed', 422);
    await expectCode(mailboxes.enable(ctx, sourceId, { acknowledgeAi: false } as never), 'validation_failed', 422);
    expect(await q('select 1 from hub_mailbox_setting where source_id = $1', [sourceId])).toHaveLength(0);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('enable twice is 409 conflict', async () => {
    const ctx = await newCtx();
    const sourceId = await newSource(ctx.userId);
    await mailboxes.enable(ctx, sourceId, { acknowledgeAi: true });
    await expectCode(mailboxes.enable(ctx, sourceId, { acknowledgeAi: true }), 'conflict', 409);
  });

  it('a source of another user is 404 for enable, disable and retry', async () => {
    const ctx = await newCtx();
    const other = await newCtx();
    const foreign = await newSource(other.userId);
    await expectCode(mailboxes.enable(ctx, foreign, { acknowledgeAi: true }), 'not_found', 404);
    await expectCode(mailboxes.disable(ctx, foreign, { hubData: 'keep' }), 'not_found', 404);
    await expectCode(
      mailboxes.retryThread(ctx, foreign, '00000000-0000-4000-8000-000000000000'),
      'not_found',
      404,
    );
    expect(await q('select 1 from hub_mailbox_setting where source_id = $1', [foreign])).toHaveLength(0);
    expect(await mailboxes.list(ctx)).toEqual([]);
  });

  it('disable keep records the choice and audits', async () => {
    const ctx = await newCtx();
    const sourceId = await newSource(ctx.userId);
    await mailboxes.enable(ctx, sourceId, { acknowledgeAi: true });
    const res = await mailboxes.disable(ctx, sourceId, { hubData: 'keep' });
    expect(res.mailbox).toMatchObject({ enabled: false, dataChoice: 'keep' });
    expect(res.deletionRequestId).toBeNull();
    const [row] = await q<Record<string, unknown>>('select * from hub_mailbox_setting where source_id = $1', [sourceId]);
    expect(row).toMatchObject({ enabled: false, data_choice: 'keep' });
    expect(row!.disabled_at).toBeInstanceOf(Date);
    expect((await auditRows(ctx.userId, 'hub.mailbox_disabled')).map((a) => a.metadata)).toEqual([
      { sourceId, hubData: 'keep' },
    ]);
    expect(await q('select 1 from deletion_request where user_id = $1', [ctx.userId])).toHaveLength(0);
    expect(await mailboxes.isEnabled(sourceId)).toBe(false);
  });

  it('disable delete creates a hub_source deletion request', async () => {
    const ctx = await newCtx();
    const sourceId = await newSource(ctx.userId);
    await mailboxes.enable(ctx, sourceId, { acknowledgeAi: true });
    const res = await mailboxes.disable(ctx, sourceId, { hubData: 'delete' });
    expect(res.mailbox).toMatchObject({ enabled: false, dataChoice: 'delete' });
    const rows = await q<{ id: string; scope: string; target_id: string }>(
      'select id, scope, target_id from deletion_request where user_id = $1',
      [ctx.userId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scope: 'hub_source', target_id: sourceId });
    expect(res.deletionRequestId).toBe(rows[0]!.id);
    expect((await auditRows(ctx.userId, 'hub.mailbox_disabled')).map((a) => a.metadata)).toEqual([
      { sourceId, hubData: 'delete' },
    ]);
  });

  it('disable validates hubData and requires an enabled mailbox', async () => {
    const ctx = await newCtx();
    const sourceId = await newSource(ctx.userId);
    await expectCode(mailboxes.disable(ctx, sourceId, { hubData: 'keep' }), 'hub_not_enabled', 409);
    await mailboxes.enable(ctx, sourceId, { acknowledgeAi: true });
    await expectCode(mailboxes.disable(ctx, sourceId, { hubData: 'x' } as never), 'validation_failed', 422);
    await mailboxes.disable(ctx, sourceId, { hubData: 'keep' });
    await expectCode(mailboxes.disable(ctx, sourceId, { hubData: 'keep' }), 'hub_not_enabled', 409);
  });

  it('re-enable clears disabled_at and data_choice', async () => {
    const ctx = await newCtx();
    const sourceId = await newSource(ctx.userId);
    await mailboxes.enable(ctx, sourceId, { acknowledgeAi: true });
    await mailboxes.disable(ctx, sourceId, { hubData: 'keep' });
    await mailboxes.enable(ctx, sourceId, { acknowledgeAi: true });
    const [row] = await q<Record<string, unknown>>('select * from hub_mailbox_setting where source_id = $1', [sourceId]);
    expect(row).toMatchObject({ enabled: true, disabled_at: null, data_choice: null, backfill_state: 'pending' });
  });

  it('list returns counters, failed threads and a threads_failed recomputed from hub_thread', async () => {
    const ctx = await newCtx();
    const sourceId = await newSource(ctx.userId);
    await mailboxes.enable(ctx, sourceId, { acknowledgeAi: true });
    await q('update hub_mailbox_setting set threads_processed = 7, threads_skipped = 2, threads_failed = 99 where source_id = $1', [
      sourceId,
    ]);
    const failed = await newThread(ctx.userId, sourceId, 'failed', 'a');
    await newThread(ctx.userId, sourceId, 'failed', 'b');
    await newThread(ctx.userId, sourceId, 'done', 'c');
    const [item] = await mailboxes.list(ctx);
    expect(item).toMatchObject({
      sourceId,
      accountLabel: 'box@example.test',
      status: 'connected',
      enabled: true,
      backfillState: 'pending',
      pausedUntil: null,
      threadsProcessed: 7,
      threadsSkipped: 2,
      threadsFailed: 2,
      lastRunAt: null,
      dataChoice: null,
    });
    expect(item!.failedThreads).toHaveLength(2);
    expect(item!.failedThreads.find((t) => t.id === failed)).toMatchObject({
      subjectAvailable: false,
      errorCode: 'llm_unavailable',
      attempts: 8,
    });
  });

  it('list sets pausedUntil to the next UTC midnight when the daily cap is reached', async () => {
    const ctx = await newCtx();
    const sourceId = await newSource(ctx.userId);
    await mailboxes.enable(ctx, sourceId, { acknowledgeAi: true });
    await q(
      `insert into app_setting (key, value) values ('hub.daily_thread_cap_per_user', '1'::jsonb)
       on conflict (key) do update set value = excluded.value`,
      [],
    );
    try {
      expect((await mailboxes.list(ctx))[0]!.pausedUntil).toBeNull();
      await q(`insert into hub_llm_call (user_id, purpose, model, prompt_version, input_tokens, output_tokens)
       values ($1, 'extract', 'm', 'v1', 1, 1)`, [ctx.userId]);
      const paused = (await mailboxes.list(ctx))[0]!.pausedUntil;
      expect(paused).not.toBeNull();
      const at = new Date(paused!);
      expect(at.getTime()).toBeGreaterThan(Date.now());
      expect(at.getTime() - Date.now()).toBeLessThanOrEqual(24 * 3600 * 1000);
      expect([at.getUTCHours(), at.getUTCMinutes(), at.getUTCSeconds()]).toEqual([0, 0, 0]);
    } finally {
      await q(`delete from app_setting where key = 'hub.daily_thread_cap_per_user'`, []);
    }
  });

  it('retryThread resets a failed thread and enqueues hub.thread', async () => {
    const ctx = await newCtx();
    const sourceId = await newSource(ctx.userId);
    await mailboxes.enable(ctx, sourceId, { acknowledgeAi: true });
    const threadId = await newThread(ctx.userId, sourceId, 'failed', 'd');
    enqueueMock.mockClear();
    await mailboxes.retryThread(ctx, sourceId, threadId);
    const [row] = await q<Record<string, unknown>>('select * from hub_thread where id = $1', [threadId]);
    expect(row).toMatchObject({ status: 'pending', attempts: 0, last_error_code: null });
    expect(row!.next_attempt_at).toBeInstanceOf(Date);
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock.mock.calls[0]![0]).toBe('hub.thread');
    expect(enqueueMock.mock.calls[0]![1]).toMatchObject({ userId: ctx.userId, threadId });
  });

  it('retryThread is 409 conflict for a thread that is not failed and 404 for an unknown or foreign thread', async () => {
    const ctx = await newCtx();
    const sourceId = await newSource(ctx.userId);
    await mailboxes.enable(ctx, sourceId, { acknowledgeAi: true });
    const done = await newThread(ctx.userId, sourceId, 'done', 'e');
    enqueueMock.mockClear();
    await expectCode(mailboxes.retryThread(ctx, sourceId, done), 'conflict', 409);
    expect(enqueueMock).not.toHaveBeenCalled();
    await expectCode(
      mailboxes.retryThread(ctx, sourceId, '00000000-0000-4000-8000-000000000000'),
      'not_found',
      404,
    );
    const other = await newCtx();
    const otherSource = await newSource(other.userId, 'other@example.test');
    const foreignThread = await newThread(other.userId, otherSource, 'failed', 'f');
    await expectCode(mailboxes.retryThread(ctx, sourceId, foreignThread), 'not_found', 404);
  });
});
