import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, getPool } from '@voicespark/db';
import {
  ANALYSIS_WRAPPER_MAX_TOKENS,
  backfillAnalysisPrompts,
  buildAnalysisPromptFromDimensions,
} from '@voicespark/db/data/analysis-prompts';
import { cleanupProfiles, seedDefinition, TEST_DIMENSIONS } from './helpers/profiles';

// Migration 0007 backfill (T011, T012; FR-025). Queues are mocked (no Redis needed).
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

const KEY = 'tone_profile.generate';
const LEGACY_SYSTEM = 'Legacy system template without the new variable.';
const LEGACY_USER = 'Legacy user template. Dimensions: {{definition.dimensionsJson}}';

interface VersionRow {
  id: string;
  version_number: number;
  status: string;
  system_template: string;
  user_template: string;
  model: string;
  effort: string;
  max_tokens: number;
}

async function templateState(): Promise<{
  templateId: string;
  versions: VersionRow[];
  activeId: string | null;
}> {
  const pool = getPool();
  const t = await pool.query<{ id: string; active_version_id: string | null }>(
    'select id, active_version_id from prompt_template where key = $1',
    [KEY],
  );
  const row = t.rows[0];
  if (!row) throw new Error(`${KEY} prompt template is not seeded in the test database`);
  const v = await pool.query<VersionRow>(
    `select id, version_number, status, system_template, user_template, model, effort, max_tokens
       from prompt_template_version where prompt_template_id = $1 order by version_number`,
    [row.id],
  );
  return { templateId: row.id, versions: v.rows, activeId: row.active_version_id };
}

describe('analysis prompts backfill (migration 0007)', () => {
  let originalActiveId: string;
  let legacyId: string;
  let templateId: string;
  let legacyDefinitionVersionId: string;
  let legacyDefinitionVersionDraftId: string;

  beforeAll(async () => {
    // Normalise first: the shared database may still hold the pre-0007 v1 wrapper.
    await backfillAnalysisPrompts(getDb());
    const pool = getPool();
    const state = await templateState();
    templateId = state.templateId;
    originalActiveId = state.activeId!;
    const active = state.versions.find((v) => v.id === originalActiveId)!;

    // A legacy wrapper version (no {{analysisPrompt}}) becomes the active one.
    const next = Math.max(...state.versions.map((v) => v.version_number)) + 1;
    await pool.query("update prompt_template_version set status = 'superseded' where id = $1", [
      originalActiveId,
    ]);
    const ins = await pool.query<{ id: string }>(
      `insert into prompt_template_version
         (prompt_template_id, version_number, status, system_template, user_template, model, effort, max_tokens,
          change_note, created_by, published_by, published_at)
       values ($1, $2, 'active', $3, $4, $5, 'high', 8192, 'legacy test version',
               '00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', now())
       returning id`,
      [templateId, next, LEGACY_SYSTEM, LEGACY_USER, active.model],
    );
    legacyId = ins.rows[0]!.id;
    await pool.query('update prompt_template set active_version_id = $2 where id = $1', [
      templateId,
      legacyId,
    ]);

    // Legacy definition versions: an active one and a superseded one, both with analysis_prompt null.
    const def = await seedDefinition({
      name: 'Backfill voice',
      dims: TEST_DIMENSIONS,
      analysisPrompt: null,
    });
    legacyDefinitionVersionId = def.versionId;
    const sup = await pool.query<{ id: string }>(
      `insert into tone_definition_version
         (definition_id, version_number, status, name, description, dimensions, created_by)
       values ($1, 2, 'superseded', 'Backfill voice old', 'Old description', $2::jsonb,
               '00000000-0000-0000-0000-000000000000')
       returning id`,
      [def.definitionId, JSON.stringify(TEST_DIMENSIONS)],
    );
    legacyDefinitionVersionDraftId = sup.rows[0]!.id;
  });

  afterAll(async () => {
    const pool = getPool();
    // Restore the global prompt rows: drop everything this test added and re-activate the original version.
    const state = await templateState();
    const originalNumber =
      state.versions.find((v) => v.id === originalActiveId)?.version_number ?? 0;
    const toDelete = state.versions
      .filter((v) => v.version_number > originalNumber)
      .map((v) => v.id);
    await pool.query(
      'delete from version_activation where entity_id = $1 and to_version_id = any($2::uuid[])',
      [templateId, toDelete],
    );
    await pool.query('update prompt_template set active_version_id = $2 where id = $1', [
      templateId,
      originalActiveId,
    ]);
    await pool.query('delete from prompt_template_version where id = any($1::uuid[])', [toDelete]);
    await pool.query("update prompt_template_version set status = 'active' where id = $1", [
      originalActiveId,
    ]);
    await cleanupProfiles();
    await closeDb();
  });

  it('fills analysis_prompt for legacy definition versions (T012)', async () => {
    const first = await backfillAnalysisPrompts(getDb());
    expect(first.definitionVersionsUpdated).toBeGreaterThanOrEqual(2);
    const pool = getPool();
    const rows = await pool.query<{
      id: string;
      analysis_prompt: string | null;
      name: string;
      description: string;
    }>(
      'select id, analysis_prompt, name, description from tone_definition_version where id = any($1::uuid[])',
      [[legacyDefinitionVersionId, legacyDefinitionVersionDraftId]],
    );
    expect(rows.rows).toHaveLength(2);
    for (const r of rows.rows) {
      expect(r.analysis_prompt).toBe(
        buildAnalysisPromptFromDimensions({
          name: r.name,
          description: r.description,
          dimensions: TEST_DIMENSIONS,
        }),
      );
    }
    const nulls = await pool.query(
      'select 1 from tone_definition_version where analysis_prompt is null',
    );
    expect(nulls.rowCount).toBe(0);
  });

  it('inserts the document-oriented wrapper as a new active version (T012)', async () => {
    const state = await templateState();
    const active = state.versions.find((v) => v.id === state.activeId)!;
    expect(active.id).not.toBe(legacyId);
    expect(active.status).toBe('active');
    expect(active.user_template).toContain('{{analysisPrompt}}');
    expect(active.max_tokens).toBe(ANALYSIS_WRAPPER_MAX_TOKENS);
    expect(active.effort).toBe('medium');
    const legacy = state.versions.find((v) => v.id === legacyId)!;
    expect(legacy.status).toBe('superseded');
    expect(active.model).toBe(legacy.model);
    expect(active.version_number).toBe(legacy.version_number + 1);

    const acts = await getPool().query(
      'select from_version_id, action from version_activation where entity_id = $1 and to_version_id = $2',
      [state.templateId, active.id],
    );
    expect(acts.rows).toEqual([{ from_version_id: legacyId, action: 'publish' }]);
  });

  it('is idempotent: a second run changes nothing (T012)', async () => {
    const before = await templateState();
    const actsBefore = await getPool().query(
      'select count(*)::int as n from version_activation where entity_id = $1',
      [before.templateId],
    );
    const second = await backfillAnalysisPrompts(getDb());
    expect(second).toEqual({ definitionVersionsUpdated: 0, wrappersInserted: [] });
    const after = await templateState();
    expect(after.activeId).toBe(before.activeId);
    expect(after.versions.map((v) => [v.id, v.status])).toEqual(
      before.versions.map((v) => [v.id, v.status]),
    );
    const actsAfter = await getPool().query(
      'select count(*)::int as n from version_activation where entity_id = $1',
      [after.templateId],
    );
    expect(actsAfter.rows[0]!.n).toBe(actsBefore.rows[0]!.n);
  });
});
