import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  account,
  auditLogEntry,
  closeDb,
  connectedSource,
  getDb,
  getPool,
  importJob,
  session,
  signInIdentity,
  user,
} from '@voicespark/db';
import { and, eq, inArray } from 'drizzle-orm';
import { enqueue, jobIds, QUEUES, removeScheduler, upsertScheduler } from '@voicespark/core/queues';
import { AppError } from '@voicespark/core/errors';
import * as adminUsers from '@voicespark/core/services/admin-users';

// US6 / T130: suspend, reinstate, role changes and the last-admin protection. Queues are mocked.
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
process.env.APP_URL ??= 'http://localhost:3000';

const tag = randomUUID().slice(0, 8);
const userIds: string[] = [];
// Active admins that existed before this file ran; demoted for the last-admin cases and restored afterwards.
let displacedAdminIds: string[] = [];

async function createUser(
  role: 'user' | 'admin' = 'user',
  label = 'u',
  status: 'active' | 'suspended' = 'active',
): Promise<string> {
  const [row] = await getDb()
    .insert(user)
    .values({ name: `AU ${label} ${tag}`, email: `au-${label}-${tag}-${randomUUID().slice(0, 6)}@example.test`, role, status })
    .returning({ id: user.id });
  userIds.push(row!.id);
  return row!.id;
}

async function errorOf(p: Promise<unknown>): Promise<AppError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return err as AppError;
}

async function auditActions(targetId: string): Promise<string[]> {
  const rows = await getDb().select({ action: auditLogEntry.action }).from(auditLogEntry).where(eq(auditLogEntry.targetId, targetId));
  return rows.map((r) => r.action);
}

beforeAll(async () => {
  await getPool().query('select 1');
});

beforeEach(() => {
  vi.mocked(enqueue).mockClear();
  vi.mocked(upsertScheduler).mockClear();
  vi.mocked(removeScheduler).mockClear();
});

afterAll(async () => {
  if (displacedAdminIds.length > 0) {
    await getDb().update(user).set({ role: 'admin' }).where(inArray(user.id, displacedAdminIds));
  }
  if (userIds.length > 0) await getDb().delete(user).where(inArray(user.id, userIds));
  await closeDb();
});

describe('last-admin protection', () => {
  beforeAll(async () => {
    const others = await getDb()
      .select({ id: user.id })
      .from(user)
      .where(and(eq(user.role, 'admin'), eq(user.status, 'active')));
    displacedAdminIds = others.map((r) => r.id);
    if (displacedAdminIds.length > 0) {
      await getDb().update(user).set({ role: 'user' }).where(inArray(user.id, displacedAdminIds));
    }
  });

  afterAll(async () => {
    if (displacedAdminIds.length > 0) {
      await getDb().update(user).set({ role: 'admin' }).where(inArray(user.id, displacedAdminIds));
      displacedAdminIds = [];
    }
  });

  it('refuses the only active admin suspending themselves with 409 last_admin', async () => {
    const adminId = await createUser('admin', 'sole');
    const err = await errorOf(adminUsers.suspend(adminId, adminId));
    expect(err.code).toBe('last_admin');
    expect(err.status).toBe(409);
    const [row] = await getDb().select({ status: user.status }).from(user).where(eq(user.id, adminId));
    expect(row!.status).toBe('active');
    await getDb().update(user).set({ role: 'user' }).where(eq(user.id, adminId));
  });

  it('refuses the only active admin revoking their own role with 409 last_admin', async () => {
    const adminId = await createUser('admin', 'sole2');
    const err = await errorOf(adminUsers.revokeRole(adminId, adminId));
    expect(err.code).toBe('last_admin');
    expect(err.status).toBe(409);
    const [row] = await getDb().select({ role: user.role }).from(user).where(eq(user.id, adminId));
    expect(row!.role).toBe('admin');
    await getDb().update(user).set({ role: 'user' }).where(eq(user.id, adminId));
  });

  it('lets exactly one of two concurrent revokes of the last two admins succeed', async () => {
    const a = await createUser('admin', 'race-a');
    const b = await createUser('admin', 'race-b');
    const results = await Promise.allSettled([adminUsers.revokeRole(a, b), adminUsers.revokeRole(b, a)]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0]!.reason as AppError).code).toBe('last_admin');
    const rows = await getDb().select({ role: user.role }).from(user).where(inArray(user.id, [a, b]));
    expect(rows.filter((r) => r.role === 'admin')).toHaveLength(1);
    await getDb().update(user).set({ role: 'user' }).where(inArray(user.id, [a, b]));
  });
});

describe('suspend and reinstate', () => {
  it('suspends: status, sessions, source, job, scheduler removal and audit', async () => {
    const adminId = await createUser('admin', 'actor');
    const userId = await createUser('user', 'target');
    const [src] = await getDb()
      .insert(connectedSource)
      .values({ userId, type: 'imap', accountLabel: 'Box', accountAddress: `${randomUUID()}@example.test`, status: 'connected', consentTextVersion: 'v1' })
      .returning({ id: connectedSource.id });
    const sourceId = src!.id;
    const [job] = await getDb()
      .insert(importJob)
      .values({ userId, sourceId, kind: 'initial', status: 'running' })
      .returning({ id: importJob.id });
    await getDb().insert(session).values({ token: randomUUID(), userId, expiresAt: new Date(Date.now() + 3600_000) });

    const result = await adminUsers.suspend(adminId, userId, 'free text reason that must not be stored');
    expect(result).toMatchObject({ id: userId, status: 'suspended' });

    const [u] = await getDb().select().from(user).where(eq(user.id, userId));
    expect(u!.status).toBe('suspended');
    expect(u!.suspendedAt).toBeInstanceOf(Date);
    expect(u!.suspendedBy).toBe(adminId);
    expect(await getDb().select().from(session).where(eq(session.userId, userId))).toHaveLength(0);
    const [s] = await getDb().select().from(connectedSource).where(eq(connectedSource.id, sourceId));
    expect(s).toMatchObject({ status: 'paused', pauseReason: 'suspended' });
    const [j] = await getDb().select().from(importJob).where(eq(importJob.id, job!.id));
    expect(j).toMatchObject({ status: 'paused', pauseReason: 'suspended' });
    expect(removeScheduler).toHaveBeenCalledWith(QUEUES.syncPoll, jobIds.poll(sourceId));
    expect(await auditActions(userId)).toContain('user.suspended');
    // The reason is free text: never persisted in the audit trail (FR-048).
    const audits = await getDb().select().from(auditLogEntry).where(eq(auditLogEntry.targetId, userId));
    expect(JSON.stringify(audits)).not.toContain('free text reason');

    // Suspending again is a no-op.
    await expect(adminUsers.suspend(adminId, userId)).resolves.toMatchObject({ status: 'suspended' });

    // Reinstate restores everything and restarts polling and the paused import.
    const back = await adminUsers.reinstate(adminId, userId);
    expect(back).toMatchObject({ id: userId, status: 'active' });
    const [u2] = await getDb().select().from(user).where(eq(user.id, userId));
    expect(u2).toMatchObject({ status: 'active', suspendedAt: null, suspendedBy: null });
    const [s2] = await getDb().select().from(connectedSource).where(eq(connectedSource.id, sourceId));
    expect(s2).toMatchObject({ status: 'connected', pauseReason: null });
    const [j2] = await getDb().select().from(importJob).where(eq(importJob.id, job!.id));
    expect(j2).toMatchObject({ status: 'running', pauseReason: null });
    expect(upsertScheduler).toHaveBeenCalledWith(
      QUEUES.syncPoll,
      jobIds.poll(sourceId),
      expect.objectContaining({ every: expect.any(Number) }),
      expect.objectContaining({ name: 'sync.poll', data: { userId, sourceId } }),
    );
    expect(enqueue).toHaveBeenCalledWith(
      'import.page',
      expect.objectContaining({ userId, sourceId, importJobId: job!.id }),
      expect.anything(),
    );
    expect(await auditActions(userId)).toContain('user.reinstated');
  });

  it('does not resume a source the user paused themselves', async () => {
    const adminId = await createUser('admin', 'actor2');
    const userId = await createUser('user', 'target2');
    const [src] = await getDb()
      .insert(connectedSource)
      .values({ userId, type: 'imap', accountLabel: 'Mine', accountAddress: `${randomUUID()}@example.test`, status: 'paused', pauseReason: 'user', consentTextVersion: 'v1' })
      .returning({ id: connectedSource.id });
    await adminUsers.suspend(adminId, userId);
    await adminUsers.reinstate(adminId, userId);
    const [s] = await getDb().select().from(connectedSource).where(eq(connectedSource.id, src!.id));
    expect(s).toMatchObject({ status: 'paused', pauseReason: 'user' });
    expect(upsertScheduler).not.toHaveBeenCalled();
  });

  it('suspending an unknown user is not_found', async () => {
    const adminId = await createUser('admin', 'actor3');
    expect((await errorOf(adminUsers.suspend(adminId, randomUUID()))).code).toBe('not_found');
  });
});

describe('setRole', () => {
  it('grants and revokes with audits', async () => {
    const adminId = await createUser('admin', 'grantor');
    const userId = await createUser('user', 'grantee');
    await expect(adminUsers.setRole(adminId, userId, 'admin')).resolves.toMatchObject({ id: userId, role: 'admin' });
    await expect(adminUsers.revokeRole(adminId, userId)).resolves.toMatchObject({ id: userId, role: 'user' });
    const actions = await auditActions(userId);
    expect(actions).toContain('user.role_granted');
    expect(actions).toContain('user.role_revoked');
  });
});

describe('list and detail', () => {
  it('filters and pages with a keyset cursor', async () => {
    const ids = [await createUser('user', 'l1'), await createUser('user', 'l2'), await createUser('user', 'l3')];
    const suspended = await createUser('user', 'l4', 'suspended');
    const page1 = await adminUsers.list({ query: `${tag}`, limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toEqual(expect.any(String));
    const page2 = await adminUsers.list({ query: `${tag}`, limit: 2, cursor: page1.nextCursor! });
    const seen = [...page1.items, ...page2.items].map((i) => i.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expect.arrayContaining(ids));

    const onlySuspended = await adminUsers.list({ query: `${tag}`, status: 'suspended', limit: 50 });
    expect(onlySuspended.items.map((i) => i.id)).toEqual([suspended]);
    const onlyAdmins = await adminUsers.list({ query: `${tag}`, role: 'admin', limit: 50 });
    expect(onlyAdmins.items.every((i) => i.role === 'admin')).toBe(true);
  });

  it('returns metadata only: identities, sources and profiles, no *Enc keys', async () => {
    const userId = await createUser('user', 'detail');
    const [acc] = await getDb()
      .insert(account)
      .values({ accountId: randomUUID(), providerId: 'google', userId })
      .returning({ id: account.id });
    await getDb().insert(signInIdentity).values({
      accountId: acc!.id,
      userId,
      provider: 'google',
      providerEmail: 'detail@example.test',
      emailVerified: true,
      isRelayEmail: false,
      linkedVia: 'signup',
    });
    await getDb()
      .insert(connectedSource)
      .values({ userId, type: 'imap', accountLabel: 'Box', accountAddress: `${randomUUID()}@example.test`, status: 'connected', consentTextVersion: 'v1' });

    const detail = await adminUsers.detail(userId);
    expect(detail.id).toBe(userId);
    expect(detail.identities).toEqual([expect.objectContaining({ provider: 'google', providerEmail: 'detail@example.test', verified: true })]);
    expect(detail.sources).toHaveLength(1);
    expect(detail.sources[0]).toEqual(expect.objectContaining({ type: 'imap', status: 'connected' }));
    expect(Array.isArray(detail.profiles)).toBe(true);
    const keys: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') {
        for (const [k, val] of Object.entries(v)) {
          keys.push(k);
          walk(val);
        }
      }
    };
    walk(detail);
    expect(keys.filter((k) => /Enc$|_enc$/.test(k))).toEqual([]);
    expect((await errorOf(adminUsers.detail(randomUUID()))).code).toBe('not_found');
  });
});
