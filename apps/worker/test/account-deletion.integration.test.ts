import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DelayedError, type Job } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getPool, type SourceType } from '@voicespark/db';
import { encrypt, subjectRef } from '@voicespark/core/crypto';
import { resetEnvForTests } from '@voicespark/core/env';
import { createFsBlobStore, type BlobStore } from '@voicespark/core/hub/blob-store';
import { jobIds, removeScheduler } from '@voicespark/core/queues';
import { getDeletion, requestDeletion } from '@voicespark/core/services/deletion';
import { flaggedDeletions } from '@voicespark/db/repos/system/deletions';
import type { FilteredText } from '@voicespark/filters';
import type { Mailer } from '@voicespark/integrations/smtp';
import { InMemoryMemoryStore, META, namespaceFor } from '@voicespark/integrations/supermemory';
import { createDeletionHandler, handlers } from '../src/processors/deletion';
import {
  choose,
  cleanupProfiles,
  ensureActivePrompt,
  insertVersion,
  sampleDocument,
  seedDefinition,
  seedOwnPrompt,
} from './helpers/profiles';

// deletion.execute, account scope (T142, research R19, D-U7a) plus the deletion_completed notification of the
// source / content_item scopes. Compose Postgres + in-memory Supermemory; queues mocked (no Redis needed).
// The `hub` queue is a recording fake: account deletion removes the user's queued hub jobs best effort (T069).
const { hubQueue } = vi.hoisted(() => ({
  hubQueue: {
    remove: vi.fn(async (_jobId: string) => 1),
    getJobs: vi.fn(async (_types?: string[]) => [] as { id?: string }[]),
  },
}));
vi.mock('@voicespark/core/queues', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@voicespark/core/queues')>()),
  enqueue: vi.fn(async () => ({})),
  upsertScheduler: vi.fn(async () => undefined),
  removeScheduler: vi.fn(async () => undefined),
  getQueue: vi.fn(() => hubQueue),
}));

process.env.DATABASE_URL ??= 'postgres://voicespark:voicespark@localhost:55432/voicespark_test';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-00';
process.env.ENCRYPTION_KEYRING ??= JSON.stringify({ k1: Buffer.alloc(32, 1).toString('base64') });
process.env.ENCRYPTION_ACTIVE_KEY_ID ??= 'k1';
process.env.DEDUP_HMAC_KEY ??= Buffer.alloc(32, 2).toString('base64');
process.env.REDIS_URL ??= 'redis://localhost:56379';
process.env.NODE_ENV ??= 'test';
// Hub file blobs go to a temp directory for this file (T069); the env cache is reset so loadEnv() picks it up.
const hubFilesDir = mkdtempSync(join(tmpdir(), 'vs-hub-files-'));
process.env.HUB_FILES_DIR = hubFilesDir;
resetEnvForTests();

const GMAIL_REFRESH = 'gmail-refresh-token-for-revoke';

interface FakeJob {
  id: string;
  data: { deletionRequestId: string; waitCount?: number };
  opts: { attempts: number };
  attemptsMade: number;
  updateData: ReturnType<typeof vi.fn>;
  moveToDelayed: ReturnType<typeof vi.fn>;
}

function fakeJob(
  deletionRequestId: string,
  opts: { attemptsMade?: number; waitCount?: number } = {},
): FakeJob {
  const job: FakeJob = {
    id: jobIds.deletion(deletionRequestId),
    data: {
      deletionRequestId,
      ...(opts.waitCount !== undefined ? { waitCount: opts.waitCount } : {}),
    },
    opts: { attempts: 12 },
    attemptsMade: opts.attemptsMade ?? 0,
    updateData: vi.fn(async (d: FakeJob['data']) => {
      job.data = d;
    }),
    moveToDelayed: vi.fn(async () => undefined),
  };
  return job;
}

/** A recording mailer; `failFirst` makes the first send throw (SMTP outage). */
function recordingMailer(failFirst = false) {
  const sent: { to: string; subject: string; text: string }[] = [];
  let calls = 0;
  const mailer: Mailer = {
    send: vi.fn(async (msg: { to: string; subject: string; text: string }) => {
      calls += 1;
      if (failFirst && calls === 1) throw new Error('smtp_unavailable');
      sent.push(msg);
    }),
  };
  return { mailer, sent };
}

const userIds: string[] = [];
const subjectRefs: string[] = [];

async function createUser(): Promise<{ userId: string; email: string }> {
  const email = `account-deletion-${randomUUID()}@example.test`;
  const { rows } = await getPool().query<{ id: string }>(
    `insert into "user" (name, email) values ('Ada Lovelace', $1) returning id`,
    [email],
  );
  userIds.push(rows[0]!.id);
  subjectRefs.push(subjectRef(rows[0]!.id));
  return { userId: rows[0]!.id, email };
}

async function createSource(userId: string, type: SourceType): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `insert into connected_source (user_id, type, account_label, account_address, status, consent_text_version)
     values ($1, $2, 'Test mailbox', $3, 'connected', 'v1') returning id`,
    [userId, type, `${randomUUID()}@example.test`],
  );
  const sourceId = rows[0]!.id;
  if (type === 'gmail') {
    await getPool().query(
      `insert into mailbox_credential (source_id, kind, refresh_token_enc, key_id) values ($1, 'oauth', $2, 'k1')`,
      [sourceId, encrypt('mailbox-credentials', GMAIL_REFRESH)],
    );
  } else if (type === 'imap') {
    await getPool().query(
      `insert into mailbox_credential (source_id, kind, imap_host, imap_port, imap_password_enc, key_id)
       values ($1, 'imap_password', 'imap.example.test', 993, $2, 'k1')`,
      [sourceId, encrypt('mailbox-credentials', 'imap-secret')],
    );
  }
  return sourceId;
}

async function createItem(
  store: InMemoryMemoryStore,
  userId: string,
  sourceId: string,
): Promise<string> {
  const id = randomUUID();
  await getPool().query(
    `insert into content_item (id, user_id, kind, authorship, item_date, word_count, content_hash, filter_policy_version, status)
     values ($1, $2, 'email', 'authored', now(), 3, $3, 1, 'active')`,
    [id, userId, randomBytes(32).toString('hex')],
  );
  await getPool().query(
    'insert into content_item_occurrence (content_item_id, source_id, provider_ref) values ($1, $2, $3)',
    [id, sourceId, randomUUID()],
  );
  await store.addDocuments(namespaceFor(userId), [
    {
      id,
      content: 'hello from a test' as FilteredText,
      documentDate: new Date().toISOString(),
      metadata: { [META.contentItemId]: id, [META.sourceIds]: [sourceId] },
    },
  ]);
  return id;
}

/** A pending_deletion user with a gmail + imap source, documents, a notification and an account request. */
async function accountWorld() {
  const store = new InMemoryMemoryStore();
  const { userId, email } = await createUser();
  const gmail = await createSource(userId, 'gmail');
  const imap = await createSource(userId, 'imap');
  await createItem(store, userId, gmail);
  await createItem(store, userId, imap);
  await getPool().query(
    `insert into notification (user_id, type, payload) values ($1, 'import_completed', '{}'::jsonb)`,
    [userId],
  );
  await getPool().query(`update "user" set status = 'pending_deletion' where id = $1`, [userId]);
  const { id } = await requestDeletion({
    userId,
    scope: 'account',
    targetId: userId,
    requestedBy: 'user',
    notifyEmail: email,
  });
  return { store, userId, email, gmail, imap, requestId: id };
}

const run = (deps: Parameters<typeof createDeletionHandler>[0], job: FakeJob) =>
  createDeletionHandler(deps)(
    job as unknown as Job<FakeJob['data'], unknown, 'deletion.execute'>,
    'token',
  );

const count = async (sql: string, params: unknown[]) =>
  Number((await getPool().query<{ n: string }>(sql, params)).rows[0]!.n);

beforeAll(async () => {
  await getPool().query('select 1');
});

beforeEach(() => {
  vi.mocked(removeScheduler).mockClear();
  hubQueue.remove.mockReset();
  hubQueue.remove.mockImplementation(async () => 1);
  hubQueue.getJobs.mockReset();
  hubQueue.getJobs.mockImplementation(async () => []);
});

afterAll(async () => {
  if (userIds.length > 0) {
    await getPool().query(
      'delete from deletion_request where user_id = any($1::uuid[]) or target_id = any($1::uuid[])',
      [userIds],
    );
    await getPool().query(
      'delete from audit_log_entry where actor_user_id = any($1::uuid[]) or subject_ref = any($2::text[])',
      [userIds, subjectRefs],
    );
    await getPool().query('delete from "user" where id = any($1::uuid[])', [userIds]);
  }
  await cleanupProfiles();
  await closeDb();
  rmSync(hubFilesDir, { recursive: true, force: true });
});

describe('deletion processor module', () => {
  it('still exports the deletion.execute handler and the factory', () => {
    expect(typeof handlers['deletion.execute']).toBe('function');
    expect(typeof createDeletionHandler).toBe('function');
  });
});

describe('deletion.execute account', () => {
  it('revokes, purges the namespace, deletes the user, emails the captured address and pseudonymizes', async () => {
    const w = await accountWorld();
    const ns = namespaceFor(w.userId);
    await getPool().query(
      `insert into audit_log_entry (actor_type, actor_user_id, action, target_type, target_id, subject_ref, metadata)
       values ('user', $1, 'account.deletion_requested', 'user', $2, $3, '{}'::jsonb)`,
      [w.userId, w.userId, subjectRef(w.userId)],
    );
    const { mailer, sent } = recordingMailer();
    const revokeGoogleToken = vi.fn(async () => undefined);

    await run({ store: w.store, mailer, revokeGoogleToken }, fakeJob(w.requestId));

    // Supermemory namespace gone and verified.
    expect((await w.store.listDocuments(ns, { page: 1, limit: 10 })).documents).toHaveLength(0);
    // Google token revoked at the provider; every mailbox credential deleted.
    expect(revokeGoogleToken).toHaveBeenCalledWith(GMAIL_REFRESH);
    expect(
      await count(
        'select count(*) as n from mailbox_credential where source_id = any($1::uuid[])',
        [[w.gmail, w.imap]],
      ),
    ).toBe(0);
    expect(removeScheduler).toHaveBeenCalledWith('sync-poll', `poll-${w.gmail}`);
    expect(removeScheduler).toHaveBeenCalledWith('sync-poll', `poll-${w.imap}`);
    // User row gone; everything cascaded.
    expect(await count('select count(*) as n from "user" where id = $1', [w.userId])).toBe(0);
    expect(
      await count('select count(*) as n from connected_source where user_id = $1', [w.userId]),
    ).toBe(0);
    expect(
      await count('select count(*) as n from content_item where user_id = $1', [w.userId]),
    ).toBe(0);
    expect(
      await count('select count(*) as n from notification where user_id = $1', [w.userId]),
    ).toBe(0);

    // Exactly one email to the address captured at request time; no content in it.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(w.email);
    expect(sent[0]!.subject).toMatch(/account has been deleted/i);
    expect(sent[0]!.text).toContain('/sign-in');
    expect(sent[0]!.text).not.toContain(w.email);

    const row = await getDeletion(w.requestId);
    expect(row?.status).toBe('completed');
    expect(row?.completedAt).toBeInstanceOf(Date);
    expect(row?.notifyEmailEnc).toBeNull();
    expect(row?.targetId).toBe(w.userId);

    // Audit: the user is unlinked from the log; account.deleted carries only the subject_ref.
    expect(
      await count(
        'select count(*) as n from audit_log_entry where actor_user_id = $1 or target_id = $2',
        [w.userId, w.userId],
      ),
    ).toBe(0);
    const deleted = await getPool().query<{ subject_ref: string; target_id: string | null }>(
      `select subject_ref, target_id from audit_log_entry where action = 'account.deleted' and subject_ref = $1`,
      [subjectRef(w.userId)],
    );
    expect(deleted.rows).toHaveLength(1);
    expect(deleted.rows[0]!.target_id).toBeNull();

    // An idempotent re-run sends nothing more.
    await run({ store: w.store, mailer, revokeGoogleToken }, fakeJob(w.requestId));
    expect(sent).toHaveLength(1);
  });

  it('cascades own analysis prompts and profile versions; analysis_prompt.* audit rows stay unlinked and text-free', async () => {
    const w = await accountWorld();
    const secret = 'My private analysis instructions SECRET-TEXT';
    const def = await seedDefinition();
    const profileId = await choose(w.userId, def.definitionId);
    const own = await seedOwnPrompt({
      userId: w.userId,
      definitionId: def.definitionId,
      text: secret,
      basedOnDefinitionVersionId: def.versionId,
    });
    await insertVersion({
      profileId,
      body: sampleDocument(randomUUID()),
      format: 'document',
      promptSource: 'own',
      ownPromptVersionId: own.versionId,
      definitionVersionId: def.versionId,
      promptVersionId: await ensureActivePrompt('tone_profile.generate'),
    });
    await getPool().query(
      `insert into audit_log_entry (actor_type, actor_user_id, action, target_type, target_id, subject_ref, metadata)
       values ('user', $1, 'analysis_prompt.customised', 'definition', $2, $3, $4::jsonb)`,
      [
        w.userId,
        def.definitionId,
        subjectRef(w.userId),
        JSON.stringify({
          ownPromptId: own.ownPromptId,
          versionId: own.versionId,
          basedOnDefinitionVersionId: def.versionId,
          charCount: secret.length,
        }),
      ],
    );
    expect(
      await count(
        'select count(*) as n from profile_version where profile_id = $1 and format = $2',
        [profileId, 'document'],
      ),
    ).toBe(1);

    const { mailer } = recordingMailer();
    await run(
      { store: w.store, mailer, revokeGoogleToken: vi.fn(async () => undefined) },
      fakeJob(w.requestId),
    );

    expect(await count('select count(*) as n from "user" where id = $1', [w.userId])).toBe(0);
    expect(
      await count('select count(*) as n from own_analysis_prompt where id = $1', [own.ownPromptId]),
    ).toBe(0);
    expect(
      await count('select count(*) as n from own_analysis_prompt_version where id = $1', [
        own.versionId,
      ]),
    ).toBe(0);
    expect(
      await count('select count(*) as n from profile_version where profile_id = $1', [profileId]),
    ).toBe(0);
    expect(await count('select count(*) as n from tone_profile where id = $1', [profileId])).toBe(
      0,
    );

    const rows = await getPool().query<{ actor_user_id: string | null; metadata: unknown }>(
      `select actor_user_id, metadata from audit_log_entry
       where action like 'analysis_prompt.%' and subject_ref = $1`,
      [subjectRef(w.userId)],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.actor_user_id).toBeNull();
    expect(JSON.stringify(rows.rows[0]!.metadata)).not.toContain(secret);
    expect(JSON.stringify(rows.rows[0]!.metadata)).not.toContain('SECRET-TEXT');
  });

  it('keeps the request retryable when the email fails, then sends exactly one email on the next attempt', async () => {
    const w = await accountWorld();
    const { mailer, sent } = recordingMailer(true);
    const revokeGoogleToken = vi.fn(async () => undefined);

    await expect(
      run({ store: w.store, mailer, revokeGoogleToken }, fakeJob(w.requestId)),
    ).rejects.toThrow();
    const failed = await getDeletion(w.requestId);
    expect(failed?.status).not.toBe('completed');
    expect(failed?.status).not.toBe('failed');
    expect(failed?.lastErrorCode).toBeTruthy();
    expect(failed?.notifyEmailEnc).not.toBeNull();
    expect(sent).toHaveLength(0);

    await run(
      { store: w.store, mailer, revokeGoogleToken },
      fakeJob(w.requestId, { attemptsMade: 1 }),
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(w.email);
    const row = await getDeletion(w.requestId);
    expect(row?.status).toBe('completed');
    expect(row?.notifyEmailEnc).toBeNull();
    expect(await count('select count(*) as n from "user" where id = $1', [w.userId])).toBe(0);
    expect(
      await count(
        `select count(*) as n from audit_log_entry where action = 'account.deleted' and subject_ref = $1`,
        [subjectRef(w.userId)],
      ),
    ).toBe(1);
  });

  it('re-delays the same job while an import is running and deletes nothing yet', async () => {
    const w = await accountWorld();
    await getPool().query(
      `insert into import_job (user_id, source_id, kind, status) values ($1, $2, 'initial', 'running')`,
      [w.userId, w.imap],
    );
    const { mailer, sent } = recordingMailer();
    const job = fakeJob(w.requestId);

    await expect(
      run({ store: w.store, mailer, revokeGoogleToken: vi.fn(async () => undefined) }, job),
    ).rejects.toBeInstanceOf(DelayedError);

    expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'token');
    expect(job.data.waitCount).toBe(1);
    expect(sent).toHaveLength(0);
    expect(await count('select count(*) as n from "user" where id = $1', [w.userId])).toBe(1);
    expect((await getDeletion(w.requestId))?.status).not.toBe('completed');
    // Sources are disconnected before waiting so no new page can start.
    expect(
      await count(
        `select count(*) as n from connected_source where user_id = $1 and status <> 'disconnected'`,
        [w.userId],
      ),
    ).toBe(0);
  });
});

describe('deletion.execute completion notifications', () => {
  it('notifies deletion_completed when a user-requested source deletion completes', async () => {
    const store = new InMemoryMemoryStore();
    const { userId } = await createUser();
    const sourceId = await createSource(userId, 'uploads');
    await createItem(store, userId, sourceId);
    const { id } = await requestDeletion({
      userId,
      scope: 'source',
      targetId: sourceId,
      requestedBy: 'user',
    });

    await run({ store, mailer: recordingMailer().mailer }, fakeJob(id));

    expect((await getDeletion(id))?.status).toBe('completed');
    const notes = await getPool().query<{ payload: unknown }>(
      `select payload from notification where user_id = $1 and type = 'deletion_completed'`,
      [userId],
    );
    expect(notes.rows).toEqual([{ payload: { deletionRequestId: id, scope: 'source' } }]);
  });

  it('notifies deletion_completed when a user-requested content item deletion completes', async () => {
    const store = new InMemoryMemoryStore();
    const { userId } = await createUser();
    const sourceId = await createSource(userId, 'uploads');
    const itemId = await createItem(store, userId, sourceId);
    const { id } = await requestDeletion({
      userId,
      scope: 'content_item',
      targetId: itemId,
      requestedBy: 'user',
    });

    await run({ store, mailer: recordingMailer().mailer }, fakeJob(id));

    expect((await getDeletion(id))?.status).toBe('completed');
    const notes = await getPool().query<{ payload: unknown }>(
      `select payload from notification where user_id = $1 and type = 'deletion_completed'`,
      [userId],
    );
    expect(notes.rows).toEqual([{ payload: { deletionRequestId: id, scope: 'content_item' } }]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Context hub (T069, FR-030, SC-012)

const HUB_TABLES = [
  'hub_person',
  'hub_note',
  'hub_file',
  'hub_thread',
  'hub_fact',
  'hub_sync_item',
] as const;

const hubDocsLeft = async (store: InMemoryMemoryStore, userId: string) =>
  (await store.listDocuments(namespaceFor(userId), { page: 1, limit: 100 })).documents.filter((d) =>
    d.id.startsWith('hub_'),
  );

/** accountWorld plus a person with a note and a file (blob on disk), a thread, a fact, sync items and hub_ docs. */
async function hubAccountWorld() {
  const w = await accountWorld();
  const enc = (v: string) => encrypt('user-content', v);
  const hex = () => randomBytes(32).toString('hex');
  const pool = getPool();
  const personId = (
    await pool.query<{ id: string }>(
      `insert into hub_person (user_id, name_enc, name_key, match_key) values ($1, $2, $3, $4) returning id`,
      [w.userId, enc('Grace Hopper'), hex(), hex()],
    )
  ).rows[0]!.id;
  await pool.query(
    `insert into hub_note (user_id, person_id, title_enc, body_json_enc) values ($1, $2, $3, $4)`,
    [w.userId, personId, enc('Call notes'), enc('{}')],
  );
  const storageKey = randomUUID();
  const { keyId } = await createFsBlobStore(hubFilesDir).put(
    w.userId,
    storageKey,
    new TextEncoder().encode('private file bytes'),
  );
  const fileId = (
    await pool.query<{ id: string }>(
      `insert into hub_file (user_id, person_id, name_enc, mime_type, extension, size_bytes, sha256, storage_key, key_id)
       values ($1, $2, $3, 'text/plain', 'txt', 18, $4, $5, $6) returning id`,
      [w.userId, personId, enc('notes.txt'), hex(), storageKey, keyId],
    )
  ).rows[0]!.id;
  const thread = (
    await pool.query<{ id: string; version: string }>(
      `insert into hub_thread (user_id, thread_key, version) values ($1, $2, 3) returning id, version`,
      [w.userId, hex()],
    )
  ).rows[0]!;
  await pool.query(
    `insert into hub_fact (user_id, thread_id, type, state, person_id, confidence, fingerprint, policy_version, prompt_version)
     values ($1, $2, 'person', 'applied', $3, 0.9, $4, 'p1', 'v1')`,
    [w.userId, thread.id, personId, hex()],
  );
  for (const [entity, id] of [
    ['person', personId],
    ['file', fileId],
  ] as const) {
    await pool.query(
      `insert into hub_sync_item (user_id, entity_type, entity_id, doc_id, status, synced_version)
       values ($1, $2, $3, $4, 'stored', 1)`,
      [w.userId, entity, id, `hub_${entity}_${id}`],
    );
    await w.store.addDocuments(namespaceFor(w.userId), [
      {
        id: `hub_${entity}_${id}`,
        content: 'hub record copy' as FilteredText,
        documentDate: new Date().toISOString(),
        metadata: {},
      },
    ]);
  }
  await pool.query(
    `insert into audit_log_entry (actor_type, actor_user_id, action, target_type, target_id, subject_ref, metadata)
     values ('user', $1, 'hub.record_deleted', 'hub_person', $2, $3, $4::jsonb)`,
    [
      w.userId,
      personId,
      subjectRef(w.userId),
      JSON.stringify({ recordId: personId, notes: 1, files: 1 }),
    ],
  );
  return {
    ...w,
    personId,
    fileId,
    storageKey,
    threadId: thread.id,
    threadVersion: Number(thread.version),
  };
}

describe('deletion.execute account: context hub', () => {
  it('removes hub rows, the blob directory (before the user row), hub_ documents and queued hub jobs', async () => {
    const w = await hubAccountWorld();
    const userDir = join(hubFilesDir, w.userId);
    expect(existsSync(userDir)).toBe(true);
    expect(await hubDocsLeft(w.store, w.userId)).toHaveLength(2);
    for (const table of HUB_TABLES) {
      expect(
        await count(`select count(*) as n from ${table} where user_id = $1`, [w.userId]),
      ).toBeGreaterThan(0);
    }
    const otherUser = randomUUID();
    hubQueue.getJobs.mockImplementation(async () => [
      { id: jobIds.hubRefilter(w.userId, 4) },
      { id: jobIds.hubRefilter(otherUser, 4) },
      { id: jobIds.hubSync(otherUser) },
    ]);
    // The blob store runs while the user row still exists (rows cascade only after the directory is gone).
    const real = createFsBlobStore(hubFilesDir);
    const userRowAtBlobDelete: number[] = [];
    const blobStore: BlobStore = {
      ...real,
      deleteUser: vi.fn(async (userId: string) => {
        userRowAtBlobDelete.push(
          await count('select count(*) as n from "user" where id = $1', [userId]),
        );
        await real.deleteUser(userId);
      }),
    };

    const { mailer } = recordingMailer();
    await run(
      { store: w.store, mailer, revokeGoogleToken: vi.fn(async () => undefined), blobStore },
      fakeJob(w.requestId),
    );

    expect(blobStore.deleteUser).toHaveBeenCalledWith(w.userId);
    expect(userRowAtBlobDelete).toEqual([1]);
    expect(existsSync(userDir)).toBe(false);
    for (const table of HUB_TABLES) {
      expect(await count(`select count(*) as n from ${table} where user_id = $1`, [w.userId])).toBe(
        0,
      );
    }
    expect(await hubDocsLeft(w.store, w.userId)).toHaveLength(0);

    // Queued hub jobs for this user only (best effort).
    const removed = hubQueue.remove.mock.calls.map((c) => c[0]);
    expect(removed).toEqual(
      expect.arrayContaining([
        jobIds.hubSync(w.userId),
        jobIds.hubThread(w.threadId, w.threadVersion),
        jobIds.hubRefilter(w.userId, 4),
      ]),
    );
    expect(removed).not.toContain(jobIds.hubRefilter(otherUser, 4));
    expect(removed).not.toContain(jobIds.hubSync(otherUser));

    // Completed within the SLA: nothing for maintenance.deletion-sla to flag.
    const row = await getDeletion(w.requestId);
    expect(row?.status).toBe('completed');
    expect(row!.completedAt!.getTime()).toBeLessThanOrEqual(row!.dueBy.getTime());
    expect((await flaggedDeletions(new Date())).map((r) => r.id)).not.toContain(w.requestId);

    // Hub audit rows remain, unlinked from the user, with ids and counts only.
    const audits = await getPool().query<{
      actor_user_id: string | null;
      metadata: Record<string, unknown>;
    }>(
      `select actor_user_id, metadata from audit_log_entry where action = 'hub.record_deleted' and subject_ref = $1`,
      [subjectRef(w.userId)],
    );
    expect(audits.rows).toHaveLength(1);
    expect(audits.rows[0]!.actor_user_id).toBeNull();
    expect(audits.rows[0]!.metadata).toEqual({ recordId: w.personId, notes: 1, files: 1 });
    expect(JSON.stringify(audits.rows[0]!.metadata)).not.toContain('Grace');
  });

  it('throws verify_failed (retryable) while the blob directory still exists, then completes on retry', async () => {
    const w = await hubAccountWorld();
    const userDir = join(hubFilesDir, w.userId);
    const real = createFsBlobStore(hubFilesDir);
    const stuck: BlobStore = { ...real, deleteUser: vi.fn(async () => undefined) };
    const { mailer, sent } = recordingMailer();
    const revokeGoogleToken = vi.fn(async () => undefined);

    await expect(
      run({ store: w.store, mailer, revokeGoogleToken, blobStore: stuck }, fakeJob(w.requestId)),
    ).rejects.toThrow('verify_failed');

    const failed = await getDeletion(w.requestId);
    expect(failed?.lastErrorCode).toBe('verify_failed');
    expect(failed?.status).not.toBe('failed');
    expect(failed?.status).not.toBe('completed');
    expect(existsSync(userDir)).toBe(true);
    expect(await count('select count(*) as n from "user" where id = $1', [w.userId])).toBe(1);
    expect(sent).toHaveLength(0);

    await run(
      { store: w.store, mailer, revokeGoogleToken, blobStore: real },
      fakeJob(w.requestId, { attemptsMade: 1 }),
    );
    expect(existsSync(userDir)).toBe(false);
    expect((await getDeletion(w.requestId))?.status).toBe('completed');
    expect(await count('select count(*) as n from "user" where id = $1', [w.userId])).toBe(0);
  });

  it('still completes when removing hub jobs fails (best effort)', async () => {
    const w = await hubAccountWorld();
    hubQueue.remove.mockImplementation(async () => {
      throw new Error('redis_unavailable');
    });
    hubQueue.getJobs.mockImplementation(async () => {
      throw new Error('redis_unavailable');
    });

    await run(
      {
        store: w.store,
        mailer: recordingMailer().mailer,
        revokeGoogleToken: vi.fn(async () => undefined),
        blobStore: createFsBlobStore(hubFilesDir),
      },
      fakeJob(w.requestId),
    );

    expect((await getDeletion(w.requestId))?.status).toBe('completed');
    expect(existsSync(join(hubFilesDir, w.userId))).toBe(false);
    expect(await count('select count(*) as n from "user" where id = $1', [w.userId])).toBe(0);
  });
});
