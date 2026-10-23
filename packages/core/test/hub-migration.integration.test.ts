import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getPool } from '@voicespark/db';

// Migration 0008 (T020; FR-001, FR-002, FR-007, FR-012, FR-027): objects exist, a second migrate is a
// no-op, and the database itself rejects the rows the schema constraints are there to stop.

process.env.DATABASE_URL ??= 'postgres://voicespark:voicespark@localhost:55432/voicespark_test';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

const HUB_TABLES = [
  'hub_person',
  'hub_person_email',
  'hub_company',
  'hub_company_domain',
  'hub_project',
  'hub_link',
  'hub_note',
  'hub_file',
  'hub_thread',
  'hub_message',
  'hub_message_source',
  'hub_thread_source',
  'hub_thread_record',
  'hub_llm_call',
  'hub_fact',
  'hub_fact_evidence',
  'hub_block_marker',
  'hub_ignore_rule',
  'hub_merge_redirect',
  'hub_mailbox_setting',
  'hub_search_doc',
  'hub_sync_item',
];

const HUB_ENUMS = [
  'hub_origin',
  'hub_project_status',
  'hub_link_kind',
  'hub_extraction_status',
  'hub_thread_status',
  'hub_skip_reason',
  'hub_fact_type',
  'hub_fact_state',
  'hub_fact_basis',
  'hub_sync_status',
  'hub_sync_entity',
];

const H = (c: string) => c.repeat(64);

function migrate(): void {
  execFileSync('pnpm', ['db:migrate'], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: 'pipe',
  });
}

async function migrationState(): Promise<{ count: number; tables: number }> {
  const pool = getPool();
  const m = await pool.query<{ n: string }>(
    'select count(*)::text as n from drizzle.__drizzle_migrations',
  );
  const t = await pool.query<{ n: string }>(
    "select count(*)::text as n from information_schema.tables where table_schema = 'public'",
  );
  return { count: Number(m.rows[0]!.n), tables: Number(t.rows[0]!.n) };
}

/** Runs the statement and returns the Postgres error (code and constraint) the database raised. */
async function reject(
  text: string,
  values: unknown[] = [],
): Promise<{ code?: string; constraint?: string }> {
  try {
    await getPool().query(text, values);
  } catch (e) {
    const err = e as { code?: string; constraint?: string };
    return { code: err.code, constraint: err.constraint };
  }
  throw new Error(`statement was accepted: ${text}`);
}

describe('context hub migration 0008', () => {
  const userId = randomUUID();
  let otherUserId: string;
  let personId: string;
  let companyId: string;
  let projectId: string;

  beforeAll(async () => {
    const pool = getPool();
    otherUserId = randomUUID();
    for (const id of [userId, otherUserId]) {
      await pool.query('insert into "user" (id, name, email) values ($1, $2, $3)', [
        id,
        'Hub Migration',
        `hub-mig-${id}@example.test`,
      ]);
    }
    personId = (
      await pool.query<{ id: string }>(
        'insert into hub_person (user_id, name_enc, name_key, match_key) values ($1, $2, $3, $4) returning id',
        [userId, 'enc', H('a'), H('b')],
      )
    ).rows[0]!.id;
    companyId = (
      await pool.query<{ id: string }>(
        'insert into hub_company (user_id, name_enc, name_key, match_key) values ($1, $2, $3, $4) returning id',
        [userId, 'enc', H('a'), H('b')],
      )
    ).rows[0]!.id;
    projectId = (
      await pool.query<{ id: string }>(
        'insert into hub_project (user_id, name_enc, name_key, match_key) values ($1, $2, $3, $4) returning id',
        [userId, 'enc', H('a'), H('b')],
      )
    ).rows[0]!.id;
  });

  afterAll(async () => {
    const pool = getPool();
    await pool.query('delete from "user" where id = any($1)', [[userId, otherUserId]]);
    await closeDb();
  });

  it('creates every hub table, enum and the deletion_scope value', async () => {
    const pool = getPool();
    const tables = await pool.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' and table_name = any($1)",
      [HUB_TABLES],
    );
    expect(tables.rows.map((r) => r.table_name).sort()).toEqual([...HUB_TABLES].sort());

    const enums = await pool.query<{ typname: string }>(
      "select typname from pg_type where typtype = 'e' and typname = any($1)",
      [HUB_ENUMS],
    );
    expect(enums.rows.map((r) => r.typname).sort()).toEqual([...HUB_ENUMS].sort());

    const scope = await pool.query<{ enumlabel: string }>(
      "select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'deletion_scope'",
    );
    expect(scope.rows.map((r) => r.enumlabel)).toContain('hub_source');

    const cols = await pool.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'draft' and column_name like 'hub\\_%'",
    );
    expect(cols.rows.map((r) => r.column_name).sort()).toEqual([
      'hub_context_status',
      'hub_record_id',
      'hub_record_kind',
      'hub_record_label_enc',
    ]);
  });

  it('a second migrate changes nothing', async () => {
    const before = await migrationState();
    migrate();
    expect(await migrationState()).toEqual(before);
  }, 120_000);

  it('leaves existing sources with hub off (no hub_mailbox_setting row)', async () => {
    const pool = getPool();
    const source = await pool.query<{ id: string }>(
      `insert into connected_source (user_id, type, account_label, status, consent_text_version)
       values ($1, 'imap', 'hub-migration@example.test', 'connected', 'v1') returning id`,
      [userId],
    );
    const sourceId = source.rows[0]!.id;
    const orphans = await pool.query('select 1 from hub_mailbox_setting where source_id = $1', [
      sourceId,
    ]);
    expect(orphans.rowCount).toBe(0);
  });

  it('rejects end_date < start_date on a project', async () => {
    const err = await reject(
      `insert into hub_project (user_id, name_enc, name_key, match_key, start_date, end_date)
       values ($1, 'enc', $2, $3, '2026-05-02', '2026-05-01')`,
      [userId, H('a'), H('b')],
    );
    expect(err.code).toBe('23514');
    expect(err.constraint).toBe('hub_project_dates_order');
  });

  it('rejects a note with two owners (and with none)', async () => {
    const two = await reject(
      `insert into hub_note (user_id, person_id, company_id, title_enc, body_json_enc)
       values ($1, $2, $3, 't', 'b')`,
      [userId, personId, companyId],
    );
    expect(two.constraint).toBe('hub_note_one_owner');
    const none = await reject(
      `insert into hub_note (user_id, title_enc, body_json_enc) values ($1, 't', 'b')`,
      [userId],
    );
    expect(none.constraint).toBe('hub_note_one_owner');
  });

  it('rejects a person_company link with project_id set', async () => {
    const err = await reject(
      `insert into hub_link (user_id, kind, person_id, company_id, project_id, origin)
       values ($1, 'person_company', $2, $3, $4, 'user')`,
      [userId, personId, companyId, projectId],
    );
    expect(err.constraint).toBe('hub_link_kind_fks');
  });

  it('rejects a second link for the same pair', async () => {
    const pool = getPool();
    await pool.query(
      `insert into hub_link (user_id, kind, person_id, company_id, origin)
       values ($1, 'person_company', $2, $3, 'user')`,
      [userId, personId, companyId],
    );
    const err = await reject(
      `insert into hub_link (user_id, kind, person_id, company_id, origin)
       values ($1, 'person_company', $2, $3, 'email')`,
      [userId, personId, companyId],
    );
    expect(err.code).toBe('23505');
    expect(err.constraint).toBe('hub_link_person_company_uq');
  });

  it('rejects a second hub_person_email with the same address_hash per user, allows another user', async () => {
    const pool = getPool();
    await pool.query(
      `insert into hub_person_email (user_id, person_id, address_enc, address_hash, match_hash, origin)
       values ($1, $2, 'enc', $3, $4, 'user')`,
      [userId, personId, H('c'), H('d')],
    );
    const err = await reject(
      `insert into hub_person_email (user_id, person_id, address_enc, address_hash, match_hash, origin)
       values ($1, $2, 'enc', $3, $4, 'email')`,
      [userId, personId, H('c'), H('d')],
    );
    expect(err.code).toBe('23505');
    expect(err.constraint).toBe('hub_person_email_user_address_uq');

    const otherPerson = await pool.query<{ id: string }>(
      'insert into hub_person (user_id, name_enc, name_key, match_key) values ($1, $2, $3, $4) returning id',
      [otherUserId, 'enc', H('a'), H('b')],
    );
    await pool.query(
      `insert into hub_person_email (user_id, person_id, address_enc, address_hash, match_hash, origin)
       values ($1, $2, 'enc', $3, $4, 'user')`,
      [otherUserId, otherPerson.rows[0]!.id, H('c'), H('d')],
    );
  });

  it('rejects processed_version > version on a thread', async () => {
    const err = await reject(
      `insert into hub_thread (user_id, thread_key, version, processed_version)
       values ($1, $2, 1, 2)`,
      [userId, H('e')],
    );
    expect(err.constraint).toBe('hub_thread_processed_le_version');
  });

  it('rejects skip_reason on a non-skipped thread, accepts it on a skipped one', async () => {
    const err = await reject(
      `insert into hub_thread (user_id, thread_key, status, skip_reason)
       values ($1, $2, 'pending', 'automated')`,
      [userId, H('f')],
    );
    expect(err.constraint).toBe('hub_thread_skip_reason_when_skipped');
    await getPool().query(
      `insert into hub_thread (user_id, thread_key, status, skip_reason)
       values ($1, $2, 'skipped', 'automated')`,
      [userId, H('f')],
    );
  });

  it('rejects a suggested fact with a null reason', async () => {
    const err = await reject(
      `insert into hub_fact (user_id, type, state, confidence, fingerprint, policy_version, prompt_version)
       values ($1, 'person', 'suggested', 0.5, $2, 'p1', 'v1')`,
      [userId, H('1')],
    );
    expect(err.constraint).toBe('hub_fact_reason_when_suggested');
    await getPool().query(
      `insert into hub_fact (user_id, type, state, confidence, fingerprint, policy_version, prompt_version, reason)
       values ($1, 'person', 'suggested', 0.5, $2, 'p1', 'v1', 'low_confidence')`,
      [userId, H('1')],
    );
  });

  it('rejects a draft with only hub_record_kind set, accepts all three or none', async () => {
    const pool = getPool();
    const version = await pool.query<{ id: string }>(
      'select id from prompt_template_version limit 1',
    );
    const promptVersionId = version.rows[0]?.id;
    if (!promptVersionId) throw new Error('no prompt_template_version seeded in the test database');
    const insert = (
      kind: string | null,
      id: string | null,
      label: string | null,
    ): [string, unknown[]] => [
      `insert into draft (user_id, content_type, profile_version_id, prompt_version_id, topic_enc, brief_enc,
                            hub_record_kind, hub_record_id, hub_record_label_enc)
         values ($1, 'short_article', $2, $3, 't', 'b', $4, $5, $6)`,
      [userId, randomUUID(), promptVersionId, kind, id, label],
    ];

    const err = await reject(...insert('person', null, null));
    expect(err.constraint).toBe('draft_hub_record_all_or_none');
    await pool.query(...insert(null, null, null));
    await pool.query(...insert('person', randomUUID(), 'enc-label'));

    const status = await reject(
      `insert into draft (user_id, content_type, profile_version_id, prompt_version_id, topic_enc, brief_enc, hub_context_status)
       values ($1, 'bio', $2, $3, 't', 'b', 'bogus')`,
      [userId, randomUUID(), promptVersionId],
    );
    expect(status.constraint).toBe('draft_hub_context_status_check');
  });
});
