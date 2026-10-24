import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLogEntry,
  closeDb,
  deletionRequest,
  getDb,
  getPool,
  profileVersion,
  toneDefinition,
  toneDefinitionVersion,
  toneProfile,
  user,
} from '@voicespark/db';
import { eq, inArray } from 'drizzle-orm';
import { closeQueues, QUEUES } from '@voicespark/core/queues';
import * as adminSystem from '@voicespark/core/services/admin-system';

// US6 / T131: health (real Redis-test), audit query with filters and cursor, ratings aggregates.
process.env.DATABASE_URL ??= 'postgres://voicespark:voicespark@localhost:55432/voicespark_test';
process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-00';
process.env.ENCRYPTION_KEYRING ??= JSON.stringify({ k1: Buffer.alloc(32, 1).toString('base64') });
process.env.ENCRYPTION_ACTIVE_KEY_ID ??= 'k1';
process.env.DEDUP_HMAC_KEY ??= Buffer.alloc(32, 2).toString('base64');
process.env.REDIS_URL ??= 'redis://localhost:56379';
process.env.NODE_ENV ??= 'test';
process.env.APP_URL ??= 'http://localhost:3000';

const tag = randomUUID().replace(/-/g, '').slice(0, 10);
const userIds: string[] = [];
const deletionIds: string[] = [];
const definitionIds: string[] = [];
const auditTargetType = `admin_system_test_${tag}`;
let adminId: string;

async function createUser(label: string): Promise<string> {
  const [row] = await getDb()
    .insert(user)
    .values({ name: `AS ${label}`, email: `as-${label}-${tag}@example.test` })
    .returning({ id: user.id });
  userIds.push(row!.id);
  return row!.id;
}

beforeAll(async () => {
  await getPool().query('select 1');
  adminId = await createUser('admin');
});

afterAll(async () => {
  const db = getDb();
  if (deletionIds.length > 0) await db.delete(deletionRequest).where(inArray(deletionRequest.id, deletionIds));
  await db.delete(auditLogEntry).where(eq(auditLogEntry.targetType, auditTargetType));
  if (userIds.length > 0) await db.delete(user).where(inArray(user.id, userIds));
  if (definitionIds.length > 0) {
    await db.update(toneDefinition).set({ activeVersionId: null }).where(inArray(toneDefinition.id, definitionIds));
    await db.delete(toneDefinition).where(inArray(toneDefinition.id, definitionIds));
  }
  await closeQueues();
  await closeDb();
});

describe('health', () => {
  it('returns counts for every queue in QUEUES from the real Redis', async () => {
    const health = await adminSystem.health();
    const names = Object.values(QUEUES);
    expect(names).toContain('hub');
    expect(Object.keys(health.queues).sort()).toEqual([...names].sort());
    for (const name of names) {
      expect(health.queues[name]).toEqual({
        waiting: expect.any(Number),
        active: expect.any(Number),
        failed: expect.any(Number),
        delayed: expect.any(Number),
      });
    }
    expect(health.credentialAuditHits).toEqual(expect.any(Number));
  });

  it('counts a seeded past-due pending deletion request as overdue, but not a completed one or a future one', async () => {
    const before = (await adminSystem.health()).overdueDeletions;
    const userId = await createUser('deletion');
    const base = { userId, subjectRef: 'a'.repeat(64), scope: 'content_item' as const, requestedBy: 'user' as const };
    const rows = await getDb()
      .insert(deletionRequest)
      .values([
        { ...base, status: 'pending', dueBy: new Date(Date.now() - 3600_000) },
        { ...base, status: 'completed', dueBy: new Date(Date.now() - 3600_000), completedAt: new Date() },
        { ...base, status: 'pending', dueBy: new Date(Date.now() + 86_400_000) },
      ])
      .returning({ id: deletionRequest.id });
    deletionIds.push(...rows.map((r) => r.id));
    expect((await adminSystem.health()).overdueDeletions).toBe(before + 1);
  });
});

describe('auditQuery', () => {
  async function seedAudit(): Promise<string> {
    const targetId = randomUUID();
    const base = Date.UTC(2001, 4, 1, 12, 0, 0);
    await getDb().insert(auditLogEntry).values([
      { occurredAt: new Date(base), actorType: 'admin', actorUserId: adminId, action: 'settings.changed', targetType: auditTargetType, targetId, metadata: { key: 'a' } },
      { occurredAt: new Date(base + 60_000), actorType: 'admin', actorUserId: adminId, action: 'settings.changed', targetType: auditTargetType, targetId, metadata: { key: 'b' } },
      { occurredAt: new Date(base + 120_000), actorType: 'admin', actorUserId: adminId, action: 'user.suspended', targetType: auditTargetType, targetId },
    ]);
    return targetId;
  }

  it('filters by action, actor, target and time range', async () => {
    const targetId = await seedAudit();
    const all = await adminSystem.auditQuery({ targetType: auditTargetType, targetId, limit: 50 });
    expect(all.items).toHaveLength(3);
    expect(all.nextCursor).toBeNull();
    // Newest first.
    expect(all.items.map((i) => i.action)).toEqual(['user.suspended', 'settings.changed', 'settings.changed']);
    expect(all.items[1]).toMatchObject({ targetType: auditTargetType, targetId, metadataKeys: ['key'] });
    expect(JSON.stringify(all.items)).not.toContain('"a"');

    const byAction = await adminSystem.auditQuery({ targetType: auditTargetType, action: 'user.suspended', limit: 50 });
    expect(byAction.items.map((i) => i.action)).toEqual(['user.suspended']);

    const byActor = await adminSystem.auditQuery({ targetType: auditTargetType, actorUserId: randomUUID(), limit: 50 });
    expect(byActor.items).toEqual([]);

    const base = Date.UTC(2001, 4, 1, 12, 0, 0);
    const ranged = await adminSystem.auditQuery({
      targetType: auditTargetType,
      from: new Date(base + 30_000),
      to: new Date(base + 90_000),
      limit: 50,
    });
    expect(ranged.items).toHaveLength(1);
  });

  it('pages with a keyset cursor without gaps or repeats', async () => {
    const targetId = await seedAudit();
    const page1 = await adminSystem.auditQuery({ targetType: auditTargetType, targetId, limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).toEqual(expect.any(String));
    const page2 = await adminSystem.auditQuery({ targetType: auditTargetType, targetId, limit: 2, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    const ids = [...page1.items, ...page2.items].map((i) => i.id);
    expect(new Set(ids).size).toBe(3);
  });
});

describe('ratingsMetrics', () => {
  it('counts only the latest rated version per profile', async () => {
    const db = getDb();
    const [def] = await db.insert(toneDefinition).values({ key: `t_rate_${tag}`, createdBy: adminId }).returning({ id: toneDefinition.id });
    definitionIds.push(def!.id);
    const [dv] = await db
      .insert(toneDefinitionVersion)
      .values({ definitionId: def!.id, versionNumber: 1, status: 'active', name: 'R', description: 'R', dimensions: [{ key: 'tone', name: 'Tone', description: 'Tone', valueType: 'text' }], createdBy: adminId })
      .returning({ id: toneDefinitionVersion.id });
    // An isolated window far in the past keeps other suites' ratings out of the aggregate.
    const t = (min: number) => new Date(Date.UTC(2001, 2, 1, 10, min, 0));
    const from = new Date(Date.UTC(2001, 2, 1, 0, 0, 0));
    const to = new Date(Date.UTC(2001, 2, 1, 23, 59, 59));

    async function profileWith(label: string, versions: { rating: 'sounds_like_me' | 'not_like_me' | null; at: Date }[]) {
      const userId = await createUser(label);
      const [p] = await db.insert(toneProfile).values({ userId, definitionId: def!.id }).returning({ id: toneProfile.id });
      let n = 0;
      for (const v of versions) {
        n += 1;
        await db.insert(profileVersion).values({
          profileId: p!.id,
          versionNumber: n,
          origin: n === 1 ? 'generated' : 'regenerated',
          definitionVersionId: dv!.id,
          bodyEnc: 'not-real-ciphertext',
          contributingItemCount: 1,
          rating: v.rating,
          ratedAt: v.rating ? v.at : null,
        });
      }
    }

    // P1: older not_like_me superseded by a later sounds_like_me -> counts once, as sounds_like_me.
    await profileWith('p1', [{ rating: 'not_like_me', at: t(1) }, { rating: 'sounds_like_me', at: t(2) }]);
    // P2: latest rated version is not_like_me (a later unrated version does not count).
    await profileWith('p2', [{ rating: 'sounds_like_me', at: t(1) }, { rating: 'not_like_me', at: t(2) }, { rating: null, at: t(3) }]);
    // P3: never rated.
    await profileWith('p3', [{ rating: null, at: t(1) }]);

    const metrics = await adminSystem.ratingsMetrics({ from, to });
    expect(metrics.profiles).toEqual({ rated: 2, soundsLikeMe: 1, share: 0.5 });
    // No drafts are rated in this window; byContentType always carries all three content types (D-A3).
    const none = { rated: 0, soundsLikeMe: 0, share: null };
    expect(metrics.drafts).toMatchObject(none);
    expect(metrics.drafts.byContentType).toEqual({ social_post: none, bio: none, short_article: none });

    const empty = await adminSystem.ratingsMetrics({ from: new Date(Date.UTC(1999, 0, 1)), to: new Date(Date.UTC(1999, 0, 2)) });
    expect(empty.profiles).toEqual({ rated: 0, soundsLikeMe: 0, share: null });
  });
});
