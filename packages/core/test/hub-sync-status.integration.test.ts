import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getPool, withTransaction } from '@voicespark/db';
import { encrypt } from '@voicespark/core/crypto';
import { enqueue } from '@voicespark/core/queues';
import * as sync from '@voicespark/core/services/hub/sync';
import { cleanupProfiles, createUser } from './helpers/profiles';

// Sync status, retry and re-sync of the memory-store copy (T083; contracts/http-api.md "Sync", data-model.md
// "hub_sync_item"; FR-025, FR-026).
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

const H = (c: string) => c.repeat(64);
const enc = (text: string) => encrypt('user-content', text);
const ctxOf = (userId: string) => ({ userId, role: 'user' as const });

async function seedPerson(userId: string, name: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `insert into hub_person (user_id, name_enc, name_key, match_key) values ($1, $2, $3, $3) returning id`,
    [userId, enc(name), H('a')],
  );
  return rows[0]!.id;
}

async function seedNote(userId: string, personId: string, title: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `insert into hub_note (user_id, person_id, title_enc, body_json_enc) values ($1, $2, $3, 'x') returning id`,
    [userId, personId, enc(title)],
  );
  return rows[0]!.id;
}

async function seedFile(userId: string, personId: string, name: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `insert into hub_file (user_id, person_id, name_enc, mime_type, extension, size_bytes, sha256, storage_key, key_id)
     values ($1, $2, $3, 'text/plain', 'txt', 1, $4, gen_random_uuid(), 'k1') returning id`,
    [userId, personId, enc(name), H('d')],
  );
  return rows[0]!.id;
}

async function seedSummary(userId: string, subject: string): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `insert into hub_thread (user_id, thread_key, subject_enc, summary_enc, summary_version)
     values ($1, $2, $3, 'x', 1) returning id`,
    [userId, H('e'), enc(subject)],
  );
  return rows[0]!.id;
}

async function dirty(userId: string, type: sync.SyncEntityType, id: string): Promise<void> {
  await withTransaction((tx) => sync.markDirty(tx, userId, type, id));
}

async function rowOf(userId: string, entityId: string) {
  const { rows } = await getPool().query<{
    id: string;
    status: string;
    attempts: number;
    version: number;
    deleted: boolean;
    due: boolean;
  }>(
    `select id, status, attempts, version::int as version, deleted, next_attempt_at <= now() as due
       from hub_sync_item where user_id = $1 and entity_id = $2`,
    [userId, entityId],
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function fail(
  userId: string,
  entityId: string,
  errorCode = 'store_unavailable',
): Promise<string> {
  const { id } = await rowOf(userId, entityId);
  await getPool().query(
    `update hub_sync_item set status = 'failed', attempts = 3, last_error_code = $2,
            next_attempt_at = now() + interval '10 minutes' where id = $1`,
    [id, errorCode],
  );
  return id;
}

async function store(userId: string, entityId: string): Promise<void> {
  await getPool().query(
    `update hub_sync_item set status = 'stored', synced_version = version, last_synced_at = now()
      where user_id = $1 and entity_id = $2`,
    [userId, entityId],
  );
}

beforeEach(() => {
  vi.mocked(enqueue).mockClear();
});

afterAll(async () => {
  await cleanupProfiles();
  await closeDb();
});

describe('status', () => {
  it('returns counts per status and items with decrypted labels, own rows only, tombstones left out', async () => {
    const userId = await createUser();
    const other = await createUser();
    const personId = await seedPerson(userId, 'Anna Nowak');
    const noteId = await seedNote(userId, personId, 'Call notes');
    const fileId = await seedFile(userId, personId, 'offer.pdf');
    const threadId = await seedSummary(userId, 'Kickoff');
    for (const [t, id] of [
      ['person', personId],
      ['note', noteId],
      ['file', fileId],
      ['summary', threadId],
    ] as const)
      await dirty(userId, t, id);
    await store(userId, personId);
    await fail(userId, fileId);
    await withTransaction((tx) =>
      sync.tombstone(tx, userId, 'note', '33333333-3333-4333-8333-333333333333'),
    );
    await dirty(other, 'person', await seedPerson(other, 'Foreign'));

    const res = await sync.status(ctxOf(userId), {});
    expect(res.counts).toEqual({ stored: 1, pending: 2, failed: 1 });
    expect(res.items).toHaveLength(4);
    expect(res.nextCursor).toBeNull();
    const byEntity = new Map(res.items.map((i) => [i.entityId, i]));
    expect(byEntity.get(personId)).toMatchObject({
      entityType: 'person',
      label: 'Anna Nowak',
      status: 'stored',
    });
    expect(byEntity.get(personId)!.lastSyncedAt).toEqual(expect.any(String));
    expect(byEntity.get(noteId)).toMatchObject({
      entityType: 'note',
      label: 'Call notes',
      status: 'pending',
    });
    expect(byEntity.get(fileId)).toMatchObject({
      entityType: 'file',
      label: 'offer.pdf',
      status: 'failed',
      attempts: 3,
      lastErrorCode: 'store_unavailable',
      lastSyncedAt: null,
    });
    expect(byEntity.get(threadId)).toMatchObject({ entityType: 'summary', label: 'Kickoff' });
    expect(JSON.stringify(res)).not.toContain('Foreign');

    const failed = await sync.status(ctxOf(userId), { status: 'failed' });
    expect(failed.items.map((i) => i.entityId)).toEqual([fileId]);
    expect(failed.counts).toEqual(res.counts);
  });

  it('pages with a cursor, newest change first, and rejects a forged cursor', async () => {
    const userId = await createUser();
    const ids: string[] = [];
    for (const n of ['A', 'B', 'C']) {
      const id = await seedPerson(userId, n);
      await dirty(userId, 'person', id);
      ids.push(id);
    }
    const first = await sync.status(ctxOf(userId), { limit: 2 });
    expect(first.items.map((i) => i.label)).toEqual(['C', 'B']);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await sync.status(ctxOf(userId), { limit: 2, cursor: first.nextCursor! });
    expect(second.items.map((i) => i.label)).toEqual(['A']);
    expect(second.nextCursor).toBeNull();

    await expect(sync.status(ctxOf(userId), { cursor: 'not-a-cursor' })).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });
});

describe('retry', () => {
  it('requeues every failed row of the user without ids and leaves stored, pending and foreign rows alone', async () => {
    const userId = await createUser();
    const other = await createUser();
    const a = await seedPerson(userId, 'A');
    const b = await seedPerson(userId, 'B');
    const c = await seedPerson(userId, 'C');
    for (const id of [a, b, c]) await dirty(userId, 'person', id);
    await fail(userId, a);
    await fail(userId, b);
    await store(userId, c);
    const foreign = await seedPerson(other, 'F');
    await dirty(other, 'person', foreign);
    await fail(other, foreign);
    vi.mocked(enqueue).mockClear();

    expect(await sync.retry(ctxOf(userId))).toBe(2);
    for (const id of [a, b])
      expect(await rowOf(userId, id)).toMatchObject({ status: 'pending', attempts: 0, due: true });
    expect(await rowOf(userId, c)).toMatchObject({ status: 'stored' });
    expect(await rowOf(other, foreign)).toMatchObject({ status: 'failed', attempts: 3 });
    expect(enqueue).toHaveBeenCalledWith('hub.sync', { userId }, expect.objectContaining({}));
  });

  it('with ids requeues only those failed rows; foreign ids count zero', async () => {
    const userId = await createUser();
    const other = await createUser();
    const a = await seedPerson(userId, 'A');
    const b = await seedPerson(userId, 'B');
    for (const id of [a, b]) await dirty(userId, 'person', id);
    const rowA = await fail(userId, a);
    await fail(userId, b);
    const foreign = await seedPerson(other, 'F');
    await dirty(other, 'person', foreign);
    const foreignRow = await fail(other, foreign);
    vi.mocked(enqueue).mockClear();

    expect(await sync.retry(ctxOf(userId), [rowA])).toBe(1);
    expect(await rowOf(userId, a)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(await rowOf(userId, b)).toMatchObject({ status: 'failed' });

    expect(await sync.retry(ctxOf(userId), [foreignRow])).toBe(0);
    expect(await rowOf(other, foreign)).toMatchObject({ status: 'failed' });
    expect(await sync.retry(ctxOf(userId), [])).toBe(0);
    await expect(sync.retry(ctxOf(userId), ['nope'])).rejects.toMatchObject({
      code: 'validation_failed',
    });
  });
});

describe('resync', () => {
  it('requeues every non-deleted row, audits hub.resync_requested {items} and keeps tombstones', async () => {
    const userId = await createUser();
    const personId = await seedPerson(userId, 'A');
    const noteId = await seedNote(userId, personId, 'N');
    await dirty(userId, 'person', personId);
    await store(userId, personId);
    const gone = '44444444-4444-4444-8444-444444444444';
    await withTransaction((tx) => sync.tombstone(tx, userId, 'note', gone));
    vi.mocked(enqueue).mockClear();

    expect(await sync.resync(ctxOf(userId))).toBe(2);
    expect(await rowOf(userId, personId)).toMatchObject({ status: 'pending', version: 2 });
    expect(await rowOf(userId, noteId)).toMatchObject({ status: 'pending' });
    expect(await rowOf(userId, gone)).toMatchObject({ deleted: true, version: 1 });
    expect(enqueue).toHaveBeenCalledWith('hub.sync', { userId }, expect.objectContaining({}));

    const { rows } = await getPool().query<{
      actor_type: string;
      target_type: string;
      metadata: unknown;
    }>(
      `select actor_type, target_type, metadata from audit_log_entry
        where actor_user_id = $1 and action = 'hub.resync_requested'`,
      [userId],
    );
    expect(rows).toEqual([{ actor_type: 'user', target_type: 'hub', metadata: { items: 2 } }]);
  });
});
