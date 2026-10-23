import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getPool } from '@voicespark/db';
import { EMAILED_NOTIFICATION_TYPES } from '@voicespark/integrations/smtp';
import { encrypt } from '@voicespark/core/crypto';
import { AppError, type ServiceContext } from '@voicespark/core/errors';
import { enqueue } from '@voicespark/core/queues';
import * as definitions from '@voicespark/core/services/definitions';
import {
  choose,
  cleanupProfiles,
  createUser,
  seedDefinition,
  seedOwnPrompt,
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

/** Users inserted in bulk by the fan-out test; deleted before cleanupProfiles drops the definitions. */
const bulkUserIds: string[] = [];
const touchedDefinitionIds: string[] = [];

afterAll(async () => {
  if (bulkUserIds.length > 0) {
    await getPool().query('delete from "user" where id = any($1::uuid[])', [bulkUserIds]);
  }
  if (touchedDefinitionIds.length > 0) {
    await getPool().query(
      `delete from version_activation where entity_type = 'definition' and entity_id = any($1::uuid[])`,
      [touchedDefinitionIds],
    );
    await getPool().query('delete from audit_log_entry where target_id = any($1::text[])', [
      touchedDefinitionIds,
    ]);
  }
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

// US4 / T076: a changed default analysis prompt notifies users whose own prompt is in use (contracts/notifications.md).
describe('definitions publish and rollback notify own-prompt users', () => {
  const NOTE = 'analysis_prompt_default_changed';

  const notificationsOf = async (userIds: string[]) =>
    (
      await getPool().query<{ user_id: string; payload: Record<string, unknown> }>(
        `select user_id, payload from notification where type = $1 and user_id = any($2::uuid[])
         order by created_at`,
        [NOTE, userIds],
      )
    ).rows;

  const lastAudit = async (definitionId: string, action: string) =>
    (
      await getPool().query<{ metadata: Record<string, unknown> }>(
        `select metadata from audit_log_entry where target_id = $1 and action = $2
         order by occurred_at desc limit 1`,
        [definitionId, action],
      )
    ).rows[0]?.metadata;

  async function setStatus(
    userId: string,
    status: 'suspended' | 'pending_deletion',
  ): Promise<void> {
    await getPool().query('update "user" set status = $2 where id = $1', [userId, status]);
  }

  /** Publishes a new draft with `patch` applied and returns its id. */
  async function publishDraft(
    adminId: string,
    definitionId: string,
    patch: { name?: string; description?: string; analysisPrompt?: string | null },
  ): Promise<string> {
    const draft = await definitions.createDraft(adminId, definitionId);
    await definitions.updateDraft(adminId, definitionId, draft.id, patch);
    await definitions.publish(adminId, definitionId, draft.id);
    return draft.id;
  }

  itStable(
    'notifies exactly the in-use own-prompt users of active status, on publish and rollback',
    async () => {
      const adminId = await createUser('Admin');
      const def = await seedDefinition({ analysisPrompt: 'Default prompt one.' });
      touchedDefinitionIds.push(def.definitionId);
      const v1 = def.versionId;

      const own = await createUser('Own');
      const reset = await createUser('Reset');
      const dflt = await createUser('Default');
      const suspended = await createUser('Suspended');
      const deleted = await createUser('Deleted');
      const everyone = [own, reset, dflt, suspended, deleted];
      for (const u of everyone) await choose(u, def.definitionId);
      const ownPrompt = await seedOwnPrompt({
        userId: own,
        definitionId: def.definitionId,
        text: 'Mine',
        basedOnDefinitionVersionId: v1,
      });
      await seedOwnPrompt({
        userId: reset,
        definitionId: def.definitionId,
        text: 'Reset',
        basedOnDefinitionVersionId: v1,
        inUse: false,
      });
      await seedOwnPrompt({
        userId: suspended,
        definitionId: def.definitionId,
        text: 'S',
        basedOnDefinitionVersionId: v1,
      });
      await seedOwnPrompt({
        userId: deleted,
        definitionId: def.definitionId,
        text: 'D',
        basedOnDefinitionVersionId: v1,
      });
      await setStatus(suspended, 'suspended');
      await setStatus(deleted, 'pending_deletion');

      vi.mocked(enqueue).mockClear();
      const v2 = await publishDraft(adminId, def.definitionId, {
        analysisPrompt: 'Default prompt two.',
      });
      const afterPublish = await notificationsOf(everyone);
      expect(afterPublish).toEqual([
        {
          user_id: own,
          payload: {
            definitionId: def.definitionId,
            ownPromptId: ownPrompt.ownPromptId,
            fromDefinitionVersionId: v1,
            toDefinitionVersionId: v2,
          },
        },
      ]);
      // In-app only: notify.send is queued, and the type is not one the mailer emails.
      expect(vi.mocked(enqueue).mock.calls.filter(([name]) => name === 'notify.send')).toHaveLength(
        1,
      );
      expect((EMAILED_NOTIFICATION_TYPES as readonly string[]).includes(NOTE)).toBe(false);
      expect(await lastAudit(def.definitionId, 'definition.version_published')).toMatchObject({
        analysisPromptChanged: true,
        notifiedUsers: 1,
      });

      // Rollback to v1 changes the text back: the user is notified again. `from` stays the own prompt's base.
      await definitions.rollback(adminId, def.definitionId, v1);
      const afterRollback = await notificationsOf(everyone);
      expect(afterRollback).toHaveLength(2);
      expect(afterRollback[1]).toEqual({
        user_id: own,
        payload: {
          definitionId: def.definitionId,
          ownPromptId: ownPrompt.ownPromptId,
          fromDefinitionVersionId: v1,
          toDefinitionVersionId: v1,
        },
      });
      expect(await lastAudit(def.definitionId, 'definition.rolled_back')).toMatchObject({
        analysisPromptChanged: true,
        notifiedUsers: 1,
      });
    },
  );

  itStable(
    'changes to name, description or whitespace around the prompt notify nobody',
    async () => {
      const adminId = await createUser('Admin');
      const def = await seedDefinition({ analysisPrompt: 'Same prompt.' });
      touchedDefinitionIds.push(def.definitionId);
      const own = await createUser('Own');
      await seedOwnPrompt({
        userId: own,
        definitionId: def.definitionId,
        text: 'Mine',
        basedOnDefinitionVersionId: def.versionId,
      });

      const v2 = await publishDraft(adminId, def.definitionId, {
        name: 'Renamed',
        description: 'New description',
      });
      await publishDraft(adminId, def.definitionId, { analysisPrompt: '  Same prompt.\n\n' });
      expect(await notificationsOf([own])).toEqual([]);
      expect(await lastAudit(def.definitionId, 'definition.version_published')).toMatchObject({
        analysisPromptChanged: false,
        notifiedUsers: 0,
      });
      await definitions.rollback(adminId, def.definitionId, v2);
      expect(await notificationsOf([own])).toEqual([]);
      expect(await lastAudit(def.definitionId, 'definition.rolled_back')).toMatchObject({
        analysisPromptChanged: false,
        notifiedUsers: 0,
      });
    },
  );

  itStable(
    'the first publish of a new definition notifies nobody and records the change',
    async () => {
      const adminId = await createUser('Admin');
      const created = await definitions.create(adminId, {
        key: `t_${randomBytes(6).toString('hex')}`,
        name: 'Fresh',
        description: 'Fresh definition',
        analysisPrompt: 'First prompt.',
      });
      touchedDefinitionIds.push(created.definition.id);
      try {
        await definitions.publish(adminId, created.definition.id, created.draft.id);
        expect(
          await lastAudit(created.definition.id, 'definition.version_published'),
        ).toMatchObject({
          analysisPromptChanged: true,
          notifiedUsers: 0,
        });
      } finally {
        await getPool().query('update tone_definition set active_version_id = null where id = $1', [
          created.definition.id,
        ]);
        await getPool().query('delete from tone_definition where id = $1', [created.definition.id]);
      }
    },
  );

  itStable('fans out to 1,000 users in under a second', async () => {
    const adminId = await createUser('Admin');
    const def = await seedDefinition({ analysisPrompt: 'Bulk prompt one.' });
    touchedDefinitionIds.push(def.definitionId);
    const tag = randomBytes(6).toString('hex');
    const pool = getPool();
    const users = await pool.query<{ id: string }>(
      `insert into "user" (name, email)
       select 'Bulk', 'bulk-' || g || '-' || $1 || '@example.test' from generate_series(1, 1000) g
       returning id`,
      [tag],
    );
    const ids = users.rows.map((r) => r.id);
    bulkUserIds.push(...ids);
    // Same order as seedOwnPrompt: insert not in use, add version 1, then point at it and flip in_use.
    await pool.query(
      `insert into own_analysis_prompt (user_id, definition_id, in_use) select u, $2, false from unnest($1::uuid[]) u`,
      [ids, def.definitionId],
    );
    await pool.query(
      `insert into own_analysis_prompt_version
         (own_prompt_id, version_number, prompt_text_enc, char_count, based_on_definition_version_id)
       select id, 1, $2, 4, $3 from own_analysis_prompt where definition_id = $1`,
      [def.definitionId, encrypt('user-content', 'Mine'), def.versionId],
    );
    await pool.query(
      `update own_analysis_prompt o set current_version_id = v.id, in_use = true
         from own_analysis_prompt_version v where v.own_prompt_id = o.id and o.definition_id = $1`,
      [def.definitionId],
    );

    const draft = await definitions.createDraft(adminId, def.definitionId);
    await definitions.updateDraft(adminId, def.definitionId, draft.id, {
      analysisPrompt: 'Bulk prompt two.',
    });
    const started = performance.now();
    await definitions.publish(adminId, def.definitionId, draft.id);
    const elapsed = performance.now() - started;

    const { rows } = await pool.query<{ n: string }>(
      'select count(*) as n from notification where type = $1 and user_id = any($2::uuid[])',
      [NOTE, ids],
    );
    expect(Number(rows[0]!.n)).toBe(1000);
    expect(await lastAudit(def.definitionId, 'definition.version_published')).toMatchObject({
      analysisPromptChanged: true,
      notifiedUsers: 1000,
    });
    expect(elapsed).toBeLessThan(1000);
  });
});
