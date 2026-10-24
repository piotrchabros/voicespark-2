import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getPool, withTransaction } from '@voicespark/db';
import { enqueue } from '@voicespark/core/queues';
import * as sync from '@voicespark/core/services/hub/sync';
import { cleanupProfiles, createUser } from './helpers/profiles';

// Memory-store outbox (T035; contracts/memory-store-hub.md "Outbox", data-model.md "hub_sync_item"; FR-025,
// FR-026, SC-010). Intervals are measured against `updated_at`, which every write sets to the same `now()`.
vi.mock('@voicespark/core/queues', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@voicespark/core/queues')>()),
  enqueue: vi.fn(async () => ({})),
}));

process.env.DATABASE_URL ??= 'postgres://voicespark:voicespark@localhost:55432/voicespark_test';
process.env.REDIS_URL ??= 'redis://localhost:56379';
process.env.NODE_ENV ??= 'test';

const H = (c: string) => c.repeat(64);

interface Row {
  id: string;
  entity_type: string;
  entity_id: string;
  doc_id: string;
  version: number;
  synced_version: number;
  deleted: boolean;
  status: string;
  attempts: number;
  last_error_code: string | null;
  last_synced_at: Date | null;
  /** seconds from updated_at */
  next_in: number | null;
  lease_in: number | null;
}

async function rows(userId: string): Promise<Row[]> {
  const { rows: r } = await getPool().query<Row>(
    `select id, entity_type, entity_id, doc_id, version::int as version, synced_version::int as synced_version,
            deleted, status, attempts, last_error_code, last_synced_at,
            extract(epoch from next_attempt_at - updated_at)::float8 as next_in,
            extract(epoch from lease_until - updated_at)::float8 as lease_in
       from hub_sync_item where user_id = $1 order by created_at, doc_id`,
    [userId],
  );
  return r;
}

async function row(userId: string, entityId: string): Promise<Row> {
  const found = (await rows(userId)).find((r) => r.entity_id === entityId);
  expect(found).toBeDefined();
  return found!;
}

async function set(id: string, assignments: string): Promise<void> {
  await getPool().query(`update hub_sync_item set ${assignments} where id = $1`, [id]);
}

async function seedPerson(userId: string): Promise<string> {
  const { rows: r } = await getPool().query<{ id: string }>(
    `insert into hub_person (user_id, name_enc, name_key, match_key) values ($1, 'x', $2, $2) returning id`,
    [userId, H('a')],
  );
  return r[0]!.id;
}

async function seedCompany(userId: string): Promise<string> {
  const { rows: r } = await getPool().query<{ id: string }>(
    `insert into hub_company (user_id, name_enc, name_key, match_key) values ($1, 'x', $2, $2) returning id`,
    [userId, H('b')],
  );
  return r[0]!.id;
}

async function seedProject(userId: string): Promise<string> {
  const { rows: r } = await getPool().query<{ id: string }>(
    `insert into hub_project (user_id, name_enc, name_key, match_key) values ($1, 'x', $2, $2) returning id`,
    [userId, H('c')],
  );
  return r[0]!.id;
}

async function seedNote(userId: string, personId: string): Promise<string> {
  const { rows: r } = await getPool().query<{ id: string }>(
    `insert into hub_note (user_id, person_id, title_enc, body_json_enc) values ($1, $2, 'x', 'x') returning id`,
    [userId, personId],
  );
  return r[0]!.id;
}

async function seedFile(userId: string, personId: string): Promise<string> {
  const { rows: r } = await getPool().query<{ id: string }>(
    `insert into hub_file (user_id, person_id, name_enc, mime_type, extension, size_bytes, sha256, storage_key, key_id)
     values ($1, $2, 'x', 'text/plain', 'txt', 1, $3, gen_random_uuid(), 'k1') returning id`,
    [userId, personId, H('d')],
  );
  return r[0]!.id;
}

async function seedLink(userId: string, personId: string, companyId: string): Promise<void> {
  await getPool().query(
    `insert into hub_link (user_id, kind, person_id, company_id, origin) values ($1, 'person_company', $2, $3, 'user')`,
    [userId, personId, companyId],
  );
}

/** A thread with a summary attached to the person, and one without a summary. */
async function seedThreads(
  userId: string,
  personId: string,
): Promise<{ withSummary: string; without: string }> {
  const pool = getPool();
  const a = await pool.query<{ id: string }>(
    `insert into hub_thread (user_id, thread_key, summary_enc, summary_version) values ($1, $2, 'x', 1) returning id`,
    [userId, H('e')],
  );
  const b = await pool.query<{ id: string }>(
    `insert into hub_thread (user_id, thread_key) values ($1, $2) returning id`,
    [userId, H('f')],
  );
  for (const threadId of [a.rows[0]!.id, b.rows[0]!.id]) {
    await pool.query(
      `insert into hub_thread_record (user_id, thread_id, person_id) values ($1, $2, $3)`,
      [userId, threadId, personId],
    );
  }
  return { withSummary: a.rows[0]!.id, without: b.rows[0]!.id };
}

async function dirty(userId: string, type: sync.SyncEntityType, id: string): Promise<void> {
  await withTransaction((tx) => sync.markDirty(tx, userId, type, id));
}

/** Makes every row of the user due now. */
async function makeDue(userId: string): Promise<void> {
  await getPool().query(
    `update hub_sync_item set next_attempt_at = now() - interval '1 second' where user_id = $1`,
    [userId],
  );
}

beforeEach(() => {
  vi.mocked(enqueue).mockClear();
});

afterAll(async () => {
  await cleanupProfiles();
  await closeDb();
});

describe('docIdFor', () => {
  it('builds hub ids; summaries use the thread uuid', () => {
    const id = randomUUID();
    expect(sync.docIdFor('person', id)).toBe(`hub_person_${id}`);
    expect(sync.docIdFor('company', id)).toBe(`hub_company_${id}`);
    expect(sync.docIdFor('project', id)).toBe(`hub_project_${id}`);
    expect(sync.docIdFor('note', id)).toBe(`hub_note_${id}`);
    expect(sync.docIdFor('file', id)).toBe(`hub_file_${id}`);
    expect(sync.docIdFor('summary', id)).toBe(`hub_summary_${id}`);
  });

  it('the longest custom id with the vs_user_{id}__ prefix is 94 chars and matches the v3 pattern', () => {
    const ns = `vs_user_${randomUUID()}`;
    const lengths = (['person', 'company', 'project', 'note', 'file', 'summary'] as const).map(
      (t) => {
        const custom = `${ns}__${sync.docIdFor(t, randomUUID())}`;
        expect(custom).toMatch(/^[A-Za-z0-9_.:-]{1,100}$/);
        return custom.length;
      },
    );
    expect(Math.max(...lengths)).toBe(94);
  });
});

describe('markDirty', () => {
  it('inserts a pending row due in 2 s inside the caller transaction and wakes hub.sync once per user', async () => {
    const userId = await createUser();
    const personId = randomUUID();

    await withTransaction((tx) => sync.markDirty(tx, userId, 'person', personId));

    const r = await row(userId, personId);
    expect(r).toMatchObject({
      entity_type: 'person',
      doc_id: `hub_person_${personId}`,
      version: 1,
      synced_version: 0,
      deleted: false,
      status: 'pending',
      attempts: 0,
      next_in: 2,
    });
    expect(enqueue).toHaveBeenCalledWith(
      'hub.sync',
      { userId },
      { jobId: `hubsync-${userId}`, delay: 2000 },
    );
  });

  it('writes nothing when the caller transaction rolls back', async () => {
    const userId = await createUser();
    await expect(
      withTransaction(async (tx) => {
        await sync.markDirty(tx, userId, 'note', randomUUID());
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await rows(userId)).toHaveLength(0);
  });

  it('bumps version and resets a stored or failed row to pending with attempts 0', async () => {
    const userId = await createUser();
    const id = randomUUID();
    await dirty(userId, 'company', id);
    const first = await row(userId, id);
    await set(first.id, `status = 'stored', synced_version = 1`);
    await dirty(userId, 'company', id);
    expect(await row(userId, id)).toMatchObject({
      version: 2,
      synced_version: 1,
      status: 'pending',
      attempts: 0,
      next_in: 2,
    });

    await set(
      first.id,
      `status = 'failed', attempts = 4, next_attempt_at = now() + interval '10 minutes'`,
    );
    await dirty(userId, 'company', id);
    expect(await row(userId, id)).toMatchObject({
      version: 3,
      status: 'pending',
      attempts: 0,
      next_in: 2,
    });
    expect(await rows(userId)).toHaveLength(1);
  });
});

describe('tombstone', () => {
  it('sets deleted and bumps version (and inserts a tombstone for an unknown entity)', async () => {
    const userId = await createUser();
    const id = randomUUID();
    await dirty(userId, 'file', id);
    const r = await row(userId, id);
    await set(r.id, `status = 'stored', synced_version = 1`);
    await withTransaction((tx) => sync.tombstone(tx, userId, 'file', id));
    expect(await row(userId, id)).toMatchObject({
      deleted: true,
      version: 2,
      status: 'pending',
      attempts: 0,
      next_in: 2,
    });

    const other = randomUUID();
    await withTransaction((tx) => sync.tombstone(tx, userId, 'note', other));
    expect(await row(userId, other)).toMatchObject({
      deleted: true,
      status: 'pending',
      doc_id: `hub_note_${other}`,
    });
    expect(enqueue).toHaveBeenCalledWith(
      'hub.sync',
      { userId },
      { jobId: `hubsync-${userId}`, delay: 2000 },
    );
  });

  it('a later markDirty does not resurrect a tombstone', async () => {
    const userId = await createUser();
    const id = randomUUID();
    await withTransaction((tx) => sync.tombstone(tx, userId, 'person', id));
    await dirty(userId, 'person', id);
    expect(await row(userId, id)).toMatchObject({ deleted: true, version: 2 });
  });
});

describe('claimDue', () => {
  it('claims only due, unleased, unsynced rows of the user, at most the limit, and leases them for 120 s', async () => {
    const userId = await createUser();
    const other = await createUser();
    const ids = Array.from({ length: 12 }, () => randomUUID());
    for (const id of ids) await dirty(userId, 'note', id);
    await dirty(other, 'note', randomUUID());
    await makeDue(userId);
    await makeDue(other);

    const all = await rows(userId);
    const byEntity = new Map(all.map((r) => [r.entity_id, r]));
    // Not due yet, leased, and stored-and-current rows are skipped.
    await set(byEntity.get(ids[0]!)!.id, `next_attempt_at = now() + interval '1 minute'`);
    await set(byEntity.get(ids[1]!)!.id, `lease_until = now() + interval '1 minute'`);
    await set(byEntity.get(ids[2]!)!.id, `status = 'stored', synced_version = version`);
    // Stored but behind its version, and an expired lease, are claimed.
    await set(byEntity.get(ids[3]!)!.id, `status = 'stored', version = 2, synced_version = 1`);
    await set(byEntity.get(ids[4]!)!.id, `lease_until = now() - interval '1 second'`);
    // A null next_attempt_at counts as due.
    await set(byEntity.get(ids[5]!)!.id, `next_attempt_at = null`);

    const first = await sync.claimDue(userId, 10);
    expect(first).toHaveLength(9);
    const claimed = new Set(first.map((c) => c.entityId));
    expect(claimed.has(ids[0]!)).toBe(false);
    expect(claimed.has(ids[1]!)).toBe(false);
    expect(claimed.has(ids[2]!)).toBe(false);
    expect(claimed.has(ids[3]!)).toBe(true);
    expect(claimed.has(ids[4]!)).toBe(true);
    expect(claimed.has(ids[5]!)).toBe(true);
    for (const c of first) {
      expect(c.docId).toBe(`hub_note_${c.entityId}`);
      expect(typeof c.version).toBe('number');
      expect(typeof c.deleted).toBe('boolean');
    }

    const after = await rows(userId);
    for (const r of after.filter((x) => claimed.has(x.entity_id))) expect(r.lease_in).toBe(120);

    // Leased rows are not claimed again.
    expect(await sync.claimDue(userId, 10)).toHaveLength(0);
    // The other user's row was never touched.
    const [otherRow] = await rows(other);
    expect(otherRow!.lease_in).toBeNull();
  });

  it('respects the limit and concurrent claims never overlap (SKIP LOCKED)', async () => {
    const userId = await createUser();
    for (let i = 0; i < 15; i += 1) await dirty(userId, 'person', randomUUID());
    await makeDue(userId);
    const [a, b] = await Promise.all([sync.claimDue(userId, 10), sync.claimDue(userId, 10)]);
    const ids = [...a, ...b].map((c) => c.id);
    expect(a.length).toBeLessThanOrEqual(10);
    expect(b.length).toBeLessThanOrEqual(10);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(15);
  });
});

describe('completeStored', () => {
  it('marks stored with synced_version = V only while version is still V', async () => {
    const userId = await createUser();
    const id = randomUUID();
    await dirty(userId, 'project', id);
    await makeDue(userId);
    const [claimed] = await sync.claimDue(userId, 10);
    expect(await sync.completeStored(userId, claimed!.id, claimed!.version)).toBe(true);
    const r = await row(userId, id);
    expect(r).toMatchObject({ status: 'stored', synced_version: 1, version: 1, lease_in: null });
    expect(r.last_synced_at).toBeInstanceOf(Date);
  });

  it('leaves the row pending when the version moved during the run', async () => {
    const userId = await createUser();
    const id = randomUUID();
    await dirty(userId, 'project', id);
    await makeDue(userId);
    const [claimed] = await sync.claimDue(userId, 10);
    await dirty(userId, 'project', id);
    expect(await sync.completeStored(userId, claimed!.id, claimed!.version)).toBe(false);
    const r = await row(userId, id);
    expect(r).toMatchObject({ status: 'pending', synced_version: 0, version: 2, lease_in: null });
    expect(r.last_synced_at).toBeNull();
  });

  it('is owner scoped', async () => {
    const userId = await createUser();
    const intruder = await createUser();
    const id = randomUUID();
    await dirty(userId, 'project', id);
    const r = await row(userId, id);
    expect(await sync.completeStored(intruder, r.id, 1)).toBe(false);
    expect((await row(userId, id)).status).toBe('pending');
  });
});

describe('fail and busy', () => {
  it('fail sets failed, counts the attempt and backs off min(5 s * 2^(n-1), 15 min) +/-20%', async () => {
    const userId = await createUser();
    const id = randomUUID();
    await dirty(userId, 'note', id);
    const r = await row(userId, id);
    await set(r.id, `lease_until = now() + interval '2 minutes'`);

    await sync.fail(userId, r.id, 'supermemory_http_500');
    let now = await row(userId, id);
    expect(now).toMatchObject({
      status: 'failed',
      attempts: 1,
      last_error_code: 'supermemory_http_500',
      lease_in: null,
    });
    expect(now.next_in!).toBeGreaterThanOrEqual(4);
    expect(now.next_in!).toBeLessThanOrEqual(6);

    await sync.fail(userId, r.id, 'supermemory_network');
    now = await row(userId, id);
    expect(now).toMatchObject({ attempts: 2, last_error_code: 'supermemory_network' });
    expect(now.next_in!).toBeGreaterThanOrEqual(8);
    expect(now.next_in!).toBeLessThanOrEqual(12);

    await set(r.id, 'attempts = 20');
    await sync.fail(userId, r.id, 'memory_store_auth');
    now = await row(userId, id);
    expect(now.attempts).toBe(21);
    expect(now.next_in!).toBeGreaterThanOrEqual(720);
    expect(now.next_in!).toBeLessThanOrEqual(1080);
  });

  it('busy retries in 10 s without counting an attempt', async () => {
    const userId = await createUser();
    const id = randomUUID();
    await dirty(userId, 'note', id);
    const r = await row(userId, id);
    await set(r.id, `attempts = 2, lease_until = now() + interval '2 minutes'`);
    await sync.busy(userId, r.id);
    expect(await row(userId, id)).toMatchObject({
      status: 'pending',
      attempts: 2,
      next_in: 10,
      lease_in: null,
    });
  });
});

describe('resync', () => {
  it('back-fills missing rows and bumps every non-deleted row; tombstones are left alone', async () => {
    const userId = await createUser();
    const personId = await seedPerson(userId);
    const companyId = await seedCompany(userId);
    const projectId = await seedProject(userId);
    const noteId = await seedNote(userId, personId);
    const fileId = await seedFile(userId, personId);
    const { withSummary, without } = await seedThreads(userId, personId);

    await dirty(userId, 'company', companyId);
    const company = await row(userId, companyId);
    await set(company.id, `status = 'stored', synced_version = 1`);
    const gone = randomUUID();
    await withTransaction((tx) => sync.tombstone(tx, userId, 'person', gone));
    const tomb = await row(userId, gone);
    await set(tomb.id, `status = 'stored', synced_version = version`);

    const count = await sync.resync({ userId, role: 'user' });
    expect(count).toBe(6);

    const after = await rows(userId);
    const docIds = after.map((r) => r.doc_id).sort();
    expect(docIds).toEqual(
      [
        `hub_person_${personId}`,
        `hub_company_${companyId}`,
        `hub_project_${projectId}`,
        `hub_note_${noteId}`,
        `hub_file_${fileId}`,
        `hub_summary_${withSummary}`,
        `hub_person_${gone}`,
      ].sort(),
    );
    expect(docIds).not.toContain(`hub_summary_${without}`);
    for (const r of after.filter((x) => !x.deleted))
      expect(r).toMatchObject({ status: 'pending', attempts: 0 });
    expect(await row(userId, companyId)).toMatchObject({ version: 2, synced_version: 1 });
    expect(await row(userId, gone)).toMatchObject({
      status: 'stored',
      deleted: true,
      version: 1,
      synced_version: 1,
    });
    expect(enqueue).toHaveBeenCalledWith(
      'hub.sync',
      { userId },
      { jobId: `hubsync-${userId}`, delay: 2000 },
    );

    // Running it again inserts nothing new and bumps again.
    expect(await sync.resync({ userId, role: 'user' })).toBe(6);
    expect(await rows(userId)).toHaveLength(7);
    expect(await row(userId, companyId)).toMatchObject({ version: 3 });
  });
});

describe('markRecordTree', () => {
  it('marks the record, its notes and files, linked records and summaries attached to it', async () => {
    const userId = await createUser();
    const personId = await seedPerson(userId);
    const companyId = await seedCompany(userId);
    await seedLink(userId, personId, companyId);
    const noteId = await seedNote(userId, personId);
    const fileId = await seedFile(userId, personId);
    const { withSummary, without } = await seedThreads(userId, personId);

    await withTransaction((tx) => sync.markRecordTree(tx, userId, 'person', personId));
    const after = await rows(userId);
    expect(after.map((r) => r.doc_id).sort()).toEqual(
      [
        `hub_person_${personId}`,
        `hub_company_${companyId}`,
        `hub_note_${noteId}`,
        `hub_file_${fileId}`,
        `hub_summary_${withSummary}`,
      ].sort(),
    );
    expect(after.map((r) => r.doc_id)).not.toContain(`hub_summary_${without}`);
    for (const r of after) expect(r).toMatchObject({ status: 'pending', deleted: false });
  });

  it('on delete tombstones the record, its notes and files, and marks linked trees and summaries', async () => {
    const userId = await createUser();
    const personId = await seedPerson(userId);
    const companyId = await seedCompany(userId);
    await seedLink(userId, personId, companyId);
    const noteId = await seedNote(userId, personId);
    const fileId = await seedFile(userId, personId);
    const companyNote = await getPool().query<{ id: string }>(
      `insert into hub_note (user_id, company_id, title_enc, body_json_enc) values ($1, $2, 'x', 'x') returning id`,
      [userId, companyId],
    );
    const { withSummary } = await seedThreads(userId, personId);

    await withTransaction((tx) =>
      sync.markRecordTree(tx, userId, 'person', personId, { deleted: true }),
    );
    expect(await row(userId, personId)).toMatchObject({ deleted: true });
    expect(await row(userId, noteId)).toMatchObject({ deleted: true });
    expect(await row(userId, fileId)).toMatchObject({ deleted: true });
    expect(await row(userId, companyId)).toMatchObject({ deleted: false, status: 'pending' });
    expect(await row(userId, companyNote.rows[0]!.id)).toMatchObject({
      deleted: false,
      status: 'pending',
    });
    expect(await row(userId, withSummary)).toMatchObject({ deleted: false, status: 'pending' });
  });

  it('ignores records of another user', async () => {
    const userId = await createUser();
    const intruder = await createUser();
    const personId = await seedPerson(userId);
    await seedNote(userId, personId);
    await withTransaction((tx) => sync.markRecordTree(tx, intruder, 'person', personId));
    expect(await rows(userId)).toHaveLength(0);
    expect((await rows(intruder)).map((r) => r.doc_id)).toEqual([`hub_person_${personId}`]);
  });
});

describe('syncFieldFor', () => {
  it('returns the sync field of record, note and file responses', async () => {
    const userId = await createUser();
    const id = randomUUID();
    expect(await sync.syncFieldFor(userId, 'person', id)).toEqual({
      status: 'pending',
      lastSyncedAt: null,
    });

    await dirty(userId, 'person', id);
    expect(await sync.syncFieldFor(userId, 'person', id)).toEqual({
      status: 'pending',
      lastSyncedAt: null,
    });

    const r = await row(userId, id);
    expect(await sync.completeStored(userId, r.id, 1)).toBe(true);
    const field = await sync.syncFieldFor(userId, 'person', id);
    expect(field.status).toBe('stored');
    expect(field.lastSyncedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await sync.fail(userId, r.id, 'supermemory_network');
    expect((await sync.syncFieldFor(userId, 'person', id)).status).toBe('failed');

    // Another user's row is invisible.
    const other = await createUser();
    expect(await sync.syncFieldFor(other, 'person', id)).toEqual({
      status: 'pending',
      lastSyncedAt: null,
    });
  });
});
