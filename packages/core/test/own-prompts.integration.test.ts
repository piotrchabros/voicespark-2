import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getPool } from '@voicespark/db';
import { decrypt } from '@voicespark/core/crypto';
import { AppError, type ServiceContext } from '@voicespark/core/errors';
import * as ownPrompts from '@voicespark/core/services/own-prompts';
import {
  choose,
  cleanupProfiles,
  createUser,
  seedDefinition,
  seedOwnPrompt,
  setAvailability,
  type SeededDefinition,
} from './helpers/profiles';

// US3/US4 own analysis prompts (T064; data-model.md "Own-prompt state machine", contracts/http-api.md).
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

const DEFAULT_V1 = 'Describe how the writer sounds.\n- Tone: warm or cold\n- Greeting habits\n';
const DEFAULT_V2 = 'Describe how the writer sounds.\n- Tone: warm or cold\n- Sign-off habits\n';
const MARKER = 'ZZ-OWN-PROMPT-MARKER';

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

/** A user who chose a fresh definition whose default is DEFAULT_V1. */
async function setup(): Promise<{ ctx: ServiceContext; def: SeededDefinition; profileId: string }> {
  const userId = await createUser();
  const def = await seedDefinition({ analysisPrompt: DEFAULT_V1 });
  const profileId = await choose(userId, def.definitionId);
  return { ctx: { userId, role: 'user' }, def, profileId };
}

/** Publishes a new active default version and returns its id. */
async function publishDefault(definitionId: string, text: string): Promise<string> {
  const pool = getPool();
  const admin = randomUUID();
  await pool.query(
    `update tone_definition_version set status = 'superseded' where definition_id = $1 and status = 'active'`,
    [definitionId],
  );
  const { rows } = await pool.query<{ id: string }>(
    `insert into tone_definition_version
       (definition_id, version_number, status, name, description, analysis_prompt, created_by, published_by,
        published_at)
     select $1, max(version_number) + 1, 'active', 'Voice next', 'Next default', $2, $3, $3, now()
       from tone_definition_version where definition_id = $1
     returning id`,
    [definitionId, text, admin],
  );
  await pool.query('update tone_definition set active_version_id = $2 where id = $1', [
    definitionId,
    rows[0]!.id,
  ]);
  return rows[0]!.id;
}

async function auditRows(userId: string, action: string) {
  const { rows } = await getPool().query<{
    actor_type: string;
    target_type: string;
    target_id: string;
    metadata: Record<string, unknown>;
  }>(
    `select actor_type, target_type, target_id, metadata from audit_log_entry
      where actor_user_id = $1 and action = $2 order by occurred_at, id`,
    [userId, action],
  );
  return rows;
}

async function storedVersions(ownPromptId: string) {
  const { rows } = await getPool().query<{
    id: string;
    version_number: number;
    prompt_text_enc: string;
    char_count: number;
    based_on_definition_version_id: string;
  }>(
    `select id, version_number, prompt_text_enc, char_count, based_on_definition_version_id
       from own_analysis_prompt_version where own_prompt_id = $1 order by version_number`,
    [ownPromptId],
  );
  return rows;
}

async function ownRow(ownPromptId: string) {
  const { rows } = await getPool().query<{ in_use: boolean; current_version_id: string | null }>(
    'select in_use, current_version_id from own_analysis_prompt where id = $1',
    [ownPromptId],
  );
  return rows[0]!;
}

afterAll(async () => {
  await cleanupProfiles();
  await closeDb();
});

describe('own analysis prompt state machine', () => {
  it('none -> customise copies the active default text and based_on (version 1, in use)', async () => {
    const { ctx, def } = await setup();
    const res = await ownPrompts.customise(ctx, def.definitionId);
    expect(res.own.inUse).toBe(true);
    expect(res.own.currentVersion.versionNumber).toBe(1);
    expect(res.own.currentVersion.basedOnDefinitionVersionId).toBe(def.versionId);
    expect(typeof res.own.currentVersion.createdAt).toBe('string');

    const detail = await ownPrompts.get(ctx, def.definitionId);
    expect(detail.default).toEqual({
      definitionVersionId: def.versionId,
      versionNumber: 1,
      promptText: DEFAULT_V1,
    });
    expect(detail.own?.inUse).toBe(true);
    expect(detail.own?.currentVersion?.promptText).toBe(DEFAULT_V1);
    expect(detail.own?.currentVersion?.basedOnDefinitionVersion).toEqual({
      id: def.versionId,
      versionNumber: 1,
    });
    expect(detail.limits).toEqual({ maxChars: 20000 });

    const [v1] = await storedVersions(res.own.id);
    expect(v1!.char_count).toBe(DEFAULT_V1.length);
    expect(v1!.prompt_text_enc).not.toContain('Describe');
    expect(decrypt('user-content', v1!.prompt_text_enc)).toBe(DEFAULT_V1);

    const audits = await auditRows(ctx.userId, 'analysis_prompt.customised');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toEqual({
      actor_type: 'user',
      target_type: 'definition',
      target_id: def.definitionId,
      metadata: {
        ownPromptId: res.own.id,
        versionId: res.own.currentVersion.id,
        basedOnDefinitionVersionId: def.versionId,
        charCount: DEFAULT_V1.length,
      },
    });
  });

  it('own -> customise is refused with 409 conflict', async () => {
    const { ctx, def } = await setup();
    await ownPrompts.customise(ctx, def.definitionId);
    await expectCode(ownPrompts.customise(ctx, def.definitionId), 'conflict', 409);
  });

  it('own -> save inserts version n+1, keeps based_on, encrypts the text and audits ids only', async () => {
    const { ctx, def } = await setup();
    const c = await ownPrompts.customise(ctx, def.definitionId);
    // A newer default does not move based_on of a save.
    await publishDefault(def.definitionId, DEFAULT_V2);
    const text = `${DEFAULT_V1}- How I sign off emails ${MARKER}\n`;
    const s = await ownPrompts.save(ctx, def.definitionId, {
      promptText: text,
      baseVersionId: c.own.currentVersion.id,
    });
    expect(s.own.id).toBe(c.own.id);
    expect(s.own.inUse).toBe(true);
    expect(s.own.currentVersion.versionNumber).toBe(2);
    expect(s.own.currentVersion.basedOnDefinitionVersionId).toBe(def.versionId);

    const rows = await storedVersions(c.own.id);
    expect(rows.map((r) => r.version_number)).toEqual([1, 2]);
    expect(rows[1]!.prompt_text_enc).not.toContain(MARKER);
    expect(rows[1]!.prompt_text_enc).not.toContain('sign off');
    expect(decrypt('user-content', rows[1]!.prompt_text_enc).trim()).toBe(text.trim());
    expect(await ownRow(c.own.id)).toEqual({ in_use: true, current_version_id: rows[1]!.id });

    const detail = await ownPrompts.get(ctx, def.definitionId);
    expect(detail.own?.currentVersion?.promptText).toContain(MARKER);

    const audits = await auditRows(ctx.userId, 'analysis_prompt.saved');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.target_type).toBe('definition');
    expect(audits[0]!.target_id).toBe(def.definitionId);
    expect(audits[0]!.metadata).toEqual({
      ownPromptId: c.own.id,
      versionId: s.own.currentVersion.id,
      basedOnDefinitionVersionId: def.versionId,
      charCount: rows[1]!.char_count,
    });
    expect(JSON.stringify(audits)).not.toContain(MARKER);
  });

  it('save with a stale baseVersionId is 409 conflict', async () => {
    const { ctx, def } = await setup();
    const c = await ownPrompts.customise(ctx, def.definitionId);
    await ownPrompts.save(ctx, def.definitionId, {
      promptText: 'first edit',
      baseVersionId: c.own.currentVersion.id,
    });
    await expectCode(
      ownPrompts.save(ctx, def.definitionId, {
        promptText: 'second edit from a stale editor',
        baseVersionId: c.own.currentVersion.id,
      }),
      'conflict',
      409,
    );
    expect(await storedVersions(c.own.id)).toHaveLength(2);
  });

  it('save validates the text: empty after trim and over 20000 characters', async () => {
    const { ctx, def } = await setup();
    const c = await ownPrompts.customise(ctx, def.definitionId);
    const base = c.own.currentVersion.id;
    const empty = await expectCode(
      ownPrompts.save(ctx, def.definitionId, { promptText: '  \n\t ', baseVersionId: base }),
      'validation_failed',
      422,
    );
    expect(empty.details).toEqual({ field: 'promptText', reason: 'empty', maxChars: 20000 });
    const long = await expectCode(
      ownPrompts.save(ctx, def.definitionId, {
        promptText: 'x'.repeat(20001),
        baseVersionId: base,
      }),
      'validation_failed',
      422,
    );
    expect(long.details).toEqual({ field: 'promptText', reason: 'too_long', maxChars: 20000 });
    const ok = await ownPrompts.save(ctx, def.definitionId, {
      promptText: 'y'.repeat(20000),
      baseVersionId: base,
    });
    expect(ok.own.currentVersion.versionNumber).toBe(2);
  });

  it('own -> reset sets in_use = false, keeps versions, is idempotent and audited once', async () => {
    const { ctx, def } = await setup();
    const c = await ownPrompts.customise(ctx, def.definitionId);
    const s = await ownPrompts.save(ctx, def.definitionId, {
      promptText: 'my own prompt',
      baseVersionId: c.own.currentVersion.id,
    });
    const r = await ownPrompts.reset(ctx, def.definitionId);
    expect(r).toEqual({ own: { id: c.own.id, inUse: false } });
    expect(await ownPrompts.reset(ctx, def.definitionId)).toEqual(r);
    expect(await ownRow(c.own.id)).toEqual({
      in_use: false,
      current_version_id: s.own.currentVersion.id,
    });
    expect(await storedVersions(c.own.id)).toHaveLength(2);

    const versions = await ownPrompts.listVersions(ctx, def.definitionId);
    expect(versions.map((v) => v.versionNumber)).toEqual([2, 1]);
    expect(versions.every((v) => !v.inUseNow)).toBe(true);

    const detail = await ownPrompts.get(ctx, def.definitionId);
    expect(detail.own?.inUse).toBe(false);
    expect(detail.own?.currentVersion?.versionNumber).toBe(2);
    expect(detail.own?.currentVersion?.promptText).toBe('my own prompt');

    const [item] = (await ownPrompts.list(ctx)).filter((i) => i.definition.id === def.definitionId);
    expect(item!.mode).toBe('default');
    expect(item!.own?.inUse).toBe(false);

    const audits = await auditRows(ctx.userId, 'analysis_prompt.reset');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toEqual({
      ownPromptId: c.own.id,
      versionId: s.own.currentVersion.id,
      basedOnDefinitionVersionId: def.versionId,
      charCount: 'my own prompt'.length,
    });
  });

  it('reset -> customise inserts a fresh copy of the current default with the new based_on', async () => {
    const { ctx, def } = await setup();
    const c = await ownPrompts.customise(ctx, def.definitionId);
    await ownPrompts.reset(ctx, def.definitionId);
    const v2 = await publishDefault(def.definitionId, DEFAULT_V2);
    const again = await ownPrompts.customise(ctx, def.definitionId);
    expect(again.own.id).toBe(c.own.id);
    expect(again.own.inUse).toBe(true);
    expect(again.own.currentVersion.versionNumber).toBe(2);
    expect(again.own.currentVersion.basedOnDefinitionVersionId).toBe(v2);
    const detail = await ownPrompts.get(ctx, def.definitionId);
    expect(detail.own?.currentVersion?.promptText).toBe(DEFAULT_V2);
    expect(detail.own?.currentVersion?.basedOnDefinitionVersion).toEqual({
      id: v2,
      versionNumber: 2,
    });
  });

  it('reset -> save uses the active definition version as based_on', async () => {
    const { ctx, def } = await setup();
    const c = await ownPrompts.customise(ctx, def.definitionId);
    await ownPrompts.reset(ctx, def.definitionId);
    const v2 = await publishDefault(def.definitionId, DEFAULT_V2);
    const s = await ownPrompts.save(ctx, def.definitionId, {
      promptText: 'back to my own prompt',
      baseVersionId: c.own.currentVersion.id,
    });
    expect(s.own.inUse).toBe(true);
    expect(s.own.currentVersion.versionNumber).toBe(2);
    expect(s.own.currentVersion.basedOnDefinitionVersionId).toBe(v2);
    expect(await ownRow(c.own.id)).toEqual({
      in_use: true,
      current_version_id: s.own.currentVersion.id,
    });
  });

  it('save without an own prompt is 404; reset without one is 404', async () => {
    const { ctx, def } = await setup();
    await expectCode(
      ownPrompts.save(ctx, def.definitionId, { promptText: 'hello', baseVersionId: randomUUID() }),
      'not_found',
      404,
    );
    await expectCode(ownPrompts.reset(ctx, def.definitionId), 'not_found', 404);
    await expectCode(ownPrompts.compare(ctx, def.definitionId), 'not_found', 404);
    expect(await ownPrompts.listVersions(ctx, def.definitionId)).toEqual([]);
    const detail = await ownPrompts.get(ctx, def.definitionId);
    expect(detail.own).toBeNull();
  });
});

describe('retired definitions', () => {
  it('customise and save are 409 definition_retired; reset is allowed', async () => {
    const { ctx, def } = await setup();
    const c = await ownPrompts.customise(ctx, def.definitionId);
    await setAvailability(def.definitionId, 'retired');
    await ownPrompts.reset(ctx, def.definitionId);
    await expectCode(ownPrompts.customise(ctx, def.definitionId), 'definition_retired', 409);
    await expectCode(
      ownPrompts.save(ctx, def.definitionId, {
        promptText: 'edit',
        baseVersionId: c.own.currentVersion.id,
      }),
      'definition_retired',
      409,
    );
    const detail = await ownPrompts.get(ctx, def.definitionId);
    expect(detail.definition.retired).toBe(true);
    const [item] = (await ownPrompts.list(ctx)).filter((i) => i.definition.id === def.definitionId);
    expect(item!.definition.retired).toBe(true);
  });
});

describe('scope', () => {
  it('a definition the user has not chosen is 404 for every operation', async () => {
    const { ctx } = await setup();
    const other = await seedDefinition({ analysisPrompt: DEFAULT_V1 });
    const id = other.definitionId;
    await expectCode(ownPrompts.get(ctx, id), 'not_found', 404);
    await expectCode(ownPrompts.customise(ctx, id), 'not_found', 404);
    await expectCode(
      ownPrompts.save(ctx, id, { promptText: 'x', baseVersionId: randomUUID() }),
      'not_found',
      404,
    );
    await expectCode(ownPrompts.reset(ctx, id), 'not_found', 404);
    await expectCode(ownPrompts.listVersions(ctx, id), 'not_found', 404);
    await expectCode(ownPrompts.compare(ctx, id), 'not_found', 404);
    await expectCode(ownPrompts.defaultChanges(ctx, id, other.versionId), 'not_found', 404);
    await expectCode(ownPrompts.get(ctx, 'not-a-uuid'), 'not_found', 404);
    await expectCode(ownPrompts.get(ctx, randomUUID()), 'not_found', 404);
    expect((await ownPrompts.list(ctx)).some((i) => i.definition.id === id)).toBe(false);
  });

  it('a definition with a profile but a removed choice stays in scope', async () => {
    const { ctx, def, profileId } = await setup();
    await getPool().query(
      'update user_definition_choice set removed_at = now() where user_id = $1 and definition_id = $2',
      [ctx.userId, def.definitionId],
    );
    const [item] = (await ownPrompts.list(ctx)).filter((i) => i.definition.id === def.definitionId);
    expect(item!.profileId).toBe(profileId);
    await ownPrompts.customise(ctx, def.definitionId);
  });

  it("another user's own prompt and versions are not visible", async () => {
    const a = await setup();
    const b = await createUser();
    const bctx: ServiceContext = { userId: b, role: 'user' };
    const c = await ownPrompts.customise(a.ctx, a.def.definitionId);
    // b chose the same definition but has no own prompt.
    await choose(b, a.def.definitionId);
    expect((await ownPrompts.get(bctx, a.def.definitionId)).own).toBeNull();
    await expectCode(
      ownPrompts.getVersion(bctx, a.def.definitionId, c.own.currentVersion.id),
      'not_found',
      404,
    );
    await expectCode(
      ownPrompts.save(bctx, a.def.definitionId, {
        promptText: 'hijack',
        baseVersionId: c.own.currentVersion.id,
      }),
      'not_found',
      404,
    );
  });
});

describe('versions', () => {
  it('listVersions is newest first with inUseNow; getVersion returns the text', async () => {
    const { ctx, def } = await setup();
    const c = await ownPrompts.customise(ctx, def.definitionId);
    const s = await ownPrompts.save(ctx, def.definitionId, {
      promptText: 'second',
      baseVersionId: c.own.currentVersion.id,
    });
    const versions = await ownPrompts.listVersions(ctx, def.definitionId);
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({
      id: s.own.currentVersion.id,
      versionNumber: 2,
      basedOnDefinitionVersion: { id: def.versionId, versionNumber: 1 },
      inUseNow: true,
    });
    expect(versions[1]).toMatchObject({
      id: c.own.currentVersion.id,
      versionNumber: 1,
      inUseNow: false,
    });
    expect(versions.some((v) => 'promptText' in v)).toBe(false);

    const v1 = await ownPrompts.getVersion(ctx, def.definitionId, c.own.currentVersion.id);
    expect(v1).toMatchObject({ versionNumber: 1, inUseNow: false, promptText: DEFAULT_V1 });

    // A version id under the wrong definition is not found.
    const other = await seedDefinition({ analysisPrompt: DEFAULT_V1 });
    await choose(ctx.userId, other.definitionId);
    await expectCode(
      ownPrompts.getVersion(ctx, other.definitionId, c.own.currentVersion.id),
      'not_found',
      404,
    );
    await expectCode(ownPrompts.getVersion(ctx, def.definitionId, randomUUID()), 'not_found', 404);
  });
});

describe('compare and default changes', () => {
  it('compare diffs the current own version against the current default', async () => {
    const { ctx, def } = await setup();
    const c = await ownPrompts.customise(ctx, def.definitionId);
    const s = await ownPrompts.save(ctx, def.definitionId, {
      promptText: `${DEFAULT_V1}- Sign-off phrases\n`,
      baseVersionId: c.own.currentVersion.id,
    });
    const res = await ownPrompts.compare(ctx, def.definitionId);
    expect(res.own).toEqual({ versionId: s.own.currentVersion.id, versionNumber: 2 });
    expect(res.default).toEqual({ definitionVersionId: def.versionId, versionNumber: 1 });
    expect(res.diff.length).toBeGreaterThan(0);
    // The default is the first side and the own text the second, so the user's addition is an insert.
    expect(
      res.diff
        .filter((d) => d.op === 'insert')
        .map((d) => d.value)
        .join(''),
    ).toContain('Sign-off');
    expect(
      res.diff
        .filter((d) => d.op !== 'insert')
        .map((d) => d.value)
        .join(''),
    ).toBe(DEFAULT_V1);
    expect(
      res.diff
        .filter((d) => d.op !== 'delete')
        .map((d) => d.value)
        .join(''),
    ).toBe(`${DEFAULT_V1}- Sign-off phrases`);
  });

  it('defaultChanges diffs two default versions; from is required; to defaults to active', async () => {
    const { ctx, def } = await setup();
    const v2 = await publishDefault(def.definitionId, DEFAULT_V2);
    const res = await ownPrompts.defaultChanges(ctx, def.definitionId, def.versionId);
    expect(res.from).toEqual({ id: def.versionId, versionNumber: 1 });
    expect(res.to).toEqual({ id: v2, versionNumber: 2 });
    expect(
      res.diff
        .filter((d) => d.op === 'delete')
        .map((d) => d.value)
        .join(''),
    ).toContain('Greeting');
    expect(
      res.diff
        .filter((d) => d.op === 'insert')
        .map((d) => d.value)
        .join(''),
    ).toContain('Sign-off');

    const explicit = await ownPrompts.defaultChanges(
      ctx,
      def.definitionId,
      def.versionId,
      def.versionId,
    );
    expect(explicit.diff.every((d) => d.op === 'equal')).toBe(true);

    const missing = await expectCode(
      ownPrompts.defaultChanges(ctx, def.definitionId, undefined),
      'validation_failed',
      422,
    );
    expect(missing.details).toMatchObject({ field: 'from' });

    const other = await seedDefinition({ analysisPrompt: DEFAULT_V1 });
    await expectCode(
      ownPrompts.defaultChanges(ctx, def.definitionId, other.versionId),
      'not_found',
      404,
    );
    await expectCode(
      ownPrompts.defaultChanges(ctx, def.definitionId, def.versionId, other.versionId),
      'not_found',
      404,
    );
  });
});

describe('list', () => {
  it('lists chosen definitions with mode, own state and defaultChangedSinceBase, never the text', async () => {
    const { ctx, def, profileId } = await setup();
    const plain = await seedDefinition({ analysisPrompt: DEFAULT_V1 });
    await choose(ctx.userId, plain.definitionId);

    let items = await ownPrompts.list(ctx);
    expect(items.map((i) => i.definition.id).sort()).toEqual(
      [def.definitionId, plain.definitionId].sort(),
    );
    const first = items.find((i) => i.definition.id === def.definitionId)!;
    expect(first).toMatchObject({
      profileId,
      mode: 'default',
      default: { definitionVersionId: def.versionId, versionNumber: 1 },
      own: null,
      defaultChangedSinceBase: false,
    });
    expect(first.definition.retired).toBe(false);

    const c = await ownPrompts.customise(ctx, def.definitionId);
    items = await ownPrompts.list(ctx);
    const own = items.find((i) => i.definition.id === def.definitionId)!;
    expect(own.mode).toBe('own');
    expect(own.own).toEqual({
      id: c.own.id,
      inUse: true,
      currentVersion: {
        id: c.own.currentVersion.id,
        versionNumber: 1,
        basedOnDefinitionVersionId: def.versionId,
        createdAt: c.own.currentVersion.createdAt,
      },
    });
    expect(own.defaultChangedSinceBase).toBe(false);
    expect(JSON.stringify(items)).not.toContain('Describe');

    // A new default with only whitespace changes does not count as changed.
    await publishDefault(def.definitionId, `  ${DEFAULT_V1.trim()}\n\n`);
    items = await ownPrompts.list(ctx);
    expect(items.find((i) => i.definition.id === def.definitionId)!.defaultChangedSinceBase).toBe(
      false,
    );

    const v3 = await publishDefault(def.definitionId, DEFAULT_V2);
    items = await ownPrompts.list(ctx);
    const changed = items.find((i) => i.definition.id === def.definitionId)!;
    expect(changed.default).toEqual({ definitionVersionId: v3, versionNumber: 3 });
    expect(changed.defaultChangedSinceBase).toBe(true);

    await ownPrompts.reset(ctx, def.definitionId);
    items = await ownPrompts.list(ctx);
    expect(items.find((i) => i.definition.id === def.definitionId)!.defaultChangedSinceBase).toBe(
      false,
    );
  });

  it('a seeded own prompt (helper) is visible through get', async () => {
    const { ctx, def } = await setup();
    const seeded = await seedOwnPrompt({
      userId: ctx.userId,
      definitionId: def.definitionId,
      text: 'seeded own text',
      basedOnDefinitionVersionId: def.versionId,
    });
    const detail = await ownPrompts.get(ctx, def.definitionId);
    expect(detail.own).toMatchObject({
      id: seeded.ownPromptId,
      inUse: true,
      currentVersion: { id: seeded.versionId, versionNumber: 1, promptText: 'seeded own text' },
    });
  });
});
