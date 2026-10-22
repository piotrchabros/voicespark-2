import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  auditLogEntry,
  closeDb,
  contentItem,
  deletionRequest,
  getDb,
  getPool,
  user,
  type DeletionStatus,
  type UserStatus,
} from '@voicespark/db';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { subjectRef } from '@voicespark/core/crypto';
import { closeQueues, enqueue } from '@voicespark/core/queues';
import * as adminSystem from '@voicespark/core/services/admin-system';
import * as adminUsers from '@voicespark/core/services/admin-users';
import * as credentialAudit from '@voicespark/core/services/credential-audit';
import * as deletionSla from '@voicespark/core/services/deletion-sla';
import type { FilteredText } from '@voicespark/filters';
import { InMemoryMemoryStore, META, namespaceFor } from '@voicespark/integrations/supermemory';
import { ensureActivePrompt } from './helpers/profiles';

// Maintenance services (T143 core, T167 core, D-U7d/e/f) plus the admin count and draft rating metrics.
// enqueue is mocked; health() reads the real Redis-test queue counts.
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

const HOUR = 60 * 60 * 1000;
const PASSWORD_TEXT = 'Your Password: Hunter2xyz!';
const ft = (s: string) => s as FilteredText;

const userIds: string[] = [];

async function createUser(status: UserStatus = 'active', role: 'user' | 'admin' = 'user'): Promise<string> {
  const [row] = await getDb()
    .insert(user)
    .values({ name: 'Maint', email: `maint-${randomUUID()}@example.test`, status, role })
    .returning({ id: user.id });
  userIds.push(row!.id);
  return row!.id;
}

async function seedRequest(
  userId: string,
  status: DeletionStatus,
  dueBy: Date,
  extra: { attempts?: number; lastErrorCode?: string } = {},
): Promise<string> {
  const [row] = await getDb()
    .insert(deletionRequest)
    .values({
      userId,
      subjectRef: subjectRef(userId),
      scope: 'content_item',
      targetId: randomUUID(),
      requestedBy: 'system',
      status,
      requestedAt: new Date(dueBy.getTime() - 24 * HOUR),
      dueBy,
      attempts: extra.attempts ?? 0,
      lastErrorCode: extra.lastErrorCode ?? null,
      ...(status === 'completed' ? { completedAt: new Date() } : {}),
    })
    .returning({ id: deletionRequest.id });
  return row!.id;
}

async function requestRow(id: string) {
  const [r] = await getDb().select().from(deletionRequest).where(eq(deletionRequest.id, id));
  return r!;
}

/** An active content item (optionally an attachment of `parentItemId`) with its document in `store`. */
async function seedItem(
  store: InMemoryMemoryStore,
  userId: string,
  text: string,
  parentItemId?: string,
): Promise<string> {
  const id = randomUUID();
  await getDb()
    .insert(contentItem)
    .values({
      id,
      userId,
      kind: parentItemId ? 'attachment' : 'email',
      authorship: 'authored',
      itemDate: new Date(),
      wordCount: text.split(/\s+/).length,
      contentHash: randomBytes(32).toString('hex'),
      filterPolicyVersion: 1,
      status: 'active',
      parentItemId: parentItemId ?? null,
    });
  await store.addDocuments(namespaceFor(userId), [
    {
      id,
      content: ft(`Subject: note\n\n${text}`),
      documentDate: new Date().toISOString(),
      metadata: { [META.contentItemId]: id },
    },
  ]);
  return id;
}

const slaAudits = () =>
  getDb()
    .select()
    .from(auditLogEntry)
    .where(eq(auditLogEntry.action, 'deletion.sla_flagged'))
    .orderBy(desc(auditLogEntry.occurredAt));

beforeAll(async () => {
  await getPool().query('select 1');
});

beforeEach(() => {
  vi.mocked(enqueue).mockClear();
});

afterAll(async () => {
  if (userIds.length > 0) {
    await getDb().delete(deletionRequest).where(inArray(deletionRequest.userId, userIds));
    await getDb()
      .delete(auditLogEntry)
      .where(inArray(auditLogEntry.subjectRef, userIds.map((id) => subjectRef(id))));
    await getDb().delete(auditLogEntry).where(inArray(auditLogEntry.targetId, userIds));
    await getDb().delete(user).where(inArray(user.id, userIds));
  }
  await closeQueues();
  await closeDb();
});

// ---------------------------------------------------------------------------------------------------------------------

describe('runDeletionSla (T143, R19)', () => {
  it('flags at-risk and overdue rows, re-enqueues failed ones with a fresh job id, audits the counts', async () => {
    const now = new Date();
    // Baseline: earlier leftovers (other suites share the DB) are flagged/requeued now, so the deltas below are ours.
    const base = await deletionSla.runDeletionSla(now);

    const userId = await createUser();
    const soon = await seedRequest(userId, 'pending', new Date(now.getTime() + 1 * HOUR));
    const overdue = await seedRequest(userId, 'in_progress', new Date(now.getTime() - 1 * HOUR), { attempts: 2 });
    const failed = await seedRequest(userId, 'failed', new Date(now.getTime() + 30 * 60 * 1000), {
      attempts: 3,
      lastErrorCode: 'verify_failed',
    });
    const done = await seedRequest(userId, 'completed', new Date(now.getTime() - 5 * HOUR));
    const later = await seedRequest(userId, 'pending', new Date(now.getTime() + 5 * HOUR));
    vi.mocked(enqueue).mockClear();

    const result = await deletionSla.runDeletionSla(now);

    expect(result.flagged - base.flagged).toBe(3);
    expect(result.overdue - base.overdue).toBe(1);
    expect(result.requeued).toBe(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      'deletion.execute',
      { deletionRequestId: failed },
      { jobId: `deletion-${failed}-r3` },
    );
    expect(await requestRow(failed)).toMatchObject({ status: 'pending', lastErrorCode: 'verify_failed' });
    expect((await requestRow(soon)).status).toBe('pending');
    expect((await requestRow(overdue)).status).toBe('in_progress');
    expect((await requestRow(done)).status).toBe('completed');
    expect((await requestRow(later)).status).toBe('pending');

    const [latest] = await slaAudits();
    expect(latest).toMatchObject({ actorType: 'system', actorUserId: null });
    expect(latest!.metadata).toEqual(result);
  });

  it('writes no audit entry when nothing is flagged', async () => {
    const before = (await slaAudits()).length;
    // Nothing is due within 2 h of the epoch.
    expect(await deletionSla.runDeletionSla(new Date(0))).toEqual({ flagged: 0, overdue: 0, requeued: 0 });
    expect((await slaAudits()).length).toBe(before);
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe('health().overdueDeletions counts the flagged set (D-U7e)', () => {
  it('includes a pending request due within 2 h, excludes completed and later ones', async () => {
    const userId = await createUser();
    const now = Date.now();
    const before = (await adminSystem.health()).overdueDeletions;
    await seedRequest(userId, 'pending', new Date(now + 1 * HOUR));
    await seedRequest(userId, 'completed', new Date(now - 1 * HOUR));
    await seedRequest(userId, 'pending', new Date(now + 6 * HOUR));
    expect((await adminSystem.health()).overdueDeletions).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('runCredentialAudit (T167, SC-005)', () => {
  it('finds locked-category hits, requests system content_item deletions (parent for attachments), audits counts only', async () => {
    const store = new InMemoryMemoryStore();
    const getDocument = vi.spyOn(store, 'getDocument');

    const direct = await createUser();
    const leaked = await seedItem(store, direct, PASSWORD_TEXT);
    const benign = await seedItem(store, direct, 'Lunch at noon on Friday?');

    const withAttachment = await createUser();
    const parent = await seedItem(store, withAttachment, 'See the attached file.');
    const attachment = await seedItem(store, withAttachment, PASSWORD_TEXT, parent);

    const suspended = await createUser('suspended');
    await seedItem(store, suspended, PASSWORD_TEXT);
    const leaving = await createUser('pending_deletion');
    await seedItem(store, leaving, PASSWORD_TEXT);

    const sampled = await createUser();
    for (let i = 0; i < 5; i++) await seedItem(store, sampled, `Plain note number ${i}`);

    expect(credentialAudit.CREDENTIAL_AUDIT_SAMPLE).toBe(200);
    const result = await credentialAudit.runCredentialAudit(store, { sample: 2 });

    // Only the namespaces seeded here hold documents in this store.
    expect(result.scanned).toBe(2 + 2 + 2);
    expect(result.hits).toBe(2);
    expect(result.deletionRequests).toBe(2);
    expect(result.namespaces).toBeGreaterThanOrEqual(3);

    const requests = await getDb()
      .select()
      .from(deletionRequest)
      .where(inArray(deletionRequest.userId, [direct, withAttachment, suspended, leaving, sampled]));
    expect(
      requests.map((r) => ({ userId: r.userId, scope: r.scope, targetId: r.targetId, requestedBy: r.requestedBy })),
    ).toEqual(
      expect.arrayContaining([
        { userId: direct, scope: 'content_item', targetId: leaked, requestedBy: 'system' },
        { userId: withAttachment, scope: 'content_item', targetId: parent, requestedBy: 'system' },
      ]),
    );
    expect(requests).toHaveLength(2);
    expect(requests.map((r) => r.targetId)).not.toContain(benign);
    expect(requests.map((r) => r.targetId)).not.toContain(attachment);
    for (const r of requests) {
      expect(enqueue).toHaveBeenCalledWith('deletion.execute', { deletionRequestId: r.id }, { jobId: `deletion-${r.id}` });
    }

    const hits = await getDb()
      .select()
      .from(auditLogEntry)
      .where(and(eq(auditLogEntry.action, 'filter.audit_hit'), inArray(auditLogEntry.targetId, [direct, withAttachment])));
    expect(hits).toHaveLength(2);
    for (const h of hits) {
      expect(h).toMatchObject({ actorType: 'system', targetType: 'user' });
      expect(h.metadata).toEqual({ category: 'passwords', count: 1 });
      expect(JSON.stringify(h)).not.toContain('Hunter2xyz');
    }

    // Suspended / pending-deletion users are skipped entirely; at most `sample` documents are read per namespace.
    const nsCalls = (userId: string) =>
      getDocument.mock.calls.filter(([ns]) => ns === namespaceFor(userId)).length;
    expect(nsCalls(suspended)).toBe(0);
    expect(nsCalls(leaving)).toBe(0);
    expect(nsCalls(sampled)).toBeLessThanOrEqual(2);
    expect(nsCalls(direct)).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------

describe('admin-users.count (countUsers follow-up)', () => {
  it('counts by role and status', async () => {
    const [total] = await getDb().select({ n: count() }).from(user);
    expect(await adminUsers.count()).toBe(total!.n);

    const suspendedBefore = await adminUsers.count({ status: 'suspended' });
    const adminsBefore = await adminUsers.count({ role: 'admin' });
    await createUser('suspended');
    await createUser('active', 'admin');
    expect(await adminUsers.count({ status: 'suspended' })).toBe(suspendedBefore + 1);
    expect(await adminUsers.count({ role: 'admin' })).toBe(adminsBefore + 1);
    expect(await adminUsers.count({ role: 'admin', status: 'suspended' })).toBeGreaterThanOrEqual(0);
  });
});

describe('ratingsMetrics drafts (D-A3)', () => {
  it('aggregates rated drafts in range by content type from rating metadata only', async () => {
    const userId = await createUser();
    const promptId = await ensureActivePrompt('draft.social_post');
    // A window nothing else writes to.
    const from = new Date('2001-03-01T00:00:00Z');
    const to = new Date('2001-03-02T00:00:00Z');
    const at = new Date('2001-03-01T12:00:00Z');
    const seed = (contentType: string, rating: string | null, ratedAt: Date | null) =>
      getPool().query(
        `insert into draft (user_id, content_type, profile_version_id, prompt_version_id, topic_enc, brief_enc, status, rating, rated_at)
         values ($1, $2, $3, $4, 'x', 'x', 'ready', $5, $6)`,
        [userId, contentType, randomUUID(), promptId, rating, ratedAt],
      );
    await seed('social_post', 'sounds_like_me', at);
    await seed('social_post', 'not_like_me', at);
    await seed('bio', 'sounds_like_me', at);
    await seed('bio', null, null);
    await seed('short_article', 'sounds_like_me', new Date('2001-04-01T00:00:00Z'));

    const m = await adminSystem.ratingsMetrics({ from, to });
    expect(m.drafts).toMatchObject({ rated: 3, soundsLikeMe: 2 });
    expect(m.drafts.share).toBeCloseTo(2 / 3);
    expect(m.drafts.byContentType).toEqual({
      social_post: { rated: 2, soundsLikeMe: 1, share: 0.5 },
      bio: { rated: 1, soundsLikeMe: 1, share: 1 },
      short_article: { rated: 0, soundsLikeMe: 0, share: null },
    });
  });
});
