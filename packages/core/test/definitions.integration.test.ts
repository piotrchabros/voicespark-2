import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getPool } from '@voicespark/db';
import { AppError, type ServiceContext } from '@voicespark/core/errors';
import * as definitions from '@voicespark/core/services/definitions';
import {
  cleanupProfiles,
  createUser,
  seedDefinition,
  setAvailability,
  withSoleAvailableDefinition,
  withStableDefinitions,
} from './helpers/profiles';

// US5 user-facing definitions (T118; FR-065, FR-066, FR-067). Queues are mocked (no Redis needed).
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

/** Tests whose definitions must stay `available` while they run (see withSoleAvailableDefinition). */
const itStable = (name: string, fn: () => Promise<void>) =>
  it(name, () => withStableDefinitions(fn), 30_000);

const asUser = async (): Promise<ServiceContext> => ({ userId: await createUser(), role: 'user' });

async function expectCode(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
}

const activeChoices = async (userId: string) =>
  (
    await getPool().query<{ definition_id: string }>(
      'select definition_id from user_definition_choice where user_id = $1 and removed_at is null order by definition_id',
      [userId],
    )
  ).rows.map((r) => r.definition_id);

const profileStatus = async (userId: string, definitionId: string) =>
  (
    await getPool().query<{ id: string; status: string }>(
      'select id, status from tone_profile where user_id = $1 and definition_id = $2',
      [userId, definitionId],
    )
  ).rows;

beforeAll(async () => {
  await getPool().query('select 1');
});

afterAll(async () => {
  await cleanupProfiles();
  await closeDb();
});

describe('definitions.listAvailable', () => {
  itStable(
    'lists only available definitions with an active version, named after that version',
    async () => {
      const ctx = await asUser();
      const available = await seedDefinition({ name: 'Available voice' });
      const retired = await seedDefinition({ availability: 'retired' });
      // Available but never published: no active version.
      const { rows } = await getPool().query<{ id: string }>(
        `insert into tone_definition (key, availability, created_by) values ($1, 'available', $2) returning id`,
        [`t_${randomBytes(6).toString('hex')}`, '00000000-0000-0000-0000-000000000000'],
      );
      const unpublished = rows[0]!.id;

      const list = await definitions.listAvailable(ctx);
      const ids = list.map((d) => d.id);
      expect(ids).toContain(available.definitionId);
      expect(ids).not.toContain(retired.definitionId);
      expect(ids).not.toContain(unpublished);
      expect(list.find((d) => d.id === available.definitionId)).toEqual({
        id: available.definitionId,
        name: 'Available voice',
        description: expect.any(String),
        chosen: false,
      });

      await getPool().query('delete from tone_definition where id = $1', [unpublished]);
    },
  );
});

describe('definitions.setChoices', () => {
  itStable(
    'creates choices and active profiles, removes dropped ones and reactivates on re-choose',
    async () => {
      const ctx = await asUser();
      const a = await seedDefinition();
      const b = await seedDefinition();

      const list = await definitions.setChoices(ctx, [a.definitionId, b.definitionId]);
      expect(list.find((d) => d.id === a.definitionId)?.chosen).toBe(true);
      expect(list.find((d) => d.id === b.definitionId)?.chosen).toBe(true);
      expect(await activeChoices(ctx.userId)).toEqual([a.definitionId, b.definitionId].sort());
      const [profileB] = await profileStatus(ctx.userId, b.definitionId);
      expect(profileB?.status).toBe('active');
      expect((await profileStatus(ctx.userId, a.definitionId))[0]?.status).toBe('active');

      const dropped = await definitions.setChoices(ctx, [a.definitionId]);
      expect(dropped.find((d) => d.id === b.definitionId)?.chosen).toBe(false);
      expect(await activeChoices(ctx.userId)).toEqual([a.definitionId]);
      const removedRow = await getPool().query<{ removed_at: Date | null }>(
        'select removed_at from user_definition_choice where user_id = $1 and definition_id = $2',
        [ctx.userId, b.definitionId],
      );
      expect(removedRow.rows).toHaveLength(1);
      expect(removedRow.rows[0]!.removed_at).toBeInstanceOf(Date);
      expect(await profileStatus(ctx.userId, b.definitionId)).toEqual([
        { id: profileB!.id, status: 'removed' },
      ]);

      await definitions.setChoices(ctx, [a.definitionId, b.definitionId]);
      expect(await activeChoices(ctx.userId)).toEqual([a.definitionId, b.definitionId].sort());
      // The profile row is reactivated (unique per user + definition), not duplicated.
      expect(await profileStatus(ctx.userId, b.definitionId)).toEqual([
        { id: profileB!.id, status: 'active' },
      ]);
    },
  );

  itStable('requires at least one definition', async () => {
    const ctx = await asUser();
    await expectCode(definitions.setChoices(ctx, []), 'validation_failed');
  });

  itStable(
    'rejects retired and unknown definitions with not_found and writes nothing',
    async () => {
      const ctx = await asUser();
      const ok = await seedDefinition();
      const retired = await seedDefinition({ availability: 'retired' });
      await expectCode(
        definitions.setChoices(ctx, [ok.definitionId, retired.definitionId]),
        'not_found',
      );
      await expectCode(definitions.setChoices(ctx, [randomUUID()]), 'not_found');
      expect(await activeChoices(ctx.userId)).toEqual([]);
    },
  );

  itStable('treats a definition retired after it was chosen as no longer choosable', async () => {
    const ctx = await asUser();
    const d = await seedDefinition();
    await definitions.setChoices(ctx, [d.definitionId]);
    await setAvailability(d.definitionId, 'retired');
    await expectCode(definitions.setChoices(ctx, [d.definitionId]), 'not_found');
    expect((await definitions.listAvailable(ctx)).map((x) => x.id)).not.toContain(d.definitionId);
  });
});

describe('definitions.autoChooseIfSingle', () => {
  it('chooses the only available definition once (idempotent)', async () => {
    const ctx = await asUser();
    const only = await seedDefinition();
    await withSoleAvailableDefinition(only.definitionId, async () => {
      expect(await definitions.autoChooseIfSingle(ctx)).toBe(true);
      expect(await activeChoices(ctx.userId)).toEqual([only.definitionId]);
      expect((await profileStatus(ctx.userId, only.definitionId))[0]?.status).toBe('active');

      expect(await definitions.autoChooseIfSingle(ctx)).toBe(false);
      expect(await activeChoices(ctx.userId)).toEqual([only.definitionId]);
      const rows = await getPool().query(
        'select id from user_definition_choice where user_id = $1',
        [ctx.userId],
      );
      expect(rows.rowCount).toBe(1);
    });
  }, 30_000);

  it('does nothing when the user already has an active choice', async () => {
    const ctx = await asUser();
    const first = await seedDefinition();
    await definitions.setChoices(ctx, [first.definitionId]);
    const only = await seedDefinition();
    await withSoleAvailableDefinition(only.definitionId, async () => {
      expect(await definitions.autoChooseIfSingle(ctx)).toBe(false);
    });
    expect(await activeChoices(ctx.userId)).toEqual([first.definitionId]);
  }, 30_000);
});
