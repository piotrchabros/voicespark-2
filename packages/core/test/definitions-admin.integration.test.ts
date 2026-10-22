import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditLogEntry,
  closeDb,
  getDb,
  getPool,
  toneDefinition,
  toneDefinitionVersion,
  user,
  userDefinitionChoice,
  versionActivation,
  type Dimension,
} from '@voicespark/db';
import { and, eq, inArray } from 'drizzle-orm';
import { AppError } from '@voicespark/core/errors';
import * as definitions from '@voicespark/core/services/definitions';

// US6 / T128: admin part of the definitions service (create, versions, publish, rollback, availability).
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
const definitionIds: string[] = [];
let adminId: string;

const dims = (extra = ''): Dimension[] => [
  { key: 'formality', name: 'Formality', description: `How formal${extra}`, valueType: 'scale', scale: { min: 1, max: 5, minLabel: 'casual', maxLabel: 'formal' } },
  { key: 'warmth', name: 'Warmth', description: 'How warm', valueType: 'text' },
];

const newKey = (label: string): string => `t_${label}_${tag}`;

async function errorOf(p: Promise<unknown>): Promise<AppError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  return err as AppError;
}

async function createDef(label: string) {
  const created = await definitions.create(adminId, { key: newKey(label), name: `Def ${label}`, description: 'A test definition', dimensions: dims() });
  definitionIds.push(created.definition.id);
  return created;
}

async function auditActions(targetId: string): Promise<string[]> {
  const rows = await getDb().select({ action: auditLogEntry.action }).from(auditLogEntry).where(eq(auditLogEntry.targetId, targetId));
  return rows.map((r) => r.action);
}

beforeAll(async () => {
  await getPool().query('select 1');
  const [row] = await getDb()
    .insert(user)
    .values({ name: 'Def Admin', email: `defadmin-${tag}@example.test`, role: 'admin' })
    .returning({ id: user.id });
  adminId = row!.id;
  userIds.push(adminId);
});

afterAll(async () => {
  const db = getDb();
  if (definitionIds.length > 0) {
    await db.delete(userDefinitionChoice).where(inArray(userDefinitionChoice.definitionId, definitionIds));
    await db.update(toneDefinition).set({ activeVersionId: null }).where(inArray(toneDefinition.id, definitionIds));
    await db.delete(toneDefinition).where(inArray(toneDefinition.id, definitionIds));
    await db.delete(versionActivation).where(inArray(versionActivation.entityId, definitionIds));
  }
  if (userIds.length > 0) await db.delete(user).where(inArray(user.id, userIds));
  await closeDb();
});

describe('create', () => {
  it('creates a retired definition with a v1 draft and audits it', async () => {
    const { definition, draft } = await createDef('create');
    expect(definition).toMatchObject({ key: newKey('create'), availability: 'retired', activeVersion: null, userChoiceCount: 0 });
    expect(draft).toMatchObject({ versionNumber: 1, status: 'draft', name: 'Def create' });
    expect(draft.dimensions).toHaveLength(2);
    expect(definition.draftVersionId).toBe(draft.id);
    expect(await auditActions(definition.id)).toContain('definition.created');
  });

  it('rejects a bad key, bad dimensions and a duplicate key', async () => {
    const base = { name: 'N', description: 'D', dimensions: dims() };
    for (const key of ['Bad-Key', 'ab', '1abc', 'x'.repeat(65)]) {
      expect((await errorOf(definitions.create(adminId, { ...base, key }))).code).toBe('validation_failed');
    }
    expect((await errorOf(definitions.create(adminId, { ...base, key: newKey('baddims'), dimensions: [] }))).code).toBe('validation_failed');
    const dup = [...dims(), ...dims()];
    expect((await errorOf(definitions.create(adminId, { ...base, key: newKey('dupdims'), dimensions: dup }))).code).toBe('validation_failed');
    await createDef('dupkey');
    expect((await errorOf(definitions.create(adminId, { ...base, key: newKey('dupkey') }))).code).toBe('conflict');
  });
});

describe('draft lifecycle', () => {
  it('updates and discards drafts, and rejects edits to non-drafts with 422 version_not_draft', async () => {
    const { definition, draft } = await createDef('drafts');
    const updated = await definitions.updateDraft(adminId, definition.id, draft.id, { name: 'Renamed', dimensions: dims(' v2') });
    expect(updated).toMatchObject({ id: draft.id, name: 'Renamed' });

    await definitions.publish(adminId, definition.id, draft.id);
    const err = await errorOf(definitions.updateDraft(adminId, definition.id, draft.id, { name: 'Nope' }));
    expect(err.code).toBe('version_not_draft');
    expect(err.status).toBe(422);
    expect((await errorOf(definitions.discardDraft(adminId, definition.id, draft.id))).code).toBe('version_not_draft');

    const second = await definitions.createDraft(adminId, definition.id);
    expect(second).toMatchObject({ versionNumber: 2, status: 'draft', name: 'Renamed' });
    expect((await errorOf(definitions.createDraft(adminId, definition.id))).code).toBe('conflict');
    await definitions.discardDraft(adminId, definition.id, second.id);
    const rows = await getDb().select().from(toneDefinitionVersion).where(eq(toneDefinitionVersion.id, second.id));
    expect(rows).toHaveLength(0);
    expect(await auditActions(definition.id)).toContain('definition.version_drafted');
  });

  it('unknown ids are not_found', async () => {
    const { definition } = await createDef('nf');
    expect((await errorOf(definitions.adminGet(randomUUID()))).code).toBe('not_found');
    expect((await errorOf(definitions.updateDraft(adminId, definition.id, randomUUID(), { name: 'x' }))).code).toBe('not_found');
    expect((await errorOf(definitions.publish(adminId, definition.id, randomUUID()))).code).toBe('not_found');
  });
});

describe('publish, rollback, history, diff', () => {
  it('publishes, supersedes the previous active, rolls back, and records history and audits', async () => {
    const { definition, draft: v1 } = await createDef('publish');
    const afterV1 = await definitions.publish(adminId, definition.id, v1.id);
    expect(afterV1.activeVersion).toMatchObject({ id: v1.id, versionNumber: 1 });

    const v2 = await definitions.createDraft(adminId, definition.id);
    await definitions.updateDraft(adminId, definition.id, v2.id, { description: 'Changed description', dimensions: dims(' changed') });
    const afterV2 = await definitions.publish(adminId, definition.id, v2.id);
    expect(afterV2.activeVersion).toMatchObject({ id: v2.id, versionNumber: 2 });

    const detail = await definitions.adminGet(definition.id);
    expect(detail.versions.find((v) => v.id === v1.id)?.status).toBe('superseded');
    expect(detail.versions.find((v) => v.id === v2.id)?.status).toBe('active');
    expect(detail.versions.find((v) => v.id === v2.id)?.publishedBy).toBe(adminId);

    // Only superseded versions can be rolled back to.
    expect((await errorOf(definitions.rollback(adminId, definition.id, v2.id))).code).toBe('conflict');
    const rolled = await definitions.rollback(adminId, definition.id, v1.id);
    expect(rolled.activeVersion).toMatchObject({ id: v1.id });

    const [defRow] = await getDb().select().from(toneDefinition).where(eq(toneDefinition.id, definition.id));
    expect(defRow!.activeVersionId).toBe(v1.id);

    const activations = await getDb()
      .select()
      .from(versionActivation)
      .where(and(eq(versionActivation.entityType, 'definition'), eq(versionActivation.entityId, definition.id)));
    expect(activations.map((a) => a.action).sort()).toEqual(['publish', 'publish', 'rollback']);
    const rollback = activations.find((a) => a.action === 'rollback')!;
    expect(rollback).toMatchObject({ fromVersionId: v2.id, toVersionId: v1.id, actorUserId: adminId });

    const history = await definitions.history(definition.id);
    expect(history).toHaveLength(3);
    expect(history[0]).toMatchObject({ action: 'rollback', toVersion: { id: v1.id, versionNumber: 1 }, fromVersion: { id: v2.id } });

    const actions = await auditActions(definition.id);
    expect(actions).toEqual(expect.arrayContaining(['definition.version_published', 'definition.rolled_back']));

    const diff = await definitions.diff(definition.id, v1.id, v2.id);
    expect(diff.from).toMatchObject({ id: v1.id, versionNumber: 1 });
    expect(diff.to).toMatchObject({ id: v2.id, versionNumber: 2 });
    expect(diff.changes.some((c) => c.path.startsWith('description') && c.op === 'changed')).toBe(true);
    expect(diff.changes.some((c) => c.path.startsWith('dimensions'))).toBe(true);
    expect((await definitions.diff(definition.id, v1.id, v1.id)).changes).toEqual([]);
  });

  it('publishing a non-draft is version_not_draft', async () => {
    const { definition, draft } = await createDef('republish');
    await definitions.publish(adminId, definition.id, draft.id);
    expect((await errorOf(definitions.publish(adminId, definition.id, draft.id))).code).toBe('version_not_draft');
  });
});

describe('availability', () => {
  it('refuses to become available without an active version', async () => {
    const { definition } = await createDef('noactive');
    const err = await errorOf(definitions.setAvailability(adminId, definition.id, 'available'));
    expect(err.code).toBe('conflict');
    expect(err.status).toBe(409);
  });

  it('makes available and retires, refusing to retire the last available definition', async () => {
    // Make this definition the only available one for the duration of the check.
    const previouslyAvailable = await getDb()
      .select({ id: toneDefinition.id })
      .from(toneDefinition)
      .where(eq(toneDefinition.availability, 'available'));
    const ids = previouslyAvailable.map((r) => r.id);
    if (ids.length > 0) await getDb().update(toneDefinition).set({ availability: 'retired' }).where(inArray(toneDefinition.id, ids));
    try {
      const { definition, draft } = await createDef('avail');
      await definitions.publish(adminId, definition.id, draft.id);
      const made = await definitions.setAvailability(adminId, definition.id, 'available');
      expect(made.availability).toBe('available');

      const err = await errorOf(definitions.setAvailability(adminId, definition.id, 'retired'));
      expect(err.code).toBe('last_available_definition');
      expect(err.status).toBe(409);

      const other = await createDef('avail2');
      await definitions.publish(adminId, other.definition.id, other.draft.id);
      await definitions.setAvailability(adminId, other.definition.id, 'available');
      const retired = await definitions.setAvailability(adminId, definition.id, 'retired');
      expect(retired.availability).toBe('retired');

      const actions = await auditActions(definition.id);
      expect(actions).toEqual(expect.arrayContaining(['definition.made_available', 'definition.retired']));
    } finally {
      if (ids.length > 0) await getDb().update(toneDefinition).set({ availability: 'available' }).where(inArray(toneDefinition.id, ids));
    }
  });
});

describe('adminList', () => {
  it('reports userChoiceCount for active choices only', async () => {
    const { definition, draft } = await createDef('choices');
    await definitions.publish(adminId, definition.id, draft.id);
    const [u1] = await getDb().insert(user).values({ name: 'C1', email: `c1-${tag}@example.test` }).returning({ id: user.id });
    const [u2] = await getDb().insert(user).values({ name: 'C2', email: `c2-${tag}@example.test` }).returning({ id: user.id });
    userIds.push(u1!.id, u2!.id);
    await getDb().insert(userDefinitionChoice).values([
      { userId: u1!.id, definitionId: definition.id },
      { userId: u2!.id, definitionId: definition.id, removedAt: new Date() },
    ]);
    const list = await definitions.adminList();
    const item = list.find((d) => d.id === definition.id);
    expect(item).toMatchObject({ key: newKey('choices'), userChoiceCount: 1, activeVersion: { id: draft.id, versionNumber: 1 } });
  });
});
